import { describe, expect, it } from 'vitest';

import {
  createKnowledgeBaseRequestSchema,
  createKnowledgeEmbeddingIndexVersionRequestSchema,
  knowledgeBaseSchema,
  knowledgeDocumentChunkListResponseSchema,
  knowledgeDocumentSchema,
  knowledgeDocumentSummarySchema,
  knowledgeDocumentVersionDetailSchema,
  importKnowledgeWebDocumentRequestSchema,
  ensureKnowledgeFoldersRequestSchema,
  inspectKnowledgeUploadRequestSchema,
  reviewKnowledgeDocumentGovernanceRequestSchema,
  reviewKnowledgeDocumentParseRequestSchema,
  knowledgeGraphQuerySchema,
  knowledgeGraphRebuildResponseSchema,
  knowledgeGraphOverviewSchema,
  knowledgeGraphResponseSchema,
  knowledgeRetrievalTestResponseSchema,
  publishKnowledgeDocumentVersionRequestSchema,
  rollbackKnowledgeDocumentVersionRequestSchema,
  updateKnowledgeBaseRequestSchema,
  updateKnowledgeDocumentVersionGovernanceRequestSchema,
} from '../src/index.js';

const ORG_UNIT_ID = '00000000-0000-7000-8000-000000000001';
const MEMBER_USER_ID = '00000000-0000-7000-8000-000000000005';
const DOCUMENT_ID = '00000000-0000-7000-8000-000000000003';
const VERSION_ID = '00000000-0000-7000-8000-000000000004';

describe('knowledge administration contracts', () => {
  it('accepts directory paths and files beyond the former 100 MB product limit', () => {
    expect(
      ensureKnowledgeFoldersRequestSchema.parse({ paths: ['企业战略/2026', '企业战略/制度'] }),
    ).toEqual({ paths: ['企业战略/2026', '企业战略/制度'] });
    expect(
      inspectKnowledgeUploadRequestSchema.parse({
        fileName: '战略规划.pdf',
        size: 101 * 1024 * 1024,
        sha256: 'a'.repeat(64),
        folderId: ORG_UNIT_ID,
      }),
    ).toMatchObject({ size: 101 * 1024 * 1024, folderId: ORG_UNIT_ID });
    expect(
      inspectKnowledgeUploadRequestSchema.safeParse({
        fileName: 'beyond-storage-integer.pdf',
        size: 2_147_483_648,
        sha256: 'a'.repeat(64),
      }).success,
    ).toBe(false);
  });

  it('preserves whether a department grant includes descendants', () => {
    const request = createKnowledgeBaseRequestSchema.parse({
      key: 'employee-handbook',
      name: 'Employee handbook',
      orgUnitScopes: [{ orgUnitId: ORG_UNIT_ID, includeChildren: false }],
    });

    expect(request.orgUnitScopes).toEqual([{ orgUnitId: ORG_UNIT_ID, includeChildren: false }]);
    expect(request.orgUnitIds).toEqual([]);
    expect(request.memberUserIds).toEqual([]);
  });

  it('accepts departments and named members as one restricted access audience', () => {
    const request = createKnowledgeBaseRequestSchema.parse({
      name: 'Project delivery knowledge',
      orgUnitScopes: [{ orgUnitId: ORG_UNIT_ID, includeChildren: true }],
      memberUserIds: [MEMBER_USER_ID],
    });

    expect(request.orgUnitScopes).toEqual([{ orgUnitId: ORG_UNIT_ID, includeChildren: true }]);
    expect(request.memberUserIds).toEqual([MEMBER_USER_ID]);
  });

  it('keeps legacy department id updates valid during the API transition', () => {
    expect(
      updateKnowledgeBaseRequestSchema.parse({
        orgUnitIds: [ORG_UNIT_ID],
        expectedVersion: 2,
      }),
    ).toMatchObject({ orgUnitIds: [ORG_UNIT_ID] });
  });

  it('models company, department, project and member as sibling knowledge spaces', () => {
    expect(
      createKnowledgeBaseRequestSchema.parse({
        name: 'Company strategy',
        space: { type: 'COMPANY' },
      }).space,
    ).toEqual({ type: 'COMPANY' });
    expect(
      createKnowledgeBaseRequestSchema.parse({
        name: 'Department goals',
        space: { type: 'DEPARTMENT', targetId: ORG_UNIT_ID },
      }).space,
    ).toEqual({ type: 'DEPARTMENT', targetId: ORG_UNIT_ID });
    expect(
      createKnowledgeBaseRequestSchema.parse({
        name: 'Project delivery',
        space: { type: 'PROJECT', targetName: 'New employee workbench' },
      }).space,
    ).toEqual({ type: 'PROJECT', targetName: 'New employee workbench' });
    expect(
      createKnowledgeBaseRequestSchema.parse({
        name: 'Member skills',
        space: { type: 'MEMBER', targetId: ORG_UNIT_ID },
      }).space,
    ).toEqual({ type: 'MEMBER', targetId: ORG_UNIT_ID });
  });

  it('requires explicit descendant semantics in knowledge-base responses', () => {
    const result = knowledgeBaseSchema.safeParse({
      id: '00000000-0000-7000-8000-000000000002',
      key: 'employee-handbook',
      name: 'Employee handbook',
      description: null,
      status: 'ACTIVE',
      space: {
        type: 'DEPARTMENT',
        targetId: ORG_UNIT_ID,
        targetName: 'Product',
      },
      version: 1,
      retrievalConfig: {
        mode: 'HYBRID',
        topK: 8,
        scoreThreshold: 0.08,
        semanticWeight: 0.7,
        keywordWeight: 0.3,
        rerankEnabled: true,
        relationshipRetrievalEnabled: true,
        maxChunksPerDocument: 3,
      },
      chunkingConfig: { targetTokens: 500, overlapTokens: 80 },
      activeEmbeddingIndexVersion: null,
      pendingEmbeddingIndexVersion: null,
      orgUnitIds: [ORG_UNIT_ID],
      orgUnitScopes: [{ orgUnitId: ORG_UNIT_ID, includeChildren: false }],
      memberUserIds: [MEMBER_USER_ID],
      documentCount: 0,
      folders: [],
      documents: [],
      updatedAt: '2026-07-20T00:00:00.000Z',
    });

    expect(result.success).toBe(true);
  });

  it('accepts model-specific dimensions and rejects unsafe index dimensions', () => {
    expect(
      createKnowledgeEmbeddingIndexVersionRequestSchema.parse({
        provider: 'local_fastembed',
        model: 'local-fastembed:BAAI/bge-m3:pad-1024-v1',
        dimensions: 1024,
      }),
    ).toEqual({
      provider: 'local_fastembed',
      model: 'local-fastembed:BAAI/bge-m3:pad-1024-v1',
      dimensions: 1024,
      distance: 'COSINE',
      normalization: 'L2',
    });
    expect(
      createKnowledgeEmbeddingIndexVersionRequestSchema.safeParse({
        provider: 'local_fastembed',
        model: 'model',
        dimensions: 16_001,
      }).success,
    ).toBe(false);
  });

  it('keeps list summaries separate from full document and version content', () => {
    const summary = {
      id: DOCUMENT_ID,
      knowledgeBaseId: '00000000-0000-7000-8000-000000000002',
      folderId: null,
      folderPath: null,
      title: 'Employee handbook',
      sourceType: 'MARKDOWN',
      mimeType: 'text/markdown',
      fileName: null,
      checksum: null,
      status: 'READY',
      documentVersion: 1,
      currentVersionId: VERSION_ID,
      versions: [],
      updatedAt: '2026-07-20T00:00:00.000Z',
    } as const;

    expect(knowledgeDocumentSummarySchema.parse(summary)).not.toHaveProperty('contentText');
    expect(
      knowledgeDocumentSchema.parse({ ...summary, contentText: '# Full handbook' }),
    ).toHaveProperty('contentText', '# Full handbook');
    expect(
      knowledgeDocumentVersionDetailSchema.parse({
        id: VERSION_ID,
        documentId: DOCUMENT_ID,
        versionNumber: 2,
        sourceType: 'MARKDOWN',
        mimeType: 'text/markdown',
        fileName: null,
        checksum: null,
        status: 'DRAFT',
        changeSummary: null,
        chunkCount: 0,
        createdAt: '2026-07-20T00:00:00.000Z',
        publishedAt: null,
        evaluationRunId: null,
        evaluationDatasetVersionId: null,
        evaluationSnapshotHash: null,
        governance: knowledgeGovernance(),
        ingestionJob: null,
        contentText: '# Unpublished draft',
        graphProjectionId: '00000000-0000-7000-8000-000000000099',
        graphProjectionStatus: 'CANDIDATE',
        graphProjectionHash: 'a'.repeat(64),
      }),
    ).toMatchObject({ documentId: DOCUMENT_ID, contentText: '# Unpublished draft' });
  });

  it('validates explicit version governance and maker-checker review commands', () => {
    const {
      revision: _revision,
      reviewStatus: _reviewStatus,
      reviewedById: _reviewedById,
      reviewedAt: _reviewedAt,
      reviewNote: _reviewNote,
      policyHash: _policyHash,
      ...policy
    } = knowledgeGovernance();
    expect(
      updateKnowledgeDocumentVersionGovernanceRequestSchema.parse({
        expectedRevision: 2,
        policy,
      }),
    ).toMatchObject({
      expectedRevision: 2,
      policy: { scopeMode: 'TENANT', classification: 'INTERNAL' },
    });
    expect(
      reviewKnowledgeDocumentGovernanceRequestSchema.parse({
        decision: 'REJECT',
        expectedRevision: 3,
        note: 'The declared scope is too broad.',
      }),
    ).toEqual({
      decision: 'REJECT',
      expectedRevision: 3,
      note: 'The declared scope is too broad.',
    });
    expect(
      reviewKnowledgeDocumentGovernanceRequestSchema.safeParse({
        decision: 'REJECT',
        expectedRevision: 3,
      }).success,
    ).toBe(false);
  });

  it('requires an explicit current publication id for rollback concurrency control', () => {
    expect(
      rollbackKnowledgeDocumentVersionRequestSchema.parse({
        expectedCurrentVersionId: VERSION_ID,
      }),
    ).toEqual({ expectedCurrentVersionId: VERSION_ID });
    expect(rollbackKnowledgeDocumentVersionRequestSchema.safeParse({}).success).toBe(false);
  });

  it('accepts direct Knowledge Version publication without a release proof', () => {
    expect(publishKnowledgeDocumentVersionRequestSchema.parse({})).toEqual({});
    expect(
      publishKnowledgeDocumentVersionRequestSchema.safeParse({ evaluationRunId: VERSION_ID })
        .success,
    ).toBe(false);
  });

  it('accepts only HTTPS web imports and requires a reason when parse review rejects', () => {
    expect(
      importKnowledgeWebDocumentRequestSchema.parse({
        url: 'https://docs.example.test/handbook',
      }),
    ).toEqual({ url: 'https://docs.example.test/handbook' });
    expect(
      importKnowledgeWebDocumentRequestSchema.safeParse({
        url: 'http://127.0.0.1/internal',
      }).success,
    ).toBe(false);

    expect(
      reviewKnowledgeDocumentParseRequestSchema.parse({
        decision: 'APPROVE',
        expectedReviewRevision: 3,
      }),
    ).toEqual({ decision: 'APPROVE', expectedReviewRevision: 3 });
    expect(
      reviewKnowledgeDocumentParseRequestSchema.safeParse({
        decision: 'REJECT',
        expectedReviewRevision: 3,
      }).success,
    ).toBe(false);
  });

  it('validates paginated chunk previews and semantic coverage metadata', () => {
    expect(
      knowledgeDocumentChunkListResponseSchema.parse({
        documentVersionId: VERSION_ID,
        total: 2,
        offset: 0,
        limit: 50,
        embeddedChunkCount: 1,
        semanticCoverage: 0.5,
        items: [
          {
            id: '00000000-0000-7000-8000-000000000005',
            parentChunkId: '00000000-0000-7000-8000-000000000006',
            previousChunkId: null,
            nextChunkId: '00000000-0000-7000-8000-000000000007',
            chunkIndex: 0,
            headingPath: ['Benefits', 'Leave'],
            parentHeadingPath: ['Benefits', 'Leave'],
            parentExcerpt: 'Employees receive annual leave.',
            content: 'Employees receive annual leave.',
            tokenCount: 8,
            contentHash: 'a'.repeat(64),
            pageStart: 3,
            pageEnd: 4,
            sheetName: null,
            embeddingModels: ['embedding-v1'],
          },
        ],
      }),
    ).toMatchObject({
      total: 2,
      embeddedChunkCount: 1,
      semanticCoverage: 0.5,
    });

    expect(
      knowledgeDocumentChunkListResponseSchema.safeParse({
        documentVersionId: VERSION_ID,
        total: 0,
        offset: 0,
        limit: 101,
        embeddedChunkCount: 0,
        semanticCoverage: 0,
        items: [],
      }).success,
    ).toBe(false);
  });

  it('validates an evidence-backed relationship graph overview', () => {
    const overview = {
      knowledgeBaseId: '00000000-0000-7000-8000-000000000002',
      status: 'READY',
      entityCount: 12,
      relationCount: 8,
      mentionCount: 24,
      evidenceCount: 11,
      orphanEntityCount: 0,
      relationsWithoutEvidenceCount: 0,
      publishedChunkCount: 10,
      linkedChunkCount: 10,
      mentionCoverage: 1,
      evidenceCoverage: 1,
      entityTypes: [
        { type: 'DEPARTMENT', count: 4 },
        { type: 'POLICY', count: 8 },
      ],
      relationTypes: [{ predicate: 'APPLIES_TO', count: 8 }],
      diagnostics: [],
      lastBuiltAt: '2026-07-27T08:00:00.000Z',
    } as const;

    expect(knowledgeGraphOverviewSchema.parse(overview)).toEqual(overview);
    expect(
      knowledgeGraphOverviewSchema.safeParse({
        ...overview,
        status: 'DEGRADED',
        relationsWithoutEvidenceCount: 1,
        diagnostics: ['RELATIONS_WITHOUT_EVIDENCE'],
      }).success,
    ).toBe(true);
    expect(
      knowledgeGraphOverviewSchema.safeParse({
        ...overview,
        linkedChunkCount: 11,
      }).success,
    ).toBe(false);
  });

  it('coerces HTTP graph limits and validates graph rebuild results', () => {
    expect(knowledgeGraphQuerySchema.parse({ limit: '25' })).toEqual({ limit: 25 });
    expect(
      knowledgeGraphRebuildResponseSchema.parse({
        documentVersionId: VERSION_ID,
        entityCount: 5,
        relationCount: 4,
        mentionCount: 7,
        evidenceCount: 4,
      }),
    ).toEqual({
      documentVersionId: VERSION_ID,
      entityCount: 5,
      relationCount: 4,
      mentionCount: 7,
      evidenceCount: 4,
    });
  });

  it('preserves directed relation evidence and graph retrieval diagnostics', () => {
    const response = {
      query: '研发部门适用哪项差旅制度？',
      simulatedUserId: '00000000-0000-7000-8000-000000000010',
      accessibleKnowledgeBaseIds: ['00000000-0000-7000-8000-000000000002'],
      mode: 'HYBRID',
      embeddingModel: 'embedding-v2',
      reranker: 'CROSS_ENCODER',
      rerankerModel: 'reranker-v1',
      degradedReason: null,
      lexicalCandidateCount: 20,
      vectorCandidateCount: 20,
      relationshipCandidateCount: 6,
      relationshipExpandedCount: 2,
      diagnostics: [
        { stage: 'LEXICAL', status: 'APPLIED', code: 'LEXICAL_READY', candidateCount: 20 },
        {
          stage: 'RELATIONSHIP',
          status: 'APPLIED',
          code: 'RELATIONSHIP_EXPANDED',
          candidateCount: 6,
        },
      ],
      semanticCoverage: 1,
      noAnswer: false,
      elapsedMs: 42,
      items: [
        {
          chunkId: '00000000-0000-7000-8000-000000000011',
          knowledgeBaseId: '00000000-0000-7000-8000-000000000002',
          knowledgeBaseName: '企业制度',
          documentId: DOCUMENT_ID,
          documentVersionId: VERSION_ID,
          documentVersion: 2,
          title: '差旅制度',
          headingPath: ['适用范围'],
          pageStart: 3,
          pageEnd: 4,
          sheetName: null,
          sourceMimeType: 'application/pdf',
          sourceFileName: '差旅制度.pdf',
          sourceUri: null,
          sourceDownloadAvailable: true,
          structuredPreviewAvailable: true,
          excerpt: '本制度适用于研发部门。',
          keywordScore: 0.7,
          fuzzyScore: 0.4,
          semanticScore: 0.9,
          fusionScore: 0.8,
          rerankerScore: 0.92,
          relationshipScore: 0.88,
          relationshipEvidence: [
            {
              relationId: '00000000-0000-7000-8000-000000000012',
              relationType: 'APPLIES_TO',
              sourceChunkId: '00000000-0000-7000-8000-000000000011',
              sourceEntityName: '差旅制度',
              targetEntityName: '研发部门',
              direction: 'OUTBOUND',
              hopDistance: 1,
              confidence: 0.96,
              contribution: 0.24,
              path: [
                {
                  relationId: '00000000-0000-7000-8000-000000000012',
                  predicate: 'APPLIES_TO',
                  direction: 'OUTBOUND',
                  sourceEntityId: '00000000-0000-7000-8000-000000000013',
                  sourceEntityName: '差旅制度',
                  targetEntityId: '00000000-0000-7000-8000-000000000014',
                  targetEntityName: '研发部门',
                },
              ],
            },
          ],
          finalScore: 0.95,
        },
      ],
    } as const;

    expect(knowledgeRetrievalTestResponseSchema.parse(response)).toEqual(response);
    expect(
      knowledgeRetrievalTestResponseSchema.safeParse({
        ...response,
        diagnostics: [
          {
            stage: 'RELATIONSHIP',
            status: 'DEGRADED',
            code: 'raw sql error: relation missing',
            candidateCount: 0,
          },
        ],
      }).success,
    ).toBe(false);
    const evidence = response.items[0].relationshipEvidence[0];
    expect(
      knowledgeRetrievalTestResponseSchema.safeParse({
        ...response,
        items: [
          {
            ...response.items[0],
            relationshipEvidence: [
              {
                ...evidence,
                hopDistance: 2,
              },
            ],
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      knowledgeRetrievalTestResponseSchema.safeParse({
        ...response,
        items: [
          {
            ...response.items[0],
            relationshipEvidence: [
              {
                ...evidence,
                path: [
                  ...evidence.path,
                  {
                    ...evidence.path[0],
                    relationId: '00000000-0000-7000-8000-000000000015',
                  },
                  {
                    ...evidence.path[0],
                    relationId: '00000000-0000-7000-8000-000000000016',
                  },
                ],
              },
            ],
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      knowledgeRetrievalTestResponseSchema.safeParse({
        ...response,
        items: [
          {
            ...response.items[0],
            relationshipEvidence: [
              {
                ...evidence,
                path: [
                  {
                    ...evidence.path[0],
                    debugMetadata: 'must-not-leak',
                  },
                ],
              },
            ],
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('validates paginated entity, directed relation and evidence previews', () => {
    const response = {
      knowledgeBaseId: '00000000-0000-7000-8000-000000000002',
      query: null,
      entityType: null,
      focusEntityId: null,
      totalEntities: 2,
      totalRelations: 1,
      entities: [
        {
          id: '00000000-0000-7000-8000-000000000021',
          entityType: 'POLICY',
          canonicalName: '差旅制度',
          description: null,
          aliases: ['出差制度'],
          attributes: { owner: '财务部' },
          confidence: 0.97,
          mentionCount: 3,
          relationCount: 1,
          updatedAt: '2026-07-27T08:00:00.000Z',
        },
      ],
      relations: [
        {
          id: '00000000-0000-7000-8000-000000000022',
          subjectEntityId: '00000000-0000-7000-8000-000000000021',
          subjectEntityName: '差旅制度',
          predicate: 'APPLIES_TO',
          objectEntityId: '00000000-0000-7000-8000-000000000023',
          objectEntityName: '研发部门',
          attributes: {},
          confidence: 0.94,
          evidenceCount: 1,
          evidence: [
            {
              id: '00000000-0000-7000-8000-000000000024',
              chunkId: '00000000-0000-7000-8000-000000000025',
              documentId: DOCUMENT_ID,
              documentVersionId: VERSION_ID,
              excerpt: '本制度适用于研发部门。',
              confidence: 0.96,
            },
          ],
          updatedAt: '2026-07-27T08:00:00.000Z',
        },
      ],
    } as const;

    expect(knowledgeGraphResponseSchema.parse(response)).toEqual(response);
  });
});

function knowledgeGovernance() {
  return {
    ownerUserId: '00000000-0000-7000-8000-000000000005',
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
    revision: 2,
    reviewStatus: 'APPROVED' as const,
    reviewedById: '00000000-0000-7000-8000-000000000006',
    reviewedAt: '2026-07-02T00:00:00.000Z',
    reviewNote: 'Approved.',
    policyHash: 'a'.repeat(64),
  };
}
