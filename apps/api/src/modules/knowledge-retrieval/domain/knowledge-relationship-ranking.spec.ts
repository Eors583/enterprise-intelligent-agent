import { describe, expect, it } from 'vitest';

import type { KnowledgeRelationshipTargetRecord } from './knowledge-relationship-expander.port.js';
import { rankKnowledgeRelationshipTargets } from './knowledge-relationship-ranking.js';

describe('rankKnowledgeRelationshipTargets', () => {
  it('combines independent relationship evidence with a bounded saturating score', () => {
    const result = rankKnowledgeRelationshipTargets({
      seeds: [
        { chunkId: 'seed-a', rank: 1, relevanceScore: 0.9 },
        { chunkId: 'seed-b', rank: 2, relevanceScore: 0.7 },
      ],
      accessibleKnowledgeBaseIds: ['kb-a'],
      targets: [
        target('target-a', 'kb-a', [
          evidence('relation-a', 'seed-a', 'target-a', 'DEPENDS_ON', 0.9),
          evidence('relation-b', 'seed-b', 'target-a', 'REFERENCES', 0.8),
        ]),
      ],
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.relationshipScore).toBeGreaterThan(result[0]?.evidence[0]?.contribution ?? 1);
    expect(result[0]?.relationshipScore).toBeLessThanOrEqual(1);
    expect(result[0]?.evidence.map((item) => item.relationId)).toEqual([
      'relation-a',
      'relation-b',
    ]);
  });

  it('fails closed for inaccessible targets, unseeded edges, self loops, and malformed evidence', () => {
    const result = rankKnowledgeRelationshipTargets({
      seeds: [{ chunkId: 'seed-a', rank: 1, relevanceScore: 1 }],
      accessibleKnowledgeBaseIds: ['kb-a'],
      targets: [
        target('target-inaccessible', 'kb-b', [
          evidence('relation-a', 'seed-a', 'target-inaccessible', 'DEFINES', 1),
        ]),
        target('target-unseeded', 'kb-a', [
          evidence('relation-b', 'not-a-seed', 'target-unseeded', 'DEFINES', 1),
        ]),
        target('seed-a', 'kb-a', [evidence('relation-c', 'seed-a', 'seed-a', 'DEFINES', 1)]),
        target('target-malformed', 'kb-a', [
          evidence('relation-d', 'seed-a', 'different-target', 'DEFINES', 1),
        ]),
      ],
    });

    expect(result).toEqual([]);
  });

  it('weights direct typed relations above weak two-hop generic relations', () => {
    const result = rankKnowledgeRelationshipTargets({
      seeds: [{ chunkId: 'seed-a', rank: 1, relevanceScore: 0.8 }],
      accessibleKnowledgeBaseIds: ['kb-a'],
      targets: [
        target('strong', 'kb-a', [
          evidence('strong-relation', 'seed-a', 'strong', 'REQUIRES', 0.9, 1),
        ]),
        target('weak', 'kb-a', [evidence('weak-relation', 'seed-a', 'weak', 'unknown', 0.9, 2)]),
      ],
    });

    expect(result.map((candidate) => candidate.target.chunkId)).toEqual(['strong', 'weak']);
    expect(result[0]?.relationshipScore).toBeGreaterThan(result[1]?.relationshipScore ?? 1);
  });
});

function target(
  chunkId: string,
  knowledgeBaseId: string,
  evidenceRows: KnowledgeRelationshipTargetRecord['evidence'],
): KnowledgeRelationshipTargetRecord {
  return {
    chunkId,
    knowledgeBaseId,
    knowledgeBaseName: 'Knowledge base',
    documentId: `document-${chunkId}`,
    documentVersionId: `version-${chunkId}`,
    documentVersion: 1,
    title: `Title ${chunkId}`,
    headingPath: ['Section'],
    content: `Content ${chunkId}`,
    sourceType: 'MARKDOWN',
    classification: 'INTERNAL',
    governanceHash: 'a'.repeat(64),
    contentHash: 'b'.repeat(64),
    updatedAt: new Date('2026-07-27T00:00:00.000Z'),
    metadata: {},
    resourcePolicy: {},
    evidence: evidenceRows,
  };
}

function evidence(
  relationId: string,
  sourceChunkId: string,
  targetChunkId: string,
  relationType: string,
  confidence: number,
  hopDistance: 1 | 2 = 1,
) {
  const path = Array.from({ length: hopDistance }, (_, index) => ({
    relationId: index === hopDistance - 1 ? relationId : `${relationId}-${index + 1}`,
    predicate: relationType,
    direction: 'OUTBOUND' as const,
    sourceEntityId: `entity-${index}`,
    sourceEntityName: index === 0 ? 'Source entity' : `Intermediate entity ${index}`,
    targetEntityId: `entity-${index + 1}`,
    targetEntityName:
      index === hopDistance - 1 ? 'Target entity' : `Intermediate entity ${index + 1}`,
  }));
  return {
    relationId,
    relationType,
    sourceChunkId,
    targetChunkId,
    sourceEntityName: 'Source entity',
    targetEntityName: 'Target entity',
    direction: 'OUTBOUND' as const,
    hopDistance,
    confidence,
    sourceSeedScore: 0,
    path,
  };
}
