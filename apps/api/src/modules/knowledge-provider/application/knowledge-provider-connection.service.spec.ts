import { describe, expect, it, vi } from 'vitest';

import type { AdminPrismaService } from '../../../database/admin-prisma.service.js';
import type { AdminPrincipal } from '../../admin/admin-access.service.js';
import { LexiangCredentialVault } from '../infrastructure/lexiang/lexiang-credential-vault.js';
import type { LexiangSpaceClient } from '../infrastructure/lexiang/lexiang-space.client.js';
import {
  LexiangProviderError,
  type LexiangTokenProvider,
} from '../infrastructure/lexiang/lexiang-token.provider.js';
import { KnowledgeProviderConnectionService } from './knowledge-provider-connection.service.js';

const PRINCIPAL: AdminPrincipal = {
  tenantId: '00000000-0000-7000-8000-000000000001',
  userId: '00000000-0000-7000-8000-000000000002',
  role: 'ADMIN',
  authenticationSource: 'session',
};
const CONNECTION_ID = '00000000-0000-7000-8000-000000000003';

describe('KnowledgeProviderConnectionService', () => {
  it('returns partial discovery results when Lexiang hides a bound team scope', async () => {
    const service = createService({}, testVault(), vi.fn().mockResolvedValue('access-token'), {
      listTeams: vi.fn().mockRejectedValue(new LexiangProviderError('LEXIANG_FORBIDDEN', 403)),
      listTenantManagers: vi.fn().mockResolvedValue([{ staffId: 'staff-1', name: '张三' }]),
    });

    await expect(
      service.discover({ appKey: 'lexiang-app', appSecret: 'write-only-secret' }),
    ).resolves.toEqual({
      teamStatus: 'FORBIDDEN',
      operatorStatus: 'AVAILABLE',
      teams: [],
      operators: [{ staffId: 'staff-1', name: '张三' }],
    });
  });

  it('verifies Lexiang before encrypting and persisting the write-only secret', async () => {
    const vault = testVault();
    const tokenGet = vi.fn().mockResolvedValue('access-token');
    const upsert = vi.fn().mockImplementation(({ create }) => ({
      ...create,
      version: 1,
      createdAt: new Date('2026-08-13T03:00:00.000Z'),
      updatedAt: new Date('2026-08-13T03:00:00.000Z'),
    }));
    const transaction = {
      knowledgeProviderConnection: {
        findUnique: vi.fn().mockResolvedValue({
          id: CONNECTION_ID,
          appKey: 'lexiang-app',
          teamId: 'team-1',
          operatorStaffId: 'staff-1',
        }),
        upsert,
      },
      knowledgeExternalSpaceBinding: { count: vi.fn().mockResolvedValue(0) },
      auditEvent: { create: vi.fn().mockResolvedValue({}) },
    };
    const service = createService(transaction, vault, tokenGet);

    const result = await service.connect(PRINCIPAL, {
      appKey: 'lexiang-app',
      appSecret: 'write-only-secret',
      teamId: 'team-1',
      operatorStaffId: 'staff-1',
    });

    expect(tokenGet).toHaveBeenCalledWith(
      CONNECTION_ID,
      { appKey: 'lexiang-app', appSecret: 'write-only-secret' },
      true,
    );
    const create = upsert.mock.calls[0]?.[0].create as { credentialCiphertext: string };
    expect(create.credentialCiphertext).not.toContain('write-only-secret');
    expect(
      vault.decrypt(create.credentialCiphertext, {
        tenantId: PRINCIPAL.tenantId,
        appKey: 'lexiang-app',
      }),
    ).toBe('write-only-secret');
    expect(result.connection).toMatchObject({
      id: CONNECTION_ID,
      status: 'ACTIVE',
      appKeyHint: 'lexi…-app',
      teamId: 'team-1',
      operatorStaffId: 'staff-1',
      credentialsConfigured: true,
    });
    expect(JSON.stringify(result)).not.toContain('write-only-secret');
  });

  it('records a sanitized unavailable state when a real health check fails', async () => {
    const vault = testVault();
    const credentialCiphertext = vault.encrypt('stored-secret', {
      tenantId: PRINCIPAL.tenantId,
      appKey: 'lexiang-app',
    });
    const current = {
      id: CONNECTION_ID,
      tenantId: PRINCIPAL.tenantId,
      provider: 'LEXIANG' as const,
      status: 'ACTIVE' as const,
      appKey: 'lexiang-app',
      teamId: 'team-1',
      operatorStaffId: 'staff-1',
      credentialCiphertext,
      lastHealthAt: null,
      lastHealthCode: null,
      version: 1,
      createdAt: new Date('2026-08-13T03:00:00.000Z'),
      updatedAt: new Date('2026-08-13T03:00:00.000Z'),
    };
    const update = vi.fn().mockImplementation(({ data }) => ({
      ...current,
      ...data,
      status: data.status,
      lastHealthAt: data.lastHealthAt,
      lastHealthCode: data.lastHealthCode,
      version: 2,
    }));
    const transaction = {
      knowledgeProviderConnection: {
        findUnique: vi.fn().mockResolvedValue(current),
        update,
      },
      auditEvent: { create: vi.fn().mockResolvedValue({}) },
    };
    const tokenGet = vi.fn().mockRejectedValue(new LexiangProviderError('LEXIANG_FORBIDDEN', 403));
    const service = createService(transaction, vault, tokenGet);

    await expect(service.checkHealth(PRINCIPAL)).resolves.toMatchObject({
      reachable: false,
      connection: { status: 'UNAVAILABLE', lastHealthCode: 'LEXIANG_FORBIDDEN' },
      message: expect.stringContaining('应用权限'),
    });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: CONNECTION_ID },
        data: expect.objectContaining({
          status: 'UNAVAILABLE',
          lastHealthCode: 'LEXIANG_FORBIDDEN',
        }),
      }),
    );
  });
});

function testVault(): LexiangCredentialVault {
  return new LexiangCredentialVault('primary', new Map([['primary', Buffer.alloc(32, 7)]]));
}

function createService(
  transaction: Record<string, unknown>,
  vault: LexiangCredentialVault,
  tokenGet: ReturnType<typeof vi.fn>,
  spaceOverrides: Partial<LexiangSpaceClient> = {},
): KnowledgeProviderConnectionService {
  const prisma = {
    withTenant: vi.fn((_tenantId: string, operation: (value: unknown) => unknown) =>
      operation(transaction),
    ),
  } as unknown as AdminPrismaService;
  const tokens = { get: tokenGet, invalidate: vi.fn() } as unknown as LexiangTokenProvider;
  const spaces = {
    verifyTeam: vi.fn().mockResolvedValue(undefined),
    listTeams: vi.fn().mockResolvedValue([]),
    listTenantManagers: vi.fn().mockResolvedValue([]),
    ...spaceOverrides,
  } as unknown as LexiangSpaceClient;
  return new KnowledgeProviderConnectionService(prisma, vault, tokens, spaces);
}
