import type {
  KnowledgeGraphOverview,
  KnowledgeRelationshipEvidence,
  KnowledgeRetrievalTestResponse,
} from '@enterprise/contracts';
import { describe, expect, it } from 'vitest';

import {
  hasStrongRelationshipRetrieval,
  knowledgeGraphReadinessReasonLabel,
  knowledgeGraphReadinessSummary,
  relationshipEvidencePath,
  relationshipPathEdgeLabel,
} from './knowledge-graph-view';

describe('knowledge graph view model', () => {
  it('does not call a graph ready when evidence coverage has blockers', () => {
    expect(
      knowledgeGraphReadinessSummary(
        overview({
          status: 'DEGRADED',
          entityCount: 4,
          relationCount: 3,
          relationsWithoutEvidenceCount: 1,
          strongRetrievalReady: false,
          readinessBlockers: ['RELATIONS_WITHOUT_EVIDENCE'],
        }),
      ),
    ).toBe('DEGRADED');
    expect(knowledgeGraphReadinessReasonLabel('RELATIONS_WITHOUT_EVIDENCE')).toContain('来源证据');
  });

  it('requires an applied relationship stage, expanded candidates and evidence', () => {
    const strong = retrieval({
      relationshipExpandedCount: 2,
      diagnostics: [
        {
          stage: 'RELATIONSHIP',
          status: 'APPLIED',
          code: 'RELATIONSHIP_EXPANDED',
          candidateCount: 3,
        },
      ],
      items: [
        {
          ...retrieval().items[0]!,
          relationshipScore: 0.8,
          relationshipEvidence: [
            {
              relationId: '00000000-0000-7000-8000-000000000099',
              relationType: 'APPLIES_TO',
              sourceChunkId: '00000000-0000-7000-8000-000000000011',
              sourceEntityName: '差旅制度',
              targetEntityName: '研发部门',
              direction: 'OUTBOUND',
              hopDistance: 1,
              confidence: 0.9,
              contribution: 0.2,
              path: [
                {
                  relationId: '00000000-0000-7000-8000-000000000099',
                  predicate: 'APPLIES_TO',
                  direction: 'OUTBOUND',
                  sourceEntityId: '00000000-0000-7000-8000-000000000097',
                  sourceEntityName: '差旅制度',
                  targetEntityId: '00000000-0000-7000-8000-000000000098',
                  targetEntityName: '研发部门',
                },
              ],
            },
          ],
        },
      ],
    });

    expect(hasStrongRelationshipRetrieval(strong)).toBe(true);
    expect(
      hasStrongRelationshipRetrieval({
        ...strong,
        diagnostics: [
          {
            stage: 'RELATIONSHIP',
            status: 'DEGRADED',
            code: 'RELATIONSHIP_UNAVAILABLE',
            candidateCount: 0,
          },
        ],
      }),
    ).toBe(false);
  });

  it('renders the directed relation path without losing traversal direction', () => {
    const evidence: KnowledgeRelationshipEvidence = {
      relationId: '00000000-0000-7000-8000-000000000099',
      relationType: 'OWNS',
      sourceChunkId: '00000000-0000-7000-8000-000000000011',
      sourceEntityName: '财务部',
      targetEntityName: '差旅制度',
      direction: 'INBOUND',
      hopDistance: 2,
      confidence: 0.9,
      contribution: 0.2,
      path: [
        {
          relationId: '00000000-0000-7000-8000-000000000099',
          predicate: 'OWNS',
          direction: 'INBOUND',
          sourceEntityId: '00000000-0000-7000-8000-000000000096',
          sourceEntityName: '财务部',
          targetEntityId: '00000000-0000-7000-8000-000000000097',
          targetEntityName: '预算规则',
        },
        {
          relationId: '00000000-0000-7000-8000-000000000098',
          predicate: 'APPLIES_TO',
          direction: 'OUTBOUND',
          sourceEntityId: '00000000-0000-7000-8000-000000000097',
          sourceEntityName: '预算规则',
          targetEntityId: '00000000-0000-7000-8000-000000000095',
          targetEntityName: '差旅制度',
        },
      ],
    };

    expect(relationshipEvidencePath(evidence)).toBe(
      '财务部 ← OWNS ← 预算规则 → APPLIES_TO → 差旅制度',
    );
    expect(relationshipPathEdgeLabel(evidence.path[1]!)).toBe('预算规则 → APPLIES_TO → 差旅制度');
  });
});

function overview(overrides: Partial<KnowledgeGraphOverview> = {}): KnowledgeGraphOverview {
  return {
    knowledgeBaseId: '00000000-0000-7000-8000-000000000002',
    status: 'READY',
    entityCount: 4,
    relationCount: 3,
    mentionCount: 8,
    evidenceCount: 3,
    orphanEntityCount: 0,
    relationsWithoutEvidenceCount: 0,
    publishedChunkCount: 5,
    linkedChunkCount: 5,
    mentionCoverage: 1,
    evidenceCoverage: 1,
    entityTypes: [{ type: 'POLICY', count: 4 }],
    relationTypes: [{ predicate: 'APPLIES_TO', count: 3 }],
    strongRetrievalReady: true,
    readinessBlockers: [],
    lastBuiltAt: '2026-07-27T08:00:00.000Z',
    ...overrides,
  };
}

function retrieval(
  overrides: Partial<KnowledgeRetrievalTestResponse> = {},
): KnowledgeRetrievalTestResponse {
  return {
    query: '差旅制度适用于谁？',
    simulatedUserId: '00000000-0000-7000-8000-000000000010',
    accessibleKnowledgeBaseIds: ['00000000-0000-7000-8000-000000000002'],
    mode: 'HYBRID',
    embeddingModel: 'embedding-v2',
    reranker: 'CROSS_ENCODER',
    rerankerModel: 'reranker-v1',
    degradedReason: null,
    lexicalCandidateCount: 10,
    vectorCandidateCount: 10,
    semanticCoverage: 1,
    noAnswer: false,
    elapsedMs: 40,
    items: [
      {
        chunkId: '00000000-0000-7000-8000-000000000011',
        knowledgeBaseId: '00000000-0000-7000-8000-000000000002',
        knowledgeBaseName: '企业制度',
        documentId: '00000000-0000-7000-8000-000000000003',
        documentVersionId: '00000000-0000-7000-8000-000000000004',
        documentVersion: 1,
        title: '差旅制度',
        headingPath: [],
        excerpt: '本制度适用于研发部门。',
        keywordScore: 0.7,
        fuzzyScore: 0.4,
        semanticScore: 0.9,
        fusionScore: 0.8,
        rerankerScore: 0.92,
        finalScore: 0.95,
      },
    ],
    ...overrides,
  };
}
