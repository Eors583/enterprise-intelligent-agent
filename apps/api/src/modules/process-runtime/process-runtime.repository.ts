import type {
  ProcessCommand,
  ProcessInstance,
  ProcessInstanceDetailResponse,
  ProcessStepCommand,
  ProcessStepInstance,
} from '@enterprise/contracts';

import type { TrustedRuntimePrincipal } from '../process-orchestration/application/runtime-identity.port.js';
import type {
  RuntimeCursorPage,
  RuntimeCursorRequest,
  RuntimeMutationResult,
} from '../process-orchestration/application/runtime-mutation-result.js';

export interface ProcessRuntimeCommandInput {
  readonly principal: TrustedRuntimePrincipal;
  readonly command: ProcessCommand;
}

export interface ProcessStepRuntimeCommandInput {
  readonly principal: TrustedRuntimePrincipal;
  readonly processInstanceId: string;
  readonly command: ProcessStepCommand;
}

/**
 * Persistence boundary for the runtime aggregate. Implementations must enforce
 * tenant predicates, CAS revision checks, idempotency and state transitions in
 * one transaction together with AuditLog, BusinessEvent and Outbox writes.
 */
export abstract class ProcessRuntimeRepository {
  abstract listInstances(
    principal: TrustedRuntimePrincipal,
    page: RuntimeCursorRequest,
  ): Promise<RuntimeCursorPage<ProcessInstance>>;

  abstract findInstance(
    principal: TrustedRuntimePrincipal,
    processInstanceId: string,
  ): Promise<ProcessInstanceDetailResponse | null>;

  abstract executeProcessCommand(
    input: ProcessRuntimeCommandInput,
  ): Promise<RuntimeMutationResult<ProcessInstance>>;

  abstract executeStepCommand(
    input: ProcessStepRuntimeCommandInput,
  ): Promise<RuntimeMutationResult<ProcessStepInstance>>;
}
