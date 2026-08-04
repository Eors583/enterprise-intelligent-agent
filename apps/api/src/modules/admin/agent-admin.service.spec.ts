import { ConflictException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import type { AdminPrismaService } from '../../database/admin-prisma.service.js';
import type { AdminAccessService } from './admin-access.service.js';
import { AgentAdminService } from './agent-admin.service.js';

const TENANT_ID = '00000000-0000-7000-8000-000000000001';
const USER_ID = '00000000-0000-7000-8000-000000000101';
const AGENT_ID = '00000000-0000-7000-8000-000000000301';
const VERSION_ID = '00000000-0000-7000-8000-000000000701';
const KNOWLEDGE_BASE_ID = '00000000-0000-7000-8000-000000000801';

describe('AgentAdminService governed version changes', () => {
  it('rejects prompt changes instead of creating a directly published Agent Version', async () => {
    const createVersion = vi.fn();
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      agentInstance: {
        findFirst: vi.fn().mockResolvedValue({
          id: AGENT_ID,
          tenantId: TENANT_ID,
          versionId: VERSION_ID,
          version: {
            id: VERSION_ID,
            templateId: '00000000-0000-7000-8000-000000000601',
            systemPrompt: 'approved prompt',
            knowledgeScope: { mode: 'selected', knowledgeBaseIds: [] },
          },
        }),
      },
      agentVersion: { create: createVersion },
    } as unknown as Prisma.TransactionClient;
    const prisma = {
      withTenant: vi.fn(
        async (_tenantId: string, operation: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
          operation(transaction),
      ),
    } as unknown as AdminPrismaService;
    const access = {
      requireDirectoryWrite: vi.fn().mockReturnValue({
        tenantId: TENANT_ID,
        userId: USER_ID,
        role: 'OWNER',
      }),
    } as unknown as AdminAccessService;
    const service = new AgentAdminService(prisma, access);

    await expect(
      service.update(AGENT_ID, {
        expectedVersionId: VERSION_ID,
        systemPrompt: 'unreviewed prompt',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(createVersion).not.toHaveBeenCalled();
  });

  it('stores a validated per-Agent knowledge binding without changing the governed version', async () => {
    const version = {
      id: VERSION_ID,
      templateId: '00000000-0000-7000-8000-000000000601',
      version: 1,
      status: 'PUBLISHED',
      reviewStatus: 'NOT_SUBMITTED',
      systemPrompt: 'approved prompt',
      modelPolicy: { route: 'default' },
      toolPolicy: {},
      knowledgeScope: { mode: 'owner-authorized', knowledgeBaseIds: [] },
      roleDefinitionSnapshot: {},
      blueprintRevision: 1,
    };
    const current = {
      id: AGENT_ID,
      tenantId: TENANT_ID,
      versionId: VERSION_ID,
      name: '个人工作助手',
      summary: null,
      status: 'ONLINE',
      settings: { visibility: 'tenant' },
      updatedAt: new Date('2026-08-03T00:00:00.000Z'),
      ownerUserId: USER_ID,
      kind: 'MEMBER',
      orgUnitId: null,
      owner: { id: USER_ID, displayName: '林晓', status: 'ACTIVE' },
      orgUnit: null,
      version,
      runs: [],
    };
    const updated = {
      ...current,
      settings: {
        visibility: 'tenant',
        knowledgeBaseIdsOverride: [KNOWLEDGE_BASE_ID],
      },
    };
    const createVersion = vi.fn();
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      knowledgeBase: {
        findMany: vi.fn().mockResolvedValue([{ id: KNOWLEDGE_BASE_ID }]),
      },
      agentVersion: {
        create: createVersion,
      },
      agentInstance: {
        findFirst: vi.fn().mockResolvedValue(current),
        update: vi.fn().mockResolvedValue({}),
        findFirstOrThrow: vi.fn().mockResolvedValue(updated),
      },
      auditEvent: { create: vi.fn().mockResolvedValue({}) },
    } as unknown as Prisma.TransactionClient;
    const prisma = {
      withTenant: vi.fn(
        async (_tenantId: string, operation: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
          operation(transaction),
      ),
    } as unknown as AdminPrismaService;
    const access = {
      requireDirectoryWrite: vi.fn().mockReturnValue({
        tenantId: TENANT_ID,
        userId: USER_ID,
        role: 'OWNER',
      }),
    } as unknown as AdminAccessService;
    const service = new AgentAdminService(prisma, access);

    await expect(
      service.update(AGENT_ID, {
        expectedVersionId: VERSION_ID,
        knowledgeBaseIds: [KNOWLEDGE_BASE_ID],
      }),
    ).resolves.toMatchObject({
      versionId: VERSION_ID,
      version: 1,
      configurationGovernance: 'LEGACY',
      knowledgeBaseIds: [KNOWLEDGE_BASE_ID],
    });
    expect(createVersion).not.toHaveBeenCalled();
    expect(transaction.agentInstance.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          settings: expect.objectContaining({
            knowledgeBaseIdsOverride: [KNOWLEDGE_BASE_ID],
          }),
        }),
      }),
    );
  });
});
