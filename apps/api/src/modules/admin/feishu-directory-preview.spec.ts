import type { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import type { FeishuDirectorySnapshot } from './feishu/feishu-directory.models.js';
import {
  buildPreviewChanges,
  revokeDirectoryRoleAssignments,
} from './feishu-directory-sync.service.js';

describe('Feishu directory production preview', () => {
  it('shows department transfer and mapped employment fields before apply', async () => {
    const transaction = {
      directoryOrgUnitBinding: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            departmentBinding('od-old', 'old-unit', '旧部门'),
            departmentBinding('od-new', 'new-unit', '新部门'),
          ]),
      },
      directoryUserBinding: {
        findMany: vi.fn().mockResolvedValue([
          {
            externalUserId: 'u-1',
            userId: 'user-1',
            openId: 'ou-1',
            unionId: 'on-1',
            user: {
              displayName: '测试员工',
              status: 'ACTIVE',
              avatarUrl: null,
              role: 'MEMBER',
            },
          },
        ]),
      },
      directoryEmploymentBinding: {
        findMany: vi.fn().mockResolvedValue([
          {
            externalUserId: 'u-1',
            externalDepartmentId: 'od-old',
            employment: {
              status: 'ACTIVE',
              isPrimary: true,
              workEmail: 'old@example.com',
              workEmailOverridden: false,
              employeeNumber: 'E-001',
              position: { name: '旧岗位' },
            },
          },
        ]),
      },
      user: { count: vi.fn().mockResolvedValue(0) },
      employment: { count: vi.fn().mockResolvedValue(0) },
    } as unknown as Prisma.TransactionClient;
    const snapshot: FeishuDirectorySnapshot = {
      departments: [
        { externalId: 'od-old', name: '旧部门', parentExternalId: '0', sortOrder: 0 },
        { externalId: 'od-new', name: '新部门', parentExternalId: '0', sortOrder: 0 },
      ],
      users: [
        {
          externalId: 'u-1',
          openId: 'ou-1',
          unionId: 'on-1',
          name: '测试员工',
          email: 'new@example.com',
          active: true,
          departmentExternalIds: ['od-new'],
          primaryDepartmentExternalId: 'od-new',
          employeeNumber: 'E-002',
          jobTitle: '新岗位',
        },
      ],
    };

    const result = await buildPreviewChanges(transaction, {
      tenantId: 'tenant-1',
      integrationId: 'integration-1',
      snapshot,
      now: new Date('2026-07-29T00:00:00.000Z'),
      reconcileRemovals: true,
    });

    expect(result.changes).toEqual([
      expect.objectContaining({
        entityType: 'MEMBER',
        action: 'UPDATE',
        externalId: 'u-1',
        fieldChanges: {
          departments: { before: ['od-old'], after: ['od-new'] },
          primaryDepartment: { before: 'od-old', after: 'od-new' },
          jobTitle: { before: '旧岗位', after: '新岗位' },
          workEmail: { before: 'old@example.com', after: 'new@example.com' },
          employeeNumber: { before: 'E-001', after: 'E-002' },
        },
      }),
    ]);
  });

  it('does not preview a remote email overwrite after a tenant-local override', async () => {
    const conflictingCanonicalOwners = vi.fn().mockResolvedValue(0);
    const transaction = {
      directoryOrgUnitBinding: {
        findMany: vi.fn().mockResolvedValue([departmentBinding('od-1', 'unit-1', 'Unit')]),
      },
      directoryUserBinding: {
        findMany: vi.fn().mockResolvedValue([
          {
            externalUserId: 'u-1',
            userId: 'user-1',
            openId: 'ou-1',
            unionId: 'on-1',
            user: {
              displayName: 'Member',
              status: 'ACTIVE',
              avatarUrl: null,
              role: 'MEMBER',
            },
          },
        ]),
      },
      directoryEmploymentBinding: {
        findMany: vi.fn().mockResolvedValue([
          {
            externalUserId: 'u-1',
            externalDepartmentId: 'od-1',
            employment: {
              status: 'ACTIVE',
              isPrimary: true,
              workEmail: 'local@example.test',
              workEmailOverridden: true,
              employeeNumber: null,
              position: null,
            },
          },
        ]),
      },
      user: { count: conflictingCanonicalOwners },
      employment: { count: vi.fn().mockResolvedValue(0) },
    } as unknown as Prisma.TransactionClient;

    const input = {
      tenantId: 'tenant-1',
      integrationId: 'integration-1',
      snapshot: {
        departments: [{ externalId: 'od-1', name: 'Unit', parentExternalId: '0', sortOrder: 0 }],
        users: [
          {
            externalId: 'u-1',
            openId: 'ou-1',
            unionId: 'on-1',
            name: 'Member',
            email: 'remote@example.test',
            active: true,
            departmentExternalIds: ['od-1'],
            primaryDepartmentExternalId: 'od-1',
          },
        ],
      },
      now: new Date('2026-08-04T00:00:00.000Z'),
      reconcileRemovals: true,
    } as const;
    const result = await buildPreviewChanges(transaction, input);

    expect(result.changes.filter(({ entityType }) => entityType === 'MEMBER')).toEqual([]);

    conflictingCanonicalOwners.mockResolvedValue(1);
    const conflicted = await buildPreviewChanges(transaction, input);
    expect(conflicted.changes).toContainEqual(
      expect.objectContaining({
        entityType: 'MEMBER',
        action: 'CONFLICT',
        diagnosticCode: 'USER_EMAIL_CONFLICT',
      }),
    );
  });

  it('marks a remote email owned by another local identity as a conflict', async () => {
    const transaction = {
      directoryOrgUnitBinding: {
        findMany: vi.fn().mockResolvedValue([departmentBinding('od-1', 'unit-1', 'Unit')]),
      },
      directoryUserBinding: {
        findMany: vi.fn().mockResolvedValue([
          {
            externalUserId: 'u-1',
            userId: 'user-1',
            openId: null,
            unionId: null,
            user: {
              displayName: 'Member',
              status: 'ACTIVE',
              avatarUrl: null,
              role: 'MEMBER',
            },
          },
        ]),
      },
      directoryEmploymentBinding: {
        findMany: vi.fn().mockResolvedValue([
          {
            externalUserId: 'u-1',
            externalDepartmentId: 'od-1',
            employment: {
              status: 'ACTIVE',
              isPrimary: true,
              workEmail: 'old@example.test',
              workEmailOverridden: false,
              employeeNumber: null,
              position: null,
            },
          },
        ]),
      },
      user: { count: vi.fn().mockResolvedValue(1) },
      employment: { count: vi.fn().mockResolvedValue(0) },
    } as unknown as Prisma.TransactionClient;

    const result = await buildPreviewChanges(transaction, {
      tenantId: 'tenant-1',
      integrationId: 'integration-1',
      snapshot: {
        departments: [{ externalId: 'od-1', name: 'Unit', parentExternalId: '0', sortOrder: 0 }],
        users: [
          {
            externalId: 'u-1',
            name: 'Member',
            email: 'owned@example.test',
            active: true,
            departmentExternalIds: ['od-1'],
            primaryDepartmentExternalId: 'od-1',
          },
        ],
      },
      now: new Date('2026-08-04T00:00:00.000Z'),
      reconcileRemovals: true,
    });

    expect(result.changes).toContainEqual(
      expect.objectContaining({
        entityType: 'MEMBER',
        action: 'CONFLICT',
        diagnosticCode: 'USER_EMAIL_CONFLICT',
      }),
    );
  });

  it('scopes transfer revocation to the terminated employment', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const transaction = {
      roleAssignment: { findMany },
    } as unknown as Prisma.TransactionClient;

    await revokeDirectoryRoleAssignments(
      transaction,
      {
        principal: {
          tenantId: 'tenant-1',
          userId: 'admin-1',
          role: 'ADMIN',
          authenticationSource: 'session',
        },
      } as never,
      'user-1',
      'DIRECTORY_EMPLOYMENT_CHANGED',
      new Date('2026-07-29T00:00:00.000Z'),
      'employment-old',
    );

    expect(findMany).toHaveBeenCalledWith({
      where: {
        tenantId: 'tenant-1',
        userId: 'user-1',
        employmentId: 'employment-old',
        status: { in: ['PENDING', 'ACTIVE', 'SUSPENDED'] },
      },
      select: {
        id: true,
        status: true,
        version: true,
        agentInstanceId: true,
      },
    });
  });
});

function departmentBinding(externalDepartmentId: string, orgUnitId: string, name: string) {
  return {
    externalDepartmentId,
    orgUnitId,
    orgUnit: {
      id: orgUnitId,
      parentId: null,
      name,
      sortOrder: 0,
      status: 'ACTIVE',
    },
  };
}
