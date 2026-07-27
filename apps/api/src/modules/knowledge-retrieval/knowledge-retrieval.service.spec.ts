import type { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../database/prisma.service.js';
import {
  KnowledgeAiRuntimeError,
  type KnowledgeAiRuntimeClient,
} from '../knowledge-semantic/knowledge-ai-runtime.client.js';
import { KnowledgeRetrievalService } from './knowledge-retrieval.service.js';

const TENANT_ID = '00000000-0000-7000-8000-000000000001';
const USER_ID = '00000000-0000-7000-8000-000000000002';
const KNOWLEDGE_BASE_ID = '00000000-0000-7000-8000-000000000003';
const ORG_UNIT_ID = '00000000-0000-7000-8000-000000000004';

describe('KnowledgeRetrievalService', () => {
  it('uses reciprocal-rank fusion so a chunk present in both candidate lists wins', async () => {
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
      reranker: 'RRF',
      degradedReason: null,
      lexicalCandidateCount: 2,
      vectorCandidateCount: 2,
    });
    expect(result.items.map((item) => item.chunkId)).toEqual(['chunk-b', 'chunk-a', 'chunk-c']);
    expect(result.items[0]?.fusionScore).toBeGreaterThan(result.items[1]?.fusionScore ?? 0);
    expect(result.semanticCoverage).toBeCloseTo(2 / 3);
    expect(transaction.$executeRawUnsafe).toHaveBeenCalledWith('SET LOCAL enable_indexscan = off');
    expect(transaction.$executeRawUnsafe).toHaveBeenCalledWith('SET LOCAL enable_bitmapscan = off');
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

  it('falls back to RRF and exposes a safe reason when the cross-encoder fails', async () => {
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
      reranker: 'RRF',
      rerankerModel: null,
      degradedReason: 'KNOWLEDGE_SEMANTIC_SEARCH_UNAVAILABLE',
    });
    expect(result.items.map((item) => item.chunkId)).toEqual(['chunk-a']);
  });

  it('allows only an explicitly selected draft knowledge base in an admin preview search', async () => {
    const transaction = accessibleTransaction();
    transaction.knowledgeBase.findMany.mockResolvedValue([
      { id: KNOWLEDGE_BASE_ID, status: 'DRAFT', orgUnits: [] },
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
      include: { orgUnits: true },
    });
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
      include: { orgUnits: true },
    });
    expect(transaction.$queryRaw).not.toHaveBeenCalled();
  });
});

function createService(
  transaction: ReturnType<typeof accessibleTransaction>,
  semantic: ReturnType<typeof semanticClient>,
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
  );
}

function accessibleTransaction() {
  return {
    user: { findFirst: vi.fn().mockResolvedValue({ status: 'ACTIVE' }) },
    employment: { findMany: vi.fn().mockResolvedValue([{ orgUnitId: ORG_UNIT_ID }]) },
    orgUnit: { findMany: vi.fn().mockResolvedValue([{ id: ORG_UNIT_ID, parentId: null }]) },
    knowledgeBase: {
      findMany: vi
        .fn()
        .mockResolvedValue([{ id: KNOWLEDGE_BASE_ID, status: 'ACTIVE', orgUnits: [] }]),
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
    updated_at: new Date('2026-07-21T00:00:00.000Z'),
    keyword_score: keywordScore,
    fuzzy_score: fuzzyScore,
  };
}
