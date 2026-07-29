import type {
  ExperienceAction,
  TrustedExperienceActor,
} from './domain/experience-state-machine.js';
import type {
  MemoryAccessOperation,
  TrustedMemoryAccessContext,
} from './domain/memory-access.policy.js';
import type { TrustedRuntimePrincipal } from '../process-orchestration/application/runtime-identity.port.js';

export interface ResolveMemoryAccessInput {
  readonly principal: TrustedRuntimePrincipal;
  readonly operation: MemoryAccessOperation;
  readonly purpose: string | null;
  readonly now: Date;
}

export interface ResolveExperienceActorInput {
  readonly principal: TrustedRuntimePrincipal;
  readonly taskId: string;
  readonly action: ExperienceAction | 'CONTRIBUTE';
  readonly now: Date;
}

/**
 * Resolves grants and actors exclusively from tenant-scoped trusted records.
 * HTTP bodies must never supply an actor identity or an authorization grant.
 */
export abstract class MemoryExperienceAuthorizationPort {
  abstract resolveMemoryAccess(
    input: ResolveMemoryAccessInput,
  ): Promise<TrustedMemoryAccessContext>;

  abstract resolveExperienceActor(
    input: ResolveExperienceActorInput,
  ): Promise<TrustedExperienceActor>;
}
