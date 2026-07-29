import type {
  CreateExperienceCandidateRequest,
  CreateMemoryCandidateRequest,
  ExperienceCandidate,
  ExperienceListQuery,
  ExperienceStatus,
  ExperienceTransitionRequest,
  MemoryListQuery,
  MemoryRecord,
  MemoryStatus,
  MemoryTransitionRequest,
} from '@enterprise/contracts';

import type { TrustedExperienceActor } from './domain/experience-state-machine.js';
import type { TrustedMemoryAccessContext } from './domain/memory-access.policy.js';
import type { TrustedRuntimePrincipal } from '../process-orchestration/application/runtime-identity.port.js';
import type {
  RuntimeCursorPage,
  RuntimeMutationResult,
} from '../process-orchestration/application/runtime-mutation-result.js';

export interface CreateMemoryInput {
  readonly principal: TrustedRuntimePrincipal;
  readonly access: TrustedMemoryAccessContext;
  readonly request: CreateMemoryCandidateRequest;
  readonly now: Date;
}

export interface TransitionMemoryInput {
  readonly principal: TrustedRuntimePrincipal;
  readonly access: TrustedMemoryAccessContext;
  readonly memoryId: string;
  readonly nextStatus: MemoryStatus;
  readonly request: MemoryTransitionRequest;
  readonly now: Date;
}

export interface CreateExperienceInput {
  readonly principal: TrustedRuntimePrincipal;
  readonly actor: TrustedExperienceActor;
  readonly request: CreateExperienceCandidateRequest;
  readonly enforceContributorTaskScope: boolean;
  readonly now: Date;
}

export interface TransitionExperienceInput {
  readonly principal: TrustedRuntimePrincipal;
  readonly actor: TrustedExperienceActor;
  readonly experienceId: string;
  readonly nextStatus: ExperienceStatus;
  readonly request: ExperienceTransitionRequest;
  readonly now: Date;
}

export abstract class MemoryExperienceRepository {
  abstract currentTime(principal: TrustedRuntimePrincipal): Promise<Date>;

  abstract listMemories(
    principal: TrustedRuntimePrincipal,
    query: MemoryListQuery,
  ): Promise<RuntimeCursorPage<MemoryRecord>>;

  abstract findMemory(
    principal: TrustedRuntimePrincipal,
    memoryId: string,
    purpose: string | null,
    operation: 'READ' | 'TRANSITION',
  ): Promise<MemoryRecord | null>;

  abstract createMemory(input: CreateMemoryInput): Promise<RuntimeMutationResult<MemoryRecord>>;

  abstract transitionMemory(
    input: TransitionMemoryInput,
  ): Promise<RuntimeMutationResult<MemoryRecord>>;

  abstract listExperiences(
    principal: TrustedRuntimePrincipal,
    query: ExperienceListQuery,
  ): Promise<RuntimeCursorPage<ExperienceCandidate>>;

  abstract listExperiencesByContributor(
    principal: TrustedRuntimePrincipal,
    query: ExperienceListQuery,
  ): Promise<RuntimeCursorPage<ExperienceCandidate>>;

  abstract findExperience(
    principal: TrustedRuntimePrincipal,
    experienceId: string,
  ): Promise<ExperienceCandidate | null>;

  abstract createExperience(
    input: CreateExperienceInput,
  ): Promise<RuntimeMutationResult<ExperienceCandidate>>;

  abstract transitionExperience(
    input: TransitionExperienceInput,
  ): Promise<RuntimeMutationResult<ExperienceCandidate>>;
}
