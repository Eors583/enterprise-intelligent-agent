import type { ProcessStepCommand } from '@enterprise/contracts';

import type { TrustedRuntimePrincipal } from '../process-orchestration/application/runtime-identity.port.js';

export interface TrustedProcessStepActorResolution {
  readonly actorRoleAssignmentId: string | null;
  readonly decisionId: string;
}

/**
 * Resolves the effective actor from trusted employment and Role Assignment
 * records. The request's actorRoleAssignmentId is deliberately not accepted.
 */
export abstract class ProcessRuntimeAuthorizationPort {
  abstract resolveStepActor(input: {
    readonly principal: TrustedRuntimePrincipal;
    readonly processInstanceId: string;
    readonly stepInstanceId: string;
    readonly command: ProcessStepCommand['command'];
    readonly effectiveAt: string;
  }): Promise<TrustedProcessStepActorResolution>;
}
