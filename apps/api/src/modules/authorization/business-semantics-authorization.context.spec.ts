import type { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { loadBusinessSemanticAuthorizationIdentity } from './business-semantics-authorization.context.js';

const PRINCIPAL = {
  tenantId: '00000000-0000-7000-8000-000000000001',
  userId: '00000000-0000-7000-8000-000000000002',
  tenantRole: 'MEMBER' as const,
};

function transactionWith(
  employments: readonly unknown[],
  assignments: readonly unknown[],
): {
  readonly transaction: Prisma.TransactionClient;
  readonly employmentFindMany: ReturnType<typeof vi.fn>;
  readonly assignmentFindMany: ReturnType<typeof vi.fn>;
} {
  const employmentFindMany = vi.fn().mockResolvedValue(employments);
  const assignmentFindMany = vi.fn().mockResolvedValue(assignments);
  return {
    transaction: {
      employment: { findMany: employmentFindMany },
      roleAssignment: { findMany: assignmentFindMany },
    } as unknown as Prisma.TransactionClient,
    employmentFindMany,
    assignmentFindMany,
  };
}

function employment() {
  return {
    id: '00000000-0000-7000-8000-000000000003',
    tenantId: PRINCIPAL.tenantId,
    userId: PRINCIPAL.userId,
    organizationId: '00000000-0000-7000-8000-000000000004',
    orgUnitId: '00000000-0000-7000-8000-000000000005',
    status: 'ACTIVE',
    orgUnit: { status: 'ACTIVE' },
  };
}

function assignment(organizationScope: unknown, permissionScope: unknown) {
  return {
    id: '00000000-0000-7000-8000-000000000006',
    tenantId: PRINCIPAL.tenantId,
    userId: PRINCIPAL.userId,
    employmentId: employment().id,
    roleTemplateId: '00000000-0000-7000-8000-000000000007',
    status: 'ACTIVE',
    effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
    effectiveTo: new Date('2027-01-01T00:00:00.000Z'),
    organizationScope,
    permissionScope,
    roleVersion: { status: 'PUBLISHED' },
  };
}

describe('business semantic authorization identity loader', () => {
  it('loads only the principal identity and maps legacy scope fields', async () => {
    const storedAssignment = assignment(
      {
        orgUnitIds: [' 00000000-0000-7000-8000-000000000008 '],
        includeChildren: true,
      },
      {
        projectIds: ['project-alpha'],
        taskIds: ['task-alpha'],
        dataLabels: ['internal.strategy'],
        actions: ['business.objective.read'],
      },
    );
    const { transaction, employmentFindMany, assignmentFindMany } = transactionWith(
      [employment()],
      [storedAssignment],
    );

    await expect(
      loadBusinessSemanticAuthorizationIdentity(transaction, PRINCIPAL),
    ).resolves.toEqual({
      employments: [
        {
          id: employment().id,
          tenantId: PRINCIPAL.tenantId,
          userId: PRINCIPAL.userId,
          status: 'ACTIVE',
          orgUnitStatus: 'ACTIVE',
          organizationIds: [employment().organizationId],
          orgUnitIds: [employment().orgUnitId],
        },
      ],
      assignments: [
        {
          id: storedAssignment.id,
          tenantId: PRINCIPAL.tenantId,
          userId: PRINCIPAL.userId,
          employmentId: employment().id,
          roleBlueprintId: storedAssignment.roleTemplateId,
          roleVersionStatus: 'PUBLISHED',
          status: 'ACTIVE',
          effectiveFrom: storedAssignment.effectiveFrom,
          effectiveTo: storedAssignment.effectiveTo,
          organizationScope: {
            organizationIds: ['00000000-0000-7000-8000-000000000008'],
            includeDescendants: true,
          },
          projectIds: ['project-alpha'],
          taskIds: ['task-alpha'],
          permissionLabels: ['internal.strategy'],
          permissionActions: ['business.objective.read'],
        },
      ],
    });
    expect(employmentFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: PRINCIPAL.tenantId, userId: PRINCIPAL.userId },
      }),
    );
    expect(assignmentFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: PRINCIPAL.tenantId, userId: PRINCIPAL.userId },
      }),
    );
  });

  it('uses Employment scope only for the empty default assignment scope', async () => {
    const storedAssignment = assignment({}, { actions: ['business.task.read'] });
    const { transaction } = transactionWith([employment()], [storedAssignment]);

    const identity = await loadBusinessSemanticAuthorizationIdentity(transaction, PRINCIPAL);

    expect(identity.assignments[0]).not.toHaveProperty('organizationScope');
    expect(identity.assignments[0]?.permissionActions).toEqual(['business.task.read']);
  });

  it('turns malformed organization and permission scopes into deny-all scopes', async () => {
    const storedAssignment = assignment(
      { organizationIds: ['org-allowed', 7], includeDescendants: true },
      {
        projectIds: ['project-alpha', null],
        taskIds: 'task-alpha',
        dataLabels: [false],
        actions: ['business.*', 7],
      },
    );
    const { transaction } = transactionWith([employment()], [storedAssignment]);

    const identity = await loadBusinessSemanticAuthorizationIdentity(transaction, PRINCIPAL);

    expect(identity.assignments[0]).toMatchObject({
      organizationScope: {
        organizationIds: [],
        includeDescendants: false,
      },
      projectIds: [],
      taskIds: [],
      permissionLabels: [],
      permissionActions: [],
    });
  });
});
