import type { Readable } from 'node:stream';

import type {
  AiDataClassification,
  KnowledgeDocumentGovernancePolicy,
  KnowledgeEmbeddingRebuildResponse,
  KnowledgeGraphRebuildResponse,
  KnowledgeStructuredDocumentPreview,
  TenantRole,
} from '@enterprise/contracts';

import type {
  AuthorizationAssignment,
  AuthorizationDataLabelContext,
  AuthorizationOrganizationContext,
  AuthorizationProjectContext,
  AuthorizationTaskContext,
} from '../authorization/authorization.types.js';

export type KnowledgeQueryChannel = 'DOCUMENT' | 'SQL' | 'RELATIONSHIP' | 'BUSINESS_API';

export interface KnowledgeQueryRoute {
  readonly primary: KnowledgeQueryChannel;
  readonly fallback: readonly KnowledgeQueryChannel[];
  readonly reasonCode: string;
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

export type KnowledgeRetrievalMode = 'LEXICAL' | 'HYBRID';
export type KnowledgeReranker = 'LEXICAL' | 'WEIGHTED_SCORE' | 'CROSS_ENCODER';
export type KnowledgeRetrievalDiagnosticStage =
  'ROUTER' | 'LEXICAL' | 'VECTOR' | 'SQL' | 'RELATIONSHIP' | 'BUSINESS_API' | 'RERANK';

export interface KnowledgeRetrievalDiagnostic {
  readonly stage: KnowledgeRetrievalDiagnosticStage;
  readonly status: 'APPLIED' | 'SKIPPED' | 'DEGRADED';
  readonly code: string;
  readonly candidateCount: number;
}

export interface KnowledgeRetrievalResult {
  readonly chunkId: string;
  readonly knowledgeBaseId: string;
  readonly knowledgeBaseName: string;
  readonly documentId: string;
  readonly documentVersionId: string;
  readonly documentVersion: number;
  readonly title: string;
  readonly headingPath: readonly string[];
  readonly pageStart: number | null;
  readonly pageEnd: number | null;
  readonly sheetName: string | null;
  readonly content: string;
  readonly sourceType: 'TEXT' | 'MARKDOWN' | 'FILE' | 'WEB';
  readonly classification: AiDataClassification;
  readonly governanceHash: string;
  readonly contentHash: string;
  readonly updatedAt: Date;
  readonly keywordScore: number;
  readonly fuzzyScore: number;
  readonly semanticScore: number | null;
  readonly fusionScore: number;
  readonly rerankerScore: number | null;
  readonly relationshipScore: number;
  readonly relationshipEvidence: readonly KnowledgeRelationshipEvidence[];
  readonly finalScore: number;
}

export interface KnowledgeRetrievalResponse {
  readonly accessibleKnowledgeBaseIds: readonly string[];
  readonly mode: KnowledgeRetrievalMode;
  readonly embeddingModel: string | null;
  readonly reranker: KnowledgeReranker;
  readonly rerankerModel: string | null;
  readonly degradedReason: string | null;
  readonly lexicalCandidateCount: number;
  readonly vectorCandidateCount: number;
  readonly relationshipCandidateCount: number;
  readonly relationshipExpandedCount: number;
  readonly semanticCoverage: number;
  readonly diagnostics: readonly KnowledgeRetrievalDiagnostic[];
  readonly queryRoute?: KnowledgeQueryRoute;
  readonly structuredQuerySql?: string | null;
  readonly items: readonly KnowledgeRetrievalResult[];
}

export interface KnowledgeRetrievalAuthorizationContext {
  readonly tenantRole: TenantRole;
  readonly assignment?: AuthorizationAssignment | null;
  readonly organization?: AuthorizationOrganizationContext;
  readonly project?: AuthorizationProjectContext;
  readonly dataLabels?: AuthorizationDataLabelContext;
  readonly taskContext?: AuthorizationTaskContext;
}

export interface KnowledgeSearchInput {
  readonly tenantId: string;
  readonly userId: string;
  readonly knowledgeBaseIds: readonly string[];
  readonly authorization?: KnowledgeRetrievalAuthorizationContext;
  /** Admin retrieval preview only; normal agent callers must not set it. */
  readonly previewDraftKnowledgeBaseIds?: readonly string[];
  /** Admin retrieval preview only; normal agent callers must not set it. */
  readonly previewKnowledgeVersionIds?: readonly string[];
  readonly query: string;
  readonly maximumOutboundClassification?: AiDataClassification;
  readonly limit?: number;
}

export interface KnowledgeEvidenceRecheckInput {
  readonly tenantId: string;
  readonly userId: string;
  readonly knowledgeBaseIds: readonly string[];
  readonly chunks: readonly {
    readonly chunkId: string;
    readonly documentVersionId: string;
    readonly classification: AiDataClassification;
    readonly governanceHash: string;
    readonly contentHash: string;
  }[];
  readonly authorization?: KnowledgeRetrievalAuthorizationContext;
}

export interface KnowledgeSourceDocument {
  readonly body: Readable;
  readonly size: number;
  readonly mimeType: string;
  readonly fileName: string;
}

export interface KnowledgeOperationalSummary {
  readonly activeBases: number;
  readonly totalDocuments: number;
  readonly readyDocuments: number;
  readonly failedDocuments: number;
  readonly pendingParseReviews: number;
  readonly rejectedParseReviews: number;
  readonly failedIngestionJobs: number;
  readonly totalChunks: number;
  readonly chunksWithEmbeddings: number;
}

export interface KnowledgeDocumentVersionIdentity {
  readonly documentId: string;
  readonly documentVersionId: string;
  readonly documentVersion: number;
}

export interface KnowledgeDocumentMaterialization {
  readonly documentStatus: 'DRAFT' | 'PROCESSING' | 'READY' | 'FAILED' | 'ARCHIVED';
  readonly documentCurrentVersionId: string | null;
  readonly versionStatus: 'DRAFT' | 'PROCESSING' | 'READY' | 'FAILED' | 'ARCHIVED';
  readonly governanceReviewStatus: 'PENDING' | 'APPROVED' | 'REJECTED' | 'MIGRATED';
  readonly publishedAt: Date | null;
  readonly ingestionStatus: 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | null;
  readonly ingestionErrorCode: string | null;
  readonly chunkCount: number;
  readonly embeddingCount: number;
}

/**
 * Opaque, versioned evaluation material. Evaluation code may hash or attest the
 * returned components, but it must not infer table/collection/storage layouts.
 */
export interface KnowledgeEvaluationSnapshot {
  readonly schemaVersion: 'knowledge-evaluation-snapshot.v1';
  readonly components: Readonly<Record<string, unknown>>;
}

export interface KnowledgeCommandPrincipal {
  readonly tenantId: string;
  readonly userId: string;
  readonly role: TenantRole;
  readonly authenticationSource: 'session' | 'development-header' | 'trusted-proxy';
}

export interface KnowledgeTextVersionInput {
  readonly knowledgeBaseId: string;
  readonly documentId?: string;
  readonly title: string;
  readonly sourceType: 'TEXT' | 'MARKDOWN';
  readonly content: string;
  readonly publish: boolean;
  readonly changeSummary?: string;
  readonly governance?: KnowledgeDocumentGovernancePolicy;
}

/**
 * Stateless retrieval boundary for agents, evaluation, and other background
 * services. Every caller supplies its explicit tenant/user authorization
 * context, so this port remains singleton-safe and can be implemented remotely.
 */
export abstract class KnowledgeEvaluationGateway {
  abstract captureEvaluationSnapshot(input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly versionIds: readonly string[];
    readonly mode: 'SUBJECT' | 'COMPOSITE';
    readonly expectedSubjectVersion?: number;
  }): Promise<KnowledgeEvaluationSnapshot>;

  abstract readEvaluationCorpus(input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly versionIds: readonly string[];
    readonly allowUnpublishedCandidate: boolean;
    readonly maximumBytes: number;
  }): Promise<string>;
}

export abstract class KnowledgeRetrievalGateway extends KnowledgeEvaluationGateway {
  /**
   * Resolves the authoritative set of active Knowledge Bases visible to the
   * current employee. Agent callers use this instead of persisting a second,
   * user-side list of Knowledge Base ids.
   */
  abstract resolveAccessibleKnowledgeBaseIds(input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly authorization?: KnowledgeRetrievalAuthorizationContext;
  }): Promise<readonly string[]>;

  abstract search(input: KnowledgeSearchInput): Promise<KnowledgeRetrievalResponse>;

  abstract areChunksAccessible(input: KnowledgeEvidenceRecheckInput): Promise<boolean>;

  abstract readOperationalSummary(input: {
    readonly tenantId: string;
    readonly userId: string;
  }): Promise<KnowledgeOperationalSummary>;

  abstract requireActiveKnowledgeBase(input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly knowledgeBaseId: string;
  }): Promise<void>;

  abstract validateKnowledgeBaseSelection(input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly knowledgeBaseIds: readonly string[];
    readonly orgUnitId?: string;
  }): Promise<void>;

  abstract countOrgUnitBindings(input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly orgUnitId: string;
  }): Promise<number>;

  abstract findDocumentVersionByChangeSummary(input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly changeSummary: string;
    readonly documentId?: string;
  }): Promise<KnowledgeDocumentVersionIdentity | null>;

  abstract readDocumentMaterialization(input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly documentVersionId: string;
  }): Promise<KnowledgeDocumentMaterialization | null>;
}

/**
 * Stable application boundary for request-bound knowledge administration.
 *
 * The current adapter calls the in-process NestJS modules. A future remote
 * adapter can implement the same contract over HTTP/gRPC without changing
 * Agent Run, evaluation, source sync, or the admin application services.
 */
export abstract class KnowledgeGateway extends KnowledgeRetrievalGateway {
  abstract createTextVersionAs(input: {
    readonly principal: KnowledgeCommandPrincipal;
    readonly document: KnowledgeTextVersionInput;
  }): Promise<string>;

  abstract createTextVersion(input: KnowledgeTextVersionInput): Promise<string>;

  abstract upload(input: {
    readonly knowledgeBaseId: string;
    readonly folderId?: string | null;
    readonly title: string;
    readonly bytes: Buffer;
    readonly mimeType: string;
    readonly fileName: string;
    readonly sourceUri?: string;
    readonly changeSummary?: string;
    readonly governance?: KnowledgeDocumentGovernancePolicy;
  }): Promise<string>;

  abstract uploadFileVersion(input: {
    readonly knowledgeBaseId: string;
    readonly documentId: string;
    readonly title: string;
    readonly bytes: Buffer;
    readonly mimeType: string;
    readonly fileName: string;
    readonly sourceUri?: string;
    readonly changeSummary?: string;
    readonly governance?: KnowledgeDocumentGovernancePolicy;
  }): Promise<string>;

  abstract importWeb(input: {
    readonly knowledgeBaseId: string;
    readonly sourceUri: string;
    readonly title?: string;
    readonly changeSummary?: string;
    readonly governance?: KnowledgeDocumentGovernancePolicy;
  }): Promise<string>;

  abstract retry(documentVersionId: string): Promise<string>;

  abstract rebuildEmbeddings(input: {
    readonly knowledgeBaseId: string;
    readonly documentId: string;
    readonly documentVersionId: string;
    readonly embeddingIndexVersionId?: string;
  }): Promise<KnowledgeEmbeddingRebuildResponse>;

  abstract rebuildKnowledgeGraph(input: {
    readonly knowledgeBaseId: string;
    readonly documentId: string;
    readonly documentVersionId: string;
  }): Promise<KnowledgeGraphRebuildResponse>;

  abstract syncSearchDocumentVersion(input: {
    readonly knowledgeBaseId: string;
    readonly documentId: string;
    readonly documentVersionId: string;
    readonly active: boolean;
    readonly embeddingIndexVersionId?: string;
  }): Promise<void>;

  abstract archiveSearchDocument(input: { readonly documentId: string }): Promise<void>;

  abstract readStructuredDocumentPreview(input: {
    readonly knowledgeBaseId: string;
    readonly documentId: string;
    readonly documentVersionId: string;
  }): Promise<KnowledgeStructuredDocumentPreview>;

  abstract readSourceDocument(input: {
    readonly knowledgeBaseId: string;
    readonly documentId: string;
    readonly documentVersionId: string;
  }): Promise<KnowledgeSourceDocument>;
}
