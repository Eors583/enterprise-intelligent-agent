import { describe, expect, it, vi } from 'vitest';

import type { AdminPrismaService } from '../../../database/admin-prisma.service.js';
import type { LexiangClient } from '../infrastructure/lexiang/lexiang.client.js';
import type { LexiangCredentialVault } from '../infrastructure/lexiang/lexiang-credential-vault.js';
import { LexiangProviderError } from '../infrastructure/lexiang/lexiang-token.provider.js';
import {
  KnowledgeProviderRetrievalError,
  KnowledgeProviderRetrievalService,
} from './knowledge-provider-retrieval.service.js';

const TENANT_ID = '00000000-0000-7000-8000-000000000001';
const KNOWLEDGE_BASE_ID = '00000000-0000-7000-8000-000000000002';
const USER_ID = '00000000-0000-7000-8000-000000000003';

describe('KnowledgeProviderRetrievalService', () => {
  it('searches an active Lexiang space with the connection identity and explicit space scope', async () => {
    const findMany = vi.fn().mockResolvedValue([target()]);
    const decrypt = vi.fn().mockReturnValue('app-secret');
    const search = vi.fn().mockResolvedValue([
      {
        evidenceId: 'evidence-1',
        title: '华为客户关系',
        content: '客户关系管理内容',
        url: 'https://lexiangla.com/pages/page-1',
        score: 0.91,
        externalSpaceId: 'space-1',
      },
    ]);
    const service = createService(findMany, decrypt, search);

    await expect(
      service.search({
        tenantId: TENANT_ID,
        userId: USER_ID,
        knowledgeBaseIds: [KNOWLEDGE_BASE_ID],
        query: '华为客户关系',
        limit: 8,
      }),
    ).resolves.toMatchObject({
      searchedKnowledgeBaseIds: [KNOWLEDGE_BASE_ID],
      items: [
        {
          knowledgeBaseId: KNOWLEDGE_BASE_ID,
          knowledgeBaseName: '咨询圈文库资料1',
          sourceUri: 'https://lexiangla.com/pages/page-1',
        },
      ],
    });
    expect(decrypt).toHaveBeenCalledWith('ciphertext', {
      tenantId: TENANT_ID,
      appKey: 'app-key',
    });
    expect(search).toHaveBeenCalledWith({
      connectionId: 'connection-1',
      credential: { appKey: 'app-key', appSecret: 'app-secret' },
      staffId: 'operator-staff-1',
      query: '华为客户关系',
      targets: [{ type: 'space', id: 'space-1' }],
      topN: 8,
    });
  });

  it('returns no target without calling Lexiang when no active binding is available', async () => {
    const search = vi.fn();
    const service = createService(vi.fn().mockResolvedValue([]), vi.fn(), search);

    await expect(
      service.search({
        tenantId: TENANT_ID,
        userId: USER_ID,
        knowledgeBaseIds: [KNOWLEDGE_BASE_ID],
        query: '客户关系',
        limit: 5,
      }),
    ).resolves.toEqual({ searchedKnowledgeBaseIds: [], items: [] });
    expect(search).not.toHaveBeenCalled();
  });

  it('fails closed when the connection has no operator identity', async () => {
    const findMany = vi.fn().mockResolvedValue([target({ operatorStaffId: null })]);
    const search = vi.fn();
    const service = createService(findMany, vi.fn(), search);

    await expect(
      service.search({
        tenantId: TENANT_ID,
        userId: USER_ID,
        knowledgeBaseIds: [KNOWLEDGE_BASE_ID],
        query: '客户关系',
        limit: 5,
      }),
    ).resolves.toEqual({ searchedKnowledgeBaseIds: [], items: [] });
    expect(findMany).toHaveBeenCalledOnce();
    expect(search).not.toHaveBeenCalled();
  });

  it('exposes a stable provider error code without leaking credentials', async () => {
    const service = createService(
      vi.fn().mockResolvedValue([target()]),
      vi.fn().mockReturnValue('app-secret'),
      vi.fn().mockRejectedValue(new LexiangProviderError('LEXIANG_FORBIDDEN', 403)),
    );

    await expect(
      service.search({
        tenantId: TENANT_ID,
        userId: USER_ID,
        knowledgeBaseIds: [KNOWLEDGE_BASE_ID],
        query: '客户关系',
        limit: 5,
      }),
    ).rejects.toEqual(
      new KnowledgeProviderRetrievalError('LEXIANG_FORBIDDEN', [KNOWLEDGE_BASE_ID]),
    );
  });
});

function createService(
  findMany: ReturnType<typeof vi.fn>,
  decrypt: ReturnType<typeof vi.fn>,
  search: ReturnType<typeof vi.fn>,
): KnowledgeProviderRetrievalService {
  const prisma = {
    withTenant: vi.fn((_tenantId: string, operation: (transaction: unknown) => Promise<unknown>) =>
      operation({
        knowledgeExternalSpaceBinding: { findMany },
      }),
    ),
  };
  return new KnowledgeProviderRetrievalService(
    prisma as unknown as AdminPrismaService,
    { decrypt } as unknown as LexiangCredentialVault,
    { search } as unknown as LexiangClient,
  );
}

function target(overrides: { readonly operatorStaffId?: string | null } = {}) {
  return {
    knowledgeBaseId: KNOWLEDGE_BASE_ID,
    externalSpaceId: 'space-1',
    lastSyncedAt: new Date('2026-08-13T00:00:00.000Z'),
    updatedAt: new Date('2026-08-13T00:00:00.000Z'),
    knowledgeBase: { name: '咨询圈文库资料1' },
    connection: {
      id: 'connection-1',
      appKey: 'app-key',
      credentialCiphertext: 'ciphertext',
      operatorStaffId:
        'operatorStaffId' in overrides ? overrides.operatorStaffId : 'operator-staff-1',
    },
  };
}
