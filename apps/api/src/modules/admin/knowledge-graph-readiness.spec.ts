import { describe, expect, it } from 'vitest';

import { deriveKnowledgeGraphReadiness } from './knowledge-graph-readiness.js';

describe('knowledge graph readiness', () => {
  it('requires entities, relations, evidence and full current-chunk linkage', () => {
    expect(
      deriveKnowledgeGraphReadiness({
        entityCount: 0,
        relationCount: 0,
        relationsWithoutEvidenceCount: 0,
        publishedChunkCount: 2,
        linkedChunkCount: 0,
        processingCount: 0,
        failedCount: 0,
        publishedOntologyVersionCount: 0,
        ungovernedRelationCount: 0,
        openConflictCount: 0,
      }),
    ).toMatchObject({
      status: 'NOT_BUILT',
      strongRetrievalReady: false,
      readinessBlockers: [
        'NO_ENTITIES',
        'NO_RELATIONS',
        'NO_PUBLISHED_ONTOLOGY',
        'MENTION_COVERAGE_INCOMPLETE',
      ],
    });
  });

  it('marks an evidence-backed fully linked graph ready', () => {
    expect(
      deriveKnowledgeGraphReadiness({
        entityCount: 8,
        relationCount: 5,
        relationsWithoutEvidenceCount: 0,
        publishedChunkCount: 3,
        linkedChunkCount: 3,
        processingCount: 0,
        failedCount: 0,
        publishedOntologyVersionCount: 1,
        ungovernedRelationCount: 0,
        openConflictCount: 0,
      }),
    ).toEqual({
      status: 'READY',
      mentionCoverage: 1,
      evidenceCoverage: 1,
      strongRetrievalReady: true,
      readinessBlockers: [],
    });
  });

  it('distinguishes extraction work and failed extraction from a ready graph', () => {
    expect(
      deriveKnowledgeGraphReadiness({
        entityCount: 5,
        relationCount: 2,
        relationsWithoutEvidenceCount: 0,
        publishedChunkCount: 2,
        linkedChunkCount: 2,
        processingCount: 1,
        failedCount: 0,
        publishedOntologyVersionCount: 1,
        ungovernedRelationCount: 0,
        openConflictCount: 0,
      }).status,
    ).toBe('BUILDING');
    expect(
      deriveKnowledgeGraphReadiness({
        entityCount: 5,
        relationCount: 2,
        relationsWithoutEvidenceCount: 0,
        publishedChunkCount: 2,
        linkedChunkCount: 2,
        processingCount: 0,
        failedCount: 1,
        publishedOntologyVersionCount: 1,
        ungovernedRelationCount: 0,
        openConflictCount: 0,
      }).status,
    ).toBe('FAILED');
  });

  it('fails closed when ontology governance or conflict resolution is incomplete', () => {
    expect(
      deriveKnowledgeGraphReadiness({
        entityCount: 5,
        relationCount: 2,
        relationsWithoutEvidenceCount: 0,
        publishedChunkCount: 2,
        linkedChunkCount: 2,
        processingCount: 0,
        failedCount: 0,
        publishedOntologyVersionCount: 1,
        ungovernedRelationCount: 1,
        openConflictCount: 1,
      }),
    ).toMatchObject({
      status: 'DEGRADED',
      strongRetrievalReady: false,
      readinessBlockers: ['UNGOVERNED_RELATIONS', 'OPEN_GRAPH_CONFLICTS'],
    });
  });
});
