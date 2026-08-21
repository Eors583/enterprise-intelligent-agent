import type { Prisma } from '@prisma/client';

import type { KnowledgeDataClassification } from '../../ai-safety-model-routing/ai-data-classification.js';
import type { KnowledgeResourceAuthorizationFilters } from '../knowledge-resource-authorization.js';

export type KnowledgeRelationshipDirection = 'OUTBOUND' | 'INBOUND';

export interface KnowledgeRelationshipPathEdgeRecord {
  readonly relationId: string;
  readonly predicate: string;
  readonly direction: KnowledgeRelationshipDirection;
  readonly sourceEntityId: string;
  readonly sourceEntityName: string;
  readonly targetEntityId: string;
  readonly targetEntityName: string;
}

export interface KnowledgeRelationshipEvidenceRecord {
  readonly relationId: string;
  readonly relationType: string;
  readonly sourceChunkId: string;
  readonly targetChunkId: string;
  readonly sourceEntityName: string;
  readonly targetEntityName: string;
  readonly direction: KnowledgeRelationshipDirection;
  readonly hopDistance: 1 | 2;
  readonly confidence: number;
  /** Non-zero only when the query matched an entity name/alias directly. */
  readonly sourceSeedScore: number;
  readonly path: readonly KnowledgeRelationshipPathEdgeRecord[];
}

export interface KnowledgeRelationshipTargetRecord {
  readonly chunkId: string;
  readonly knowledgeBaseId: string;
  readonly knowledgeBaseName: string;
  readonly documentId: string;
  readonly documentVersionId: string;
  readonly documentVersion: number;
  readonly title: string;
  readonly headingPath: readonly string[];
  readonly content: string;
  readonly sourceType: 'TEXT' | 'MARKDOWN' | 'FILE' | 'WEB';
  readonly classification: KnowledgeDataClassification;
  readonly governanceHash: string;
  readonly contentHash: string;
  readonly updatedAt: Date;
  readonly metadata: Prisma.JsonValue;
  readonly resourcePolicy: Prisma.JsonValue;
  readonly evidence: readonly KnowledgeRelationshipEvidenceRecord[];
}

export interface KnowledgeRelationshipExpansionQuery {
  readonly tenantId: string;
  readonly accessibleKnowledgeBaseIds: readonly string[];
  readonly previewDraftKnowledgeBaseIds: readonly string[];
  /**
   * Admin retrieval-test only. When non-empty, relationship traversal is
   * restricted to the exact CANDIDATE graph projections for these versions.
   */
  readonly previewKnowledgeVersionIds: readonly string[];
  readonly seedChunkIds: readonly string[];
  readonly query: string;
  readonly candidateLimit: number;
  readonly authorizationFilters: KnowledgeResourceAuthorizationFilters;
}

export abstract class KnowledgeRelationshipExpander {
  abstract expand(
    transaction: Prisma.TransactionClient,
    input: KnowledgeRelationshipExpansionQuery,
  ): Promise<readonly KnowledgeRelationshipTargetRecord[]>;
}
