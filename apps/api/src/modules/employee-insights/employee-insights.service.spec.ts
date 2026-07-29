import { ForbiddenException } from '@nestjs/common';
import type { ExperienceCandidate } from '@enterprise/contracts';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import { EmployeeInsightsRepository } from './employee-insights.repository.js';
import { EmployeeInsightsService } from './employee-insights.service.js';
import { MemoryExperienceAuthorizationPort } from '../memory-experience/memory-experience-authorization.port.js';
import { MemoryExperienceRepository } from '../memory-experience/memory-experience.repository.js';
import { RuntimeIdentityPort } from '../process-orchestration/application/runtime-identity.port.js';

const PRINCIPAL = {
  tenantId: '00000000-0000-7000-8000-000000000301',
  userId: '00000000-0000-7000-8000-000000000302',
  tenantRole: 'MEMBER' as const,
  authenticationSource: 'session' as const,
};
const ASSIGNMENT = '00000000-0000-7000-8000-000000000303';
const TASK = '00000000-0000-7000-8000-000000000304';
const EXPERIENCE = '00000000-0000-7000-8000-000000000305';
const EVIDENCE = '00000000-0000-7000-8000-000000000306';
const NOW = '2026-07-28T08:00:00.000Z';

describe('EmployeeInsightsService', () => {
  it('lists only the repository contributor page and removes raw candidate material', async () => {
    const harness = createHarness();
    harness.experiences.listExperiencesByContributor.mockResolvedValueOnce({
      items: [candidateFixture()],
      nextCursor: null,
    });

    const result = await harness.service.listExperiences({ limit: 25 });

    expect(harness.experiences.listExperiencesByContributor).toHaveBeenCalledWith(PRINCIPAL, {
      limit: 25,
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).not.toHaveProperty('candidateSummary');
    expect(result.items[0]).not.toHaveProperty('rawInputHash');
    expect(result.items[0]).not.toHaveProperty('contributorUserId');
    expect(result.items[0]?.sanitized).toBeNull();
  });

  it('derives contributor identity and raw hash after an exact Task grant', async () => {
    const harness = createHarness();
    grantTask(harness.authorization);
    harness.authorization.resolveExperienceActor.mockResolvedValueOnce(actorFixture());
    harness.experiences.createExperience.mockResolvedValueOnce({
      kind: 'APPLIED',
      value: candidateFixture(),
    });
    const request = {
      title: 'Repeatable customer handoff',
      sourceTaskId: TASK,
      sourceDeliverableIds: [],
      sourceEvidenceIds: [EVIDENCE],
      candidateSummary: 'Raw employee contribution for governed sanitization.',
      permissionLabels: [],
      sensitivity: 'INTERNAL' as const,
      idempotencyKey: 'employee-experience-0001',
    };

    await expect(harness.service.createExperience(request)).resolves.toMatchObject({
      id: EXPERIENCE,
      status: 'CANDIDATE',
    });
    expect(harness.experiences.createExperience).toHaveBeenCalledWith(
      expect.objectContaining({
        principal: PRINCIPAL,
        actor: expect.objectContaining({
          userId: PRINCIPAL.userId,
          roleAssignmentId: ASSIGNMENT,
        }),
        enforceContributorTaskScope: true,
        request: {
          ...request,
          rawInputHash: createHash('sha256').update(request.candidateSummary, 'utf8').digest('hex'),
        },
      }),
    );
  });

  it('rejects contribution when trusted grants do not include the exact Task', async () => {
    const harness = createHarness();
    harness.authorization.resolveMemoryAccess.mockResolvedValueOnce(accessFixture([]));
    await expect(
      harness.service.createExperience({
        title: 'Unauthorized candidate',
        sourceTaskId: TASK,
        sourceDeliverableIds: [],
        sourceEvidenceIds: [EVIDENCE],
        candidateSummary: 'This must not be persisted without the exact Task grant.',
        permissionLabels: [],
        sensitivity: 'INTERNAL',
        idempotencyKey: 'employee-experience-0002',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(harness.experiences.createExperience).not.toHaveBeenCalled();
  });

  it('returns self-only usage while keeping unreported usage separate from trusted totals', async () => {
    const harness = createHarness();
    harness.insights.aiUsage.mockResolvedValueOnce({
      runs: {
        total: 3,
        succeeded: 1,
        failed: 0,
        unknown: 1,
        cancelled: 0,
        inProgress: 1,
        tokenReported: 1,
        tokenUnreported: 1,
        costReported: 1,
        costUnreported: 1,
      },
      trustedUsage: {
        inputTokens: '20',
        outputTokens: '5',
        totalTokens: '25',
        costMicros: '800',
      },
      latency: { sampleCount: 2, averageMs: 250, p50Ms: 200, p95Ms: 300 },
      byAgent: [],
      byTask: [],
    });

    const result = await harness.service.aiUsage({
      from: '2026-07-01T00:00:00.000Z',
      to: NOW,
      groupLimit: 25,
    });

    expect(harness.insights.aiUsage).toHaveBeenCalledWith(
      PRINCIPAL,
      expect.objectContaining({
        from: new Date('2026-07-01T00:00:00.000Z'),
        to: new Date(NOW),
        groupLimit: 25,
      }),
    );
    expect(result.runs.tokenUnreported).toBe(1);
    expect(result.trustedUsage.totalTokens).toBe('25');
    expect(result.period.defaultedToCurrentMonth).toBe(false);
  });
});

function createHarness() {
  const insights = {
    experienceSources: vi.fn(),
    aiUsage: vi.fn(),
  };
  const experiences = {
    listMemories: vi.fn(),
    findMemory: vi.fn(),
    createMemory: vi.fn(),
    transitionMemory: vi.fn(),
    listExperiences: vi.fn(),
    listExperiencesByContributor: vi.fn(),
    findExperience: vi.fn(),
    createExperience: vi.fn(),
    transitionExperience: vi.fn(),
  };
  const authorization = {
    resolveMemoryAccess: vi.fn(),
    resolveExperienceActor: vi.fn(),
  };
  const service = new EmployeeInsightsService(
    insights as unknown as EmployeeInsightsRepository,
    experiences as unknown as MemoryExperienceRepository,
    authorization as unknown as MemoryExperienceAuthorizationPort,
    { current: () => PRINCIPAL } as RuntimeIdentityPort,
  );
  return { service, insights, experiences, authorization };
}

function grantTask(authorization: { resolveMemoryAccess: ReturnType<typeof vi.fn> }): void {
  authorization.resolveMemoryAccess.mockResolvedValueOnce(
    accessFixture([
      {
        id: 'task-grant',
        tenantId: PRINCIPAL.tenantId,
        userId: PRINCIPAL.userId,
        scope: 'TASK',
        roleAssignmentId: null,
        roleTemplateId: null,
        roleVersionId: null,
        taskId: TASK,
        conversationId: null,
        permissionLabels: [],
        assignment: null,
        effectiveFrom: '2026-01-01T00:00:00.000Z',
        effectiveTo: null,
      },
    ]),
  );
}

function accessFixture(grants: readonly unknown[]) {
  return {
    tenantId: PRINCIPAL.tenantId,
    userId: PRINCIPAL.userId,
    operation: 'READ',
    purpose: null,
    grants,
    now: new Date(NOW),
  };
}

function actorFixture() {
  return {
    tenantId: PRINCIPAL.tenantId,
    userId: PRINCIPAL.userId,
    roleAssignmentId: ASSIGNMENT,
    assignmentStatus: 'ACTIVE',
    employmentStatus: 'ACTIVE',
    permissions: [],
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    effectiveTo: null,
  };
}

function candidateFixture(): ExperienceCandidate {
  return {
    id: EXPERIENCE,
    tenantId: PRINCIPAL.tenantId,
    status: 'CANDIDATE',
    revision: 1,
    title: 'Repeatable customer handoff',
    contributorUserId: PRINCIPAL.userId,
    contributorRoleAssignmentId: ASSIGNMENT,
    sourceTaskId: TASK,
    sourceDeliverableIds: [],
    sourceEvidenceIds: [EVIDENCE],
    rawInputHash: 'a'.repeat(64),
    candidateSummary: 'Raw content that the employee endpoint must never return.',
    sanitization: null,
    structuredContent: null,
    structuredHash: null,
    review: null,
    validation: null,
    publication: null,
    permissionLabels: [],
    sensitivity: 'INTERNAL',
    monitoredUseCount: 0,
    monitoredAdoptionCount: 0,
    monitoredComplaintCount: 0,
    expiresAt: null,
    retiredAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}
