import { ConflictException, ForbiddenException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AdminPrismaService } from '../../database/admin-prisma.service.js';
import type { AdminAccessService } from './admin-access.service.js';
import {
  cascadeAssignmentDescendants,
  isDelegatedAssignmentScopeSubset,
  isGovernedPublishedRoleVersion,
  RoleAssignmentAdminService,
} from './role-assignment-admin.service.js';

const TENANT_ID = '00000000-0000-7000-8000-000000000001';
const ADMIN_ID = '00000000-0000-7000-8000-000000000002';
const USER_ID = '00000000-0000-7000-8000-000000000003';
const EMPLOYMENT_ID = '00000000-0000-7000-8000-000000000004';
const VERSION_ID = '00000000-0000-7000-8000-000000000005';
const INSTANCE_ID = '00000000-0000-7000-8000-000000000006';
const ASSIGNMENT_ID = '00000000-0000-7000-8000-000000000007';
const QUEUED_RUN_ID = '00000000-0000-7000-8000-000000000021';
const DISPATCHING_RUN_ID = '00000000-0000-7000-8000-000000000022';
const RUNNING_RUN_ID = '00000000-0000-7000-8000-000000000023';
const EXTERNAL_RUN_ID = '00000000-0000-7000-8000-000000000024';
const UNKNOWN_RUN_ID = '00000000-0000-7000-8000-000000000028';
const UNKNOWN_EXTERNAL_RUN_ID = '00000000-0000-7000-8000-000000000029';
const QUEUED_PROVIDER_RUN_ID = '00000000-0000-7000-8000-000000000030';
const QUEUED_PROVIDER_EXTERNAL_RUN_ID = '00000000-0000-7000-8000-000000000031';
const SOURCE_USER_ID = '00000000-0000-7000-8000-000000000025';
const CHILD_ASSIGNMENT_ID = '00000000-0000-7000-8000-000000000026';
const GRANDCHILD_ASSIGNMENT_ID = '00000000-0000-7000-8000-000000000027';
const NOW = new Date('2026-07-28T02:00:00.000Z');

describe('RoleAssignmentAdminService', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates a dedicated Role Agent instance, tenant-scoped assignment, and audit event', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const assignment = assignmentRecord();
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      user: {
        findFirst: vi.fn().mockResolvedValue({ id: USER_ID, displayName: '周明' }),
      },
      employment: {
        findFirst: vi.fn().mockResolvedValue({ id: EMPLOYMENT_ID }),
      },
      agentVersion: {
        findFirst: vi
          .fn()
          .mockResolvedValue(governedVersion(assignment.agentInstance.version.template.id)),
      },
      agentInstance: { create: vi.fn().mockResolvedValue({ id: INSTANCE_ID }) },
      roleAssignment: {
        create: vi.fn().mockResolvedValue({ id: ASSIGNMENT_ID }),
        findFirstOrThrow: vi.fn().mockResolvedValue(assignment),
      },
      auditEvent: { create: vi.fn().mockResolvedValue({}) },
    };
    const service = createService(transaction);

    const result = await service.create({
      key: 'asg:sales:zhouming',
      userId: USER_ID,
      employmentId: EMPLOYMENT_ID,
      agentVersionId: VERSION_ID,
      effectiveFrom: '2026-07-28T01:00:00.000Z',
      effectiveTo: null,
      source: 'LOCAL',
      organizationScope: { organizationIds: ['sales'] },
      permissionScope: {},
      memoryPolicy: { roleOnly: true },
    });

    expect(transaction.agentInstance.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: TENANT_ID,
        ownerUserId: USER_ID,
        versionId: VERSION_ID,
        status: 'ONLINE',
        name: '周明 · 销售',
        settings: expect.objectContaining({
          visibility: 'owner',
          roleTemplateId: assignment.agentInstance.version.template.id,
        }),
      }),
    });
    expect(transaction.roleAssignment.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: TENANT_ID,
        key: 'asg:sales:zhouming',
        userId: USER_ID,
        employmentId: EMPLOYMENT_ID,
        status: 'ACTIVE',
        source: 'LOCAL',
      }),
    });
    expect(transaction.auditEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: TENANT_ID,
        actorId: ADMIN_ID,
        action: 'admin.role_assignment.created',
        resourceType: 'role_assignment',
      }),
    });
    expect(transaction.agentVersion.findFirst).toHaveBeenNthCalledWith(1, {
      where: { id: VERSION_ID, tenantId: TENANT_ID },
      select: { templateId: true },
    });
    expect(transaction.agentVersion.findFirst).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({
          id: VERSION_ID,
          tenantId: TENANT_ID,
          status: 'PUBLISHED',
        }),
      }),
    );
    expect(result.id).toBe(ASSIGNMENT_ID);
    expect(result.agent.status).toBe('ONLINE');
  });

  it('replays the original assignment for the same idempotency key without duplicate writes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const stored = assignmentRecord({
      idempotencyKey: 'assignment:test:001',
      requestHash: '',
      roleTemplateId: assignmentRecord().agentInstance.version.template.id,
      roleVersionId: VERSION_ID,
      version: 1,
    });
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      user: {
        findFirst: vi.fn().mockResolvedValue({ id: USER_ID, displayName: '周明', role: 'MEMBER' }),
      },
      employment: { findFirst: vi.fn().mockResolvedValue({ id: EMPLOYMENT_ID }) },
      agentVersion: {
        findFirst: vi
          .fn()
          .mockResolvedValue(governedVersion(stored.agentInstance.version.template.id)),
      },
      agentInstance: { create: vi.fn().mockResolvedValue({ id: INSTANCE_ID }) },
      roleAssignment: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: ASSIGNMENT_ID }),
        findFirstOrThrow: vi.fn().mockResolvedValue(stored),
      },
      auditEvent: { create: vi.fn().mockResolvedValue({}) },
    };
    const service = createService(transaction);
    const request = {
      idempotencyKey: 'assignment:test:001',
      userId: USER_ID,
      employmentId: EMPLOYMENT_ID,
      agentVersionId: VERSION_ID,
      effectiveFrom: '2026-07-28T01:00:00.000Z',
      effectiveTo: null,
      source: 'LOCAL' as const,
      organizationScope: {},
      permissionScope: {},
      memoryPolicy: {},
    };

    await service.create(request);
    const createdData = transaction.roleAssignment.create.mock.calls[0]?.[0].data;
    stored.requestHash = createdData.requestHash;
    transaction.roleAssignment.findFirst.mockReset().mockResolvedValue(stored);

    await expect(service.create(request)).resolves.toMatchObject({
      id: ASSIGNMENT_ID,
      idempotencyKey: 'assignment:test:001',
    });
    expect(transaction.agentInstance.create).toHaveBeenCalledTimes(1);
    expect(transaction.roleAssignment.create).toHaveBeenCalledTimes(1);
  });

  it('validates delegation lineage and persists the source assignment', async () => {
    const templateId = assignmentRecord().agentInstance.version.template.id;
    const sourceAssignmentId = '00000000-0000-7000-8000-000000000031';
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      user: {
        findFirst: vi.fn().mockResolvedValue({ id: USER_ID, displayName: '周明', role: 'MEMBER' }),
      },
      employment: { findFirst: vi.fn().mockResolvedValue({ id: EMPLOYMENT_ID }) },
      agentVersion: {
        findFirst: vi.fn().mockResolvedValue(governedVersion(templateId)),
      },
      agentInstance: { create: vi.fn().mockResolvedValue({ id: INSTANCE_ID }) },
      roleAssignment: {
        findFirst: vi
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce({
            id: sourceAssignmentId,
            userId: '00000000-0000-7000-8000-000000000099',
            roleTemplateId: templateId,
            status: 'ACTIVE',
            effectiveFrom: new Date('2026-07-01T00:00:00.000Z'),
            effectiveTo: new Date('2026-08-31T00:00:00.000Z'),
          })
          .mockResolvedValueOnce(null),
        create: vi.fn().mockResolvedValue({ id: ASSIGNMENT_ID }),
        findFirstOrThrow: vi.fn().mockResolvedValue(
          assignmentRecord({
            source: 'DELEGATION',
            delegatedFromAssignmentId: sourceAssignmentId,
            idempotencyKey: 'auto:test',
            requestHash: '0'.repeat(64),
            roleTemplateId: templateId,
            roleVersionId: VERSION_ID,
            version: 1,
          }),
        ),
      },
      auditEvent: { create: vi.fn().mockResolvedValue({}) },
    };
    const service = createService(transaction);

    await service.create({
      userId: USER_ID,
      employmentId: EMPLOYMENT_ID,
      agentVersionId: VERSION_ID,
      effectiveFrom: '2026-07-28T03:00:00.000Z',
      effectiveTo: '2026-08-01T00:00:00.000Z',
      source: 'DELEGATION',
      delegatedFromAssignmentId: sourceAssignmentId,
      organizationScope: {},
      permissionScope: {},
      memoryPolicy: {},
    });

    expect(transaction.roleAssignment.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        source: 'DELEGATION',
        delegatedFromAssignmentId: sourceAssignmentId,
        roleTemplateId: templateId,
        roleVersionId: VERSION_ID,
      }),
    });
  });

  it('rejects an overlapping assignment for the same member and Role Blueprint', async () => {
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      user: {
        findFirst: vi.fn().mockResolvedValue({ id: USER_ID, displayName: '周明', role: 'MEMBER' }),
      },
      employment: { findFirst: vi.fn().mockResolvedValue({ id: EMPLOYMENT_ID }) },
      agentVersion: {
        findFirst: vi
          .fn()
          .mockResolvedValue(governedVersion(assignmentRecord().agentInstance.version.template.id)),
      },
      roleAssignment: {
        findFirst: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ id: ASSIGNMENT_ID }),
        create: vi.fn(),
      },
      agentInstance: { create: vi.fn() },
    };
    const service = createService(transaction);

    await expect(
      service.create({
        userId: USER_ID,
        employmentId: EMPLOYMENT_ID,
        agentVersionId: VERSION_ID,
        effectiveFrom: '2026-07-28T03:00:00.000Z',
        source: 'LOCAL',
        organizationScope: {},
        permissionScope: {},
        memoryPolicy: {},
      }),
    ).rejects.toThrow('overlapping assignment');
    expect(transaction.agentInstance.create).not.toHaveBeenCalled();
    expect(transaction.roleAssignment.create).not.toHaveBeenCalled();
  });

  it('refuses to bind a draft or missing Agent version', async () => {
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      user: {
        findFirst: vi.fn().mockResolvedValue({ id: USER_ID, displayName: '周明' }),
      },
      employment: {
        findFirst: vi.fn().mockResolvedValue({ id: EMPLOYMENT_ID }),
      },
      agentVersion: { findFirst: vi.fn().mockResolvedValue(null) },
    };
    const service = createService(transaction);

    await expect(
      service.create({
        userId: USER_ID,
        employmentId: EMPLOYMENT_ID,
        agentVersionId: VERSION_ID,
        effectiveFrom: '2026-07-28T03:00:00.000Z',
        source: 'LOCAL',
        organizationScope: {},
        permissionScope: {},
        memoryPolicy: {},
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('requires the selected employment to belong to the member and be active', async () => {
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      user: {
        findFirst: vi.fn().mockResolvedValue({ id: USER_ID, displayName: '周明', role: 'MEMBER' }),
      },
      employment: { findFirst: vi.fn().mockResolvedValue(null) },
      agentVersion: { findFirst: vi.fn() },
      agentInstance: { create: vi.fn() },
      roleAssignment: { create: vi.fn() },
    };
    const service = createService(transaction);

    await expect(
      service.create({
        userId: USER_ID,
        employmentId: EMPLOYMENT_ID,
        agentVersionId: VERSION_ID,
        effectiveFrom: '2026-07-28T03:00:00.000Z',
        source: 'LOCAL',
        organizationScope: {},
        permissionScope: {},
        memoryPolicy: {},
      }),
    ).rejects.toThrow('The employment must belong to the assignment user and be active.');
    expect(transaction.employment.findFirst).toHaveBeenCalledWith({
      where: {
        id: EMPLOYMENT_ID,
        tenantId: TENANT_ID,
        userId: USER_ID,
        status: 'ACTIVE',
      },
      select: { id: true },
    });
    expect(transaction.agentVersion.findFirst).not.toHaveBeenCalled();
    expect(transaction.agentInstance.create).not.toHaveBeenCalled();
    expect(transaction.roleAssignment.create).not.toHaveBeenCalled();
  });

  it('does not accept caller-defined permission grants', async () => {
    const service = createService({});

    await expect(
      service.create({
        userId: USER_ID,
        employmentId: EMPLOYMENT_ID,
        agentVersionId: VERSION_ID,
        effectiveFrom: '2026-07-28T03:00:00.000Z',
        source: 'LOCAL',
        organizationScope: {},
        permissionScope: { tools: ['crm.write'] },
        memoryPolicy: {},
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('recognizes only independently approved versions with a strict immutable snapshot', () => {
    const governed = governedVersion(assignmentRecord().agentInstance.version.template.id);

    expect(isGovernedPublishedRoleVersion(governed)).toBe(true);
    expect(isGovernedPublishedRoleVersion({ ...governed, approvedById: ADMIN_ID })).toBe(false);
    expect(
      isGovernedPublishedRoleVersion({
        ...governed,
        roleDefinitionSnapshot: { mission: governed.roleDefinitionSnapshot.mission },
      }),
    ).toBe(false);
  });

  it('accepts narrower delegation scopes and rejects every tested expansion', () => {
    const source = {
      organizationIds: ['sales', 'partners'],
      includeChildren: true,
      controls: {
        allowWrite: true,
        labels: ['read', 'draft'],
        retentionDays: 90,
      },
    };

    expect(
      isDelegatedAssignmentScopeSubset(
        {
          organizationIds: ['sales'],
          includeChildren: false,
          controls: {
            allowWrite: false,
            labels: ['read'],
            retentionDays: 30,
          },
        },
        source,
      ),
    ).toBe(true);
    expect(
      isDelegatedAssignmentScopeSubset(
        {
          ...source,
          organizationIds: ['sales', 'partners', 'executive'],
        },
        source,
      ),
    ).toBe(false);
    expect(
      isDelegatedAssignmentScopeSubset(
        {
          ...source,
          controls: { ...source.controls, retentionDays: 180 },
        },
        source,
      ),
    ).toBe(false);
  });

  it('atomically revokes an active handover source and records both audits', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const templateId = assignmentRecord().agentInstance.version.template.id;
    const sourceAssignmentId = '00000000-0000-7000-8000-000000000031';
    const sourceUpdatedAt = new Date('2026-07-27T00:00:00.000Z');
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      user: {
        findFirst: vi.fn().mockResolvedValue({
          id: USER_ID,
          displayName: '周明',
          role: 'MEMBER',
        }),
      },
      employment: { findFirst: vi.fn().mockResolvedValue({ id: EMPLOYMENT_ID }) },
      agentVersion: { findFirst: vi.fn().mockResolvedValue(governedVersion(templateId)) },
      agentInstance: {
        create: vi.fn().mockResolvedValue({ id: INSTANCE_ID }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      roleAssignment: {
        findFirst: vi
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce({
            id: sourceAssignmentId,
            userId: SOURCE_USER_ID,
            roleTemplateId: templateId,
            status: 'ACTIVE',
            effectiveFrom: new Date('2026-07-01T00:00:00.000Z'),
            effectiveTo: null,
            organizationScope: { organizationIds: ['sales', 'partners'] },
            permissionScope: { bundles: ['crm.read', 'crm.draft'] },
            memoryPolicy: { roleOnly: false, retentionDays: 90 },
            agentInstanceId: '00000000-0000-7000-8000-000000000032',
            version: 4,
            updatedAt: sourceUpdatedAt,
          })
          .mockResolvedValueOnce(null),
        create: vi.fn().mockResolvedValue({ id: ASSIGNMENT_ID }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        count: vi.fn().mockResolvedValue(0),
        findMany: vi.fn().mockResolvedValue([]),
        findFirstOrThrow: vi.fn().mockResolvedValue(
          assignmentRecord({
            source: 'HANDOVER',
            delegatedFromAssignmentId: sourceAssignmentId,
          }),
        ),
      },
      agentRun: { findMany: vi.fn().mockResolvedValue([]) },
      auditEvent: { create: vi.fn().mockResolvedValue({}) },
    };
    const service = createService(transaction);

    await service.create({
      userId: USER_ID,
      employmentId: EMPLOYMENT_ID,
      agentVersionId: VERSION_ID,
      effectiveFrom: '2026-07-28T01:00:00.000Z',
      source: 'HANDOVER',
      delegatedFromAssignmentId: sourceAssignmentId,
      organizationScope: { organizationIds: ['sales'] },
      permissionScope: { bundles: ['crm.read'] },
      memoryPolicy: { roleOnly: true, retentionDays: 30 },
    });

    expect(transaction.roleAssignment.updateMany).toHaveBeenCalledWith({
      where: {
        id: sourceAssignmentId,
        tenantId: TENANT_ID,
        status: 'ACTIVE',
        version: 4,
        updatedAt: sourceUpdatedAt,
      },
      data: expect.objectContaining({
        status: 'REVOKED',
        revokedById: ADMIN_ID,
        version: { increment: 1 },
      }),
    });
    expect(transaction.auditEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'admin.role_assignment.handed_over',
        resourceId: sourceAssignmentId,
      }),
    });
    expect(transaction.auditEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'admin.role_assignment.created',
      }),
    });
  });

  it('recursively revokes delegation descendants and disables their agents', async () => {
    const transaction = {
      roleAssignment: {
        findMany: vi
          .fn()
          .mockResolvedValueOnce([
            {
              id: CHILD_ASSIGNMENT_ID,
              userId: USER_ID,
              agentInstanceId: INSTANCE_ID,
              status: 'ACTIVE',
              version: 1,
            },
          ])
          .mockResolvedValueOnce([
            {
              id: GRANDCHILD_ASSIGNMENT_ID,
              userId: SOURCE_USER_ID,
              agentInstanceId: '00000000-0000-7000-8000-000000000028',
              status: 'PENDING',
              version: 2,
            },
          ])
          .mockResolvedValueOnce([]),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        count: vi.fn().mockResolvedValue(0),
      },
      agentRun: { findMany: vi.fn().mockResolvedValue([]) },
      agentInstance: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };

    await expect(
      cascadeAssignmentDescendants(transaction as never, TENANT_ID, ASSIGNMENT_ID, 'REVOKED', NOW, {
        revokedById: ADMIN_ID,
        reason: 'Source assignment revoked.',
        errorCode: 'ROLE_ASSIGNMENT_REVOKED',
        errorMessage: 'The source role assignment was revoked.',
      }),
    ).resolves.toMatchObject([
      { id: CHILD_ASSIGNMENT_ID, parentAssignmentId: ASSIGNMENT_ID },
      { id: GRANDCHILD_ASSIGNMENT_ID, parentAssignmentId: CHILD_ASSIGNMENT_ID },
    ]);
    expect(transaction.roleAssignment.updateMany).toHaveBeenCalledTimes(2);
    expect(transaction.agentInstance.updateMany).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['the administrator account itself', ADMIN_ID, 'ADMIN'],
    ['a tenant owner', USER_ID, 'OWNER'],
  ])('prevents an administrator from assigning %s', async (_label, userId, role) => {
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      user: {
        findFirst: vi.fn().mockResolvedValue({ id: userId, displayName: '受保护成员', role }),
      },
    };
    const service = createService(transaction);

    await expect(
      service.create({
        userId,
        employmentId: EMPLOYMENT_ID,
        agentVersionId: VERSION_ID,
        effectiveFrom: '2026-07-28T03:00:00.000Z',
        source: 'LOCAL',
        organizationScope: {},
        permissionScope: {},
        memoryPolicy: {},
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('revokes with optimistic concurrency, disables the orphaned instance, and audits', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const current = assignmentRecord();
    const revoked = assignmentRecord({
      status: 'REVOKED',
      revokedAt: NOW,
      revokedBy: { id: ADMIN_ID, displayName: '管理员' },
      revokedById: ADMIN_ID,
      revokeReason: '岗位调整',
      updatedAt: NOW,
      agentInstance: {
        ...assignmentRecord().agentInstance,
        status: 'DISABLED',
      },
    });
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      roleAssignment: {
        findFirst: vi.fn().mockResolvedValue(current),
        findMany: vi.fn().mockResolvedValue([]),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        count: vi.fn().mockResolvedValue(0),
        findFirstOrThrow: vi.fn().mockResolvedValue(revoked),
      },
      agentRun: {
        findMany: vi
          .fn()
          .mockResolvedValueOnce([
            { id: QUEUED_RUN_ID },
            { id: DISPATCHING_RUN_ID },
            { id: RUNNING_RUN_ID },
            { id: UNKNOWN_RUN_ID },
            { id: QUEUED_PROVIDER_RUN_ID },
          ])
          .mockResolvedValueOnce([
            { id: QUEUED_RUN_ID, status: 'QUEUED', externalRunId: null },
            { id: DISPATCHING_RUN_ID, status: 'DISPATCHING', externalRunId: null },
            { id: RUNNING_RUN_ID, status: 'RUNNING', externalRunId: EXTERNAL_RUN_ID },
            {
              id: UNKNOWN_RUN_ID,
              status: 'UNKNOWN',
              externalRunId: UNKNOWN_EXTERNAL_RUN_ID,
            },
            {
              id: QUEUED_PROVIDER_RUN_ID,
              status: 'QUEUED',
              externalRunId: QUEUED_PROVIDER_EXTERNAL_RUN_ID,
            },
          ]),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      outboxEvent: { createMany: vi.fn().mockResolvedValue({ count: 4 }) },
      agentInstance: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      auditEvent: { create: vi.fn().mockResolvedValue({}) },
    };
    const service = createService(transaction);

    const result = await service.revoke(ASSIGNMENT_ID, {
      reason: '岗位调整',
      expectedUpdatedAt: current.updatedAt.toISOString(),
    });

    expect(transaction.roleAssignment.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: ASSIGNMENT_ID,
        tenantId: TENANT_ID,
        updatedAt: current.updatedAt,
      }),
      data: expect.objectContaining({
        status: 'REVOKED',
        revokedById: ADMIN_ID,
        revokeReason: '岗位调整',
      }),
    });
    expect(transaction.agentInstance.updateMany).toHaveBeenCalledWith({
      where: { id: INSTANCE_ID, tenantId: TENANT_ID },
      data: { status: 'DISABLED' },
    });
    expect(transaction.agentRun.updateMany).toHaveBeenCalledTimes(5);
    expect(transaction.agentRun.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        tenantId: TENANT_ID,
        id: QUEUED_RUN_ID,
        agentId: INSTANCE_ID,
        requesterUserId: USER_ID,
        status: 'QUEUED',
      }),
      data: expect.objectContaining({
        status: 'CANCELLED',
        errorCode: 'ROLE_ASSIGNMENT_REVOKED',
        reservedTokens: 0,
      }),
    });
    const queuedUpdate = transaction.agentRun.updateMany.mock.calls.find(
      ([input]) => input.where.id === QUEUED_RUN_ID,
    )?.[0].data;
    expect(queuedUpdate).not.toHaveProperty('cancellationRequestedAt');
    expect(queuedUpdate).not.toHaveProperty('cancellationReason');
    expect(queuedUpdate).not.toHaveProperty('cancellationConfirmedAt');
    for (const [runId, status] of [
      [DISPATCHING_RUN_ID, 'DISPATCHING'],
      [RUNNING_RUN_ID, 'RUNNING'],
      [UNKNOWN_RUN_ID, 'UNKNOWN'],
      [QUEUED_PROVIDER_RUN_ID, 'QUEUED'],
    ] as const) {
      const call = transaction.agentRun.updateMany.mock.calls.find(
        ([input]) => input.where.id === runId,
      );
      expect(call?.[0]).toMatchObject({
        where: {
          tenantId: TENANT_ID,
          id: runId,
          agentId: INSTANCE_ID,
          requesterUserId: USER_ID,
          status,
        },
        data: {
          cancellationRequestedAt: NOW,
          cancellationReason: 'ROLE_ASSIGNMENT_REVOKED',
        },
      });
      expect(call?.[0].data).not.toHaveProperty('status');
      expect(call?.[0].data).not.toHaveProperty('errorCode');
      expect(call?.[0].data).not.toHaveProperty('finishedAt');
      expect(call?.[0].data).not.toHaveProperty('reservedTokens');
      expect(call?.[0].data).not.toHaveProperty('cancellationConfirmedAt');
    }
    expect(transaction.outboxEvent.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          tenantId: TENANT_ID,
          aggregateId: DISPATCHING_RUN_ID,
          eventType: 'agent.run_cancel_requested.v1',
          payload: expect.objectContaining({
            runId: DISPATCHING_RUN_ID,
            roleAssignmentId: ASSIGNMENT_ID,
            externalRunId: null,
          }),
        }),
        expect.objectContaining({
          tenantId: TENANT_ID,
          aggregateId: RUNNING_RUN_ID,
          eventType: 'agent.run_cancel_requested.v1',
          payload: expect.objectContaining({
            runId: RUNNING_RUN_ID,
            roleAssignmentId: ASSIGNMENT_ID,
            externalRunId: EXTERNAL_RUN_ID,
          }),
        }),
        expect.objectContaining({
          tenantId: TENANT_ID,
          aggregateId: UNKNOWN_RUN_ID,
          eventType: 'agent.run_cancel_requested.v1',
          payload: expect.objectContaining({
            runId: UNKNOWN_RUN_ID,
            roleAssignmentId: ASSIGNMENT_ID,
            externalRunId: UNKNOWN_EXTERNAL_RUN_ID,
          }),
        }),
        expect.objectContaining({
          tenantId: TENANT_ID,
          aggregateId: QUEUED_PROVIDER_RUN_ID,
          eventType: 'agent.run_cancel_requested.v1',
          payload: expect.objectContaining({
            runId: QUEUED_PROVIDER_RUN_ID,
            roleAssignmentId: ASSIGNMENT_ID,
            externalRunId: QUEUED_PROVIDER_EXTERNAL_RUN_ID,
          }),
        }),
      ],
    });
    expect(transaction.auditEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'admin.role_assignment.revoked',
        resourceId: ASSIGNMENT_ID,
        metadata: expect.objectContaining({
          cancelledAgentRunIds: [
            QUEUED_RUN_ID,
            DISPATCHING_RUN_ID,
            RUNNING_RUN_ID,
            UNKNOWN_RUN_ID,
            QUEUED_PROVIDER_RUN_ID,
          ],
          externalCancellationRunIds: [
            DISPATCHING_RUN_ID,
            RUNNING_RUN_ID,
            UNKNOWN_RUN_ID,
            QUEUED_PROVIDER_RUN_ID,
          ],
        }),
      }),
    });
    expect(result.status).toBe('REVOKED');
  });
});

function createService(transaction: Record<string, unknown>): RoleAssignmentAdminService {
  const roleAssignment = (transaction.roleAssignment as Record<string, unknown> | undefined) ?? {};
  roleAssignment.findFirst ??= vi.fn().mockResolvedValue(null);
  transaction.roleAssignment = roleAssignment;
  const prisma = {
    withTenant: vi.fn((_tenantId: string, operation: (value: unknown) => unknown) =>
      operation(transaction),
    ),
  };
  const access = {
    requireDirectoryWrite: vi.fn(() => ({
      tenantId: TENANT_ID,
      userId: ADMIN_ID,
      role: 'ADMIN',
      authenticationSource: 'session',
    })),
  };
  return new RoleAssignmentAdminService(
    prisma as unknown as AdminPrismaService,
    access as unknown as AdminAccessService,
  );
}

function assignmentRecord(overrides: Record<string, unknown> = {}) {
  const createdAt = new Date('2026-07-28T01:00:00.000Z');
  return {
    id: ASSIGNMENT_ID,
    tenantId: TENANT_ID,
    key: 'asg:sales:zhouming',
    idempotencyKey: 'assignment:fixture:001',
    requestHash: '0'.repeat(64),
    userId: USER_ID,
    employmentId: EMPLOYMENT_ID,
    roleTemplateId: '00000000-0000-7000-8000-000000000013',
    roleVersionId: VERSION_ID,
    agentInstanceId: INSTANCE_ID,
    status: 'ACTIVE',
    source: 'LOCAL',
    effectiveFrom: new Date('2026-07-28T01:00:00.000Z'),
    effectiveTo: null,
    organizationScope: { organizationIds: ['sales'] },
    permissionScope: {},
    memoryPolicy: { roleOnly: true },
    delegatedFromAssignmentId: null,
    createdById: ADMIN_ID,
    revokedAt: null,
    revokedById: null,
    revokeReason: null,
    version: 1,
    createdAt,
    updatedAt: createdAt,
    user: { id: USER_ID, displayName: '周明', status: 'ACTIVE' },
    employment: {
      id: EMPLOYMENT_ID,
      organizationId: '00000000-0000-7000-8000-000000000011',
      orgUnitId: '00000000-0000-7000-8000-000000000012',
      positionId: null,
      status: 'ACTIVE',
    },
    agentInstance: {
      id: INSTANCE_ID,
      name: '周明 · 销售',
      status: 'ONLINE',
      versionId: VERSION_ID,
      version: {
        id: VERSION_ID,
        version: 1,
        status: 'PUBLISHED',
        roleDefinitionSnapshot: roleDefinitionSnapshot(),
        blueprintRevision: 1,
        template: {
          id: '00000000-0000-7000-8000-000000000013',
          key: 'sales',
          name: '销售',
        },
      },
    },
    createdBy: { id: ADMIN_ID, displayName: '管理员' },
    revokedBy: null,
    ...overrides,
  };
}

function governedVersion(templateId: string) {
  return {
    id: VERSION_ID,
    templateId,
    status: 'PUBLISHED',
    reviewStatus: 'APPROVED',
    createdById: ADMIN_ID,
    reviewRequestedById: ADMIN_ID,
    reviewedById: USER_ID,
    approvedById: USER_ID,
    blueprintRevision: 1,
    roleDefinitionSnapshot: roleDefinitionSnapshot(),
    template: {
      id: templateId,
      key: 'sales',
      name: '销售',
      mission: 'Deliver governed sales outcomes.',
    },
  };
}

function roleDefinitionSnapshot() {
  return {
    mission: 'Deliver governed sales outcomes.',
    responsibilities: [
      {
        key: 'pipeline',
        name: 'Pipeline',
        description: 'Maintain a verified opportunity pipeline.',
        outcomes: ['Every opportunity has an owner and next action.'],
      },
    ],
    valueDefinition: {
      statement: 'Create verifiable customer value.',
      stakeholderOutcomes: ['Customers receive reliable support.'],
      measures: ['Verified sales outcomes'],
    },
    capabilities: [],
    processes: [],
    tools: [],
    knowledgeDomains: [],
  };
}
