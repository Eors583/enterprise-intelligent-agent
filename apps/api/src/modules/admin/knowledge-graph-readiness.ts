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
  readonly diagnostics: readonly KnowledgeGraphReadinessReason[];
}

// Not every published chunk should manufacture an entity merely to satisfy a
// counter (for example, short checklists and separator-only fragments). A
// production graph is considered sufficiently linked once at least 90% of
// published chunks have an entity mention or relation evidence. The exact
// percentage remains visible in the UI for ongoing quality improvement.
const MINIMUM_READY_MENTION_COVERAGE = 0.9;

export function deriveKnowledgeGraphReadiness(
  input: KnowledgeGraphReadinessInput,
): DerivedKnowledgeGraphReadiness {
  const mentionCoverage = ratio(input.linkedChunkCount, input.publishedChunkCount);
  const evidenceCoverage =
    input.relationCount === 0
      ? 0
      : ratio(input.relationCount - input.relationsWithoutEvidenceCount, input.relationCount);
  const diagnostics: KnowledgeGraphReadinessReason[] = [];
  if (input.processingCount > 0) diagnostics.push('GRAPH_EXTRACTION_PROCESSING');
  if (input.failedCount > 0) diagnostics.push('GRAPH_EXTRACTION_FAILED');
  if (input.entityCount === 0) diagnostics.push('NO_ENTITIES');
  if (input.relationCount === 0) diagnostics.push('NO_RELATIONS');
  if (input.publishedOntologyVersionCount === 0) {
    diagnostics.push('NO_PUBLISHED_ONTOLOGY');
  }
  if (input.ungovernedRelationCount > 0) {
    diagnostics.push('UNGOVERNED_RELATIONS');
  }
  if (input.openConflictCount > 0) {
    diagnostics.push('OPEN_GRAPH_CONFLICTS');
  }
  if (input.publishedChunkCount > 0 && mentionCoverage < MINIMUM_READY_MENTION_COVERAGE) {
    diagnostics.push('MENTION_COVERAGE_INCOMPLETE');
  }
  if (input.relationsWithoutEvidenceCount > 0) {
    diagnostics.push('RELATIONS_WITHOUT_EVIDENCE');
  }

  const status: KnowledgeGraphOverview['status'] =
    input.processingCount > 0
      ? 'BUILDING'
      : input.failedCount > 0
        ? 'FAILED'
        : input.entityCount === 0
          ? 'NOT_BUILT'
          : diagnostics.length === 0
            ? 'READY'
            : 'DEGRADED';
  return {
    status,
    mentionCoverage,
    evidenceCoverage,
    diagnostics,
  };
}

function ratio(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.min(1, Math.max(0, numerator / denominator));
}
