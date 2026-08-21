import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../database/prisma.service.js';
import type { IdentityService } from '../identity/application/identity.service.js';
import { MyRoleAssignmentService } from './my-role-assignment.service.js';

const TENANT_ID = '00000000-0000-7000-8000-000000000001';
const USER_ID = '00000000-0000-7000-8000-000000000002';
const OTHER_USER_ID = '00000000-0000-7000-8000-000000000003';
const OTHER_TENANT_ID = '00000000-0000-7000-8000-000000000004';

describe('MyRoleAssignmentService', () => {
  it('queries and returns only the current tenant and current user assignments', async () => {
    const findMany = vi
      .fn()
      .mockResolvedValue([
        assignmentRecord(1, 'ACTIVE'),
        assignmentRecord(2, 'PENDING'),
        assignmentRecord(3, 'REVOKED'),
        assignmentRecord(4, 'ACTIVE', { userId: OTHER_USER_ID }),
        assignmentRecord(5, 'ACTIVE', { tenantId: OTHER_TENANT_ID }),
        assignmentRecord(6, 'ACTIVE', { agentTenantId: OTHER_TENANT_ID }),
        assignmentRecord(7, 'ACTIVE', { employmentTenantId: OTHER_TENANT_ID }),
      ]);
    const transaction = { roleAssignment: { findMany } };
    const withTenant = vi.fn(
      async (_tenantId: string, operation: (value: typeof transaction) => Promise<unknown>) =>
        operation(transaction),
    );
    const identity = {
      getCurrentIdentity: vi.fn().mockResolvedValue({
        tenant: { id: TENANT_ID, name: 'Acme', status: 'active' },
        user: { id: USER_ID, tenantId: TENANT_ID, name: 'Current user', status: 'active' },
      }),
    };
    const service = new MyRoleAssignmentService(
      identity as unknown as IdentityService,
      { withTenant } as unknown as PrismaService,
    );

    const result = await service.listMine();

    expect(withTenant).toHaveBeenCalledWith(TENANT_ID, expect.any(Function));
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: TENANT_ID, userId: USER_ID },
        take: 200,
      }),
    );
    expect(result.items.map(({ status }) => status)).toEqual(['ACTIVE', 'PENDING', 'REVOKED']);
    expect(result.items.every(({ assignee }) => assignee.id === USER_ID)).toBe(true);
  });

  it('does not enter a tenant transaction until the active identity is resolved', async () => {
    const identityError = new Error('identity unavailable');
    const identity = { getCurrentIdentity: vi.fn().mockRejectedValue(identityError) };
    const withTenant = vi.fn();
    const service = new MyRoleAssignmentService(
      identity as unknown as IdentityService,
      { withTenant } as unknown as PrismaService,
    );

    await expect(service.listMine()).rejects.toBe(identityError);
    expect(withTenant).not.toHaveBeenCalled();
  });
});

function assignmentRecord(
  sequence: number,
  status: 'ACTIVE' | 'PENDING' | 'REVOKED',
  overrides: {
    tenantId?: string;
    userId?: string;
    agentTenantId?: string;
    employmentTenantId?: string;
  } = {},
) {
  const suffix = String(sequence).padStart(12, '0');
  const tenantId = overrides.tenantId ?? TENANT_ID;
  const userId = overrides.userId ?? USER_ID;
  const id = `10000000-0000-7000-8000-${suffix}`;
  return {
    id,
    tenantId,
    key: `assignment-${sequence}`,
    userId,
    status,
    source: 'LOCAL' as const,
    effectiveFrom: new Date('2026-07-01T00:00:00.000Z'),
    effectiveTo: status === 'REVOKED' ? new Date('2026-07-20T00:00:00.000Z') : null,
    organizationScope: { orgUnitIds: ['sales'] },
    permissionScope: { bundles: ['crm.read'] },
    memoryPolicy: {},
    delegatedFromAssignmentId: null,
    user: {
      id: userId,
      tenantId,
      displayName: 'Current user',
      status: 'ACTIVE' as const,
    },
    employment: {
      id: `20000000-0000-7000-8000-${suffix}`,
      tenantId: overrides.employmentTenantId ?? tenantId,
      organizationId: `30000000-0000-7000-8000-${suffix}`,
      orgUnitId: `40000000-0000-7000-8000-${suffix}`,
      positionId: null,
      status: 'ACTIVE' as const,
    },
    agentInstance: {
      id: `50000000-0000-7000-8000-${suffix}`,
      tenantId: overrides.agentTenantId ?? tenantId,
      name: `Role Agent ${sequence}`,
      status: status === 'ACTIVE' ? ('ONLINE' as const) : ('OFFLINE' as const),
      versionId: `60000000-0000-7000-8000-${suffix}`,
      version: {
        tenantId: overrides.agentTenantId ?? tenantId,
        version: 1,
        status: 'PUBLISHED' as const,
        roleDefinitionSnapshot: roleDefinitionSnapshot(),
        blueprintRevision: 1,
        template: {
          id: `70000000-0000-7000-8000-${suffix}`,
          key: `role-${sequence}`,
          name: `Role ${sequence}`,
        },
      },
    },
    createdBy: {
      id: '80000000-0000-7000-8000-000000000001',
      displayName: 'Administrator',
    },
    revokedAt: status === 'REVOKED' ? new Date('2026-07-20T00:00:00.000Z') : null,
    revokedBy:
      status === 'REVOKED'
        ? {
            id: '80000000-0000-7000-8000-000000000001',
            displayName: 'Administrator',
          }
        : null,
    revokeReason: status === 'REVOKED' ? 'Role changed' : null,
    createdAt: new Date('2026-06-30T00:00:00.000Z'),
    updatedAt: new Date('2026-07-20T00:00:00.000Z'),
  };
}

function roleDefinitionSnapshot() {
  return {
    mission: 'Deliver a governed enterprise outcome.',
    responsibilities: [
      {
        key: 'delivery',
        name: 'Delivery',
        description: 'Deliver a verified result.',
        outcomes: ['A verified result exists.'],
      },
    ],
    valueDefinition: {
      statement: 'Produce verifiable enterprise value.',
      stakeholderOutcomes: ['Stakeholders receive a reliable result.'],
      measures: ['Verified outcomes'],
    },
    capabilities: [],
    processes: [],
    tools: [],
    knowledgeDomains: [],
  };
}
