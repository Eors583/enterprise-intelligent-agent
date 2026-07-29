import { ForbiddenException, UnprocessableEntityException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { MemoryExperienceAuthorizationPort } from './memory-experience-authorization.port.js';
import { ExperienceKnowledgeProjectionPort } from './experience-knowledge-projection.port.js';
import { MemoryExperienceRepository } from './memory-experience.repository.js';
import { MemoryExperienceService } from './memory-experience.service.js';
import { RuntimeIdentityPort } from '../process-orchestration/application/runtime-identity.port.js';

const PRINCIPAL = {
  tenantId: '00000000-0000-7000-8000-000000000201',
  userId: '00000000-0000-7000-8000-000000000202',
  tenantRole: 'OWNER' as const,
  authenticationSource: 'session' as const,
};
const ASSIGNMENT = '00000000-0000-7000-8000-000000000203';
const ROLE = '00000000-0000-7000-8000-000000000204';
const ROLE_VERSION = '00000000-0000-7000-8000-000000000205';
const TASK = '00000000-0000-7000-8000-000000000206';
const EXPERIENCE = '00000000-0000-7000-8000-000000000207';
const EVIDENCE = '00000000-0000-7000-8000-000000000208';
const KNOWLEDGE_BASE = '00000000-0000-7000-8000-000000000209';
const DOCUMENT = '00000000-0000-7000-8000-000000000210';
const DOCUMENT_VERSION = '00000000-0000-7000-8000-000000000211';
const NOW = new Date('2026-07-28T06:00:00.000Z');

describe('MemoryExperienceService', () => {
  it('derives private Memory ownership and consent from the trusted principal', async () => {
    const repository = repositoryMock();
    const authorization = authorizationMock();
    const service = createService(repository, authorization);
    const request = {
      scope: 'EMPLOYEE_PRIVATE' as const,
      title: 'Personal working preference',
      summary: 'The employee explicitly confirmed this private preference.',
      contentHash: 'a'.repeat(64),
      sourceType: 'USER_CONFIRMED' as const,
      sourceId: EVIDENCE,
      sourceVersion: 1,
      sourceEvidenceIds: [EVIDENCE],
      roleTemplateId: ROLE,
      roleVersionId: ROLE_VERSION,
      roleAssignmentId: ASSIGNMENT,
      permissionLabels: [],
      sensitivity: 'CONFIDENTIAL' as const,
      retentionAction: 'SEAL' as const,
      consentPurpose: 'Personal assistant',
      idempotencyKey: 'private-memory-1',
    };
    authorization.resolveMemoryAccess.mockImplementationOnce(async (input) => ({
      tenantId: PRINCIPAL.tenantId,
      userId: PRINCIPAL.userId,
      operation: input.operation,
      purpose: input.purpose,
      now: input.now,
      grants: [
        {
          id: 'private-grant',
          tenantId: PRINCIPAL.tenantId,
          userId: PRINCIPAL.userId,
          scope: 'EMPLOYEE_PRIVATE',
          roleAssignmentId: ASSIGNMENT,
          roleTemplateId: ROLE,
          roleVersionId: ROLE_VERSION,
          taskId: null,
          conversationId: null,
          permissionLabels: [],
          assignment: activeAssignment(),
          effectiveFrom: '2026-01-01T00:00:00.000Z',
          effectiveTo: null,
        },
      ],
    }));
    repository.createMemory.mockResolvedValueOnce({
      kind: 'APPLIED',
      value: { id: 'memory-1' },
    });

    await expect(service.createMemory(request)).resolves.toEqual({ id: 'memory-1' });
    expect(repository.currentTime).toHaveBeenCalledWith(PRINCIPAL);
    expect(authorization.resolveMemoryAccess).toHaveBeenCalledWith(
      expect.objectContaining({ now: NOW }),
    );
    expect(repository.createMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        principal: PRINCIPAL,
        request,
        now: NOW,
        access: expect.objectContaining({
          userId: PRINCIPAL.userId,
          purpose: 'Personal assistant',
        }),
      }),
    );
  });

  it('rejects ambiguous Memory scope before persistence', async () => {
    const repository = repositoryMock();
    const service = createService(repository, authorizationMock());
    await expect(
      service.createMemory({
        scope: 'TASK',
        title: 'Ambiguous task memory',
        summary: 'This request incorrectly carries Role identity.',
        contentHash: 'a'.repeat(64),
        sourceType: 'TASK',
        sourceId: TASK,
        sourceVersion: 1,
        sourceEvidenceIds: [],
        roleTemplateId: ROLE,
        taskId: TASK,
        permissionLabels: [],
        sensitivity: 'INTERNAL',
        retentionAction: 'ARCHIVE',
        idempotencyKey: 'ambiguous-memory-1',
      }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(repository.createMemory).not.toHaveBeenCalled();
  });

  it('requires an admin role before querying Experience governance', async () => {
    const repository = repositoryMock();
    const service = new MemoryExperienceService(
      repository as unknown as MemoryExperienceRepository,
      authorizationMock() as unknown as MemoryExperienceAuthorizationPort,
      {
        current: () => ({ ...PRINCIPAL, tenantRole: 'MEMBER' as const }),
      } as RuntimeIdentityPort,
      projectionMock() as unknown as ExperienceKnowledgeProjectionPort,
    );
    await expect(service.listExperiences({ limit: 50 })).rejects.toBeInstanceOf(ForbiddenException);
    expect(repository.listExperiences).not.toHaveBeenCalled();
  });

  it('binds an Experience review transition to an independent trusted actor', async () => {
    const repository = repositoryMock();
    const authorization = authorizationMock();
    const service = createService(repository, authorization);
    repository.findExperience.mockResolvedValueOnce({
      id: EXPERIENCE,
      tenantId: PRINCIPAL.tenantId,
      status: 'STRUCTURED',
      revision: 3,
      contributorUserId: '00000000-0000-7000-8000-000000000299',
      contributorRoleAssignmentId: '00000000-0000-7000-8000-000000000298',
      sourceTaskId: TASK,
    });
    authorization.resolveExperienceActor.mockResolvedValueOnce({
      tenantId: PRINCIPAL.tenantId,
      userId: PRINCIPAL.userId,
      roleAssignmentId: ASSIGNMENT,
      assignmentStatus: 'ACTIVE',
      employmentStatus: 'ACTIVE',
      permissions: ['EXPERIENCE_REVIEW'],
      effectiveFrom: '2026-01-01T00:00:00.000Z',
      effectiveTo: null,
    });
    repository.transitionExperience.mockResolvedValueOnce({
      kind: 'APPLIED',
      value: { id: EXPERIENCE, status: 'APPROVED' },
    });
    const request = {
      expectedRevision: 3,
      action: 'APPROVE' as const,
      reason: 'The evidence supports publishing this reusable practice.',
      payload: { evidenceIds: [EVIDENCE] },
      idempotencyKey: 'experience-approve-1',
    };
    await expect(service.transitionExperienceCandidate(EXPERIENCE, request)).resolves.toMatchObject(
      { status: 'APPROVED' },
    );
    expect(repository.transitionExperience).toHaveBeenCalledWith(
      expect.objectContaining({
        experienceId: EXPERIENCE,
        nextStatus: 'APPROVED',
        actor: expect.objectContaining({
          userId: PRINCIPAL.userId,
          roleAssignmentId: ASSIGNMENT,
        }),
        request,
      }),
    );
  });

  it('prepares a validated Experience as a governed Knowledge projection', async () => {
    const repository = repositoryMock();
    const authorization = authorizationMock();
    const projections = projectionMock();
    const service = createService(repository, authorization, projections);
    const candidate = {
      id: EXPERIENCE,
      tenantId: PRINCIPAL.tenantId,
      status: 'VALIDATED',
      revision: 5,
      contributorUserId: '00000000-0000-7000-8000-000000000299',
      contributorRoleAssignmentId: '00000000-0000-7000-8000-000000000298',
      sourceTaskId: TASK,
    };
    repository.findExperience.mockResolvedValueOnce(candidate);
    authorization.resolveExperienceActor.mockResolvedValueOnce({
      tenantId: PRINCIPAL.tenantId,
      userId: PRINCIPAL.userId,
      roleAssignmentId: ASSIGNMENT,
      assignmentStatus: 'ACTIVE',
      employmentStatus: 'ACTIVE',
      permissions: ['EXPERIENCE_PUBLISH'],
      effectiveFrom: '2026-01-01T00:00:00.000Z',
      effectiveTo: null,
    });
    projections.prepare.mockResolvedValueOnce({ id: 'projection-1', status: 'PROCESSING' });
    const request = {
      expectedRevision: 5,
      knowledgeBaseId: KNOWLEDGE_BASE,
      targetRoleTemplateIds: [ROLE],
      targetOrgUnitIds: [],
      idempotencyKey: 'experience-projection-1',
    };

    await expect(
      service.prepareExperienceKnowledgeProjection(EXPERIENCE, request),
    ).resolves.toMatchObject({ status: 'PROCESSING' });
    expect(projections.prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        principal: PRINCIPAL,
        candidate,
        request,
        actor: expect.objectContaining({ roleAssignmentId: ASSIGNMENT }),
      }),
    );
  });

  it('rejects a forged Experience publication that is not its exact ready projection', async () => {
    const repository = repositoryMock();
    const authorization = authorizationMock();
    const projections = projectionMock();
    const service = createService(repository, authorization, projections);
    repository.findExperience.mockResolvedValueOnce({
      id: EXPERIENCE,
      tenantId: PRINCIPAL.tenantId,
      status: 'VALIDATED',
      revision: 5,
      contributorUserId: '00000000-0000-7000-8000-000000000299',
      contributorRoleAssignmentId: '00000000-0000-7000-8000-000000000298',
      sourceTaskId: TASK,
    });
    authorization.resolveExperienceActor.mockResolvedValueOnce({
      tenantId: PRINCIPAL.tenantId,
      userId: PRINCIPAL.userId,
      roleAssignmentId: ASSIGNMENT,
      assignmentStatus: 'ACTIVE',
      employmentStatus: 'ACTIVE',
      permissions: ['EXPERIENCE_PUBLISH'],
      effectiveFrom: '2026-01-01T00:00:00.000Z',
      effectiveTo: null,
    });
    projections.find.mockResolvedValueOnce({
      knowledgeBaseId: KNOWLEDGE_BASE,
      documentId: DOCUMENT,
      documentVersionId: DOCUMENT_VERSION,
      documentVersion: 1,
      targetRoleTemplateIds: [ROLE],
      targetOrgUnitIds: [],
      publicationHash: 'b'.repeat(64),
      status: 'READY',
    });
    const request = {
      expectedRevision: 5,
      action: 'PUBLISH' as const,
      reason: 'Publish the independently validated reusable practice.',
      payload: {
        knowledgeBaseId: KNOWLEDGE_BASE,
        documentId: DOCUMENT,
        documentVersionId: DOCUMENT_VERSION,
        documentVersion: 1,
        targetRoleTemplateIds: [ROLE],
        targetOrgUnitIds: [],
        publicationHash: 'b'.repeat(64),
      },
      idempotencyKey: 'experience-publish-forged-1',
    };

    await expect(service.transitionExperienceCandidate(EXPERIENCE, request)).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
    expect(repository.transitionExperience).not.toHaveBeenCalled();
  });
});

function createService(
  repository: ReturnType<typeof repositoryMock>,
  authorization: ReturnType<typeof authorizationMock>,
  projections: ReturnType<typeof projectionMock> = projectionMock(),
) {
  return new MemoryExperienceService(
    repository as unknown as MemoryExperienceRepository,
    authorization as unknown as MemoryExperienceAuthorizationPort,
    { current: () => PRINCIPAL } as RuntimeIdentityPort,
    projections as unknown as ExperienceKnowledgeProjectionPort,
  );
}

function repositoryMock() {
  return {
    currentTime: vi.fn().mockResolvedValue(NOW),
    listMemories: vi.fn(),
    findMemory: vi.fn(),
    createMemory: vi.fn(),
    transitionMemory: vi.fn(),
    listExperiences: vi.fn(),
    findExperience: vi.fn(),
    createExperience: vi.fn(),
    transitionExperience: vi.fn(),
  };
}

function authorizationMock() {
  return {
    resolveMemoryAccess: vi.fn(),
    resolveExperienceActor: vi.fn(),
  };
}

function projectionMock() {
  return {
    prepare: vi.fn(),
    find: vi.fn(),
  };
}

function activeAssignment() {
  return {
    id: ASSIGNMENT,
    tenantId: PRINCIPAL.tenantId,
    userId: PRINCIPAL.userId,
    roleTemplateId: ROLE,
    roleVersionId: ROLE_VERSION,
    status: 'ACTIVE' as const,
    employmentStatus: 'ACTIVE' as const,
    orgUnitStatus: 'ACTIVE' as const,
    roleVersionStatus: 'PUBLISHED' as const,
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    effectiveTo: null,
  };
}
