import type {
  KnowledgeRelationshipEvidenceRecord,
  KnowledgeRelationshipTargetRecord,
} from './knowledge-relationship-expander.port.js';

const MAX_EVIDENCE_PER_TARGET = 5;
const MINIMUM_RELATIONSHIP_SCORE = 0.08;

export interface KnowledgeRelationshipSeed {
  readonly chunkId: string;
  readonly rank: number;
  readonly relevanceScore: number;
}

export interface KnowledgeRelationshipEvidence {
  readonly relationId: string;
  readonly relationType: string;
  readonly sourceChunkId: string;
  readonly sourceEntityName: string;
  readonly targetEntityName: string;
  readonly direction: 'OUTBOUND' | 'INBOUND';
  readonly hopDistance: 1 | 2;
  readonly confidence: number;
  /** Non-zero only when relationship expansion started from a direct query/entity match. */
  readonly sourceSeedScore: number;
  readonly contribution: number;
  readonly path: readonly {
    readonly relationId: string;
    readonly predicate: string;
    readonly direction: 'OUTBOUND' | 'INBOUND';
    readonly sourceEntityId: string;
    readonly sourceEntityName: string;
    readonly targetEntityId: string;
    readonly targetEntityName: string;
  }[];
}

export interface RankedKnowledgeRelationshipTarget {
  readonly target: KnowledgeRelationshipTargetRecord;
  readonly relationshipScore: number;
  readonly evidence: readonly KnowledgeRelationshipEvidence[];
}

/**
 * Scores graph expansion independently from lexical/vector scoring.
 *
 * The function deliberately accepts the already ACL-filtered knowledge-base IDs
 * and validates every source/target again. That keeps a malformed graph row from
 * becoming an authorization bypass.
 */
export function rankKnowledgeRelationshipTargets(input: {
  readonly seeds: readonly KnowledgeRelationshipSeed[];
  readonly targets: readonly KnowledgeRelationshipTargetRecord[];
  readonly accessibleKnowledgeBaseIds: readonly string[];
}): readonly RankedKnowledgeRelationshipTarget[] {
  const accessibleIds = new Set(input.accessibleKnowledgeBaseIds);
  const seeds = new Map(
    input.seeds.map((seed) => [
      seed.chunkId,
      {
        rank: Math.max(1, seed.rank),
        relevanceScore: clamp01(seed.relevanceScore),
      },
    ]),
  );
  const grouped = new Map<
    string,
    {
      target: KnowledgeRelationshipTargetRecord;
      evidence: KnowledgeRelationshipEvidence[];
    }
  >();

  for (const target of input.targets) {
    if (!accessibleIds.has(target.knowledgeBaseId)) continue;
    for (const evidence of target.evidence) {
      const seed = seeds.get(evidence.sourceChunkId);
      if (
        seed === undefined ||
        evidence.targetChunkId !== target.chunkId ||
        evidence.sourceChunkId === evidence.targetChunkId ||
        !isValidEvidence(evidence)
      ) {
        continue;
      }
      const contribution = relationshipContribution(evidence, seed);
      if (contribution <= 0) continue;
      const existing = grouped.get(target.chunkId) ?? {
        target,
        evidence: [],
      };
      existing.evidence.push({
        relationId: evidence.relationId,
        relationType: normalizeRelationType(evidence.relationType),
        sourceChunkId: evidence.sourceChunkId,
        sourceEntityName: evidence.sourceEntityName,
        targetEntityName: evidence.targetEntityName,
        direction: evidence.direction,
        hopDistance: evidence.hopDistance,
        confidence: clamp01(evidence.confidence),
        sourceSeedScore: clamp01(evidence.sourceSeedScore),
        contribution,
        path: evidence.path,
      });
      grouped.set(target.chunkId, existing);
    }
  }

  return [...grouped.values()]
    .map(({ target, evidence }) => {
      const strongest = evidence
        .sort(
          (left, right) =>
            right.contribution - left.contribution ||
            left.relationId.localeCompare(right.relationId),
        )
        .slice(0, MAX_EVIDENCE_PER_TARGET);
      return {
        target,
        relationshipScore: saturatingScore(strongest.map((item) => item.contribution)),
        evidence: strongest,
      };
    })
    .filter((candidate) => candidate.relationshipScore >= MINIMUM_RELATIONSHIP_SCORE)
    .sort(
      (left, right) =>
        right.relationshipScore - left.relationshipScore ||
        left.target.chunkId.localeCompare(right.target.chunkId),
    );
}

function relationshipContribution(
  evidence: KnowledgeRelationshipEvidenceRecord,
  seed: { readonly rank: number; readonly relevanceScore: number },
): number {
  const sourceSignal = 0.6 + seed.relevanceScore * 0.4;
  const rankDecay = 1 / Math.sqrt(seed.rank);
  const directionWeight = evidence.direction === 'OUTBOUND' ? 1 : 0.92;
  const hopWeight = evidence.hopDistance === 1 ? 1 : 0.58;
  return clamp01(
    sourceSignal *
      rankDecay *
      clamp01(evidence.confidence) *
      relationTypeWeight(evidence.relationType) *
      directionWeight *
      hopWeight,
  );
}

function relationTypeWeight(value: string): number {
  switch (normalizeRelationType(value)) {
    case 'DEPENDS_ON':
    case 'REQUIRES':
      return 1;
    case 'DEFINES':
      return 0.96;
    case 'IMPLEMENTS':
    case 'APPLIES_TO':
      return 0.92;
    case 'REFERENCES':
    case 'SUPERSEDES':
      return 0.84;
    case 'RELATED_TO':
      return 0.68;
    default:
      return 0.58;
  }
}

function normalizeRelationType(value: string): string {
  return value
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase()
    .slice(0, 80);
}

function isValidEvidence(value: KnowledgeRelationshipEvidenceRecord): boolean {
  return (
    value.relationId.length > 0 &&
    value.relationType.trim().length > 0 &&
    value.sourceEntityName.trim().length > 0 &&
    value.targetEntityName.trim().length > 0 &&
    (value.direction === 'OUTBOUND' || value.direction === 'INBOUND') &&
    (value.hopDistance === 1 || value.hopDistance === 2) &&
    value.path.length === value.hopDistance &&
    value.path.every(
      (edge, index) =>
        edge.relationId.length > 0 &&
        edge.predicate.trim().length > 0 &&
        (edge.direction === 'OUTBOUND' || edge.direction === 'INBOUND') &&
        edge.sourceEntityId.length > 0 &&
        edge.sourceEntityName.trim().length > 0 &&
        edge.targetEntityId.length > 0 &&
        edge.targetEntityName.trim().length > 0 &&
        (index === 0 ||
          (value.path[index - 1]?.targetEntityId === edge.sourceEntityId &&
            value.path[index - 1]?.targetEntityName === edge.sourceEntityName)),
    ) &&
    value.path[0]?.sourceEntityName === value.sourceEntityName &&
    value.path.at(-1)?.targetEntityName === value.targetEntityName &&
    value.path.at(-1)?.relationId === value.relationId &&
    value.path[0]?.direction === value.direction &&
    Number.isFinite(value.confidence) &&
    value.confidence > 0
  );
}

function saturatingScore(values: readonly number[]): number {
  return clamp01(1 - values.reduce((remaining, value) => remaining * (1 - clamp01(value)), 1));
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
