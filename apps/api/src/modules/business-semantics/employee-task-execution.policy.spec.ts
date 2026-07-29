import type { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { BusinessSemanticsPolicyService } from './business-semantics-policy.service.js';

const tenantId = '00000000-0000-7000-8000-000000000001';
const userId = '00000000-0000-7000-8000-000000000002';
const employmentId = '00000000-0000-7000-8000-000000000003';
const claimedAssignmentId = '00000000-0000-7000-8000-000000000004';
const relatedAssignmentId = '00000000-0000-7000-8000-000000000005';
const taskId = '00000000-0000-7000-8000-000000000006';
const permissionLabel = 'classification:internal';

describe('employee task execution policy', () => {
  it('does not combine a claimed assignment grant with another assignment relation', async () => {
    const policy = new BusinessSemanticsPolicyService();
    const transaction = transactionWithAssignments([
      assignment(claimedAssignmentId),
      assignment(relatedAssignmentId),
    ]);
    const input = {
      roleAssignmentId: claimedAssignmentId,
      resource: {
        id: taskId,
        tenantId,
        type: 'TASK' as const,
        owner: { type: 'ROLE_ASSIGNMENT' as const, id: relatedAssignmentId },
        responsibleRoleAssignmentIds: [relatedAssignmentId],
        taskId,
        permissionLabels: [permissionLabel],
      },
      mutation: { proposedTaskId: taskId },
    };

    await expect(
      policy.requireEmployeeWrite(
        transaction,
        { tenantId, userId, role: 'MEMBER', authenticationSource: 'session' },
        'business.task.execute',
        input,
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        reasonCode: 'RESOURCE_RELATION_DENIED',
      }),
    });

    await expect(
      policy.requireEmployeeWrite(
        transaction,
        { tenantId, userId, role: 'MEMBER', authenticationSource: 'session' },
        'business.task.execute',
        { ...input, roleAssignmentId: relatedAssignmentId },
      ),
    ).resolves.toMatchObject({
      roleAssignmentId: relatedAssignmentId,
    });
  });

  it('rejects an inactive or request-forged Role Assignment before policy evaluation', async () => {
    const policy = new BusinessSemanticsPolicyService();
    const transaction = transactionWithAssignments([assignment(claimedAssignmentId)]);

    await expect(
      policy.requireEmployeeWrite(
        transaction,
        { tenantId, userId, role: 'MEMBER', authenticationSource: 'session' },
        'business.evidence.contribute',
        {
          roleAssignmentId: relatedAssignmentId,
          resource: {
            id: taskId,
            tenantId,
            type: 'EVIDENCE',
            owner: { type: 'ROLE_ASSIGNMENT', id: claimedAssignmentId },
            taskId,
            permissionLabels: [permissionLabel],
          },
          mutation: {
            proposedTaskId: taskId,
            proposedPermissionLabels: [permissionLabel],
          },
        },
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        reasonCode: 'ASSIGNMENT_NOT_ACTIVE',
      }),
    });
  });
});

function transactionWithAssignments(
  assignments: ReturnType<typeof assignment>[],
): Prisma.TransactionClient {
  return {
    employment: {
      findMany: () =>
        Promise.resolve([
          {
            id: employmentId,
            tenantId,
            userId,
            organizationId: 'org-root',
            orgUnitId: 'org-unit-root',
            status: 'ACTIVE',
            orgUnit: { status: 'ACTIVE' },
          },
        ]),
    },
    roleAssignment: {
      findMany: () => Promise.resolve(assignments),
    },
  } as unknown as Prisma.TransactionClient;
}

function assignment(id: string) {
  return {
    id,
    tenantId,
    userId,
    employmentId,
    roleTemplateId: `role-${id}`,
    status: 'ACTIVE',
    effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
    effectiveTo: new Date('2027-01-01T00:00:00.000Z'),
    organizationScope: {},
    permissionScope: {
      taskIds: [taskId],
      dataLabels: [permissionLabel],
      actions: [
        'business.task.execute',
        'business.evidence.contribute',
        'business.deliverable.submit',
        'business.acceptance.request',
      ],
    },
    roleVersion: { status: 'PUBLISHED' },
  };
}
