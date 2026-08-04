import type {
  AvailableTool,
  CreateToolCompensationRequest,
  CreateToolDefinitionRequest,
  CreateToolInvocationRequest,
  CreateToolVersionRequest,
  ToolDefinition,
  ToolDefinitionDetail,
  ToolInvocation,
  ToolInvocationDecisionRequest,
  ToolVersion,
  ToolVersionLifecycleRequest,
} from '@enterprise/contracts';

import type {
  RuntimeCursorPage,
  RuntimeCursorRequest,
  RuntimeMutationResult,
} from '../process-orchestration/application/runtime-mutation-result.js';
import type { TrustedRuntimePrincipal } from '../process-orchestration/application/runtime-identity.port.js';

export interface CreateToolDefinitionInput {
  readonly principal: TrustedRuntimePrincipal;
  readonly request: CreateToolDefinitionRequest & { readonly key: string };
  readonly keyWasGenerated: boolean;
}

export interface CreateToolVersionInput {
  readonly principal: TrustedRuntimePrincipal;
  readonly toolId: string;
  readonly request: CreateToolVersionRequest;
}

export interface TransitionToolVersionInput {
  readonly principal: TrustedRuntimePrincipal;
  readonly toolId: string;
  readonly toolVersionId: string;
  readonly request: ToolVersionLifecycleRequest;
}

export interface CreateToolInvocationInput {
  readonly principal: TrustedRuntimePrincipal;
  readonly request: CreateToolInvocationRequest;
}

export interface DecideToolInvocationInput {
  readonly principal: TrustedRuntimePrincipal;
  readonly invocationId: string;
  readonly request: ToolInvocationDecisionRequest;
}

export interface CreateToolCompensationInput {
  readonly principal: TrustedRuntimePrincipal;
  readonly originalInvocationId: string;
  readonly request: CreateToolCompensationRequest;
}

/**
 * Tool Gateway persistence boundary.
 *
 * Implementations must resolve requester/approver Role Assignments from the
 * database and apply policy, CAS, command ledger, AuditLog and Outbox writes in
 * one tenant-bound transaction. No caller-provided actor identity is trusted.
 */
export abstract class ToolGatewayRepository {
  abstract listAvailableTools(
    principal: TrustedRuntimePrincipal,
    taskId: string,
  ): Promise<readonly AvailableTool[]>;

  abstract listReviewableInvocations(
    principal: TrustedRuntimePrincipal,
    taskId: string,
  ): Promise<readonly ToolInvocation[]>;

  abstract listDefinitions(
    principal: TrustedRuntimePrincipal,
    page: RuntimeCursorRequest,
  ): Promise<RuntimeCursorPage<ToolDefinition>>;

  abstract findDefinition(
    principal: TrustedRuntimePrincipal,
    toolId: string,
  ): Promise<ToolDefinitionDetail | null>;

  abstract createDefinition(
    input: CreateToolDefinitionInput,
  ): Promise<RuntimeMutationResult<ToolDefinition>>;

  abstract createVersion(
    input: CreateToolVersionInput,
  ): Promise<RuntimeMutationResult<ToolVersion>>;

  abstract transitionVersion(
    input: TransitionToolVersionInput,
  ): Promise<RuntimeMutationResult<ToolDefinitionDetail>>;

  abstract listInvocations(
    principal: TrustedRuntimePrincipal,
    page: RuntimeCursorRequest,
  ): Promise<RuntimeCursorPage<ToolInvocation>>;

  abstract findInvocation(
    principal: TrustedRuntimePrincipal,
    invocationId: string,
  ): Promise<ToolInvocation | null>;

  abstract createInvocation(
    input: CreateToolInvocationInput,
  ): Promise<RuntimeMutationResult<ToolInvocation>>;

  abstract createCompensation(
    input: CreateToolCompensationInput,
  ): Promise<RuntimeMutationResult<ToolInvocation>>;

  abstract decideInvocation(
    input: DecideToolInvocationInput,
  ): Promise<RuntimeMutationResult<ToolInvocation>>;
}
