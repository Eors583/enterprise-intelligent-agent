import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type {
  ProcessCommand,
  ProcessInstance,
  ProcessInstanceDetailResponse,
  ProcessInstanceListResponse,
  ProcessStepCommand,
  ProcessStepInstance,
} from '@enterprise/contracts';

import {
  normalizeRuntimeCursor,
  unwrapRuntimeMutation,
} from '../process-orchestration/application/runtime-http-errors.js';
import { requireRuntimeAdministrator } from '../process-orchestration/application/runtime-admin.policy.js';
import { RuntimeIdentityPort } from '../process-orchestration/application/runtime-identity.port.js';
import { ProcessRuntimeAuthorizationPort } from './process-runtime-authorization.port.js';
import {
  mapProcessInstanceDetail,
  mapProcessInstanceMutation,
  mapProcessInstancePage,
  mapProcessStepMutation,
} from './process-runtime.mapper.js';
import { ProcessRuntimeRepository } from './process-runtime.repository.js';

const PAGE_SIZE = 100;

@Injectable()
export class ProcessRuntimeService {
  constructor(
    @Inject(ProcessRuntimeRepository)
    private readonly repository: ProcessRuntimeRepository,
    @Inject(ProcessRuntimeAuthorizationPort)
    private readonly authorization: ProcessRuntimeAuthorizationPort,
    @Inject(RuntimeIdentityPort)
    private readonly identity: RuntimeIdentityPort,
  ) {}

  async listInstances(cursor?: string): Promise<ProcessInstanceListResponse> {
    const principal = this.requireAdministrator();
    const page = await this.repository.listInstances(principal, {
      cursor: normalizeRuntimeCursor(cursor),
      limit: PAGE_SIZE,
    });
    return mapProcessInstancePage(principal.tenantId, page);
  }

  async getInstance(processInstanceId: string): Promise<ProcessInstanceDetailResponse> {
    const principal = this.requireAdministrator();
    const detail = await this.repository.findInstance(principal, processInstanceId);
    if (detail === null) {
      throw new NotFoundException('Process Instance was not found.');
    }
    return mapProcessInstanceDetail(principal.tenantId, processInstanceId, detail);
  }

  async executeProcessCommand(
    processInstanceId: string,
    command: ProcessCommand,
  ): Promise<ProcessInstance> {
    const principal = this.requireAdministrator();
    if (command.processInstanceId !== processInstanceId) {
      throw new UnprocessableEntityException(
        'Path and command Process Instance identities differ.',
      );
    }
    const result = unwrapRuntimeMutation(
      await this.repository.executeProcessCommand({ principal, command }),
      'Process Instance',
    );
    return mapProcessInstanceMutation(
      principal.tenantId,
      processInstanceId,
      command.expectedRevision,
      result,
    );
  }

  async executeStepCommand(
    processInstanceId: string,
    stepInstanceId: string,
    command: ProcessStepCommand,
  ): Promise<ProcessStepInstance> {
    const principal = this.requireAdministrator();
    if (command.stepInstanceId !== stepInstanceId) {
      throw new UnprocessableEntityException('Path and command Process Step identities differ.');
    }

    const trustedActor = await this.authorization.resolveStepActor({
      principal,
      processInstanceId,
      stepInstanceId,
      command: command.command,
      effectiveAt: command.effectiveAt,
    });
    if (command.actorRoleAssignmentId !== trustedActor.actorRoleAssignmentId) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        message: 'The claimed Process Step actor does not match the trusted execution identity.',
        decisionId: trustedActor.decisionId,
      });
    }

    const trustedCommand: ProcessStepCommand = {
      ...command,
      actorRoleAssignmentId: trustedActor.actorRoleAssignmentId,
    };
    const result = unwrapRuntimeMutation(
      await this.repository.executeStepCommand({
        principal,
        processInstanceId,
        command: trustedCommand,
      }),
      'Process Step',
    );
    return mapProcessStepMutation(
      principal.tenantId,
      processInstanceId,
      stepInstanceId,
      command.expectedRevision,
      result,
    );
  }

  private requireAdministrator() {
    const principal = this.identity.current();
    requireRuntimeAdministrator(principal);
    return principal;
  }
}
