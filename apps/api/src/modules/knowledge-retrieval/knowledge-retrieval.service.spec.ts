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
import type { KnowledgeVersionResourcePolicy } from './knowledge-resource-authorization.js';
import { KnowledgeRetrievalService } from './knowledge-retrieval.service.js';

const TENANT_ID = '00000000-0000-7000-8000-000000000001';
const USER_ID = '00000000-0000-7000-8000-000000000002';
const KNOWLEDGE_BASE_ID = '00000000-0000-7000-8000-000000000003';
const ORG_UNIT_ID = '00000000-0000-7000-8000-000000000004';
const ORGANIZATION_ID = '00000000-0000-7000-8000-000000000005';
const OTHER_ORG_UNIT_ID = '00000000-0000-7000-8000-000000000006';
const CANDIDATE_VERSION_ID = '00000000-0000-7000-8000-000000000009';

describe('KnowledgeRetrievalService', () => {
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
      include: { orgUnits: true },
    });
    expect(transaction.$queryRaw).not.toHaveBeenCalled();
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

    const result = await service.search(searchInput());

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

    const result = await service.search(searchInput());

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
    relationships as unknown as KnowledgeRelationshipExpander,
    authorization,
  );
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
