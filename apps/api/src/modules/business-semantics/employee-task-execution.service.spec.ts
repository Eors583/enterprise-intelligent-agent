import type { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import type { TenantContext } from '../../common/context/tenant-context.js';
import type { PrismaService } from '../../database/prisma.service.js';
import type { BusinessSemanticsPolicyService } from './business-semantics-policy.service.js';
import { EmployeeTaskExecutionService } from './employee-task-execution.service.js';

const tenantId = '00000000-0000-7000-8000-000000000001';
const userId = '00000000-0000-7000-8000-000000000002';
const assignmentId = '00000000-0000-7000-8000-000000000003';
const taskId = '00000000-0000-7000-8000-000000000004';

describe('EmployeeTaskExecutionService fail-closed boundaries', () => {
  it('does not advance a Task owned by the formal process runtime', async () => {
    const transaction = authorizationTransaction(
      taskRecord({ processInstanceId: '00000000-0000-7000-8000-000000000099' }),
    );
    const prisma = prismaMock(transaction);
    const policy = policyMock();
    const service = createService(prisma, policy);

    await expect(
      service.transitionTask(taskId, {
        expectedRevision: 1,
        action: 'START',
        roleAssignmentId: assignmentId,
        reason: 'Start outside the process engine must be rejected.',
        effectiveAt: '2026-07-28T08:00:00.000Z',
      }),
    ).rejects.toMatchObject({ status: 409 });

    expect(policy.requireEmployeeWrite).toHaveBeenCalledOnce();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects stale task revision after the executor context is established and writes nothing', async () => {
    const authorized = authorizationTransaction(taskRecord({ revision: 2 }));
    const executor = {
      $executeRawUnsafe: vi.fn().mockResolvedValue(0),
      $executeRaw: vi.fn().mockResolvedValue(0),
      $queryRaw: vi.fn().mockResolvedValue([]),
      task: {
        findFirst: vi.fn().mockResolvedValue(taskRecord({ revision: 2 })),
        updateMany: vi.fn(),
      },
    };
    const prisma = prismaMock(authorized, executor);
    const service = createService(prisma, policyMock());

    await expect(
      service.transitionTask(taskId, {
        expectedRevision: 1,
        action: 'START',
        roleAssignmentId: assignmentId,
        reason: 'This request carries a stale revision.',
        effectiveAt: '2026-07-28T08:00:00.000Z',
      }),
    ).rejects.toMatchObject({ status: 409 });

    expect(executor.task.updateMany).not.toHaveBeenCalled();
  });

  it('does not submit a Deliverable while its Task is outside IN_PROGRESS', async () => {
    const evidenceId = '00000000-0000-7000-8000-000000000007';
    const transaction = {
      ...authorizationTransaction(taskRecord({ status: 'READY' })),
      deliverable: {
        findFirst: vi.fn().mockResolvedValue({
          id: '00000000-0000-7000-8000-000000000006',
          tenantId,
          taskId,
          ownerUserId: null,
          ownerRoleAssignmentId: assignmentId,
          ownerRoleTemplateId: null,
          ownerOrgUnitId: null,
          permissionLabels: ['classification:internal'],
        }),
      },
      evidenceLink: {
        findMany: vi.fn().mockResolvedValue([{ evidenceId }]),
      },
    };
    const prisma = prismaMock(transaction);
    const service = createService(prisma, policyMock());

    await expect(
      service.submitDeliverable(taskId, '00000000-0000-7000-8000-000000000006', {
        expectedRevision: 1,
        roleAssignmentId: assignmentId,
        submittedAt: '2026-07-28T08:00:00.000Z',
        artifactUri: 'https://artifacts.example.test/result',
        contentHash: 'a'.repeat(64),
        evidenceIds: [evidenceId],
      }),
    ).rejects.toMatchObject({ status: 409 });

    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('applies the same task-state boundary to the simplified business submission command', async () => {
    const evidenceId = '00000000-0000-7000-8000-000000000007';
    const deliverableId = '00000000-0000-7000-8000-000000000006';
    const transaction = {
      ...authorizationTransaction(taskRecord({ status: 'READY' })),
      deliverable: {
        findFirst: vi.fn().mockResolvedValue({
          id: deliverableId,
          tenantId,
          taskId,
          ownerUserId: null,
          ownerRoleAssignmentId: assignmentId,
          ownerRoleTemplateId: null,
          ownerOrgUnitId: null,
          permissionLabels: [],
        }),
      },
      evidenceLink: {
        findMany: vi.fn().mockResolvedValue([{ evidenceId }]),
      },
    };
    const prisma = prismaMock(transaction);
    const service = createService(prisma, policyMock());

    await expect(
      service.submitDeliverableCommand(taskId, deliverableId, {
        roleAssignmentId: assignmentId,
        businessDescription: '交付资料已整理完成。',
        sourceType: 'DOCUMENT',
        sourceUri: 'https://documents.example.test/result',
        evidenceIds: [evidenceId],
      }),
    ).rejects.toMatchObject({ status: 409 });

    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects a simplified submission when the deliverable does not resolve inside the task', async () => {
    const evidenceId = '00000000-0000-7000-8000-000000000007';
    const deliverableId = '00000000-0000-7000-8000-000000000006';
    const transaction = {
      ...authorizationTransaction(taskRecord({ status: 'IN_PROGRESS' })),
      deliverable: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
      evidenceLink: {
        findMany: vi.fn(),
      },
    };
    const prisma = prismaMock(transaction);
    const service = createService(prisma, policyMock());

    await expect(
      service.submitDeliverableCommand(taskId, deliverableId, {
        roleAssignmentId: assignmentId,
        businessDescription: '尝试引用其他任务的交付物。',
        sourceType: 'HUMAN_ATTESTATION',
        sourceUri: null,
        evidenceIds: [evidenceId],
      }),
    ).rejects.toMatchObject({ status: 404 });

    expect(transaction.deliverable.findFirst).toHaveBeenCalledWith({
      where: { tenantId, id: deliverableId, taskId },
    });
    expect(transaction.evidenceLink.findMany).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

function createService(
  prisma: ReturnType<typeof prismaMock>,
  policy: ReturnType<typeof policyMock>,
): EmployeeTaskExecutionService {
  const context = {
    current: { tenantId, userId, role: 'MEMBER' },
  } as unknown as TenantContext;
  return new EmployeeTaskExecutionService(
    prisma as unknown as PrismaService,
    context,
    policy as unknown as BusinessSemanticsPolicyService,
  );
}

function prismaMock(
  authorization: Record<string, unknown>,
  executor: Record<string, unknown> = {},
) {
  return {
    enabled: true,
    withTenant: vi.fn(
      (_tenantId: string, operation: (transaction: Prisma.TransactionClient) => Promise<unknown>) =>
        operation(authorization as unknown as Prisma.TransactionClient),
    ),
    $transaction: vi.fn((operation: (transaction: Prisma.TransactionClient) => Promise<unknown>) =>
      operation(executor as unknown as Prisma.TransactionClient),
    ),
  };
}

function policyMock() {
  return {
    requireEmployeeWrite: vi.fn().mockResolvedValue({
      decisionId: 'decision-test',
      roleAssignmentId: assignmentId,
    }),
  };
}

function authorizationTransaction(task: ReturnType<typeof taskRecord>) {
  return {
    task: {
      findFirst: vi.fn().mockResolvedValue(task),
    },
    objectiveRoleAssignment: {
      findMany: vi.fn().mockResolvedValue([{ roleAssignmentId: assignmentId }]),
    },
  };
}

function taskRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: taskId,
    tenantId,
    objectiveId: '00000000-0000-7000-8000-000000000010',
    objectiveVersion: 1,
    ownerUserId: null,
    ownerRoleAssignmentId: assignmentId,
    ownerRoleTemplateId: null,
    ownerOrgUnitId: null,
    permissionLabels: ['classification:internal'],
    processInstanceId: null,
    status: 'READY',
    revision: 1,
    ...overrides,
  };
}
