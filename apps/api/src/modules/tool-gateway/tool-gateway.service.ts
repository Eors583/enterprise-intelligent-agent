import { createHash } from 'node:crypto';

import {
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  AvailableToolListResponse,
  CreateToolCompensationRequest,
  CreateToolDefinitionRequest,
  CreateToolInvocationRequest,
  CreateToolVersionRequest,
  ToolDefinition,
  ToolDefinitionDetail,
  ToolDefinitionListResponse,
  ToolInvocation,
  ToolInvocationDecisionRequest,
  ToolInvocationListResponse,
  ToolVersion,
  ToolVersionLifecycleRequest,
} from '@enterprise/contracts';

import {
  normalizeRuntimeCursor,
  unwrapRuntimeMutation,
} from '../process-orchestration/application/runtime-http-errors.js';
import { requireRuntimeAdministrator } from '../process-orchestration/application/runtime-admin.policy.js';
import { RuntimeIdentityPort } from '../process-orchestration/application/runtime-identity.port.js';
import type { EnvironmentVariables } from '../../config/environment.js';
import { ToolGatewayRepository } from './tool-gateway.repository.js';

const PAGE_SIZE = 100;

@Injectable()
export class ToolGatewayService {
  constructor(
    @Inject(ToolGatewayRepository)
    private readonly repository: ToolGatewayRepository,
    @Inject(RuntimeIdentityPort)
    private readonly identity: RuntimeIdentityPort,
    @Inject(ConfigService)
    private readonly config: ConfigService<EnvironmentVariables, true>,
  ) {}

  async listAvailableTools(taskId: string): Promise<AvailableToolListResponse> {
    if (!this.toolExecutionEnabled()) return { items: [] };
    const principal = this.identity.current();
    const items = await this.repository.listAvailableTools(principal, taskId);
    return { items: [...items] };
  }

  async listReviewableInvocations(taskId: string): Promise<ToolInvocationListResponse> {
    const principal = this.identity.current();
    const items = await this.repository.listReviewableInvocations(principal, taskId);
    return { items: [...items], nextCursor: null };
  }

  async listDefinitions(cursor?: string): Promise<ToolDefinitionListResponse> {
    const principal = this.administrator();
    const page = await this.repository.listDefinitions(principal, {
      cursor: normalizeRuntimeCursor(cursor),
      limit: PAGE_SIZE,
    });
    return { items: [...page.items], nextCursor: page.nextCursor };
  }

  async getDefinition(toolId: string): Promise<ToolDefinitionDetail> {
    const principal = this.administrator();
    const detail = await this.repository.findDefinition(principal, toolId);
    if (detail === null) throw new NotFoundException('Tool Definition was not found.');
    return detail;
  }

  async createDefinition(request: CreateToolDefinitionRequest): Promise<ToolDefinition> {
    const principal = this.administrator();
    const keyWasGenerated = request.key === undefined;
    const normalizedRequest = {
      ...request,
      key: request.key ?? stableToolDefinitionKey(request.name),
    };
    return unwrapRuntimeMutation(
      await this.repository.createDefinition({
        principal,
        request: normalizedRequest,
        keyWasGenerated,
      }),
      'Tool Definition',
    );
  }

  async createVersion(toolId: string, request: CreateToolVersionRequest): Promise<ToolVersion> {
    const principal = this.administrator();
    return unwrapRuntimeMutation(
      await this.repository.createVersion({ principal, toolId, request }),
      'Tool Version',
    );
  }

  async transitionVersion(
    toolId: string,
    toolVersionId: string,
    request: ToolVersionLifecycleRequest,
  ): Promise<ToolDefinitionDetail> {
    const principal = this.administrator();
    if (request.action === 'PUBLISH') {
      await this.assertPublishedVersionExecutable(principal, toolId, toolVersionId);
    }
    return unwrapRuntimeMutation(
      await this.repository.transitionVersion({
        principal,
        toolId,
        toolVersionId,
        request,
      }),
      'Tool Version',
    );
  }

  async listInvocations(cursor?: string): Promise<ToolInvocationListResponse> {
    const principal = this.identity.current();
    const page = await this.repository.listInvocations(principal, {
      cursor: normalizeRuntimeCursor(cursor),
      limit: PAGE_SIZE,
    });
    return { items: [...page.items], nextCursor: page.nextCursor };
  }

  async getInvocation(invocationId: string): Promise<ToolInvocation> {
    const principal = this.identity.current();
    const invocation = await this.repository.findInvocation(principal, invocationId);
    if (invocation === null) throw new NotFoundException('Tool Invocation was not found.');
    return invocation;
  }

  async createInvocation(request: CreateToolInvocationRequest): Promise<ToolInvocation> {
    if (!this.toolExecutionEnabled()) {
      throw new ServiceUnavailableException(
        'Tool execution is not available; no invocation was created.',
      );
    }
    const principal = this.identity.current();
    return unwrapRuntimeMutation(
      await this.repository.createInvocation({ principal, request }),
      'Tool Invocation',
    );
  }

  async createCompensation(
    originalInvocationId: string,
    request: CreateToolCompensationRequest,
  ): Promise<ToolInvocation> {
    if (!this.toolExecutionEnabled()) {
      throw new ServiceUnavailableException(
        'Tool execution is not available; no compensation was created.',
      );
    }
    const principal = this.identity.current();
    return unwrapRuntimeMutation(
      await this.repository.createCompensation({
        principal,
        originalInvocationId,
        request,
      }),
      'Tool Compensation',
    );
  }

  async decideInvocation(
    invocationId: string,
    request: ToolInvocationDecisionRequest,
  ): Promise<ToolInvocation> {
    const principal = this.identity.current();
    return unwrapRuntimeMutation(
      await this.repository.decideInvocation({ principal, invocationId, request }),
      'Tool Invocation',
    );
  }

  private administrator() {
    const principal = this.identity.current();
    requireRuntimeAdministrator(principal);
    return principal;
  }

  private toolExecutionEnabled(): boolean {
    return this.config.get('TOOL_EXECUTION_WORKER_ENABLED', { infer: true });
  }

  private async assertPublishedVersionExecutable(
    principal: ReturnType<ToolGatewayService['administrator']>,
    toolId: string,
    toolVersionId: string,
  ): Promise<void> {
    if (!this.toolExecutionEnabled()) {
      throw new ServiceUnavailableException(
        'Tool execution is not available; this version cannot be published.',
      );
    }
    const detail = await this.repository.findDefinition(principal, toolId);
    if (detail === null) throw new NotFoundException('Tool Definition was not found.');
    const version = detail.versions.find((candidate) => candidate.id === toolVersionId);
    if (version === undefined) throw new NotFoundException('Tool Version was not found.');
    if (version.adapter !== 'HTTP') {
      throw new UnprocessableEntityException(
        'This Tool adapter has no registered sandboxed runtime and cannot be published.',
      );
    }
    const binding = this.config.get('TOOL_ENDPOINT_BINDINGS', { infer: true })[version.endpointRef];
    if (binding === undefined) {
      throw new ServiceUnavailableException(
        'The server-side Tool endpoint binding is unavailable; this version cannot be published.',
      );
    }
    if (!version.allowedHttpMethods.includes(binding.method)) {
      throw new UnprocessableEntityException(
        'The server-side Tool endpoint method is outside the immutable version allowlist.',
      );
    }
    if (version.riskClass !== 'READ_ONLY' && version.idempotencyMode === 'SYSTEM_LEDGER') {
      throw new UnprocessableEntityException(
        'A side-effecting Tool must provide an external idempotency contract before publication.',
      );
    }
  }
}

export function stableToolDefinitionKey(name: string): string {
  const normalized = name
    .normalize('NFKD')
    .replace(/\p{Mark}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  const readable = normalized.length > 0 ? normalized : `tool-${shortStableHash(name)}`;
  const prefixed = /^[a-z]/u.test(readable) ? readable : `tool-${readable}`;
  const padded = prefixed.length >= 3 ? prefixed : `${prefixed}-tool`;
  return padded.slice(0, 100).replace(/[-.]+$/u, '');
}

function shortStableHash(value: string): string {
  return createHash('sha256').update(value.trim(), 'utf8').digest('hex').slice(0, 12);
}
