import { ConflictException, ForbiddenException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { AdminPrismaService } from '../../database/admin-prisma.service.js';
import type { AdminAccessService } from './admin-access.service.js';
import { RoleBlueprintAdminService } from './role-blueprint-admin.service.js';

const TENANT_ID = '00000000-0000-7000-8000-000000000001';
const AUTHOR_ID = '00000000-0000-7000-8000-000000000002';
const REVIEWER_ID = '00000000-0000-7000-8000-000000000003';
const BLUEPRINT_ID = '00000000-0000-7000-8000-000000000004';
const VERSION_ID = '00000000-0000-7000-8000-000000000005';
const CURRENT_VERSION_ID = '00000000-0000-7000-8000-000000000006';
const ROLLBACK_ID = '00000000-0000-7000-8000-000000000007';

describe('RoleBlueprintAdminService', () => {
  it('submits a draft for review using a revision CAS and audit event', async () => {
    const draft = versionRecord();
    const submitted = versionRecord({
      status: 'TESTING',
      reviewStatus: 'IN_REVIEW',
      revision: 2,
      reviewRequestedAt: new Date(),
      reviewRequestedById: AUTHOR_ID,
    });
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      agentVersion: {
        findFirst: vi.fn().mockResolvedValueOnce(draft).mockResolvedValueOnce(submitted),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      auditEvent: { create: vi.fn().mockResolvedValue({}) },
    };
    const service = createService(transaction, AUTHOR_ID);

    await expect(
      service.submit(BLUEPRINT_ID, VERSION_ID, { expectedRevision: 1 }),
    ).resolves.toMatchObject({
      id: VERSION_ID,
      status: 'TESTING',
      reviewStatus: 'IN_REVIEW',
      revision: 2,
    });
    expect(transaction.agentVersion.updateMany).toHaveBeenCalledWith({
      where: {
        tenantId: TENANT_ID,
        templateId: BLUEPRINT_ID,
        id: VERSION_ID,
        revision: 1,
      },
      data: expect.objectContaining({
        status: 'TESTING',
        reviewStatus: 'IN_REVIEW',
        reviewRequestedById: AUTHOR_ID,
        revision: { increment: 1 },
      }),
    });
    expect(transaction.auditEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'admin.role_version.review_requested' }),
    });
  });

  it('prevents a Role Version author from approving their own submission', async () => {
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      agentVersion: {
        findFirst: vi.fn().mockResolvedValue(
          versionRecord({
            status: 'TESTING',
            reviewStatus: 'IN_REVIEW',
            revision: 2,
            reviewRequestedAt: new Date(),
            reviewRequestedById: AUTHOR_ID,
          }),
        ),
        updateMany: vi.fn(),
      },
    };
    const service = createService(transaction, AUTHOR_ID);

    await expect(
      service.review(BLUEPRINT_ID, VERSION_ID, {
        expectedRevision: 2,
        decision: 'APPROVE',
        comment: 'Looks good.',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(transaction.agentVersion.updateMany).not.toHaveBeenCalled();
  });

  it('prevents the review requester from reviewing another author submission', async () => {
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      agentVersion: {
        findFirst: vi.fn().mockResolvedValue(
          versionRecord({
            createdById: REVIEWER_ID,
            status: 'TESTING',
            reviewStatus: 'IN_REVIEW',
            revision: 2,
            reviewRequestedAt: new Date(),
            reviewRequestedById: AUTHOR_ID,
          }),
        ),
        updateMany: vi.fn(),
      },
    };
    const service = createService(transaction, AUTHOR_ID);

    await expect(
      service.review(BLUEPRINT_ID, VERSION_ID, {
        expectedRevision: 2,
        decision: 'APPROVE',
        comment: 'Looks good.',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(transaction.agentVersion.updateMany).not.toHaveBeenCalled();
  });

  it('publishes a draft directly and retires the former published version', async () => {
    const approved = versionRecord({
      status: 'DRAFT',
      reviewStatus: 'NOT_SUBMITTED',
      revision: 3,
    });
    const published = versionRecord({
      status: 'PUBLISHED',
      reviewStatus: 'APPROVED',
      revision: 4,
      publishedAt: new Date(),
      publishedById: REVIEWER_ID,
    });
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      agentVersion: {
        findFirst: vi
          .fn()
          .mockResolvedValueOnce(approved)
          .mockResolvedValueOnce(approved)
          .mockResolvedValueOnce(published),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      agentInstance: { updateMany: vi.fn().mockResolvedValue({ count: 4 }) },
      auditEvent: { create: vi.fn().mockResolvedValue({}) },
    };
    const service = createService(transaction, REVIEWER_ID);

    await expect(
      service.publish(BLUEPRINT_ID, VERSION_ID, {
        expectedRevision: 3,
      }),
    ).resolves.toMatchObject({ status: 'PUBLISHED', revision: 4 });
    expect(transaction.agentVersion.updateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({
          templateId: BLUEPRINT_ID,
          status: 'PUBLISHED',
          id: { not: VERSION_ID },
        }),
        data: expect.objectContaining({ status: 'RETIRED', retiredById: REVIEWER_ID }),
      }),
    );
    expect(transaction.agentInstance.updateMany).toHaveBeenCalledWith({
      where: {
        tenantId: TENANT_ID,
        version: { is: { templateId: BLUEPRINT_ID } },
      },
      data: { versionId: VERSION_ID },
    });
    expect(transaction.agentVersion.updateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({ id: VERSION_ID, revision: 3 }),
        data: expect.objectContaining({
          status: 'PUBLISHED',
          publishedById: REVIEWER_ID,
          evaluationRunId: null,
          evaluationDatasetVersionId: null,
          evaluationSnapshotHash: null,
        }),
      }),
    );
  });

  it('refuses an explicit retirement while current or scheduled assignments are pinned', async () => {
    const current = versionRecord({
      status: 'PUBLISHED',
      reviewStatus: 'APPROVED',
      revision: 4,
      publishedAt: new Date(),
      publishedById: REVIEWER_ID,
    });
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      agentVersion: {
        findFirst: vi.fn().mockResolvedValue(current),
        updateMany: vi.fn(),
      },
      roleAssignment: { count: vi.fn().mockResolvedValue(2) },
      auditEvent: { create: vi.fn() },
    };
    const service = createService(transaction, REVIEWER_ID);

    await expect(
      service.retire(BLUEPRINT_ID, VERSION_ID, { expectedRevision: 4 }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(transaction.roleAssignment.count).toHaveBeenCalledWith({
      where: {
        tenantId: TENANT_ID,
        roleTemplateId: BLUEPRINT_ID,
        roleVersionId: VERSION_ID,
        status: { in: ['PENDING', 'ACTIVE', 'SUSPENDED'] },
      },
    });
    expect(transaction.agentVersion.updateMany).not.toHaveBeenCalled();
    expect(transaction.auditEvent.create).not.toHaveBeenCalled();
  });

  it('retires a published version after all pinned assignments have ended', async () => {
    const current = versionRecord({
      status: 'PUBLISHED',
      reviewStatus: 'APPROVED',
      revision: 4,
      publishedAt: new Date(),
      publishedById: REVIEWER_ID,
    });
    const retired = versionRecord({
      status: 'RETIRED',
      reviewStatus: 'APPROVED',
      revision: 5,
      retiredAt: new Date(),
      retiredById: REVIEWER_ID,
    });
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      agentVersion: {
        findFirst: vi.fn().mockResolvedValueOnce(current).mockResolvedValueOnce(retired),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      roleAssignment: { count: vi.fn().mockResolvedValue(0) },
      auditEvent: { create: vi.fn().mockResolvedValue({}) },
    };
    const service = createService(transaction, REVIEWER_ID);

    await expect(
      service.retire(BLUEPRINT_ID, VERSION_ID, { expectedRevision: 4 }),
    ).resolves.toMatchObject({ status: 'RETIRED', revision: 5 });
    expect(transaction.agentVersion.updateMany).toHaveBeenCalledWith({
      where: {
        tenantId: TENANT_ID,
        templateId: BLUEPRINT_ID,
        id: VERSION_ID,
        revision: 4,
      },
      data: expect.objectContaining({
        status: 'RETIRED',
        retiredById: REVIEWER_ID,
        revision: { increment: 1 },
      }),
    });
    expect(transaction.auditEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'admin.role_version.retired' }),
    });
  });

  it('creates a rollback draft with lineage without retiring the current published version', async () => {
    const source = versionRecord({
      status: 'RETIRED',
      reviewStatus: 'APPROVED',
      version: 2,
      retiredAt: new Date(),
    });
    const current = versionRecord({
      id: CURRENT_VERSION_ID,
      status: 'PUBLISHED',
      reviewStatus: 'APPROVED',
      version: 4,
      publishedAt: new Date(),
    });
    const rollback = versionRecord({
      id: ROLLBACK_ID,
      status: 'DRAFT',
      reviewStatus: 'NOT_SUBMITTED',
      version: 5,
      rollbackOfVersionId: VERSION_ID,
      createdById: REVIEWER_ID,
    });
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      agentVersion: {
        findFirst: vi
          .fn()
          .mockResolvedValueOnce(source)
          .mockResolvedValueOnce(current)
          .mockResolvedValueOnce({ version: 4 }),
        create: vi.fn().mockResolvedValue(rollback),
      },
      auditEvent: { create: vi.fn().mockResolvedValue({}) },
    };
    const service = createService(transaction, REVIEWER_ID);

    await expect(
      service.rollback(BLUEPRINT_ID, VERSION_ID, {
        expectedPublishedVersionId: CURRENT_VERSION_ID,
        changeSummary: 'Rollback after production regression.',
      }),
    ).resolves.toMatchObject({
      id: ROLLBACK_ID,
      version: 5,
      rollbackOfVersionId: VERSION_ID,
      status: 'DRAFT',
      reviewStatus: 'NOT_SUBMITTED',
    });
    expect(transaction.agentVersion.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        version: 5,
        status: 'DRAFT',
        reviewStatus: 'NOT_SUBMITTED',
        rollbackOfVersionId: VERSION_ID,
        systemPrompt: source.systemPrompt,
        roleDefinitionSnapshot: source.roleDefinitionSnapshot,
        blueprintRevision: source.blueprintRevision,
        createdById: REVIEWER_ID,
      }),
    });
    expect(transaction.agentVersion).not.toHaveProperty('updateMany');
    expect(transaction.auditEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'admin.role_version.rollback_draft_created',
        metadata: expect.objectContaining({
          sourceVersionId: VERSION_ID,
          currentPublishedVersionId: CURRENT_VERSION_ID,
        }),
      }),
    });
  });

  it('captures the current structured blueprint as an immutable draft snapshot', async () => {
    const snapshot = roleDefinitionSnapshot();
    const created = versionRecord({
      roleDefinitionSnapshot: snapshot,
      blueprintRevision: 7,
    });
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      agentTemplate: {
        findFirst: vi.fn().mockResolvedValue({
          id: BLUEPRINT_ID,
          ...snapshot,
          revision: 7,
        }),
      },
      agentVersion: {
        findFirst: vi.fn().mockResolvedValue({ version: 4 }),
        create: vi.fn().mockResolvedValue(created),
      },
      auditEvent: { create: vi.fn().mockResolvedValue({}) },
    };
    const service = createService(transaction, AUTHOR_ID);

    await service.createDraft(BLUEPRINT_ID, {
      systemPrompt: 'Execute this governed enterprise role safely.',
      modelPolicy: {},
      toolPolicy: {},
      knowledgeScope: { knowledgeBaseIds: [] },
      changeSummary: 'Capture blueprint revision seven.',
    });

    expect(transaction.agentVersion.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        roleDefinitionSnapshot: snapshot,
        blueprintRevision: 7,
      }),
    });
  });

  it('rejects inactive or cross-tenant knowledge selections before creating a draft', async () => {
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      agentTemplate: {
        findFirst: vi.fn().mockResolvedValue({
          id: BLUEPRINT_ID,
          ...roleDefinitionSnapshot(),
          revision: 7,
        }),
      },
      knowledgeBase: { findMany: vi.fn().mockResolvedValue([]) },
      agentVersion: { findFirst: vi.fn(), create: vi.fn() },
    };
    const validateKnowledgeBaseSelection = vi
      .fn()
      .mockRejectedValue(new ConflictException('The knowledge selection is unavailable.'));
    const service = createService(transaction, AUTHOR_ID, validateKnowledgeBaseSelection);

    await expect(
      service.createDraft(BLUEPRINT_ID, {
        systemPrompt: 'Execute this governed enterprise role safely.',
        modelPolicy: {},
        toolPolicy: {},
        knowledgeScope: {
          knowledgeBaseIds: ['00000000-0000-7000-8000-000000000109'],
        },
        changeSummary: 'Attempt an invalid knowledge binding.',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(validateKnowledgeBaseSelection).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      userId: AUTHOR_ID,
      knowledgeBaseIds: ['00000000-0000-7000-8000-000000000109'],
    });
    expect(transaction.agentVersion.create).not.toHaveBeenCalled();
  });

  it('returns published assignment candidates with a valid immutable snapshot', async () => {
    const compliant = versionRecord({
      id: VERSION_ID,
      status: 'PUBLISHED',
      reviewStatus: 'APPROVED',
      reviewRequestedAt: new Date(),
      reviewRequestedById: AUTHOR_ID,
      reviewedAt: new Date(),
      reviewedById: REVIEWER_ID,
      approvedAt: new Date(),
      approvedById: REVIEWER_ID,
      roleDefinitionSnapshot: roleDefinitionSnapshot(),
      blueprintRevision: 3,
      template: { id: BLUEPRINT_ID, key: 'sales', name: 'Sales' },
    });
    const invalidSnapshot = {
      ...compliant,
      id: CURRENT_VERSION_ID,
      roleDefinitionSnapshot: { mission: 'incomplete' },
    };
    const transaction = {
      agentVersion: {
        findMany: vi.fn().mockResolvedValue([compliant, invalidSnapshot]),
      },
    };
    const service = createService(transaction, REVIEWER_ID);

    await expect(service.listAssignmentCandidates()).resolves.toMatchObject({
      items: [
        {
          id: VERSION_ID,
          blueprintRevision: 3,
          roleDefinitionSnapshot: roleDefinitionSnapshot(),
        },
      ],
    });
  });
});

function createService(
  transaction: Record<string, unknown>,
  userId: string,
  validateKnowledgeBaseSelection = vi.fn().mockResolvedValue(undefined),
): RoleBlueprintAdminService {
  const prisma = {
    withTenant: vi.fn((_tenantId: string, operation: (value: unknown) => unknown) =>
      operation(transaction),
    ),
  };
  const access = {
    requireDirectoryWrite: vi.fn(() => ({
      tenantId: TENANT_ID,
      userId,
      role: 'ADMIN',
      authenticationSource: 'session',
    })),
  };
  return new RoleBlueprintAdminService(
    prisma as unknown as AdminPrismaService,
    access as unknown as AdminAccessService,
    {
      validateKnowledgeBaseSelection,
    } as never,
  );
}

function versionRecord(overrides: Record<string, unknown> = {}) {
  const createdAt = new Date('2026-07-28T00:00:00.000Z');
  return {
    id: VERSION_ID,
    tenantId: TENANT_ID,
    templateId: BLUEPRINT_ID,
    version: 1,
    status: 'DRAFT',
    reviewStatus: 'NOT_SUBMITTED',
    systemPrompt: 'Act as the governed enterprise role.',
    modelPolicy: {},
    toolPolicy: {},
    knowledgeScope: {},
    roleDefinitionSnapshot: roleDefinitionSnapshot(),
    blueprintRevision: 1,
    changeSummary: 'Initial governed draft.',
    revision: 1,
    createdById: AUTHOR_ID,
    reviewRequestedAt: null,
    reviewRequestedById: null,
    reviewedAt: null,
    reviewedById: null,
    reviewComment: null,
    approvedAt: null,
    approvedById: null,
    publishedAt: null,
    publishedById: null,
    evaluationRunId: null,
    evaluationDatasetVersionId: null,
    evaluationSnapshotHash: null,
    retiredAt: null,
    retiredById: null,
    rollbackOfVersionId: null,
    createdAt,
    ...overrides,
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
