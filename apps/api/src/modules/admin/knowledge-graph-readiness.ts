import type { KnowledgeGraphOverview, KnowledgeGraphReadinessReason } from '@enterprise/contracts';

export interface KnowledgeGraphReadinessInput {
  readonly entityCount: number;
  readonly relationCount: number;
  readonly relationsWithoutEvidenceCount: number;
  readonly publishedChunkCount: number;
  readonly linkedChunkCount: number;
  readonly processingCount: number;
  readonly failedCount: number;
  readonly publishedOntologyVersionCount: number;
  readonly ungovernedRelationCount: number;
  readonly openConflictCount: number;
}

export interface DerivedKnowledgeGraphReadiness {
  readonly status: KnowledgeGraphOverview['status'];
  readonly mentionCoverage: number;
  readonly evidenceCoverage: number;
  readonly strongRetrievalReady: boolean;
  readonly readinessBlockers: readonly KnowledgeGraphReadinessReason[];
}

export function deriveKnowledgeGraphReadiness(
  input: KnowledgeGraphReadinessInput,
): DerivedKnowledgeGraphReadiness {
  const mentionCoverage = ratio(input.linkedChunkCount, input.publishedChunkCount);
  const evidenceCoverage =
    input.relationCount === 0
      ? 0
      : ratio(input.relationCount - input.relationsWithoutEvidenceCount, input.relationCount);
  const readinessBlockers: KnowledgeGraphReadinessReason[] = [];
  if (input.processingCount > 0) readinessBlockers.push('GRAPH_EXTRACTION_PROCESSING');
  if (input.failedCount > 0) readinessBlockers.push('GRAPH_EXTRACTION_FAILED');
  if (input.entityCount === 0) readinessBlockers.push('NO_ENTITIES');
  if (input.relationCount === 0) readinessBlockers.push('NO_RELATIONS');
  if (input.publishedOntologyVersionCount === 0) {
    readinessBlockers.push('NO_PUBLISHED_ONTOLOGY');
  }
  if (input.ungovernedRelationCount > 0) {
    readinessBlockers.push('UNGOVERNED_RELATIONS');
  }
  if (input.openConflictCount > 0) {
    readinessBlockers.push('OPEN_GRAPH_CONFLICTS');
  }
  if (input.publishedChunkCount > 0 && mentionCoverage < 1) {
    readinessBlockers.push('MENTION_COVERAGE_INCOMPLETE');
  }
  if (input.relationsWithoutEvidenceCount > 0) {
    readinessBlockers.push('RELATIONS_WITHOUT_EVIDENCE');
  }

  const status: KnowledgeGraphOverview['status'] =
    input.processingCount > 0
      ? 'BUILDING'
      : input.failedCount > 0
        ? 'FAILED'
        : input.entityCount === 0
          ? 'NOT_BUILT'
          : readinessBlockers.length === 0
            ? 'READY'
            : 'DEGRADED';
  return {
    status,
    mentionCoverage,
    evidenceCoverage,
    strongRetrievalReady: status === 'READY' && readinessBlockers.length === 0,
    readinessBlockers,
  };
}

function ratio(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.min(1, Math.max(0, numerator / denominator));
}
