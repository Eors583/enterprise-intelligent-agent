import type {
  ExperienceCandidate,
  ExperienceKnowledgeProjection,
  PrepareExperienceKnowledgeProjectionRequest,
} from '@enterprise/contracts';

import type { TrustedExperienceActor } from './domain/experience-state-machine.js';
import type { TrustedRuntimePrincipal } from '../process-orchestration/application/runtime-identity.port.js';

export interface PrepareExperienceKnowledgeProjectionInput {
  readonly principal: TrustedRuntimePrincipal;
  readonly actor: TrustedExperienceActor;
  readonly candidate: ExperienceCandidate;
  readonly request: PrepareExperienceKnowledgeProjectionRequest;
  readonly now: Date;
}

export abstract class ExperienceKnowledgeProjectionPort {
  abstract prepare(
    input: PrepareExperienceKnowledgeProjectionInput,
  ): Promise<ExperienceKnowledgeProjection>;

  abstract find(
    principal: TrustedRuntimePrincipal,
    experienceId: string,
  ): Promise<ExperienceKnowledgeProjection | null>;
}
