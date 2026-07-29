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
});
