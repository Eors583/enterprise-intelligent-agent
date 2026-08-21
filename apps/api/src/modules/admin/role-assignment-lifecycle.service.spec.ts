import { describe, expect, it, vi } from 'vitest';

import type { LifecyclePrismaService } from '../../database/lifecycle-prisma.service.js';
import {
  ROLE_ASSIGNMENT_RECONCILE_INTERVAL_MS,
  RoleAssignmentLifecycleService,
} from './role-assignment-lifecycle.service.js';

const TENANT_ID = '00000000-0000-7000-8000-000000000001';
const ACTOR_ID = '00000000-0000-7000-8000-000000000002';
const USER_ID = '00000000-0000-7000-8000-000000000003';
const EXPIRED_ID = '00000000-0000-7000-8000-000000000004';
const PENDING_ID = '00000000-0000-7000-8000-000000000005';
const EXPIRED_INSTANCE_ID = '00000000-0000-7000-8000-000000000006';
const PENDING_INSTANCE_ID = '00000000-0000-7000-8000-000000000007';
const VERSION_ID = '00000000-0000-7000-8000-000000000008';
const SOURCE_ID = '00000000-0000-7000-8000-000000000009';
const SOURCE_INSTANCE_ID = '00000000-0000-7000-8000-000000000010';
const NOW = new Date('2026-07-28T04:00:00.000Z');

describe('RoleAssignmentLifecycleService', () => {
  it('enumerates active tenants through the narrow lifecycle capability and reconciles them', async () => {
    const prisma = {
      enabled: true,
      listActiveTenantIds: vi.fn().mockResolvedValue([TENANT_ID]),
    };
    const lifecycle = new RoleAssignmentLifecycleService(
      prisma as unknown as LifecyclePrismaService,
    );
    vi.spyOn(lifecycle, 'reconcileTenant').mockResolvedValue({
      activated: 2,
      expired: 1,
      cancelledRuns: 3,
    });

    await expect(lifecycle.runOnce(NOW)).resolves.toEqual({
      activated: 2,
      expired: 1,
      cancelledRuns: 3,
    });
    expect(prisma.listActiveTenantIds).toHaveBeenCalledOnce();
    expect(lifecycle.reconcileTenant).toHaveBeenCalledWith(TENANT_ID, NOW);
  });

  it('drains multiple successful batches in one call within a sub-five-minute timer boundary', async () => {
    const lifecycle = new RoleAssignmentLifecycleService({
      enabled: true,
    } as unknown as LifecyclePrismaService);
    const reconcileBatch = vi
      .spyOn(
        lifecycle as unknown as {
          reconcileTenantBatch: (
            tenantId: string,
            now: Date,
          ) => Promise<{
            activated: number;
            expired: number;
            cancelledRuns: number;
            transitioned: number;
          }>;
        },
        'reconcileTenantBatch',
      )
      .mockResolvedValueOnce({
        activated: 100,
        expired: 0,
        cancelledRuns: 0,
        transitioned: 100,
      })
      .mockResolvedValueOnce({
        activated: 1,
        expired: 0,
        cancelledRuns: 0,
        transitioned: 1,
      })
      .mockResolvedValueOnce({
        activated: 0,
        expired: 0,
        cancelledRuns: 0,
        transitioned: 0,
      });

    await expect(lifecycle.reconcileTenant(TENANT_ID, NOW)).resolves.toEqual({
      activated: 101,
      expired: 0,
      cancelledRuns: 0,
    });
    expect(reconcileBatch).toHaveBeenCalledTimes(3);
    expect(ROLE_ASSIGNMENT_RECONCILE_INTERVAL_MS).toBeLessThanOrEqual(5 * 60_000);
  });

  it('drains an actual backlog larger than the 100-row transaction batch', async () => {
    const expiringBatches = [
      Array.from({ length: 100 }, (_, index) =>
        lifecycleAssignment({
          id: `10000000-0000-7000-8000-${String(index + 1).padStart(12, '0')}`,
          agentInstanceId: `20000000-0000-7000-8000-${String(index + 1).padStart(12, '0')}`,
          effectiveTo: new Date('2026-07-28T03:00:00.000Z'),
        }),
      ),
      [
        lifecycleAssignment({
          id: '10000000-0000-7000-8000-000000000101',
          agentInstanceId: '20000000-0000-7000-8000-000000000101',
          effectiveTo: new Date('2026-07-28T03:00:00.000Z'),
        }),
      ],
      [],
    ];
    const findMany = vi.fn().mockImplementation((query: Record<string, any>) => {
      if (query.where?.delegatedFromAssignmentId !== undefined) return [];
      if (query.where?.effectiveTo?.lte !== undefined) return expiringBatches.shift() ?? [];
      return [];
    });
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      roleAssignment: {
        findMany,
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        count: vi.fn().mockResolvedValue(0),
      },
      agentRun: { findMany: vi.fn().mockResolvedValue([]) },
      agentInstance: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      auditEvent: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    const lifecycle = createLifecycle(transaction);

    await expect(lifecycle.reconcileTenant(TENANT_ID, NOW)).resolves.toEqual({
      activated: 0,
      expired: 101,
      cancelledRuns: 0,
    });
    expect(transaction.roleAssignment.updateMany).toHaveBeenCalledTimes(101);
    expect(
      findMany.mock.calls
        .map(([query]) => query)
        .filter((query) => query.where?.effectiveTo?.lte !== undefined),
    ).toEqual([
      expect.objectContaining({ take: 100 }),
      expect.objectContaining({ take: 100 }),
      expect.objectContaining({ take: 100 }),
    ]);
  });

  it('expires due assignments, activates pending assignments, and audits both transitions', async () => {
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      roleAssignment: {
        findMany: vi
          .fn()
          .mockResolvedValueOnce([
            lifecycleAssignment({
              id: EXPIRED_ID,
              agentInstanceId: EXPIRED_INSTANCE_ID,
              status: 'ACTIVE',
              effectiveFrom: new Date('2026-07-20T00:00:00.000Z'),
            }),
          ])
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([
            lifecycleAssignment({
              id: PENDING_ID,
              agentInstanceId: PENDING_INSTANCE_ID,
              status: 'PENDING',
              effectiveFrom: new Date('2026-07-28T03:00:00.000Z'),
            }),
          ])
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([]),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        count: vi.fn().mockResolvedValue(0),
      },
      agentRun: { findMany: vi.fn().mockResolvedValue([]) },
      agentInstance: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      auditEvent: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    const lifecycle = createLifecycle(transaction);

    await expect(lifecycle.reconcileTenant(TENANT_ID, NOW)).resolves.toEqual({
      activated: 1,
      expired: 1,
      cancelledRuns: 0,
    });
    expect(transaction.roleAssignment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: EXPIRED_ID, status: 'ACTIVE', version: 1 }),
        data: expect.objectContaining({ status: 'EXPIRED', version: { increment: 1 } }),
      }),
    );
    expect(transaction.roleAssignment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: PENDING_ID, status: 'PENDING', version: 1 }),
        data: expect.objectContaining({ status: 'ACTIVE', version: { increment: 1 } }),
      }),
    );
    expect(transaction.agentInstance.updateMany).toHaveBeenCalledWith({
      where: {
        id: PENDING_INSTANCE_ID,
        tenantId: TENANT_ID,
        versionId: VERSION_ID,
        status: { in: ['OFFLINE', 'ONLINE'] },
      },
      data: { status: 'ONLINE' },
    });
    expect(transaction.auditEvent.createMany).toHaveBeenCalledTimes(2);
    expect(transaction.auditEvent.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          actorType: 'SERVICE',
          action: 'admin.role_assignment.expired',
          resourceId: EXPIRED_ID,
        }),
      ],
    });
    expect(transaction.auditEvent.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          actorType: 'SERVICE',
          action: 'admin.role_assignment.activated',
          resourceId: PENDING_ID,
        }),
      ],
    });
  });

  it('activates a scheduled assignment that was pinned before its approved version was superseded', async () => {
    const pending = lifecycleAssignment({
      id: PENDING_ID,
      agentInstanceId: PENDING_INSTANCE_ID,
      status: 'PENDING',
      effectiveFrom: new Date('2026-07-28T03:00:00.000Z'),
      roleVersion: {
        ...lifecycleAssignment().roleVersion,
        status: 'RETIRED',
      },
    });
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      roleAssignment: {
        findMany: vi
          .fn()
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([pending])
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([]),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        count: vi.fn().mockResolvedValue(0),
      },
      agentRun: { findMany: vi.fn().mockResolvedValue([]) },
      agentInstance: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      auditEvent: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    const lifecycle = createLifecycle(transaction);

    await expect(lifecycle.reconcileTenant(TENANT_ID, NOW)).resolves.toEqual({
      activated: 1,
      expired: 0,
      cancelledRuns: 0,
    });
    expect(transaction.roleAssignment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: PENDING_ID, status: 'PENDING', version: 1 }),
        data: expect.objectContaining({ status: 'ACTIVE', version: { increment: 1 } }),
      }),
    );
    expect(transaction.agentInstance.updateMany).toHaveBeenCalledWith({
      where: {
        id: PENDING_INSTANCE_ID,
        tenantId: TENANT_ID,
        versionId: VERSION_ID,
        status: { in: ['OFFLINE', 'ONLINE'] },
      },
      data: { status: 'ONLINE' },
    });
  });

  it('does not apply side effects when a concurrent lifecycle CAS wins first', async () => {
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      roleAssignment: {
        findMany: vi
          .fn()
          .mockResolvedValueOnce([lifecycleAssignment({ status: 'ACTIVE' })])
          .mockResolvedValueOnce([]),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        count: vi.fn(),
      },
      agentRun: { findMany: vi.fn() },
      agentInstance: { updateMany: vi.fn() },
      auditEvent: { createMany: vi.fn() },
    };
    const lifecycle = createLifecycle(transaction);

    await expect(lifecycle.reconcileTenant(TENANT_ID, NOW)).resolves.toEqual({
      activated: 0,
      expired: 0,
      cancelledRuns: 0,
    });
    expect(transaction.agentRun.findMany).not.toHaveBeenCalled();
    expect(transaction.agentInstance.updateMany).not.toHaveBeenCalled();
    expect(transaction.auditEvent.createMany).not.toHaveBeenCalled();
  });

  it('activates a scheduled handover and revokes its source in the same transaction', async () => {
    const sourceUpdatedAt = new Date('2026-07-27T00:00:00.000Z');
    const handover = lifecycleAssignment({
      id: PENDING_ID,
      agentInstanceId: PENDING_INSTANCE_ID,
      status: 'PENDING',
      source: 'HANDOVER',
      delegatedFromAssignmentId: SOURCE_ID,
      effectiveFrom: new Date('2026-07-28T03:00:00.000Z'),
      organizationScope: { organizationIds: ['sales'] },
      permissionScope: { bundles: ['crm.read'] },
      memoryPolicy: { roleOnly: true, retentionDays: 30 },
    });
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      roleAssignment: {
        findMany: vi
          .fn()
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([handover])
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([]),
        findFirst: vi.fn().mockResolvedValue({
          id: SOURCE_ID,
          userId: '00000000-0000-7000-8000-000000000011',
          agentInstanceId: SOURCE_INSTANCE_ID,
          status: 'ACTIVE',
          version: 4,
          updatedAt: sourceUpdatedAt,
          effectiveFrom: new Date('2026-07-01T00:00:00.000Z'),
          effectiveTo: null,
          organizationScope: { organizationIds: ['sales', 'partners'] },
          permissionScope: { bundles: ['crm.read', 'crm.draft'] },
          memoryPolicy: { roleOnly: false, retentionDays: 90 },
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        count: vi.fn().mockResolvedValue(0),
      },
      agentRun: { findMany: vi.fn().mockResolvedValue([]) },
      agentInstance: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      auditEvent: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    const lifecycle = createLifecycle(transaction);

    await expect(lifecycle.reconcileTenant(TENANT_ID, NOW)).resolves.toEqual({
      activated: 1,
      expired: 0,
      cancelledRuns: 0,
    });
    expect(transaction.roleAssignment.updateMany).toHaveBeenCalledWith({
      where: {
        tenantId: TENANT_ID,
        id: SOURCE_ID,
        status: 'ACTIVE',
        version: 4,
        updatedAt: sourceUpdatedAt,
      },
      data: expect.objectContaining({
        status: 'REVOKED',
        revokedById: ACTOR_ID,
        version: { increment: 1 },
      }),
    });
    expect(transaction.auditEvent.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          action: 'admin.role_assignment.handed_over',
          resourceId: SOURCE_ID,
          metadata: expect.objectContaining({ successorAssignmentId: PENDING_ID }),
        }),
      ],
    });
    expect(transaction.auditEvent.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          action: 'admin.role_assignment.activated',
          resourceId: PENDING_ID,
        }),
      ],
    });
  });

  it('activates a delayed delegation only after revalidating its source and narrower scope', async () => {
    const delegation = lifecycleAssignment({
      id: PENDING_ID,
      agentInstanceId: PENDING_INSTANCE_ID,
      status: 'PENDING',
      source: 'DELEGATION',
      delegatedFromAssignmentId: SOURCE_ID,
      effectiveFrom: new Date('2026-07-28T03:00:00.000Z'),
      effectiveTo: new Date('2026-07-29T00:00:00.000Z'),
      organizationScope: { organizationIds: ['sales'], includeChildren: false },
      permissionScope: { bundles: ['crm.read'] },
      memoryPolicy: { roleOnly: true, retentionDays: 30 },
    });
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      roleAssignment: {
        findMany: vi
          .fn()
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([delegation])
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([]),
        findFirst: vi.fn().mockResolvedValue({
          id: SOURCE_ID,
          userId: '00000000-0000-7000-8000-000000000011',
          agentInstanceId: SOURCE_INSTANCE_ID,
          status: 'ACTIVE',
          version: 4,
          updatedAt: new Date('2026-07-27T00:00:00.000Z'),
          effectiveFrom: new Date('2026-07-01T00:00:00.000Z'),
          effectiveTo: new Date('2026-07-30T00:00:00.000Z'),
          organizationScope: {
            organizationIds: ['sales', 'partners'],
            includeChildren: true,
          },
          permissionScope: { bundles: ['crm.read', 'crm.draft'] },
          memoryPolicy: { roleOnly: false, retentionDays: 90 },
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      agentInstance: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      auditEvent: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    const lifecycle = createLifecycle(transaction);

    await expect(lifecycle.reconcileTenant(TENANT_ID, NOW)).resolves.toEqual({
      activated: 1,
      expired: 0,
      cancelledRuns: 0,
    });
    expect(transaction.roleAssignment.updateMany).toHaveBeenCalledTimes(1);
    expect(transaction.roleAssignment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: PENDING_ID, status: 'PENDING' }),
        data: expect.objectContaining({ status: 'ACTIVE' }),
      }),
    );
  });

  it.each([
    ['missing or inactive source', null],
    [
      'expanded scope',
      {
        id: SOURCE_ID,
        userId: '00000000-0000-7000-8000-000000000011',
        agentInstanceId: SOURCE_INSTANCE_ID,
        status: 'ACTIVE',
        version: 4,
        updatedAt: new Date('2026-07-27T00:00:00.000Z'),
        effectiveFrom: new Date('2026-07-01T00:00:00.000Z'),
        effectiveTo: new Date('2026-07-30T00:00:00.000Z'),
        organizationScope: { organizationIds: ['sales'], includeChildren: false },
        permissionScope: { bundles: ['crm.read'] },
        memoryPolicy: { roleOnly: true, retentionDays: 30 },
      },
    ],
    [
      'assignment outlives source',
      {
        id: SOURCE_ID,
        userId: '00000000-0000-7000-8000-000000000011',
        agentInstanceId: SOURCE_INSTANCE_ID,
        status: 'ACTIVE',
        version: 4,
        updatedAt: new Date('2026-07-27T00:00:00.000Z'),
        effectiveFrom: new Date('2026-07-01T00:00:00.000Z'),
        effectiveTo: new Date('2026-07-28T12:00:00.000Z'),
        organizationScope: {
          organizationIds: ['sales', 'partners'],
          includeChildren: true,
        },
        permissionScope: { bundles: ['crm.read', 'crm.draft'] },
        memoryPolicy: { roleOnly: false, retentionDays: 90 },
      },
    ],
  ])('keeps a delayed delegation pending for an invalid %s', async (reason, source) => {
    const invalid =
      reason === 'expanded scope'
        ? lifecycleAssignment({
            id: PENDING_ID,
            agentInstanceId: PENDING_INSTANCE_ID,
            status: 'PENDING',
            source: 'DELEGATION',
            delegatedFromAssignmentId: SOURCE_ID,
            effectiveFrom: new Date('2026-07-28T03:00:00.000Z'),
            effectiveTo: new Date('2026-07-29T00:00:00.000Z'),
            organizationScope: {
              organizationIds: ['sales', 'partners'],
              includeChildren: true,
            },
            permissionScope: { bundles: ['crm.read', 'crm.draft'] },
            memoryPolicy: { roleOnly: false, retentionDays: 90 },
          })
        : lifecycleAssignment({
            id: PENDING_ID,
            agentInstanceId: PENDING_INSTANCE_ID,
            status: 'PENDING',
            source: 'DELEGATION',
            delegatedFromAssignmentId: SOURCE_ID,
            effectiveFrom: new Date('2026-07-28T03:00:00.000Z'),
            effectiveTo: new Date('2026-07-29T00:00:00.000Z'),
            organizationScope: { organizationIds: ['sales'], includeChildren: false },
            permissionScope: { bundles: ['crm.read'] },
            memoryPolicy: { roleOnly: true, retentionDays: 30 },
          });
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      roleAssignment: {
        findMany: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([invalid]),
        findFirst: vi.fn().mockResolvedValue(source),
        updateMany: vi.fn(),
      },
      agentInstance: { updateMany: vi.fn() },
      auditEvent: { createMany: vi.fn() },
    };
    const lifecycle = createLifecycle(transaction);

    await expect(lifecycle.reconcileTenant(TENANT_ID, NOW)).resolves.toEqual({
      activated: 0,
      expired: 0,
      cancelledRuns: 0,
    });
    expect(transaction.roleAssignment.updateMany).not.toHaveBeenCalled();
    expect(transaction.agentInstance.updateMany).not.toHaveBeenCalled();
    expect(transaction.auditEvent.createMany).not.toHaveBeenCalled();
  });
});

function createLifecycle(transaction: Record<string, unknown>): RoleAssignmentLifecycleService {
  const prisma = {
    enabled: true,
    withTenant: vi.fn((_tenantId: string, operation: (value: unknown) => unknown) =>
      operation(transaction),
    ),
  };
  return new RoleAssignmentLifecycleService(prisma as unknown as LifecyclePrismaService);
}

function lifecycleAssignment(overrides: Record<string, unknown> = {}) {
  return {
    id: EXPIRED_ID,
    userId: USER_ID,
    agentInstanceId: EXPIRED_INSTANCE_ID,
    roleVersionId: VERSION_ID,
    source: 'LOCAL',
    delegatedFromAssignmentId: null,
    organizationScope: {},
    permissionScope: {},
    memoryPolicy: {},
    status: 'ACTIVE',
    version: 1,
    effectiveFrom: new Date('2026-07-20T00:00:00.000Z'),
    effectiveTo: null,
    createdById: ACTOR_ID,
    roleVersion: {
      status: 'PUBLISHED',
      reviewStatus: 'APPROVED',
      createdById: ACTOR_ID,
      reviewRequestedById: ACTOR_ID,
      reviewedById: USER_ID,
      approvedById: USER_ID,
      blueprintRevision: 1,
      roleDefinitionSnapshot: roleDefinitionSnapshot(),
      template: { mission: 'Execute a governed enterprise role.' },
    },
    ...overrides,
  };
}

function roleDefinitionSnapshot() {
  return {
    mission: 'Execute a governed enterprise role.',
    responsibilities: [
      {
        key: 'delivery',
        name: 'Delivery',
        description: 'Deliver governed outcomes.',
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
