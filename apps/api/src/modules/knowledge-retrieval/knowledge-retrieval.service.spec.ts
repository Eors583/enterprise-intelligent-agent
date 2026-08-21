import { ForbiddenException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../database/prisma.service.js';
import { AuthorizationDecisionService } from '../authorization/authorization-decision.service.js';
import {
  KnowledgeAiRuntimeError,
  type KnowledgeAiRuntimeClient,
} from '../knowledge-semantic/knowledge-ai-runtime.client.js';
import type { KnowledgeRelationshipExpander } from './domain/knowledge-relationship-expander.port.js';
import {
  KnowledgeProviderRetrievalError,
  type KnowledgeProviderRetrievalService,
} from '../knowledge-provider/application/knowledge-provider-retrieval.service.js';
import type { KnowledgeVersionResourcePolicy } from './knowledge-resource-authorization.js';
import { KnowledgeRetrievalService } from './knowledge-retrieval.service.js';

const TENANT_ID = '00000000-0000-7000-8000-000000000001';
const USER_ID = '00000000-0000-7000-8000-000000000002';
const KNOWLEDGE_BASE_ID = '00000000-0000-7000-8000-000000000003';
const SECOND_KNOWLEDGE_BASE_ID = '00000000-0000-7000-8000-000000000013';
const ORG_UNIT_ID = '00000000-0000-7000-8000-000000000004';
const ORGANIZATION_ID = '00000000-0000-7000-8000-000000000005';
const OTHER_ORG_UNIT_ID = '00000000-0000-7000-8000-000000000006';
const CANDIDATE_VERSION_ID = '00000000-0000-7000-8000-000000000009';

describe('KnowledgeRetrievalService', () => {
  it('keeps authoritative knowledge access metadata available when local indexing is disabled', async () => {
    const transaction = accessibleTransaction();
    const semantic = semanticClient();
    const service = createService(
      transaction,
      semantic,
      relationshipExpander(),
      new AuthorizationDecisionService(),
      undefined,
      false,
    );

    await expect(
      service.resolveAccessibleKnowledgeBaseIds({
        tenantId: TENANT_ID,
        userId: USER_ID,
      }),
    ).resolves.toEqual([KNOWLEDGE_BASE_ID]);
    await expect(service.search(searchInput())).rejects.toMatchObject({
      code: 'KNOWLEDGE_PROVIDER_RETRIEVAL_UNAVAILABLE',
    });
    await expect(
      service.areChunksAccessible({
        tenantId: TENANT_ID,
        userId: USER_ID,
        knowledgeBaseIds: [KNOWLEDGE_BASE_ID],
        chunks: [],
      }),
    ).resolves.toBe(true);
    expect(semantic.embed).not.toHaveBeenCalled();
    expect(transaction.user.findFirst).toHaveBeenCalled();
  });

  it('accepts an empty evidence recheck when the optional local backend is disabled', async () => {
    const transaction = accessibleTransaction();
    const service = createService(
      transaction,
      semanticClient(),
      relationshipExpander(),
      new AuthorizationDecisionService(),
      undefined,
      false,
    );

    await expect(
      service.areChunksAccessible({
        tenantId: TENANT_ID,
        userId: USER_ID,
        knowledgeBaseIds: [],
        chunks: [],
      }),
    ).resolves.toBe(true);
    expect(transaction.user.findFirst).not.toHaveBeenCalled();
  });

  it('still rejects local evidence when the optional local backend is disabled', async () => {
    const transaction = accessibleTransaction();
    const service = createService(
      transaction,
      semanticClient(),
      relationshipExpander(),
      new AuthorizationDecisionService(),
      undefined,
      false,
    );

    await expect(
      service.areChunksAccessible({
        tenantId: TENANT_ID,
        userId: USER_ID,
        knowledgeBaseIds: [KNOWLEDGE_BASE_ID],
        chunks: [
          {
            chunkId: '00000000-0000-7000-8000-000000000020',
            documentVersionId: '00000000-0000-7000-8000-000000000021',
            knowledgeBaseId: KNOWLEDGE_BASE_ID,
            classification: 'INTERNAL',
            governanceHash: 'a'.repeat(64),
            contentHash: 'b'.repeat(64),
          },
        ],
      }),
    ).resolves.toBe(false);
    expect(transaction.user.findFirst).not.toHaveBeenCalled();
  });

  it('resolves the employee accessible Knowledge Bases from the authoritative admin scope', async () => {
    const transaction = accessibleTransaction();
    transaction.knowledgeBase.findMany.mockResolvedValue([
      {
        id: KNOWLEDGE_BASE_ID,
        status: 'ACTIVE',
        orgUnits: [],
        members: [],
      },
      {
        id: '00000000-0000-7000-8000-000000000007',
        status: 'ACTIVE',
        orgUnits: [],
        members: [{ userId: '00000000-0000-7000-8000-000000000099' }],
      },
    ]);
    const service = createService(transaction, semanticClient());

    await expect(
      service.resolveAccessibleKnowledgeBaseIds({
        tenantId: TENANT_ID,
        userId: USER_ID,
      }),
    ).resolves.toEqual([KNOWLEDGE_BASE_ID]);

    expect(transaction.knowledgeBase.findMany).toHaveBeenCalledWith({
      where: { tenantId: TENANT_ID, status: 'ACTIVE' },
      include: { orgUnits: true, members: true },
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
    });
  });

  it('authorizes before calling the semantic provider or tenant repository', async () => {
    const transaction = accessibleTransaction();
    const semantic = semanticClient();
    const authorization = {
      require: vi.fn(() => {
        throw new ForbiddenException('denied');
      }),
    };
    const service = createService(
      transaction,
      semantic,
      relationshipExpander(),
      authorization as unknown as AuthorizationDecisionService,
    );

    await expect(service.search(searchInput())).rejects.toBeInstanceOf(ForbiddenException);
    expect(authorization.require).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      userId: USER_ID,
      tenantRole: 'MEMBER',
      action: 'knowledge.retrieve',
      resourceTenantId: TENANT_ID,
      risk: 'LOW',
    });
    expect(semantic.embed).not.toHaveBeenCalled();
    expect(transaction.user.findFirst).not.toHaveBeenCalled();
  });

  it('merges authorized Lexiang AI search evidence and rechecks its active binding', async () => {
    const transaction = accessibleTransaction();
    transaction.$queryRaw.mockResolvedValue([]);
    const provider = {
      search: vi.fn().mockResolvedValue({
        searchedKnowledgeBaseIds: [KNOWLEDGE_BASE_ID],
        items: [
          {
            evidenceId: 'evidence-1',
            knowledgeBaseId: KNOWLEDGE_BASE_ID,
            knowledgeBaseName: '咨询圈文库资料1',
            title: '华为客户关系',
            content: '客户关系管理需要持续维护关键人和合作记录。',
            sourceUri: 'https://lexiangla.com/pages/page-1',
            score: 0.92,
            updatedAt: new Date('2026-08-13T00:00:00.000Z'),
          },
        ],
      }),
      areKnowledgeBasesRetrievable: vi.fn().mockResolvedValue(true),
    };
    const service = createService(
      transaction,
      semanticClient({ semanticEnabled: false }),
      relationshipExpander(),
      new AuthorizationDecisionService(),
      undefined,
      true,
      provider,
    );

    const result = await service.search({ ...searchInput(), query: '华为客户关系' });

    expect(provider.search).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      userId: USER_ID,
      knowledgeBaseIds: [KNOWLEDGE_BASE_ID],
      query: '华为客户关系',
      limit: 8,
    });
    expect(result.diagnostics).toContainEqual({
      stage: 'EXTERNAL',
      status: 'APPLIED',
      code: 'LEXIANG_AI_SEARCH_APPLIED',
      candidateCount: 1,
    });
    expect(result.items[0]).toMatchObject({
      knowledgeBaseId: KNOWLEDGE_BASE_ID,
      title: '华为客户关系',
      sourceProvider: 'LEXIANG',
      sourceUri: 'https://lexiangla.com/pages/page-1',
      sourceType: 'WEB',
      classification: 'INTERNAL',
      finalScore: 0.92,
    });
    expect(result.items[0]?.chunkId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );

    await expect(
      service.areChunksAccessible({
        tenantId: TENANT_ID,
        userId: USER_ID,
        knowledgeBaseIds: [KNOWLEDGE_BASE_ID],
        chunks: result.items.map((item) => ({
          chunkId: item.chunkId,
          documentVersionId: item.documentVersionId,
          knowledgeBaseId: item.knowledgeBaseId,
          ...(item.sourceProvider === undefined ? {} : { sourceProvider: item.sourceProvider }),
          classification: item.classification,
          governanceHash: item.governanceHash,
          contentHash: item.contentHash,
        })),
      }),
    ).resolves.toBe(true);
    expect(provider.areKnowledgeBasesRetrievable).toHaveBeenCalledWith(TENANT_ID, USER_ID, [
      KNOWLEDGE_BASE_ID,
    ]);
  });

  it('uses the external provider when local indexing is disabled', async () => {
    const transaction = accessibleTransaction();
    const provider = {
      search: vi.fn().mockResolvedValue({
        searchedKnowledgeBaseIds: [KNOWLEDGE_BASE_ID],
        items: [
          {
            evidenceId: 'external-evidence',
            knowledgeBaseId: KNOWLEDGE_BASE_ID,
            knowledgeBaseName: '企业资料',
            title: '客户关系',
            content: '客户关系内容',
            sourceUri: 'https://lexiangla.com/pages/page-1',
            score: 0.9,
            updatedAt: new Date('2026-08-13T00:00:00.000Z'),
          },
        ],
      }),
      areKnowledgeBasesRetrievable: vi.fn().mockResolvedValue(true),
    };
    const service = createService(
      transaction,
      semanticClient(),
      relationshipExpander(),
      new AuthorizationDecisionService(),
      undefined,
      false,
      provider,
    );

    const result = await service.search(searchInput());

    expect(provider.search).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      userId: USER_ID,
      knowledgeBaseIds: [KNOWLEDGE_BASE_ID],
      query: 'policy',
      limit: 8,
    });
    expect(result.items[0]).toMatchObject({ sourceProvider: 'LEXIANG' });
    expect(result.degradedReason).toBeNull();
  });

  it('does not turn a remote-only provider outage into a successful empty search', async () => {
    const transaction = accessibleTransaction();
    const provider = {
      search: vi
        .fn()
        .mockRejectedValue(
          new KnowledgeProviderRetrievalError('LEXIANG_SEARCH_UNAVAILABLE', [KNOWLEDGE_BASE_ID]),
        ),
      areKnowledgeBasesRetrievable: vi.fn().mockResolvedValue(true),
    };
    const service = createService(
      transaction,
      semanticClient(),
      relationshipExpander(),
      new AuthorizationDecisionService(),
      undefined,
      false,
      provider,
    );

    await expect(service.search(searchInput())).rejects.toMatchObject({
      code: 'LEXIANG_SEARCH_UNAVAILABLE',
    });
  });

  it('does not report no matches when an accessible remote-only base has no search target', async () => {
    const transaction = accessibleTransaction();
    const provider = {
      search: vi.fn().mockResolvedValue({ searchedKnowledgeBaseIds: [], items: [] }),
      areKnowledgeBasesRetrievable: vi.fn().mockResolvedValue(false),
    };
    const service = createService(
      transaction,
      semanticClient(),
      relationshipExpander(),
      new AuthorizationDecisionService(),
      undefined,
      false,
      provider,
    );

    await expect(service.search(searchInput())).rejects.toMatchObject({
      code: 'LEXIANG_SEARCH_TARGET_UNAVAILABLE',
    });
  });

  it('uses configured weighted fusion so a chunk present in both candidate lists wins', async () => {
    const lexicalRows = [
      candidate('chunk-a', 'document-a', 6, 1),
      candidate('chunk-b', 'document-b', 5, 0.8),
    ];
    const vectorRows = [
      { ...candidate('chunk-b', 'document-b', 0, 0), semantic_score: 0.85 },
      { ...candidate('chunk-c', 'document-c', 0, 0), semantic_score: 0.7 },
    ];
    const transaction = accessibleTransaction();
    transaction.$queryRaw.mockResolvedValueOnce(lexicalRows).mockResolvedValueOnce(vectorRows);
    const semantic = semanticClient();
    const service = createService(transaction, semantic);

    const result = await service.search(searchInput());

    expect(result).toMatchObject({
      mode: 'HYBRID',
      embeddingModel: 'embedding-model-v1',
      reranker: 'WEIGHTED_SCORE',
      degradedReason: null,
      lexicalCandidateCount: 2,
      vectorCandidateCount: 2,
    });
    expect(result.items.map((item) => item.chunkId)).toEqual(['chunk-b', 'chunk-c', 'chunk-a']);
    expect(result.items[0]?.fusionScore).toBeGreaterThan(result.items[1]?.fusionScore ?? 0);
    expect(result.semanticCoverage).toBeCloseTo(2 / 3);
    expect(transaction.$executeRawUnsafe).toHaveBeenCalledWith('SET LOCAL enable_indexscan = off');
    expect(transaction.$executeRawUnsafe).toHaveBeenCalledWith('SET LOCAL enable_bitmapscan = off');
  });

  it('fans out compatible Knowledge Bases across Qdrant collections without scanning PostgreSQL text', async () => {
    const transaction = accessibleTransaction();
    transaction.knowledgeBase.findMany.mockResolvedValue([
      knowledgeBaseRecord(
        KNOWLEDGE_BASE_ID,
        'collection-a',
        '00000000-0000-7000-8000-000000000099',
      ),
      knowledgeBaseRecord(
        SECOND_KNOWLEDGE_BASE_ID,
        'collection-b',
        '00000000-0000-7000-8000-000000000199',
      ),
    ]);
    transaction.$queryRaw.mockResolvedValueOnce([
      { ...candidate('chunk-a', 'document-a', 0, 0), semantic_score: 1 },
      {
        ...candidate('chunk-b', 'document-b', 0, 0),
        knowledge_base_id: SECOND_KNOWLEDGE_BASE_ID,
        semantic_score: 0.9,
      },
    ]);
    const searchIndex = {
      driver: 'qdrant' as const,
      query: vi
        .fn()
        .mockResolvedValueOnce([{ chunkId: 'chunk-a', score: 0.9 }])
        .mockResolvedValueOnce([{ chunkId: 'chunk-b', score: 0.8 }]),
    };
    const service = createService(
      transaction,
      semanticClient(),
      relationshipExpander(),
      new AuthorizationDecisionService(),
      searchIndex,
    );

    const result = await service.search({
      ...searchInput(),
      knowledgeBaseIds: [KNOWLEDGE_BASE_ID, SECOND_KNOWLEDGE_BASE_ID],
    });

    expect(searchIndex.query).toHaveBeenCalledTimes(2);
    expect(searchIndex.query).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        knowledgeBaseIds: [KNOWLEDGE_BASE_ID],
        profile: expect.objectContaining({ collectionName: 'collection-a' }),
      }),
    );
    expect(searchIndex.query).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        knowledgeBaseIds: [SECOND_KNOWLEDGE_BASE_ID],
        profile: expect.objectContaining({ collectionName: 'collection-b' }),
      }),
    );
    expect(transaction.$queryRaw).toHaveBeenCalledOnce();
    expect(transaction.$executeRawUnsafe).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      degradedReason: null,
      lexicalCandidateCount: 0,
      vectorCandidateCount: 2,
    });
  });

  it('returns no evidence for a semantically nearby result without direct support', async () => {
    const transaction = accessibleTransaction();
    transaction.$queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { ...candidate('chunk-unrelated', 'document-unrelated', 0, 0), semantic_score: 0.98 },
      ]);
    const service = createService(transaction, semanticClient());

    const result = await service.search({
      ...searchInput(),
      query: 'What is the authorization code for lunar base Zephyr?',
    });

    expect(result.items).toEqual([]);
    expect(result.vectorCandidateCount).toBe(1);
  });

  it('keeps an exact quoted source hit when document instructions surround the evidence', async () => {
    const transaction = accessibleTransaction();
    transaction.knowledgeBase.findMany.mockResolvedValue([
      knowledgeBaseRecord(
        KNOWLEDGE_BASE_ID,
        'collection-a',
        '00000000-0000-7000-8000-000000000099',
      ),
    ]);
    transaction.$queryRaw.mockResolvedValueOnce([
      {
        ...candidate('chunk-table', 'document-table', 0, 0),
        title: 'quarterly-service-metrics',
        content:
          'Service Q1 uptime Q2 uptime Average Payment API 0.999 0.998 Identity API 0.997 0.999',
        semantic_score: 1,
      },
    ]);
    const searchIndex = {
      driver: 'qdrant' as const,
      query: vi.fn().mockResolvedValue([{ chunkId: 'chunk-table', score: 1 }]),
    };
    const service = createService(
      transaction,
      semanticClient(),
      relationshipExpander(),
      new AuthorizationDecisionService(),
      searchIndex,
    );

    const result = await service.search({
      ...searchInput(),
      query:
        '请根据《quarterly-service-metrics》“正文”说明这段原文的含义：Service、Q1 uptime、Q2 uptime、Average、Payment API、0.999、0.998、Identity API、0.997、0.999',
    });

    expect(result.items.map((item) => item.chunkId)).toEqual(['chunk-table']);
    expect(result.lexicalCandidateCount).toBe(0);
  });

  it('uses a quoted section heading to break equal hybrid-score ties', async () => {
    const transaction = accessibleTransaction();
    transaction.knowledgeBase.findMany.mockResolvedValue([
      knowledgeBaseRecord(
        KNOWLEDGE_BASE_ID,
        'collection-a',
        '00000000-0000-7000-8000-000000000099',
      ),
    ]);
    const sharedExcerpt =
      'Enterprise Incident Dashboard Owner Platform Operations P1 response target 15 minutes';
    transaction.$queryRaw.mockResolvedValueOnce([
      {
        ...candidate('chunk-a', 'document-policy', 0, 0),
        heading_path: ['Policy owner'],
        content: sharedExcerpt,
        semantic_score: 1,
      },
      {
        ...candidate('chunk-z', 'document-policy', 0, 0),
        heading_path: ['Escalation evidence'],
        content: sharedExcerpt,
        semantic_score: 1,
      },
    ]);
    const searchIndex = {
      driver: 'qdrant' as const,
      query: vi.fn().mockResolvedValue([
        { chunkId: 'chunk-a', score: 1 },
        { chunkId: 'chunk-z', score: 1 },
      ]),
    };
    const service = createService(
      transaction,
      semanticClient(),
      relationshipExpander(),
      new AuthorizationDecisionService(),
      searchIndex,
    );

    const result = await service.search({
      ...searchInput(),
      query:
        '员工查阅《incident-response-policy》的“Escalation evidence”时，应如何理解原文“Enterprise Incident Dashboard Owner Platform Operations P1 response target 15 minutes”？',
    });

    expect(result.items.map((item) => item.chunkId)).toEqual(['chunk-z', 'chunk-a']);
  });

  it('degrades to lexical retrieval with an explicit safe reason when embedding fails', async () => {
    const transaction = accessibleTransaction();
    transaction.$queryRaw.mockResolvedValueOnce([candidate('chunk-a', 'document-a', 6, 0.9)]);
    const semantic = semanticClient();
    semantic.embed.mockRejectedValue(
      new KnowledgeAiRuntimeError('EMBEDDING_PROVIDER_UNAVAILABLE', true),
    );
    const service = createService(transaction, semantic);

    const result = await service.search(searchInput());

    expect(result).toMatchObject({
      mode: 'LEXICAL',
      embeddingModel: null,
      reranker: 'LEXICAL',
      degradedReason: 'EMBEDDING_PROVIDER_UNAVAILABLE',
      lexicalCandidateCount: 1,
      vectorCandidateCount: 0,
    });
    expect(result.items.map((item) => item.chunkId)).toEqual(['chunk-a']);
    expect(transaction.$queryRaw).toHaveBeenCalledOnce();
    expect(transaction.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  it('keeps late Chinese query terms so natural questions can recall an exact answer phrase', async () => {
    const transaction = accessibleTransaction();
    transaction.$queryRaw.mockResolvedValueOnce([
      candidate('chunk-canary', 'document-canary', 1, 0),
    ]);
    const service = createService(transaction, semanticClient({ semanticEnabled: false }));

    const result = await service.search({
      ...searchInput(),
      query: '请告诉我知识库验收口令是什么',
    });

    expect(result.items.map((item) => item.chunkId)).toEqual(['chunk-canary']);
    const query = transaction.$queryRaw.mock.calls[0]?.[0] as Prisma.Sql;
    expect(query.strings.join('')).toContain('chunk."content" ILIKE');
    expect(query.values).toContain('%验收%');
    expect(query.values).toContain('%口令%');
  });

  it('uses a configured TopK below the default when the caller does not override the limit', async () => {
    const transaction = accessibleTransaction();
    transaction.knowledgeBase.findMany.mockResolvedValue([
      {
        id: KNOWLEDGE_BASE_ID,
        status: 'ACTIVE',
        orgUnits: [],
        members: [],
        retrievalTopK: 1,
      },
    ]);
    transaction.$queryRaw.mockResolvedValueOnce([
      candidate('chunk-a', 'document-a', 6, 0.9),
      candidate('chunk-b', 'document-b', 5, 0.8),
    ]);
    const service = createService(transaction, semanticClient({ semanticEnabled: false }));

    const input = searchInput();
    const result = await service.search({
      tenantId: input.tenantId,
      userId: input.userId,
      knowledgeBaseIds: input.knowledgeBaseIds,
      query: input.query,
    });

    expect(result.items.map((item) => item.chunkId)).toEqual(['chunk-a']);
  });

  it('labels results as lexical when the active embedding model has no vector candidates', async () => {
    const transaction = accessibleTransaction();
    transaction.$queryRaw
      .mockResolvedValueOnce([candidate('chunk-a', 'document-a', 6, 0.9)])
      .mockResolvedValueOnce([]);
    const semantic = semanticClient({ rerankEnabled: true });
    const service = createService(transaction, semantic);

    const result = await service.search(searchInput());

    expect(result).toMatchObject({
      mode: 'LEXICAL',
      embeddingModel: 'embedding-model-v1',
      reranker: 'LEXICAL',
      degradedReason: 'KNOWLEDGE_VECTOR_CANDIDATES_EMPTY',
      lexicalCandidateCount: 1,
      vectorCandidateCount: 0,
    });
    expect(result.items.map((item) => item.chunkId)).toEqual(['chunk-a']);
    expect(semantic.rerank).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'no active employment',
      employments: [],
      activeOrgUnits: [{ id: ORG_UNIT_ID, parentId: null }],
    },
    {
      label: 'only an employment in an archived department',
      employments: [{ orgUnitId: ORG_UNIT_ID }],
      activeOrgUnits: [],
    },
  ])(
    'returns no accessible knowledge for a member with $label',
    async ({ employments, activeOrgUnits }) => {
      const transaction = accessibleTransaction();
      transaction.employment.findMany.mockResolvedValue(employments);
      transaction.orgUnit.findMany.mockResolvedValue(activeOrgUnits);
      const semantic = semanticClient({ semanticEnabled: false });
      const service = createService(transaction, semantic);

      const result = await service.search(searchInput());

      expect(result).toMatchObject({
        accessibleKnowledgeBaseIds: [],
        mode: 'LEXICAL',
        items: [],
        lexicalCandidateCount: 0,
        vectorCandidateCount: 0,
      });
      expect(transaction.$queryRaw).not.toHaveBeenCalled();
      expect(semantic.embed).not.toHaveBeenCalled();
    },
  );

  it('filters cross-organization and cross-role chunks even when they share an accessible knowledge base', async () => {
    const transaction = accessibleTransaction();
    transaction.orgUnit.findMany.mockResolvedValue([
      { id: ORG_UNIT_ID, parentId: null, organizationId: ORGANIZATION_ID },
      {
        id: OTHER_ORG_UNIT_ID,
        parentId: null,
        organizationId: '00000000-0000-7000-8000-000000000007',
      },
    ]);
    transaction.$queryRaw.mockResolvedValueOnce([
      {
        ...candidate('chunk-allowed', 'document-allowed', 6, 0.9),
        metadata: { orgUnitId: ORG_UNIT_ID, dataLabels: ['role:hr'] },
        resource_policy: restrictedResourcePolicy({
          organizationScopeIds: [ORG_UNIT_ID],
          dataLabels: ['role:hr'],
        }),
      },
      {
        ...candidate('chunk-other-org', 'document-other-org', 6, 0.9),
        metadata: { orgUnitId: OTHER_ORG_UNIT_ID, dataLabels: ['role:hr'] },
        resource_policy: restrictedResourcePolicy({
          organizationScopeIds: [OTHER_ORG_UNIT_ID],
          dataLabels: ['role:hr'],
        }),
      },
      {
        ...candidate('chunk-other-role', 'document-other-role', 6, 0.9),
        metadata: { orgUnitId: ORG_UNIT_ID, dataLabels: ['role:finance'] },
        resource_policy: restrictedResourcePolicy({
          organizationScopeIds: [ORG_UNIT_ID],
          dataLabels: ['role:finance'],
        }),
      },
    ]);
    const service = createService(transaction, semanticClient({ semanticEnabled: false }));

    const result = await service.search({
      ...searchInput(),
      authorization: {
        tenantRole: 'MEMBER',
        assignment: {
          id: '00000000-0000-7000-8000-000000000008',
          tenantId: TENANT_ID,
          userId: USER_ID,
          status: 'ACTIVE',
          effectiveFrom: '2026-07-01T00:00:00.000Z',
          effectiveTo: null,
          employmentActive: true,
          organizationScope: {
            organizationIds: [ORG_UNIT_ID],
            includeDescendants: false,
          },
          dataLabels: ['role:hr'],
          permissionActions: ['knowledge.retrieve'],
        },
        taskContext: { taskId: 'role-workbench-run' },
      },
    });

    expect(result.items.map((item) => item.chunkId)).toEqual(['chunk-allowed']);
    expect(result.lexicalCandidateCount).toBe(1);
  });

  it('falls back to weighted fusion and exposes a safe reason when the cross-encoder fails', async () => {
    const transaction = accessibleTransaction();
    transaction.$queryRaw
      .mockResolvedValueOnce([candidate('chunk-a', 'document-a', 6, 0.9)])
      .mockResolvedValueOnce([
        { ...candidate('chunk-a', 'document-a', 0, 0), semantic_score: 0.9 },
      ]);
    const semantic = semanticClient({ rerankEnabled: true });
    semantic.rerank.mockRejectedValue(new Error('must not be exposed'));
    const service = createService(transaction, semantic);

    const result = await service.search(searchInput());

    expect(result).toMatchObject({
      mode: 'HYBRID',
      reranker: 'WEIGHTED_SCORE',
      rerankerModel: null,
      degradedReason: 'KNOWLEDGE_SEMANTIC_SEARCH_UNAVAILABLE',
    });
    expect(result.items.map((item) => item.chunkId)).toEqual(['chunk-a']);
  });

  it('temporarily bypasses reranking after an interactive timeout', async () => {
    vi.useFakeTimers();
    try {
      const transaction = accessibleTransaction();
      transaction.$queryRaw.mockResolvedValue([
        { ...candidate('chunk-a', 'document-a', 0, 0), semantic_score: 0.9 },
      ]);
      const semantic = semanticClient({ rerankEnabled: true });
      semantic.rerank.mockImplementation(
        async (_tenant, _query, _documents, _topN, _classification, signal) =>
          new Promise((_, reject) =>
            signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
          ),
      );
      const service = createService(transaction, semantic);

      const first = service.search(searchInput());
      await vi.advanceTimersByTimeAsync(3_001);
      await expect(first).resolves.toMatchObject({
        degradedReason: 'KNOWLEDGE_RERANK_TIMEOUT_FALLBACK',
      });

      await expect(service.search(searchInput())).resolves.toMatchObject({
        degradedReason: 'KNOWLEDGE_RERANK_CIRCUIT_OPEN_FALLBACK',
      });
      expect(semantic.rerank).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to weighted fusion when the cross-encoder filters every valid vector candidate', async () => {
    const transaction = accessibleTransaction();
    transaction.$queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { ...candidate('chunk-a', 'document-a', 0, 0), semantic_score: 0.9 },
      ]);
    const semantic = semanticClient({ rerankEnabled: true });
    semantic.rerank.mockResolvedValue({
      model: 'local-reranker',
      results: [{ id: 'chunk-a', relevanceScore: 0.01 }],
    });
    const service = createService(transaction, semantic);

    const result = await service.search(searchInput());

    expect(result).toMatchObject({
      mode: 'HYBRID',
      reranker: 'WEIGHTED_SCORE',
      rerankerModel: null,
      degradedReason: 'KNOWLEDGE_RERANK_NO_RESULT_FALLBACK',
    });
    expect(result.items.map((item) => item.chunkId)).toEqual(['chunk-a']);
  });

  it('reranks a bounded evidence window around a query match in a long chunk', async () => {
    const transaction = accessibleTransaction();
    const longCandidate = {
      ...candidate('chunk-a', 'document-a', 6, 0.9),
      content: `${'prefix '.repeat(1_000)}needle evidence${' suffix'.repeat(1_000)}`,
    };
    transaction.$queryRaw
      .mockResolvedValueOnce([longCandidate])
      .mockResolvedValueOnce([{ ...longCandidate, semantic_score: 0.9 }]);
    const semantic = semanticClient({ rerankEnabled: true });
    semantic.rerank.mockResolvedValue({
      model: 'local-reranker',
      results: [{ id: 'chunk-a', relevanceScore: 0.9 }],
    });
    const service = createService(transaction, semantic);

    const result = await service.search({ ...searchInput(), query: 'needle' });

    expect(result.items.map((item) => item.chunkId)).toEqual(['chunk-a']);
    const rerankDocuments = semantic.rerank.mock.calls[0]?.[2] as
      readonly { readonly text: string }[] | undefined;
    expect(rerankDocuments?.[0]?.text).toContain('needle evidence');
    expect(rerankDocuments?.[0]?.text.length).toBeLessThanOrEqual(1_500);
  });

  it('does not embed a confidential query and degrades to lexical retrieval', async () => {
    const transaction = accessibleTransaction();
    transaction.$queryRaw.mockResolvedValueOnce([candidate('chunk-a', 'document-a', 6, 0.9)]);
    const semantic = semanticClient();
    const service = createService(transaction, semantic);

    const result = await service.search({
      ...searchInput(),
      query: 'contact employee@example.com',
    });

    expect(semantic.embed).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      mode: 'LEXICAL',
      degradedReason: 'KNOWLEDGE_EMBEDDING_CLASSIFICATION_NOT_APPROVED',
    });
  });

  it('does not send sensitive candidates to the cross-encoder', async () => {
    const sensitive = {
      ...candidate('chunk-a', 'document-a', 6, 0.9),
      knowledge_classification: 'SENSITIVE' as const,
    };
    const transaction = accessibleTransaction();
    transaction.$queryRaw
      .mockResolvedValueOnce([sensitive])
      .mockResolvedValueOnce([{ ...sensitive, semantic_score: 0.9 }]);
    const semantic = semanticClient({ rerankEnabled: true });
    const service = createService(transaction, semantic);

    const result = await service.search(searchInput());

    expect(semantic.rerank).not.toHaveBeenCalled();
    expect(result.degradedReason).toBe('KNOWLEDGE_RERANK_CLASSIFICATION_NOT_APPROVED');
    expect(result.items[0]?.classification).toBe('CONFIDENTIAL');
  });

  it('revalidates classification, governance hash, content hash, and version before dispatch', async () => {
    const chunkId = '00000000-0000-7000-8000-000000000007';
    const documentVersionId = '00000000-0000-7000-8000-000000000008';
    const transaction = accessibleTransaction();
    transaction.$queryRaw.mockResolvedValue([
      {
        chunk_id: chunkId,
        document_version_id: documentVersionId,
        content_hash: 'b'.repeat(64),
        governance_hash: 'a'.repeat(64),
        classification: 'SENSITIVE',
      },
    ]);
    const service = createService(transaction, semanticClient({ semanticEnabled: false }));
    const expectedChunk = {
      chunkId,
      documentVersionId,
      classification: 'CONFIDENTIAL' as const,
      governanceHash: 'a'.repeat(64),
      contentHash: 'b'.repeat(64),
    };
    const input = {
      tenantId: TENANT_ID,
      userId: USER_ID,
      knowledgeBaseIds: [KNOWLEDGE_BASE_ID],
      chunks: [expectedChunk],
    };

    await expect(
      service.areChunksAccessibleInTransaction(
        transaction as unknown as Prisma.TransactionClient,
        input,
      ),
    ).resolves.toBe(true);
    await expect(
      service.areChunksAccessibleInTransaction(transaction as unknown as Prisma.TransactionClient, {
        ...input,
        chunks: [{ ...expectedChunk, governanceHash: 'c'.repeat(64) }],
      }),
    ).resolves.toBe(false);
  });

  it('allows only an explicitly selected draft knowledge base in an admin preview search', async () => {
    const transaction = accessibleTransaction();
    transaction.knowledgeBase.findMany.mockResolvedValue([
      { id: KNOWLEDGE_BASE_ID, status: 'DRAFT', orgUnits: [], members: [] },
    ]);
    transaction.$queryRaw.mockResolvedValueOnce([
      candidate('chunk-draft', 'document-draft', 6, 0.9),
    ]);
    const service = createService(transaction, semanticClient({ semanticEnabled: false }));

    const result = await service.search({
      ...searchInput(),
      previewDraftKnowledgeBaseIds: [KNOWLEDGE_BASE_ID, 'not-requested'],
    });

    expect(result.items.map((item) => item.chunkId)).toEqual(['chunk-draft']);
    expect(transaction.knowledgeBase.findMany).toHaveBeenCalledWith({
      where: {
        tenantId: TENANT_ID,
        id: { in: [KNOWLEDGE_BASE_ID] },
        OR: [{ status: 'ACTIVE' }, { status: 'DRAFT', id: { in: [KNOWLEDGE_BASE_ID] } }],
      },
      include: { orgUnits: true, members: true },
    });
  });

  it('restricts an admin candidate preview to the exact version and candidate graph projection', async () => {
    const transaction = accessibleTransaction();
    transaction.$queryRaw.mockResolvedValueOnce([
      {
        ...candidate('chunk-candidate', 'document-candidate', 6, 0.9),
        document_version_id: CANDIDATE_VERSION_ID,
      },
    ]);
    const relationships = relationshipExpander();
    const service = createService(
      transaction,
      semanticClient({ semanticEnabled: false }),
      relationships,
    );

    const result = await service.search({
      ...searchInput(),
      query: 'Which policy relationship applies to this preview?',
      previewKnowledgeVersionIds: [CANDIDATE_VERSION_ID],
    });

    expect(result.items.map((item) => item.documentVersionId)).toEqual([CANDIDATE_VERSION_ID]);
    expect(relationships.expand).toHaveBeenCalledWith(
      transaction,
      expect.objectContaining({
        previewKnowledgeVersionIds: [CANDIDATE_VERSION_ID],
      }),
    );
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: 'RELATIONSHIP',
          status: 'SKIPPED',
          code: 'KNOWLEDGE_RELATIONSHIP_CANDIDATES_EMPTY',
        }),
      ]),
    );
    const query = transaction.$queryRaw.mock.calls[0]?.[0] as Prisma.Sql;
    expect(query.strings.join('')).toContain('chunk."document_version_id" IN');
    expect(query.values).toContain(CANDIDATE_VERSION_ID);
  });

  it('keeps ordinary Agent Run retrieval restricted to active knowledge bases', async () => {
    const transaction = accessibleTransaction();
    transaction.knowledgeBase.findMany.mockResolvedValue([]);
    const service = createService(transaction, semanticClient({ semanticEnabled: false }));

    const result = await service.search(searchInput());

    expect(result.items).toEqual([]);
    expect(transaction.knowledgeBase.findMany).toHaveBeenCalledWith({
      where: {
        tenantId: TENANT_ID,
        id: { in: [KNOWLEDGE_BASE_ID] },
        OR: [{ status: 'ACTIVE' }],
      },
      include: { orgUnits: true, members: true },
    });
    expect(transaction.$queryRaw).not.toHaveBeenCalled();
  });

  it('does not run graph expansion for an ordinary document query with base candidates', async () => {
    const transaction = accessibleTransaction();
    transaction.$queryRaw.mockResolvedValueOnce([candidate('chunk-a', 'document-a', 6, 0.9)]);
    const relationships = relationshipExpander();
    const service = createService(
      transaction,
      semanticClient({ semanticEnabled: false }),
      relationships,
    );

    const result = await service.search({ ...searchInput(), query: 'What is the travel policy?' });

    expect(relationships.expand).not.toHaveBeenCalled();
    expect(result.items.map((item) => item.chunkId)).toEqual(['chunk-a']);
    expect(result.diagnostics).toContainEqual({
      stage: 'RELATIONSHIP',
      status: 'SKIPPED',
      code: 'KNOWLEDGE_RELATIONSHIP_ROUTE_NOT_SELECTED',
      candidateCount: 0,
    });
  });

  it('expands an authorized relationship target and returns explainable scoring evidence', async () => {
    const transaction = accessibleTransaction();
    transaction.$queryRaw.mockResolvedValueOnce([candidate('chunk-a', 'document-a', 6, 0.9)]);
    const relationships = relationshipExpander();
    relationships.expand.mockResolvedValue([
      {
        chunkId: 'chunk-related',
        knowledgeBaseId: KNOWLEDGE_BASE_ID,
        knowledgeBaseName: 'Enterprise handbook',
        documentId: 'document-related',
        documentVersionId: 'version-related',
        documentVersion: 1,
        title: 'Required approval form',
        headingPath: ['Approval'],
        content: 'Use this form after the policy applies.',
        sourceType: 'MARKDOWN',
        classification: 'INTERNAL',
        governanceHash: 'a'.repeat(64),
        contentHash: 'b'.repeat(64),
        updatedAt: new Date('2026-07-27T00:00:00.000Z'),
        metadata: {},
        resourcePolicy: tenantResourcePolicy(),
        evidence: [
          {
            relationId: 'relation-a',
            relationType: 'REQUIRES',
            sourceChunkId: 'chunk-a',
            targetChunkId: 'chunk-related',
            sourceEntityName: 'Travel policy',
            targetEntityName: 'Approval form',
            direction: 'OUTBOUND',
            hopDistance: 1,
            confidence: 0.95,
            sourceSeedScore: 0,
            path: [
              {
                relationId: 'relation-a',
                predicate: 'REQUIRES',
                direction: 'OUTBOUND',
                sourceEntityId: 'entity-policy',
                sourceEntityName: 'Travel policy',
                targetEntityId: 'entity-form',
                targetEntityName: 'Approval form',
              },
            ],
          },
        ],
      },
    ]);
    const service = createService(
      transaction,
      semanticClient({ semanticEnabled: false }),
      relationships,
    );

    const result = await service.search({
      ...searchInput(),
      query: 'What relationship requires the approval form?',
    });

    expect(result.relationshipCandidateCount).toBe(1);
    expect(result.relationshipExpandedCount).toBe(1);
    expect(result.diagnostics).toContainEqual({
      stage: 'RELATIONSHIP',
      status: 'APPLIED',
      code: 'KNOWLEDGE_RELATIONSHIP_EXPANSION_APPLIED',
      candidateCount: 1,
    });
    expect(result.items.map((item) => item.chunkId)).toEqual(['chunk-a', 'chunk-related']);
    expect(result.items[1]).toMatchObject({
      relationshipScore: expect.any(Number),
      relationshipEvidence: [
        {
          relationId: 'relation-a',
          relationType: 'REQUIRES',
          sourceChunkId: 'chunk-a',
          sourceEntityName: 'Travel policy',
          targetEntityName: 'Approval form',
          direction: 'OUTBOUND',
          hopDistance: 1,
          confidence: 0.95,
          contribution: expect.any(Number),
          path: [
            {
              relationId: 'relation-a',
              predicate: 'REQUIRES',
              direction: 'OUTBOUND',
              sourceEntityId: 'entity-policy',
              sourceEntityName: 'Travel policy',
              targetEntityId: 'entity-form',
              targetEntityName: 'Approval form',
            },
          ],
        },
      ],
    });
  });

  it('uses a direct entity-name match as a graph seed when lexical and vector recall are empty', async () => {
    const transaction = accessibleTransaction();
    transaction.$queryRaw.mockResolvedValueOnce([]);
    const relationships = relationshipExpander();
    relationships.expand.mockResolvedValue([
      {
        chunkId: 'chunk-related',
        knowledgeBaseId: KNOWLEDGE_BASE_ID,
        knowledgeBaseName: 'Enterprise handbook',
        documentId: 'document-related',
        documentVersionId: 'version-related',
        documentVersion: 1,
        title: 'Supplier approval',
        headingPath: ['Approval'],
        content: 'Supplier approval requirements.',
        sourceType: 'MARKDOWN',
        classification: 'INTERNAL',
        governanceHash: 'a'.repeat(64),
        contentHash: 'b'.repeat(64),
        updatedAt: new Date('2026-07-27T00:00:00.000Z'),
        metadata: {},
        resourcePolicy: tenantResourcePolicy(),
        evidence: [
          {
            relationId: 'relation-direct',
            relationType: 'REQUIRES',
            sourceChunkId: 'direct-entity-seed-chunk',
            targetChunkId: 'chunk-related',
            sourceEntityName: 'Vendor onboarding',
            targetEntityName: 'Supplier approval',
            direction: 'OUTBOUND',
            hopDistance: 1,
            confidence: 0.9,
            sourceSeedScore: 1,
            path: [
              {
                relationId: 'relation-direct',
                predicate: 'REQUIRES',
                direction: 'OUTBOUND',
                sourceEntityId: 'entity-vendor',
                sourceEntityName: 'Vendor onboarding',
                targetEntityId: 'entity-approval',
                targetEntityName: 'Supplier approval',
              },
            ],
          },
        ],
      },
    ]);
    const service = createService(
      transaction,
      semanticClient({ semanticEnabled: false }),
      relationships,
    );

    const result = await service.search({ ...searchInput(), query: 'vendor-onboarding-alias' });

    expect(relationships.expand).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        seedChunkIds: [],
        query: 'vendor-onboarding-alias',
      }),
    );
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      chunkId: 'chunk-related',
      relationshipScore: expect.any(Number),
    });
  });

  it('keeps base retrieval usable and emits a safe diagnostic when graph expansion fails', async () => {
    const transaction = accessibleTransaction();
    transaction.$queryRaw.mockResolvedValueOnce([candidate('chunk-a', 'document-a', 6, 0.9)]);
    const relationships = relationshipExpander();
    relationships.expand.mockRejectedValue(new Error('relation table unavailable: secret detail'));
    const service = createService(
      transaction,
      semanticClient({ semanticEnabled: false }),
      relationships,
    );

    const result = await service.search({
      ...searchInput(),
      query: 'What relationship does the travel policy depend on?',
    });

    expect(result.items.map((item) => item.chunkId)).toEqual(['chunk-a']);
    expect(result.degradedReason).toBe('KNOWLEDGE_RELATIONSHIP_GRAPH_UNAVAILABLE');
    expect(result.diagnostics).toContainEqual({
      stage: 'RELATIONSHIP',
      status: 'DEGRADED',
      code: 'KNOWLEDGE_RELATIONSHIP_GRAPH_UNAVAILABLE',
      candidateCount: 0,
    });
    expect(JSON.stringify(result)).not.toContain('secret detail');
  });
});

function createService(
  transaction: ReturnType<typeof accessibleTransaction>,
  semantic: ReturnType<typeof semanticClient>,
  relationships: ReturnType<typeof relationshipExpander> = relationshipExpander(),
  authorization: AuthorizationDecisionService = new AuthorizationDecisionService(),
  searchIndex: {
    readonly driver: 'postgres' | 'qdrant';
    readonly query: ReturnType<typeof vi.fn>;
  } = {
    driver: 'postgres',
    query: vi.fn().mockResolvedValue([]),
  },
  localBackendEnabled = true,
  providerRetrieval?: Pick<
    KnowledgeProviderRetrievalService,
    'search' | 'areKnowledgeBasesRetrievable'
  >,
): KnowledgeRetrievalService {
  const prisma = {
    withTenant: vi.fn(
      (_tenantId: string, operation: (value: Prisma.TransactionClient) => Promise<unknown>) =>
        operation(transaction as unknown as Prisma.TransactionClient),
    ),
  };
  return new KnowledgeRetrievalService(
    prisma as unknown as PrismaService,
    semantic as unknown as KnowledgeAiRuntimeClient,
    searchIndex as never,
    relationships as unknown as KnowledgeRelationshipExpander,
    authorization,
    { tryQuery: vi.fn().mockResolvedValue(null) } as never,
    {
      get: vi.fn().mockReturnValue(localBackendEnabled),
    } as never,
    providerRetrieval as KnowledgeProviderRetrievalService | undefined,
  );
}

function knowledgeBaseRecord(id: string, collectionName: string, indexVersionId: string) {
  return {
    id,
    status: 'ACTIVE' as const,
    orgUnits: [],
    members: [],
    activeEmbeddingIndexVersion: {
      id: indexVersionId,
      provider: 'ai-runtime',
      model: 'embedding-model-v1',
      dimensions: 1_536,
      distance: 'COSINE',
      collectionName,
    },
  };
}

function accessibleTransaction() {
  return {
    user: { findFirst: vi.fn().mockResolvedValue({ status: 'ACTIVE' }) },
    employment: { findMany: vi.fn().mockResolvedValue([{ orgUnitId: ORG_UNIT_ID }]) },
    orgUnit: {
      findMany: vi
        .fn()
        .mockResolvedValue([{ id: ORG_UNIT_ID, parentId: null, organizationId: ORGANIZATION_ID }]),
    },
    knowledgeBase: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: KNOWLEDGE_BASE_ID,
          status: 'ACTIVE',
          orgUnits: [],
          members: [],
          activeEmbeddingIndexVersion: {
            id: '00000000-0000-7000-8000-000000000099',
            provider: 'legacy_runtime',
            model: 'embedding-model-v1',
            dimensions: 1_536,
            distance: 'COSINE',
            collectionName: null,
          },
        },
      ]),
    },
    $queryRaw: vi.fn(),
    $executeRawUnsafe: vi.fn().mockResolvedValue(0),
  };
}

function semanticClient(overrides: { semanticEnabled?: boolean; rerankEnabled?: boolean } = {}) {
  return {
    semanticEnabled: overrides.semanticEnabled ?? true,
    rerankEnabled: overrides.rerankEnabled ?? false,
    vectorSearchMode: 'exact' as const,
    embed: vi.fn().mockResolvedValue({
      model: 'embedding-model-v1',
      dimensions: 1_536,
      vectors: [Array<number>(1_536).fill(0.01)],
      inputTokens: 3,
    }),
    rerank: vi.fn(),
  };
}

function relationshipExpander() {
  return {
    expand: vi.fn().mockResolvedValue([]),
  };
}

function searchInput() {
  return {
    tenantId: TENANT_ID,
    userId: USER_ID,
    knowledgeBaseIds: [KNOWLEDGE_BASE_ID],
    query: 'policy',
    limit: 8,
  };
}

function candidate(chunkId: string, documentId: string, keywordScore: number, fuzzyScore: number) {
  return {
    chunk_id: chunkId,
    knowledge_base_id: KNOWLEDGE_BASE_ID,
    knowledge_base_name: 'Enterprise handbook',
    document_id: documentId,
    document_version_id: `version-${documentId}`,
    document_version: 1,
    title: `Title ${documentId}`,
    heading_path: ['Policy'],
    content: `Content ${documentId}`,
    source_type: 'MARKDOWN' as const,
    knowledge_classification: 'INTERNAL' as const,
    governance_hash: 'a'.repeat(64),
    content_hash: 'b'.repeat(64),
    updated_at: new Date('2026-07-21T00:00:00.000Z'),
    metadata: {},
    resource_policy: tenantResourcePolicy(),
    keyword_score: keywordScore,
    fuzzy_score: fuzzyScore,
  };
}

function tenantResourcePolicy(): KnowledgeVersionResourcePolicy {
  return {
    ownerUserId: USER_ID,
    classification: 'INTERNAL' as const,
    scopeMode: 'TENANT' as const,
    organizationScopeIds: [],
    projectScopeIds: [],
    taskScopeIds: [],
    roleTemplateScopeIds: [],
    dataLabels: [],
    effectiveFrom: '2026-07-01T00:00:00.000Z',
    expiresAt: null,
    retentionUntil: null,
    retentionAction: 'ARCHIVE' as const,
    supersedesVersionId: null,
    reviewStatus: 'APPROVED' as const,
    policyHash: 'a'.repeat(64),
  };
}

function restrictedResourcePolicy(
  overrides: Partial<KnowledgeVersionResourcePolicy> = {},
): KnowledgeVersionResourcePolicy {
  return {
    ...tenantResourcePolicy(),
    scopeMode: 'RESTRICTED' as const,
    ...overrides,
  };
}
