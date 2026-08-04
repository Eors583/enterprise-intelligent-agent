import { createHash } from 'node:crypto';

import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  experienceMonitorPayloadSchema,
  experiencePublishPayloadSchema,
  experienceRetirePayloadSchema,
  experienceReviewPayloadSchema,
  experienceSanitizePayloadSchema,
  experienceStructurePayloadSchema,
  experienceValidatePayloadSchema,
  type CreateExperienceCandidateRequest,
  type CreateMemoryCandidateRequest,
  type ExperienceCandidate,
  type ExperienceKnowledgeProjection,
  type ExperienceListQuery,
  type ExperienceListResponse,
  type ExperienceTransitionRequest,
  type MemoryListQuery,
  type MemoryListResponse,
  type MemoryRecord,
  type MemoryTransitionRequest,
  type PrepareExperienceKnowledgeProjectionRequest,
} from '@enterprise/contracts';

import {
  InvalidExperienceTransitionError,
  transitionExperience,
  type ExperienceAction,
  type ExperienceTransitionProof,
  type TrustedExperienceActor,
} from './domain/experience-state-machine.js';
import { ExperienceKnowledgeProjectionPort } from './experience-knowledge-projection.port.js';
import { decideMemoryAccess, type MemoryAccessResource } from './domain/memory-access.policy.js';
import { InvalidMemoryTransitionError, transitionMemory } from './domain/memory-state-machine.js';
import { MemoryExperienceAuthorizationPort } from './memory-experience-authorization.port.js';
import { MemoryExperienceRepository } from './memory-experience.repository.js';
import { unwrapRuntimeMutation } from '../process-orchestration/application/runtime-http-errors.js';
import { RuntimeIdentityPort } from '../process-orchestration/application/runtime-identity.port.js';

@Injectable()
export class MemoryExperienceService {
  constructor(
    @Inject(MemoryExperienceRepository)
    private readonly repository: MemoryExperienceRepository,
    @Inject(MemoryExperienceAuthorizationPort)
    private readonly authorization: MemoryExperienceAuthorizationPort,
    @Inject(RuntimeIdentityPort)
    private readonly identity: RuntimeIdentityPort,
    @Inject(ExperienceKnowledgeProjectionPort)
    private readonly knowledgeProjection: ExperienceKnowledgeProjectionPort,
  ) {}

  async listMemories(query: MemoryListQuery): Promise<MemoryListResponse> {
    const principal = this.identity.current();
    const now = await this.repository.currentTime(principal);
    const access = await this.authorization.resolveMemoryAccess({
      principal,
      operation: 'READ',
      purpose: query.purpose ?? null,
      now,
    });
    const page = await this.repository.listMemories(principal, query);
    const items = page.items.filter((memory) => decideMemoryAccess(access, memory).allowed);
    return { items, nextCursor: page.nextCursor };
  }

  async getMemory(memoryId: string, purpose?: string): Promise<MemoryRecord> {
    const principal = this.identity.current();
    const memory = await this.repository.findMemory(principal, memoryId, purpose ?? null, 'READ');
    if (memory === null) throw new NotFoundException('Memory was not found.');
    const now = await this.repository.currentTime(principal);
    const access = await this.authorization.resolveMemoryAccess({
      principal,
      operation: 'READ',
      purpose: purpose ?? null,
      now,
    });
    this.requireMemoryAccess(access, memory);
    return memory;
  }

  async createMemory(request: CreateMemoryCandidateRequest): Promise<MemoryRecord> {
    const principal = this.identity.current();
    const now = await this.repository.currentTime(principal);
    const resource = memoryCandidateResource(principal.tenantId, principal.userId, request, now);
    const access = await this.authorization.resolveMemoryAccess({
      principal,
      operation: 'CREATE',
      purpose: request.consentPurpose ?? null,
      now,
    });
    this.requireMemoryAccess(access, resource);
    return unwrapRuntimeMutation(
      await this.repository.createMemory({ principal, access, request, now }),
      'Memory',
    );
  }

  async transitionMemoryRecord(
    memoryId: string,
    request: MemoryTransitionRequest,
  ): Promise<MemoryRecord> {
    const principal = this.identity.current();
    const memory = await this.repository.findMemory(principal, memoryId, null, 'TRANSITION');
    if (memory === null) throw new NotFoundException('Memory was not found.');
    const now = await this.repository.currentTime(principal);
    const access = await this.authorization.resolveMemoryAccess({
      principal,
      operation: 'TRANSITION',
      purpose: memory.consent.purpose,
      now,
    });
    this.requireMemoryAccess(access, memory);
    if (memory.revision !== request.expectedRevision) {
      throw new UnprocessableEntityException('Memory revision is stale.');
    }
    try {
      const nextStatus = transitionMemory(memory.status, request.action);
      return unwrapRuntimeMutation(
        await this.repository.transitionMemory({
          principal,
          access,
          memoryId,
          nextStatus,
          request,
          now,
        }),
        'Memory',
      );
    } catch (error) {
      if (error instanceof InvalidMemoryTransitionError) {
        throw new UnprocessableEntityException(error.message);
      }
      throw error;
    }
  }

  async listExperiences(query: ExperienceListQuery): Promise<ExperienceListResponse> {
    const principal = this.experienceAdministrator();
    const page = await this.repository.listExperiences(principal, query);
    return { items: page.items, nextCursor: page.nextCursor };
  }

  async getExperience(experienceId: string): Promise<ExperienceCandidate> {
    const principal = this.experienceAdministrator();
    const candidate = await this.repository.findExperience(principal, experienceId);
    if (candidate === null) throw new NotFoundException('Experience Candidate was not found.');
    return candidate;
  }

  async createExperience(request: CreateExperienceCandidateRequest): Promise<ExperienceCandidate> {
    const principal = this.experienceAdministrator();
    const now = await this.repository.currentTime(principal);
    const actor = await this.authorization.resolveExperienceActor({
      principal,
      taskId: request.sourceTaskId,
      action: 'CONTRIBUTE',
      now,
    });
    const governedRequest = {
      ...request,
      rawInputHash: experienceInputHash(request),
    };
    return unwrapRuntimeMutation(
      await this.repository.createExperience({
        principal,
        actor,
        request: governedRequest,
        enforceContributorTaskScope: false,
        now,
      }),
      'Experience Candidate',
    );
  }

  async prepareExperienceKnowledgeProjection(
    experienceId: string,
    request: PrepareExperienceKnowledgeProjectionRequest,
  ): Promise<ExperienceKnowledgeProjection> {
    const principal = this.experienceAdministrator();
    const candidate = await this.repository.findExperience(principal, experienceId);
    if (candidate === null) throw new NotFoundException('Experience Candidate was not found.');
    if (candidate.revision !== request.expectedRevision) {
      throw new UnprocessableEntityException('Experience Candidate revision is stale.');
    }
    const now = await this.repository.currentTime(principal);
    const actor = await this.authorization.resolveExperienceActor({
      principal,
      taskId: candidate.sourceTaskId,
      action: 'PUBLISH',
      now,
    });
    return this.knowledgeProjection.prepare({ principal, actor, candidate, request, now });
  }

  async getExperienceKnowledgeProjection(
    experienceId: string,
  ): Promise<ExperienceKnowledgeProjection> {
    const principal = this.experienceAdministrator();
    const projection = await this.knowledgeProjection.find(principal, experienceId);
    if (projection === null) throw new NotFoundException('Experience projection was not found.');
    return projection;
  }

  async transitionExperienceCandidate(
    experienceId: string,
    request: ExperienceTransitionRequest,
  ): Promise<ExperienceCandidate> {
    const principal = this.experienceAdministrator();
    const candidate = await this.repository.findExperience(principal, experienceId);
    if (candidate === null) throw new NotFoundException('Experience Candidate was not found.');
    if (candidate.revision !== request.expectedRevision) {
      throw new UnprocessableEntityException('Experience Candidate revision is stale.');
    }
    const now = await this.repository.currentTime(principal);
    const actor = await this.authorization.resolveExperienceActor({
      principal,
      taskId: candidate.sourceTaskId,
      action: request.action,
      now,
    });
    try {
      const proof = experienceProof(request, actor);
      const nextStatus = transitionExperience(candidate.status, request.action, {
        tenantId: principal.tenantId,
        contributorUserId: candidate.contributorUserId,
        contributorRoleAssignmentId: candidate.contributorRoleAssignmentId,
        actor,
        proof,
        now,
      });
      if (request.action === 'PUBLISH') {
        const payload = experiencePublishPayloadSchema.parse(request.payload);
        const projection = await this.knowledgeProjection.find(principal, experienceId);
        if (
          projection === null ||
          projection.status !== 'PUBLISHED' ||
          projection.knowledgeBaseId !== payload.knowledgeBaseId ||
          projection.documentId !== payload.documentId ||
          projection.documentVersionId !== payload.documentVersionId ||
          projection.documentVersion !== payload.documentVersion ||
          projection.publicationHash !== payload.publicationHash ||
          !sameIds(projection.targetRoleTemplateIds, payload.targetRoleTemplateIds) ||
          !sameIds(projection.targetOrgUnitIds, payload.targetOrgUnitIds)
        ) {
          throw new UnprocessableEntityException(
            'Experience publication must reference its exact prepared, evaluated and published Knowledge projection.',
          );
        }
      }
      return unwrapRuntimeMutation(
        await this.repository.transitionExperience({
          principal,
          actor,
          experienceId,
          nextStatus,
          request,
          now,
        }),
        'Experience Candidate',
      );
    } catch (error) {
      if (error instanceof InvalidExperienceTransitionError) {
        throw new UnprocessableEntityException(error.message);
      }
      throw error;
    }
  }

  private requireMemoryAccess(
    access: Awaited<ReturnType<MemoryExperienceAuthorizationPort['resolveMemoryAccess']>>,
    resource: MemoryAccessResource,
  ): void {
    const decision = decideMemoryAccess(access, resource);
    if (!decision.allowed) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        message: 'The current trusted identity cannot access this memory scope.',
        reasonCode: decision.reason,
      });
    }
  }

  private experienceAdministrator() {
    const principal = this.identity.current();
    if (
      principal.tenantRole !== 'OWNER' &&
      principal.tenantRole !== 'ADMIN' &&
      principal.tenantRole !== 'KNOWLEDGE_ADMIN'
    ) {
      throw new ForbiddenException(
        'Experience governance requires an owner, administrator, or knowledge administrator.',
      );
    }
    return principal;
  }
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const expected = new Set(left);
  return right.every((value) => expected.has(value));
}

function memoryCandidateResource(
  tenantId: string,
  userId: string,
  request: CreateMemoryCandidateRequest,
  now: Date,
): MemoryAccessResource {
  const privateMemory = request.scope === 'EMPLOYEE_PRIVATE';
  const exact =
    (request.scope === 'ENTERPRISE' &&
      request.roleTemplateId === undefined &&
      request.roleVersionId === undefined &&
      request.roleAssignmentId === undefined &&
      request.taskId === undefined &&
      request.conversationId === undefined &&
      request.consentPurpose === undefined) ||
    (request.scope === 'ROLE' &&
      request.roleTemplateId !== undefined &&
      request.roleVersionId !== undefined &&
      request.roleAssignmentId === undefined &&
      request.taskId === undefined &&
      request.conversationId === undefined &&
      request.consentPurpose === undefined) ||
    (privateMemory &&
      request.roleTemplateId !== undefined &&
      request.roleVersionId !== undefined &&
      request.roleAssignmentId !== undefined &&
      request.taskId === undefined &&
      request.conversationId === undefined &&
      request.consentPurpose !== undefined) ||
    (request.scope === 'TASK' &&
      request.roleTemplateId === undefined &&
      request.roleVersionId === undefined &&
      request.roleAssignmentId === undefined &&
      request.taskId !== undefined &&
      request.conversationId === undefined &&
      request.consentPurpose === undefined) ||
    (request.scope === 'CONVERSATION' &&
      request.roleTemplateId === undefined &&
      request.roleVersionId === undefined &&
      request.roleAssignmentId === undefined &&
      request.taskId === undefined &&
      request.conversationId !== undefined &&
      request.consentPurpose === undefined &&
      request.expiresAt !== undefined);
  if (!exact) {
    throw new UnprocessableEntityException('Memory scope identity must be exact and unambiguous.');
  }
  return {
    tenantId,
    scope: request.scope,
    status: 'CANDIDATE',
    ownerUserId: privateMemory ? userId : null,
    roleTemplateId: request.roleTemplateId ?? null,
    roleVersionId: request.roleVersionId ?? null,
    roleAssignmentId: request.roleAssignmentId ?? null,
    taskId: request.taskId ?? null,
    conversationId: request.conversationId ?? null,
    permissionLabels: request.permissionLabels,
    consent: {
      required: privateMemory,
      grantedByUserId: privateMemory ? userId : null,
      grantedAt: privateMemory ? now.toISOString() : null,
      purpose: request.consentPurpose ?? null,
    },
    effectiveFrom: now.toISOString(),
    effectiveTo: null,
    expiresAt: request.expiresAt ?? null,
  };
}

export function experienceInputHash(request: CreateExperienceCandidateRequest): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        schema: 'experience-candidate-input.v1',
        title: request.title,
        sourceTaskId: request.sourceTaskId,
        sourceDeliverableIds: [...request.sourceDeliverableIds].sort(),
        sourceEvidenceIds: [...request.sourceEvidenceIds].sort(),
        candidateSummary: request.candidateSummary,
        permissionLabels: [...request.permissionLabels].sort(),
        sensitivity: request.sensitivity,
      }),
      'utf8',
    )
    .digest('hex');
}

function experienceProof(
  request: ExperienceTransitionRequest,
  actor: TrustedExperienceActor,
): ExperienceTransitionProof {
  switch (request.action) {
    case 'SANITIZE': {
      const payload = experienceSanitizePayloadSchema.parse(request.payload);
      return { action: 'SANITIZE', ...payload };
    }
    case 'STRUCTURE': {
      const payload = experienceStructurePayloadSchema.parse(request.payload);
      return {
        action: 'STRUCTURE',
        structuredHash: payload.structuredHash,
        scenarioPresent: payload.structuredContent.scenario.length > 0,
        problemPresent: payload.structuredContent.problem.length > 0,
        stepsPresent: payload.structuredContent.steps.length > 0,
        outcomesPresent: payload.structuredContent.outcomes.length > 0,
        applicabilityBoundariesPresent:
          payload.structuredContent.applicabilityBoundaries.length > 0,
      };
    }
    case 'APPROVE':
    case 'REJECT': {
      const payload = experienceReviewPayloadSchema.parse(request.payload);
      return {
        action: request.action,
        reviewerUserId: actor.userId,
        reviewerRoleAssignmentId: actor.roleAssignmentId,
        evidenceIds: payload.evidenceIds,
      };
    }
    case 'VALIDATE': {
      const payload = experienceValidatePayloadSchema.parse(request.payload);
      return { action: 'VALIDATE', ...payload };
    }
    case 'PUBLISH': {
      const payload = experiencePublishPayloadSchema.parse(request.payload);
      return { action: 'PUBLISH', ...payload };
    }
    case 'MONITOR': {
      const payload = experienceMonitorPayloadSchema.parse(request.payload);
      return { action: 'MONITOR', ...payload };
    }
    case 'RETIRE': {
      const payload = experienceRetirePayloadSchema.parse(request.payload);
      return { action: 'RETIRE', ...payload };
    }
  }
}
