import { Inject, Injectable } from '@nestjs/common';
import type { AiDataClassification, TenantRole } from '@enterprise/contracts';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../database/prisma.service.js';
import {
  isExternalKnowledgeAiApproved,
  knowledgeClassificationToAi,
  maximumAiDataClassification,
  type KnowledgeDataClassification,
} from '../ai-safety-model-routing/ai-data-classification.js';
import { classifyTextForAiEgress } from '../ai-safety-model-routing/ai-safety-policy.js';
import { AuthorizationDecisionService } from '../authorization/authorization-decision.service.js';
import type {
  AuthorizationAssignment,
  AuthorizationDataLabelContext,
  AuthorizationOrganizationContext,
  AuthorizationProjectContext,
  AuthorizationTaskContext,
} from '../authorization/authorization.types.js';
import {
  KnowledgeAiRuntimeClient,
  KnowledgeAiRuntimeError,
  type KnowledgeEmbeddingBatch,
} from '../knowledge-semantic/knowledge-ai-runtime.client.js';
import {
  KnowledgeRelationshipExpander,
  type KnowledgeRelationshipTargetRecord,
} from './domain/knowledge-relationship-expander.port.js';
import {
  rankKnowledgeRelationshipTargets,
  type KnowledgeRelationshipEvidence,
  type KnowledgeRelationshipSeed,
} from './domain/knowledge-relationship-ranking.js';
import { accessibleKnowledgeBaseIds, isOrgUnitAncestor } from './knowledge-access.policy.js';
import {
  knowledgeFiltersFromDecision,
  knowledgeVersionResourcePolicyAllowed,
  knowledgeVersionResourcePolicySnapshotSql,
  knowledgeVersionResourcePolicySql,
  type KnowledgeResourceAuthorizationFilters,
  withResolvedOrganizationIds,
} from './knowledge-resource-authorization.js';

const CANDIDATE_LIMIT = 40;
const RELATIONSHIP_SEED_LIMIT = 20;
const RELATIONSHIP_CANDIDATE_LIMIT = 80;
const RRF_K = 60;
const MINIMUM_LEXICAL_SCORE = 0.08;
const MINIMUM_FUZZY_CANDIDATE_SCORE = 0.05;
const MINIMUM_SEMANTIC_SCORE = 0.35;
const MINIMUM_RERANK_SCORE = 0.15;
const MINIMUM_RELATIONSHIP_SCORE = 0.08;
const MINIMUM_RELATIONSHIP_SEED_LEXICAL_SCORE = 0.35;
const MINIMUM_RELATIONSHIP_SEED_SEMANTIC_SCORE = 0.6;

export type KnowledgeRetrievalMode = 'LEXICAL' | 'HYBRID';
export type KnowledgeReranker = 'LEXICAL' | 'RRF' | 'CROSS_ENCODER';
export type KnowledgeRetrievalDiagnosticStage = 'LEXICAL' | 'VECTOR' | 'RELATIONSHIP' | 'RERANK';

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
  readonly items: readonly KnowledgeRetrievalResult[];
}

interface CandidateRow {
  chunk_id: string;
  knowledge_base_id: string;
  knowledge_base_name: string;
  document_id: string;
  document_version_id: string;
  document_version: number;
  title: string;
  heading_path: string[];
  content: string;
  source_type: 'TEXT' | 'MARKDOWN' | 'FILE' | 'WEB';
  knowledge_classification: KnowledgeDataClassification;
  governance_hash: string;
  content_hash: string;
  updated_at: Date;
  metadata: Prisma.JsonValue;
  resource_policy: Prisma.JsonValue;
  keyword_score: number;
  fuzzy_score: number;
}

interface VectorCandidateRow extends CandidateRow {
  semantic_score: number;
}

interface CandidateState {
  readonly row: CandidateRow;
  readonly lexicalRank: number | null;
  readonly vectorRank: number | null;
  readonly lexicalScore: number;
  readonly semanticScore: number | null;
  readonly fusionScore: number;
  readonly relationshipScore: number;
  readonly relationshipEvidence: readonly KnowledgeRelationshipEvidence[];
}

interface LoadedCandidates {
  readonly accessibleKnowledgeBaseIds: readonly string[];
  readonly candidates: readonly CandidateState[];
  readonly lexicalCandidateCount: number;
  readonly vectorCandidateCount: number;
  readonly relationshipCandidateCount: number;
  readonly relationshipExpandedCount: number;
  readonly relationshipDiagnostic: KnowledgeRetrievalDiagnostic;
  readonly relationshipDegradedReason: string | null;
}

export interface KnowledgeRetrievalAuthorizationContext {
  readonly tenantRole: TenantRole;
  readonly assignment?: AuthorizationAssignment | null;
  readonly organization?: AuthorizationOrganizationContext;
  readonly project?: AuthorizationProjectContext;
  readonly dataLabels?: AuthorizationDataLabelContext;
  readonly taskContext?: AuthorizationTaskContext;
}

interface SearchInput {
  readonly tenantId: string;
  readonly userId: string;
  readonly knowledgeBaseIds: readonly string[];
  readonly authorization?: KnowledgeRetrievalAuthorizationContext;
  /**
   * Admin retrieval-test only. IDs must also be present in knowledgeBaseIds.
   * Agent Run callers deliberately never set this field.
   */
  readonly previewDraftKnowledgeBaseIds?: readonly string[];
  /**
   * Admin retrieval-test only. When present, retrieval is restricted to these
   * exact READY candidate versions instead of following each document's
   * published current-version pointer. Employee and Agent Run callers never
   * receive this capability.
   */
  readonly previewKnowledgeVersionIds?: readonly string[];
  readonly query: string;
  readonly maximumOutboundClassification?: AiDataClassification;
  readonly limit?: number;
}

@Injectable()
export class KnowledgeRetrievalService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(KnowledgeAiRuntimeClient) private readonly semantic: KnowledgeAiRuntimeClient,
    @Inject(KnowledgeRelationshipExpander)
    private readonly relationships: KnowledgeRelationshipExpander,
    @Inject(AuthorizationDecisionService)
    private readonly authorization: AuthorizationDecisionService,
  ) {}

  async search(input: SearchInput): Promise<KnowledgeRetrievalResponse> {
    const authorizationFilters = this.authorizeRetrieval(input);
    const query = normalizeQuery(input.query);
    const outboundClassification = resolveOutboundClassification(input, query);
    let embedding: KnowledgeEmbeddingBatch | null = null;
    let degradedReason: string | null = null;
    if (this.semantic.semanticEnabled && !isExternalKnowledgeAiApproved(outboundClassification)) {
      degradedReason = 'KNOWLEDGE_EMBEDDING_CLASSIFICATION_NOT_APPROVED';
    } else if (this.semantic.semanticEnabled) {
      try {
        embedding = await this.semantic.embed(input.tenantId, [query], outboundClassification);
      } catch (error) {
        degradedReason = safeSemanticErrorCode(error);
      }
    }

    const loaded = await this.prisma.withTenant(input.tenantId, (transaction) =>
      this.loadCandidates(transaction, input, query, embedding, authorizationFilters),
    );
    return this.rankCandidates(
      input,
      query,
      loaded,
      embedding,
      degradedReason ?? loaded.relationshipDegradedReason,
      outboundClassification,
    );
  }

  /**
   * Transaction-bound compatibility path. It is intentionally lexical-only:
   * no provider HTTP request is ever made while a caller holds a DB lock.
   */
  async searchInTransaction(
    transaction: Prisma.TransactionClient,
    input: SearchInput,
  ): Promise<KnowledgeRetrievalResponse> {
    const authorizationFilters = this.authorizeRetrieval(input);
    const query = normalizeQuery(input.query);
    const loaded = await this.loadCandidates(transaction, input, query, null, authorizationFilters);
    return this.rankWithoutRemote(input, loaded, null, loaded.relationshipDegradedReason);
  }

  /** Re-checks source lineage and ACLs immediately before runtime dispatch. */
  async areChunksAccessibleInTransaction(
    transaction: Prisma.TransactionClient,
    input: {
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
    },
  ): Promise<boolean> {
    const authorizationFilters = this.authorizeRetrieval(input);
    const requestedIds = [...new Set(input.knowledgeBaseIds)].slice(0, 50);
    const expectedChunks = [
      ...new Map(input.chunks.map((chunk) => [chunk.chunkId, chunk])).values(),
    ].slice(0, 100);
    const chunkIds = expectedChunks.map((chunk) => chunk.chunkId);
    if (chunkIds.length === 0) return true;
    const [user, employments, orgUnits, knowledgeBases] = await Promise.all([
      transaction.user.findFirst({
        where: { tenantId: input.tenantId, id: input.userId },
        select: { status: true },
      }),
      transaction.employment.findMany({
        where: { tenantId: input.tenantId, userId: input.userId, status: 'ACTIVE' },
        select: { orgUnitId: true },
      }),
      transaction.orgUnit.findMany({
        where: { tenantId: input.tenantId, status: 'ACTIVE' },
        select: { id: true, parentId: true, organizationId: true },
      }),
      transaction.knowledgeBase.findMany({
        where: { tenantId: input.tenantId, id: { in: requestedIds }, status: 'ACTIVE' },
        include: { orgUnits: true },
      }),
    ]);
    const resolvedAuthorization = resolveOrganizationAuthorization(
      authorizationFilters,
      employments,
      orgUnits,
    );
    const activeOrgUnitIds = new Set(orgUnits.map((orgUnit) => orgUnit.id));
    const scopedKnowledgeBases = filterKnowledgeBasesByAssignmentOrganization(
      knowledgeBases,
      resolvedAuthorization.assignmentOrgUnitIds,
      new Map(orgUnits.map((unit) => [unit.id, unit.parentId])),
    );
    const accessibleIds = accessibleKnowledgeBaseIds({
      userActive: user?.status === 'ACTIVE',
      memberOrgUnitIds: new Set(
        employments
          .map((employment) => employment.orgUnitId)
          .filter((orgUnitId) => activeOrgUnitIds.has(orgUnitId)),
      ),
      parentByOrgUnitId: new Map(orgUnits.map((unit) => [unit.id, unit.parentId])),
      knowledgeBases: scopedKnowledgeBases,
    });
    if (accessibleIds.length === 0) return false;
    const accessibleSql = Prisma.join(accessibleIds.map((id) => Prisma.sql`${id}::uuid`));
    const chunkSql = Prisma.join(chunkIds.map((id) => Prisma.sql`${id}::uuid`));
    const resourceFilterSql = knowledgeVersionResourcePolicySql(
      Prisma.sql`version`,
      resolvedAuthorization.filters,
    );
    const rows = await transaction.$queryRaw<
      Array<{
        chunk_id: string;
        document_version_id: string;
        content_hash: string;
        governance_hash: string;
        classification: KnowledgeDataClassification;
      }>
    >(Prisma.sql`
      SELECT
        chunk."id"::text AS chunk_id,
        chunk."document_version_id"::text AS document_version_id,
        chunk."content_hash" AS content_hash,
        version."governance_hash" AS governance_hash,
        version."classification"::text AS classification
      FROM public."knowledge_chunks" AS chunk
      JOIN public."knowledge_documents" AS document
        ON document."tenant_id" = chunk."tenant_id"
       AND document."knowledge_base_id" = chunk."knowledge_base_id"
       AND document."id" = chunk."document_id"
       AND document."status" = 'READY'
       AND document."current_version_id" = chunk."document_version_id"
      JOIN public."knowledge_document_versions" AS version
        ON version."tenant_id" = chunk."tenant_id"
       AND version."knowledge_base_id" = chunk."knowledge_base_id"
       AND version."document_id" = chunk."document_id"
       AND version."id" = chunk."document_version_id"
       AND version."status" = 'READY'
      WHERE chunk."tenant_id" = ${input.tenantId}::uuid
        AND chunk."knowledge_base_id" IN (${accessibleSql})
        AND chunk."id" IN (${chunkSql})
        AND ${resourceFilterSql}
    `);
    const rowByChunkId = new Map(rows.map((row) => [row.chunk_id, row]));
    return expectedChunks.every((expected) => {
      const row = rowByChunkId.get(expected.chunkId);
      return (
        row !== undefined &&
        row.document_version_id === expected.documentVersionId &&
        row.content_hash === expected.contentHash &&
        row.governance_hash === expected.governanceHash &&
        knowledgeClassificationToAi(row.classification) === expected.classification
      );
    });
  }

  private authorizeRetrieval(input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly authorization?: KnowledgeRetrievalAuthorizationContext;
  }): KnowledgeResourceAuthorizationFilters {
    const context = input.authorization;
    const decision = this.authorization.require({
      tenantId: input.tenantId,
      userId: input.userId,
      tenantRole: context?.tenantRole ?? 'MEMBER',
      action: 'knowledge.retrieve',
      resourceTenantId: input.tenantId,
      ...(context?.assignment === undefined ? {} : { assignment: context.assignment }),
      ...(context?.organization === undefined ? {} : { organization: context.organization }),
      ...(context?.project === undefined ? {} : { project: context.project }),
      ...(context?.dataLabels === undefined ? {} : { dataLabels: context.dataLabels }),
      ...(context?.taskContext === undefined ? {} : { taskContext: context.taskContext }),
      risk: 'LOW',
    });
    return knowledgeFiltersFromDecision(
      decision,
      context?.assignment?.roleTemplateId === undefined ? [] : [context.assignment.roleTemplateId],
    );
  }

  private async loadCandidates(
    transaction: Prisma.TransactionClient,
    input: SearchInput,
    query: string,
    embedding: KnowledgeEmbeddingBatch | null,
    authorizationFilters: KnowledgeResourceAuthorizationFilters,
  ): Promise<LoadedCandidates> {
    const requestedIds = [...new Set(input.knowledgeBaseIds)].slice(0, 50);
    const requestedIdSet = new Set(requestedIds);
    const previewDraftIds = [...new Set(input.previewDraftKnowledgeBaseIds ?? [])]
      .filter((id) => requestedIdSet.has(id))
      .slice(0, 50);
    const previewVersionIds = [...new Set(input.previewKnowledgeVersionIds ?? [])].slice(0, 20);
    if (requestedIds.length === 0) {
      return {
        accessibleKnowledgeBaseIds: [],
        candidates: [],
        lexicalCandidateCount: 0,
        vectorCandidateCount: 0,
        relationshipCandidateCount: 0,
        relationshipExpandedCount: 0,
        relationshipDiagnostic: relationshipDiagnostic(
          'SKIPPED',
          'KNOWLEDGE_RELATIONSHIP_REQUEST_EMPTY',
          0,
        ),
        relationshipDegradedReason: null,
      };
    }

    const [user, employments, orgUnits, knowledgeBases] = await Promise.all([
      transaction.user.findFirst({
        where: { tenantId: input.tenantId, id: input.userId },
        select: { status: true },
      }),
      transaction.employment.findMany({
        where: { tenantId: input.tenantId, userId: input.userId, status: 'ACTIVE' },
        select: { orgUnitId: true },
      }),
      transaction.orgUnit.findMany({
        where: { tenantId: input.tenantId, status: 'ACTIVE' },
        select: { id: true, parentId: true, organizationId: true },
      }),
      transaction.knowledgeBase.findMany({
        where: {
          tenantId: input.tenantId,
          id: { in: requestedIds },
          OR: [
            { status: 'ACTIVE' },
            ...(previewDraftIds.length === 0
              ? []
              : [{ status: 'DRAFT' as const, id: { in: previewDraftIds } }]),
          ],
        },
        include: { orgUnits: true },
      }),
    ]);
    const resolvedAuthorization = resolveOrganizationAuthorization(
      authorizationFilters,
      employments,
      orgUnits,
    );
    const activeOrgUnitIds = new Set(orgUnits.map((orgUnit) => orgUnit.id));
    const memberOrgUnitIds = new Set(
      employments
        .map((employment) => employment.orgUnitId)
        .filter((orgUnitId) => activeOrgUnitIds.has(orgUnitId)),
    );
    const parentByOrgUnitId = new Map(orgUnits.map((unit) => [unit.id, unit.parentId]));
    const scopedKnowledgeBases = filterKnowledgeBasesByAssignmentOrganization(
      knowledgeBases,
      resolvedAuthorization.assignmentOrgUnitIds,
      parentByOrgUnitId,
    );
    const accessibleIds = accessibleKnowledgeBaseIds({
      userActive: user?.status === 'ACTIVE',
      memberOrgUnitIds,
      parentByOrgUnitId,
      knowledgeBases: scopedKnowledgeBases,
    });
    if (accessibleIds.length === 0) {
      return {
        accessibleKnowledgeBaseIds: accessibleIds,
        candidates: [],
        lexicalCandidateCount: 0,
        vectorCandidateCount: 0,
        relationshipCandidateCount: 0,
        relationshipExpandedCount: 0,
        relationshipDiagnostic: relationshipDiagnostic(
          'SKIPPED',
          'KNOWLEDGE_RELATIONSHIP_ACCESS_DENIED',
          0,
        ),
        relationshipDegradedReason: null,
      };
    }

    const terms = queryTerms(query);
    const accessibleKnowledgeBaseIdSql = Prisma.join(
      accessibleIds.map((id) => Prisma.sql`${id}::uuid`),
    );
    const knowledgeBaseStatusSql =
      previewDraftIds.length === 0
        ? Prisma.sql`knowledge_base."status" = 'ACTIVE'`
        : Prisma.sql`(
            knowledge_base."status" = 'ACTIVE'
            OR (
              knowledge_base."status" = 'DRAFT'
              AND knowledge_base."id" IN (
                ${Prisma.join(previewDraftIds.map((id) => Prisma.sql`${id}::uuid`))}
              )
            )
          )`;
    const documentVersionScopeSql =
      previewVersionIds.length === 0
        ? Prisma.sql`document."current_version_id" = chunk."document_version_id"`
        : Prisma.sql`chunk."document_version_id" IN (
            ${Prisma.join(previewVersionIds.map((id) => Prisma.sql`${id}::uuid`))}
          )`;
    const keywordExpression = keywordScoreExpression(terms);
    const resourceFilterSql = knowledgeVersionResourcePolicySql(
      Prisma.sql`version`,
      resolvedAuthorization.filters,
    );
    const versionPolicySql = knowledgeVersionResourcePolicySnapshotSql(Prisma.sql`version`);
    const lexicalRows = await transaction.$queryRaw<CandidateRow[]>(Prisma.sql`
      SELECT *
      FROM (
        SELECT
          chunk."id" AS chunk_id,
          chunk."knowledge_base_id" AS knowledge_base_id,
          knowledge_base."name" AS knowledge_base_name,
          chunk."document_id" AS document_id,
          chunk."document_version_id" AS document_version_id,
          version."version_number" AS document_version,
          document."title" AS title,
          chunk."heading_path" AS heading_path,
          chunk."content" AS content,
          chunk."content_hash" AS content_hash,
          version."source_type"::text AS source_type,
          version."classification"::text AS knowledge_classification,
          version."governance_hash" AS governance_hash,
          coalesce(version."published_at", version."created_at") AS updated_at,
          chunk."metadata" AS metadata,
          ${versionPolicySql} AS resource_policy,
          (${keywordExpression})::double precision AS keyword_score,
          greatest(
            similarity(lower(chunk."content"), lower(${query})),
            least(1.0, similarity(lower(document."title"), lower(${query})) * 1.15),
            least(1.0, similarity(lower(array_to_string(chunk."heading_path", ' ')), lower(${query})) * 1.1),
            word_similarity(lower(${query}), lower(chunk."content"))
          )::double precision AS fuzzy_score
        FROM public."knowledge_chunks" AS chunk
        JOIN public."knowledge_bases" AS knowledge_base
          ON knowledge_base."tenant_id" = chunk."tenant_id"
         AND knowledge_base."id" = chunk."knowledge_base_id"
         AND ${knowledgeBaseStatusSql}
        JOIN public."knowledge_documents" AS document
          ON document."tenant_id" = chunk."tenant_id"
         AND document."knowledge_base_id" = chunk."knowledge_base_id"
         AND document."id" = chunk."document_id"
         AND document."status" = 'READY'
         AND ${documentVersionScopeSql}
        JOIN public."knowledge_document_versions" AS version
          ON version."tenant_id" = chunk."tenant_id"
         AND version."knowledge_base_id" = chunk."knowledge_base_id"
         AND version."document_id" = chunk."document_id"
         AND version."id" = chunk."document_version_id"
         AND version."status" = 'READY'
        WHERE chunk."tenant_id" = ${input.tenantId}::uuid
          AND chunk."knowledge_base_id" IN (${accessibleKnowledgeBaseIdSql})
          AND ${resourceFilterSql}
      ) AS lexical_candidate
      WHERE lexical_candidate.keyword_score > 0
         OR lexical_candidate.fuzzy_score >= ${MINIMUM_FUZZY_CANDIDATE_SCORE}
      ORDER BY
        lexical_candidate.keyword_score DESC,
        lexical_candidate.fuzzy_score DESC,
        lexical_candidate.document_version DESC,
        lexical_candidate.chunk_id ASC
      LIMIT ${CANDIDATE_LIMIT}
    `);

    let vectorRows: VectorCandidateRow[] = [];
    const queryVector = embedding?.vectors[0];
    if (embedding !== null && queryVector !== undefined) {
      if (this.semantic.vectorSearchMode === 'exact') {
        // Exact cosine is the correctness baseline for the initial tenant scale.
        // Disabling ANN avoids cross-tenant recall interference from a shared HNSW graph.
        await transaction.$executeRawUnsafe('SET LOCAL enable_indexscan = off');
        await transaction.$executeRawUnsafe('SET LOCAL enable_bitmapscan = off');
      } else {
        await transaction.$executeRawUnsafe('SET LOCAL hnsw.iterative_scan = strict_order');
        await transaction.$executeRawUnsafe('SET LOCAL hnsw.ef_search = 100');
      }
      const literal = vectorLiteral(queryVector);
      vectorRows = await transaction.$queryRaw<VectorCandidateRow[]>(Prisma.sql`
        SELECT
          chunk."id" AS chunk_id,
          chunk."knowledge_base_id" AS knowledge_base_id,
          knowledge_base."name" AS knowledge_base_name,
          chunk."document_id" AS document_id,
          chunk."document_version_id" AS document_version_id,
          version."version_number" AS document_version,
          document."title" AS title,
          chunk."heading_path" AS heading_path,
          chunk."content" AS content,
          chunk."content_hash" AS content_hash,
          version."source_type"::text AS source_type,
          version."classification"::text AS knowledge_classification,
          version."governance_hash" AS governance_hash,
          coalesce(version."published_at", version."created_at") AS updated_at,
          chunk."metadata" AS metadata,
          ${versionPolicySql} AS resource_policy,
          0.0::double precision AS keyword_score,
          0.0::double precision AS fuzzy_score,
          (1.0 - (embedding."embedding" <=> ${literal}::vector))::double precision AS semantic_score
        FROM public."knowledge_chunk_embeddings" AS embedding
        JOIN public."knowledge_chunks" AS chunk
          ON chunk."tenant_id" = embedding."tenant_id"
         AND chunk."id" = embedding."chunk_id"
        JOIN public."knowledge_bases" AS knowledge_base
          ON knowledge_base."tenant_id" = chunk."tenant_id"
         AND knowledge_base."id" = chunk."knowledge_base_id"
         AND ${knowledgeBaseStatusSql}
        JOIN public."knowledge_documents" AS document
          ON document."tenant_id" = chunk."tenant_id"
         AND document."knowledge_base_id" = chunk."knowledge_base_id"
         AND document."id" = chunk."document_id"
         AND document."status" = 'READY'
         AND ${documentVersionScopeSql}
        JOIN public."knowledge_document_versions" AS version
          ON version."tenant_id" = chunk."tenant_id"
         AND version."knowledge_base_id" = chunk."knowledge_base_id"
         AND version."document_id" = chunk."document_id"
         AND version."id" = chunk."document_version_id"
         AND version."status" = 'READY'
        WHERE embedding."tenant_id" = ${input.tenantId}::uuid
          AND embedding."embedding_model" = ${embedding.model}
          AND chunk."knowledge_base_id" IN (${accessibleKnowledgeBaseIdSql})
          AND ${resourceFilterSql}
        ORDER BY embedding."embedding" <=> ${literal}::vector, chunk."id" ASC
        LIMIT ${CANDIDATE_LIMIT}
      `);
    }

    const authorizedLexicalRows = lexicalRows.filter((row) =>
      knowledgeVersionResourcePolicyAllowed(row.resource_policy, resolvedAuthorization.filters),
    );
    const authorizedVectorRows = vectorRows.filter((row) =>
      knowledgeVersionResourcePolicyAllowed(row.resource_policy, resolvedAuthorization.filters),
    );
    const baseCandidates = mergeCandidates(
      authorizedLexicalRows,
      authorizedVectorRows,
      terms.length,
    );
    const seeds = relationshipSeeds(baseCandidates);

    try {
      const relationshipTargets = await this.relationships.expand(transaction, {
        tenantId: input.tenantId,
        accessibleKnowledgeBaseIds: accessibleIds,
        previewDraftKnowledgeBaseIds: previewDraftIds,
        previewKnowledgeVersionIds: previewVersionIds,
        seedChunkIds: seeds.map((seed) => seed.chunkId),
        query,
        candidateLimit: RELATIONSHIP_CANDIDATE_LIMIT,
        authorizationFilters: resolvedAuthorization.filters,
      });
      const authorizedRelationshipTargets = relationshipTargets.filter((target) =>
        knowledgeVersionResourcePolicyAllowed(target.resourcePolicy, resolvedAuthorization.filters),
      );
      const rankedTargets = rankKnowledgeRelationshipTargets({
        seeds: augmentRelationshipSeeds(seeds, authorizedRelationshipTargets),
        targets: authorizedRelationshipTargets,
        accessibleKnowledgeBaseIds: accessibleIds,
      });
      const baseIds = new Set(baseCandidates.map((candidate) => candidate.row.chunk_id));
      return {
        accessibleKnowledgeBaseIds: accessibleIds,
        candidates: mergeRelationshipCandidates(baseCandidates, rankedTargets),
        lexicalCandidateCount: authorizedLexicalRows.length,
        vectorCandidateCount: authorizedVectorRows.length,
        relationshipCandidateCount: new Set(
          authorizedRelationshipTargets.map((target) => target.chunkId),
        ).size,
        relationshipExpandedCount: rankedTargets.filter(
          (candidate) => !baseIds.has(candidate.target.chunkId),
        ).length,
        relationshipDiagnostic:
          rankedTargets.length === 0
            ? relationshipDiagnostic(
                'SKIPPED',
                authorizedRelationshipTargets.length === 0
                  ? 'KNOWLEDGE_RELATIONSHIP_CANDIDATES_EMPTY'
                  : 'KNOWLEDGE_RELATIONSHIP_CANDIDATES_REJECTED',
                authorizedRelationshipTargets.length,
              )
            : relationshipDiagnostic(
                'APPLIED',
                'KNOWLEDGE_RELATIONSHIP_EXPANSION_APPLIED',
                rankedTargets.length,
              ),
        relationshipDegradedReason: null,
      };
    } catch {
      return {
        accessibleKnowledgeBaseIds: accessibleIds,
        candidates: baseCandidates,
        lexicalCandidateCount: authorizedLexicalRows.length,
        vectorCandidateCount: authorizedVectorRows.length,
        relationshipCandidateCount: 0,
        relationshipExpandedCount: 0,
        relationshipDiagnostic: relationshipDiagnostic(
          'DEGRADED',
          'KNOWLEDGE_RELATIONSHIP_GRAPH_UNAVAILABLE',
          0,
        ),
        relationshipDegradedReason: 'KNOWLEDGE_RELATIONSHIP_GRAPH_UNAVAILABLE',
      };
    }
  }

  private async rankCandidates(
    input: SearchInput,
    query: string,
    loaded: LoadedCandidates,
    embedding: KnowledgeEmbeddingBatch | null,
    degradedReason: string | null,
    outboundClassification: AiDataClassification,
  ): Promise<KnowledgeRetrievalResponse> {
    if (embedding === null) return this.rankWithoutRemote(input, loaded, null, degradedReason);
    if (loaded.vectorCandidateCount === 0) {
      return buildResponse(
        input,
        loaded,
        embedding,
        'LEXICAL',
        null,
        degradedReason ?? 'KNOWLEDGE_VECTOR_CANDIDATES_EMPTY',
        null,
      );
    }
    const eligible = eligibleHybridCandidates(loaded.candidates);
    if (!this.semantic.rerankEnabled || eligible.length === 0) {
      return this.rankWithoutRemote(input, loaded, embedding, degradedReason);
    }
    const rerankClassification = maximumAiDataClassification(
      outboundClassification,
      ...eligible.map((candidate) =>
        knowledgeClassificationToAi(candidate.row.knowledge_classification),
      ),
    );
    if (!isExternalKnowledgeAiApproved(rerankClassification)) {
      return this.rankWithoutRemote(
        input,
        loaded,
        embedding,
        'KNOWLEDGE_RERANK_CLASSIFICATION_NOT_APPROVED',
      );
    }

    try {
      const reranked = await this.semantic.rerank(
        input.tenantId,
        query,
        eligible.map((candidate) => ({
          id: candidate.row.chunk_id,
          text: rerankDocumentText(candidate),
        })),
        Math.min(20, eligible.length),
        rerankClassification,
      );
      const scoreById = new Map(reranked.results.map((item) => [item.id, item.relevanceScore]));
      const crossEncoderResponse = buildResponse(
        input,
        loaded,
        embedding,
        'CROSS_ENCODER',
        reranked.model,
        degradedReason,
        scoreById,
      );
      if (crossEncoderResponse.items.length === 0 && eligible.length > 0) {
        return this.rankWithoutRemote(
          input,
          loaded,
          embedding,
          'KNOWLEDGE_RERANK_NO_RESULT_FALLBACK',
        );
      }
      return crossEncoderResponse;
    } catch (error) {
      return this.rankWithoutRemote(input, loaded, embedding, safeSemanticErrorCode(error));
    }
  }

  private rankWithoutRemote(
    input: SearchInput,
    loaded: LoadedCandidates,
    embedding: KnowledgeEmbeddingBatch | null,
    degradedReason: string | null,
  ): KnowledgeRetrievalResponse {
    return buildResponse(
      input,
      loaded,
      embedding,
      embedding === null ? 'LEXICAL' : 'RRF',
      null,
      degradedReason,
      null,
    );
  }
}

export function resolveOrganizationAuthorization(
  filters: KnowledgeResourceAuthorizationFilters,
  employments: readonly { readonly orgUnitId: string }[],
  orgUnits: readonly {
    readonly id: string;
    readonly parentId: string | null;
    readonly organizationId: string;
  }[],
): {
  readonly filters: KnowledgeResourceAuthorizationFilters;
  readonly assignmentOrgUnitIds: ReadonlySet<string> | null;
} {
  const unitById = new Map(orgUnits.map((unit) => [unit.id, unit]));
  const parentById = new Map(orgUnits.map((unit) => [unit.id, unit.parentId]));
  if (!filters.assignmentOrganizationScoped) {
    const memberOrganizationIds = new Set<string>();
    for (const employment of employments) {
      let current = unitById.get(employment.orgUnitId);
      const visited = new Set<string>();
      while (current !== undefined && !visited.has(current.id)) {
        visited.add(current.id);
        memberOrganizationIds.add(current.id);
        memberOrganizationIds.add(current.organizationId);
        current = current.parentId === null ? undefined : unitById.get(current.parentId);
      }
    }
    return {
      filters: withResolvedOrganizationIds(filters, [...memberOrganizationIds]),
      assignmentOrgUnitIds: null,
    };
  }

  const assignmentOrgUnitIds = new Set<string>();
  const metadataOrganizationIds = new Set(filters.organizationIds);
  for (const scopeId of filters.organizationIds) {
    const scopedUnit = unitById.get(scopeId);
    if (scopedUnit !== undefined) {
      assignmentOrgUnitIds.add(scopedUnit.id);
      metadataOrganizationIds.add(scopedUnit.organizationId);
      if (filters.includeOrganizationDescendants) {
        for (const candidate of orgUnits) {
          if (isOrgUnitAncestor(scopedUnit.id, candidate.id, parentById)) {
            assignmentOrgUnitIds.add(candidate.id);
            metadataOrganizationIds.add(candidate.id);
          }
        }
      }
      continue;
    }
    for (const candidate of orgUnits) {
      if (candidate.organizationId !== scopeId) continue;
      assignmentOrgUnitIds.add(candidate.id);
      metadataOrganizationIds.add(candidate.id);
    }
  }
  return {
    filters: withResolvedOrganizationIds(filters, [...metadataOrganizationIds]),
    assignmentOrgUnitIds,
  };
}

export function filterKnowledgeBasesByAssignmentOrganization<
  T extends {
    readonly orgUnits: readonly {
      readonly orgUnitId: string;
      readonly includeChildren: boolean;
    }[];
  },
>(
  knowledgeBases: readonly T[],
  assignmentOrgUnitIds: ReadonlySet<string> | null,
  parentByOrgUnitId: ReadonlyMap<string, string | null>,
): T[] {
  if (assignmentOrgUnitIds === null) return [...knowledgeBases];
  return knowledgeBases.filter(
    (knowledgeBase) =>
      knowledgeBase.orgUnits.length === 0 ||
      knowledgeBase.orgUnits.some((scope) =>
        [...assignmentOrgUnitIds].some(
          (organizationId) =>
            organizationId === scope.orgUnitId ||
            (scope.includeChildren &&
              isOrgUnitAncestor(scope.orgUnitId, organizationId, parentByOrgUnitId)),
        ),
      ),
  );
}

function mergeCandidates(
  lexicalRows: readonly CandidateRow[],
  vectorRows: readonly VectorCandidateRow[],
  termCount: number,
): CandidateState[] {
  const byId = new Map<
    string,
    {
      row: CandidateRow;
      lexicalRank: number | null;
      vectorRank: number | null;
      lexicalScore: number;
      semanticScore: number | null;
    }
  >();
  lexicalRows.forEach((row, index) => {
    const normalizedKeyword = Math.min(1, row.keyword_score / Math.max(1, termCount * 6));
    byId.set(row.chunk_id, {
      row,
      lexicalRank: index + 1,
      vectorRank: null,
      lexicalScore: normalizedKeyword * 0.65 + row.fuzzy_score * 0.35,
      semanticScore: null,
    });
  });
  vectorRows.forEach((row, index) => {
    const existing = byId.get(row.chunk_id);
    if (existing === undefined) {
      byId.set(row.chunk_id, {
        row,
        lexicalRank: null,
        vectorRank: index + 1,
        lexicalScore: 0,
        semanticScore: clampScore(row.semantic_score),
      });
    } else {
      existing.vectorRank = index + 1;
      existing.semanticScore = clampScore(row.semantic_score);
    }
  });
  return [...byId.values()].map((candidate) => ({
    ...candidate,
    fusionScore: normalizedRrf(candidate.lexicalRank, candidate.vectorRank),
    relationshipScore: 0,
    relationshipEvidence: [],
  }));
}

function relationshipSeeds(candidates: readonly CandidateState[]): KnowledgeRelationshipSeed[] {
  return candidates
    .filter(isEligibleRelationshipSeed)
    .sort(
      (left, right) =>
        baseCandidateScore(right) - baseCandidateScore(left) ||
        left.row.chunk_id.localeCompare(right.row.chunk_id),
    )
    .slice(0, RELATIONSHIP_SEED_LIMIT)
    .map((candidate, index) => ({
      chunkId: candidate.row.chunk_id,
      rank: index + 1,
      relevanceScore: baseCandidateScore(candidate),
    }));
}

function augmentRelationshipSeeds(
  baseSeeds: readonly KnowledgeRelationshipSeed[],
  targets: readonly KnowledgeRelationshipTargetRecord[],
): KnowledgeRelationshipSeed[] {
  const relevanceByChunkId = new Map(baseSeeds.map((seed) => [seed.chunkId, seed.relevanceScore]));
  for (const target of targets) {
    for (const evidence of target.evidence) {
      if (!Number.isFinite(evidence.sourceSeedScore) || evidence.sourceSeedScore <= 0) continue;
      relevanceByChunkId.set(
        evidence.sourceChunkId,
        Math.max(relevanceByChunkId.get(evidence.sourceChunkId) ?? 0, evidence.sourceSeedScore),
      );
    }
  }
  return [...relevanceByChunkId.entries()]
    .sort(
      ([leftId, leftScore], [rightId, rightScore]) =>
        rightScore - leftScore || leftId.localeCompare(rightId),
    )
    .slice(0, RELATIONSHIP_SEED_LIMIT * 2)
    .map(([chunkId, relevanceScore], index) => ({
      chunkId,
      relevanceScore: clampUnitScore(relevanceScore),
      rank: index + 1,
    }));
}

function mergeRelationshipCandidates(
  baseCandidates: readonly CandidateState[],
  relationshipTargets: ReturnType<typeof rankKnowledgeRelationshipTargets>,
): CandidateState[] {
  const candidates = new Map(
    baseCandidates.map((candidate) => [candidate.row.chunk_id, candidate]),
  );
  for (const relationship of relationshipTargets) {
    const existing = candidates.get(relationship.target.chunkId);
    if (existing !== undefined) {
      candidates.set(relationship.target.chunkId, {
        ...existing,
        relationshipScore: relationship.relationshipScore,
        relationshipEvidence: relationship.evidence,
      });
      continue;
    }
    candidates.set(relationship.target.chunkId, {
      row: {
        chunk_id: relationship.target.chunkId,
        knowledge_base_id: relationship.target.knowledgeBaseId,
        knowledge_base_name: relationship.target.knowledgeBaseName,
        document_id: relationship.target.documentId,
        document_version_id: relationship.target.documentVersionId,
        document_version: relationship.target.documentVersion,
        title: relationship.target.title,
        heading_path: [...relationship.target.headingPath],
        content: relationship.target.content,
        source_type: relationship.target.sourceType,
        knowledge_classification: relationship.target.classification,
        governance_hash: relationship.target.governanceHash,
        content_hash: relationship.target.contentHash,
        updated_at: relationship.target.updatedAt,
        metadata: relationship.target.metadata,
        resource_policy: relationship.target.resourcePolicy,
        keyword_score: 0,
        fuzzy_score: 0,
      },
      lexicalRank: null,
      vectorRank: null,
      lexicalScore: 0,
      semanticScore: null,
      fusionScore: 0,
      relationshipScore: relationship.relationshipScore,
      relationshipEvidence: relationship.evidence,
    });
  }
  return [...candidates.values()];
}

function buildResponse(
  input: SearchInput,
  loaded: LoadedCandidates,
  embedding: KnowledgeEmbeddingBatch | null,
  reranker: KnowledgeReranker,
  rerankerModel: string | null,
  degradedReason: string | null,
  rerankerScores: ReadonlyMap<string, number> | null,
): KnowledgeRetrievalResponse {
  const maximumPerDocument = 3;
  const documentCounts = new Map<string, number>();
  const limit = Math.min(20, Math.max(1, input.limit ?? 8));
  const hybrid = embedding !== null && loaded.vectorCandidateCount > 0;
  const items = loaded.candidates
    .map((candidate) => {
      const rerankerScore = rerankerScores?.get(candidate.row.chunk_id) ?? null;
      const baseScore = hybrid ? candidate.fusionScore : candidate.lexicalScore;
      const relationshipWeight = hybrid ? 0.24 : 0.3;
      const relationshipEnhancedScore =
        1 -
        (1 - clampUnitScore(baseScore)) * (1 - candidate.relationshipScore * relationshipWeight);
      const finalScore =
        rerankerScore === null
          ? relationshipEnhancedScore
          : rerankerScore * 0.75 + candidate.fusionScore * 0.15 + candidate.relationshipScore * 0.1;
      return { candidate, rerankerScore, finalScore };
    })
    .filter(({ candidate, rerankerScore }) =>
      rerankerScores === null
        ? hybrid
          ? isEligibleHybrid(candidate)
          : candidate.lexicalScore >= MINIMUM_LEXICAL_SCORE ||
            candidate.relationshipScore >= MINIMUM_RELATIONSHIP_SCORE
        : rerankerScore !== null && rerankerScore >= MINIMUM_RERANK_SCORE,
    )
    .sort(
      (left, right) =>
        right.finalScore - left.finalScore ||
        left.candidate.row.chunk_id.localeCompare(right.candidate.row.chunk_id),
    )
    .filter(({ candidate }) => {
      const count = documentCounts.get(candidate.row.document_id) ?? 0;
      if (count >= maximumPerDocument) return false;
      documentCounts.set(candidate.row.document_id, count + 1);
      return true;
    })
    .slice(0, limit)
    .map(({ candidate, rerankerScore, finalScore }) => ({
      chunkId: candidate.row.chunk_id,
      knowledgeBaseId: candidate.row.knowledge_base_id,
      knowledgeBaseName: candidate.row.knowledge_base_name,
      documentId: candidate.row.document_id,
      documentVersionId: candidate.row.document_version_id,
      documentVersion: candidate.row.document_version,
      title: candidate.row.title,
      headingPath: candidate.row.heading_path,
      content: candidate.row.content,
      sourceType: candidate.row.source_type,
      classification: knowledgeClassificationToAi(candidate.row.knowledge_classification),
      governanceHash: candidate.row.governance_hash,
      contentHash: candidate.row.content_hash,
      updatedAt: candidate.row.updated_at,
      keywordScore: candidate.row.keyword_score,
      fuzzyScore: candidate.row.fuzzy_score,
      semanticScore: candidate.semanticScore,
      fusionScore: candidate.fusionScore,
      rerankerScore,
      relationshipScore: candidate.relationshipScore,
      relationshipEvidence: candidate.relationshipEvidence,
      finalScore,
    }));
  return {
    accessibleKnowledgeBaseIds: loaded.accessibleKnowledgeBaseIds,
    mode: hybrid ? 'HYBRID' : 'LEXICAL',
    embeddingModel: embedding?.model ?? null,
    reranker,
    rerankerModel,
    degradedReason,
    lexicalCandidateCount: loaded.lexicalCandidateCount,
    vectorCandidateCount: loaded.vectorCandidateCount,
    relationshipCandidateCount: loaded.relationshipCandidateCount,
    relationshipExpandedCount: loaded.relationshipExpandedCount,
    semanticCoverage:
      loaded.candidates.length === 0
        ? 0
        : loaded.candidates.filter((candidate) => candidate.semanticScore !== null).length /
          loaded.candidates.length,
    diagnostics: buildDiagnostics(loaded, embedding, reranker, degradedReason),
    items,
  };
}

function resolveOutboundClassification(
  input: SearchInput,
  normalizedQuery: string,
): AiDataClassification {
  return maximumAiDataClassification(
    classifyTextForAiEgress(normalizedQuery),
    input.maximumOutboundClassification ?? 'PUBLIC',
  );
}

function eligibleHybridCandidates(candidates: readonly CandidateState[]): CandidateState[] {
  return candidates
    .filter(isEligibleHybrid)
    .sort(
      (left, right) =>
        right.fusionScore - left.fusionScore || left.row.chunk_id.localeCompare(right.row.chunk_id),
    );
}

function isEligibleHybrid(candidate: CandidateState): boolean {
  return (
    candidate.lexicalScore >= MINIMUM_LEXICAL_SCORE ||
    (candidate.semanticScore !== null && candidate.semanticScore >= MINIMUM_SEMANTIC_SCORE) ||
    candidate.relationshipScore >= MINIMUM_RELATIONSHIP_SCORE
  );
}

function isEligibleRelationshipSeed(candidate: CandidateState): boolean {
  return (
    (candidate.row.keyword_score > 0 &&
      candidate.lexicalScore >= MINIMUM_RELATIONSHIP_SEED_LEXICAL_SCORE) ||
    (candidate.semanticScore !== null &&
      candidate.semanticScore >= MINIMUM_RELATIONSHIP_SEED_SEMANTIC_SCORE)
  );
}

function baseCandidateScore(candidate: CandidateState): number {
  if (candidate.semanticScore === null) return clampUnitScore(candidate.lexicalScore);
  return clampUnitScore(
    Math.max(candidate.lexicalScore, candidate.fusionScore, candidate.semanticScore),
  );
}

function normalizedRrf(lexicalRank: number | null, vectorRank: number | null): number {
  const raw =
    (lexicalRank === null ? 0 : 1 / (RRF_K + lexicalRank)) +
    (vectorRank === null ? 0 : 1 / (RRF_K + vectorRank));
  return raw / (2 / (RRF_K + 1));
}

function buildDiagnostics(
  loaded: LoadedCandidates,
  embedding: KnowledgeEmbeddingBatch | null,
  reranker: KnowledgeReranker,
  degradedReason: string | null,
): KnowledgeRetrievalDiagnostic[] {
  const lexical = relationshipDiagnostic(
    loaded.lexicalCandidateCount > 0 ? 'APPLIED' : 'SKIPPED',
    loaded.lexicalCandidateCount > 0
      ? 'KNOWLEDGE_LEXICAL_RETRIEVAL_APPLIED'
      : 'KNOWLEDGE_LEXICAL_CANDIDATES_EMPTY',
    loaded.lexicalCandidateCount,
    'LEXICAL',
  );
  const vector =
    embedding === null
      ? relationshipDiagnostic(
          degradedReason?.includes('EMBEDDING') === true ? 'DEGRADED' : 'SKIPPED',
          degradedReason?.includes('EMBEDDING') === true
            ? degradedReason
            : 'KNOWLEDGE_VECTOR_RETRIEVAL_DISABLED',
          0,
          'VECTOR',
        )
      : relationshipDiagnostic(
          loaded.vectorCandidateCount > 0 ? 'APPLIED' : 'SKIPPED',
          loaded.vectorCandidateCount > 0
            ? 'KNOWLEDGE_VECTOR_RETRIEVAL_APPLIED'
            : 'KNOWLEDGE_VECTOR_CANDIDATES_EMPTY',
          loaded.vectorCandidateCount,
          'VECTOR',
        );
  const rerank = relationshipDiagnostic(
    reranker === 'LEXICAL' ? 'SKIPPED' : 'APPLIED',
    reranker === 'CROSS_ENCODER'
      ? 'KNOWLEDGE_CROSS_ENCODER_APPLIED'
      : reranker === 'RRF'
        ? 'KNOWLEDGE_RRF_APPLIED'
        : 'KNOWLEDGE_RERANK_NOT_APPLICABLE',
    loaded.candidates.length,
    'RERANK',
  );
  return [lexical, vector, loaded.relationshipDiagnostic, rerank];
}

function relationshipDiagnostic(
  status: KnowledgeRetrievalDiagnostic['status'],
  code: string,
  candidateCount: number,
  stage: KnowledgeRetrievalDiagnosticStage = 'RELATIONSHIP',
): KnowledgeRetrievalDiagnostic {
  return {
    stage,
    status,
    code: code.slice(0, 120),
    candidateCount: Math.max(0, Math.trunc(candidateCount)),
  };
}

function keywordScoreExpression(terms: readonly string[]): Prisma.Sql {
  if (terms.length === 0) return Prisma.sql`0.0`;
  return Prisma.join(
    terms.map(
      (term) => Prisma.sql`(
        CASE WHEN lower(document."title") LIKE ${`%${escapeLike(term)}%`} ESCAPE '\\' THEN 3.0 ELSE 0.0 END +
        CASE WHEN lower(array_to_string(chunk."heading_path", ' ')) LIKE ${`%${escapeLike(term)}%`} ESCAPE '\\' THEN 2.0 ELSE 0.0 END +
        CASE WHEN lower(chunk."content") LIKE ${`%${escapeLike(term)}%`} ESCAPE '\\' THEN 1.0 ELSE 0.0 END
      )`,
    ),
    ' + ',
  );
}

function rerankDocumentText(candidate: CandidateState): string {
  const relationshipContext = candidate.relationshipEvidence
    .flatMap((evidence) =>
      evidence.path.map(
        (edge) => `${edge.sourceEntityName} ${edge.predicate} ${edge.targetEntityName}`,
      ),
    )
    .join('\n');
  return [
    candidate.row.title,
    candidate.row.heading_path.join(' / '),
    relationshipContext,
    candidate.row.content,
  ]
    .filter(Boolean)
    .join('\n')
    .slice(0, 20_000);
}

function normalizeQuery(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 2_000);
}

function queryTerms(value: string): string[] {
  const lowered = value.toLowerCase();
  const words = lowered.match(/[a-z0-9][a-z0-9._-]{1,31}/g) ?? [];
  const chineseRuns = lowered.match(/[\p{Script=Han}]+/gu) ?? [];
  const bigrams = chineseRuns.flatMap((run) =>
    Array.from({ length: Math.max(0, run.length - 1) }, (_, index) => run.slice(index, index + 2)),
  );
  return [...new Set([...words, ...bigrams])].slice(0, 24);
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function vectorLiteral(vector: readonly number[]): string {
  if (vector.length !== 1_536 || vector.some((component) => !Number.isFinite(component))) {
    throw new KnowledgeAiRuntimeError('KNOWLEDGE_EMBEDDING_DIMENSION_MISMATCH', false);
  }
  return `[${vector.join(',')}]`;
}

function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(-1, value));
}

function clampUnitScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function safeSemanticErrorCode(error: unknown): string {
  return error instanceof KnowledgeAiRuntimeError
    ? error.code
    : 'KNOWLEDGE_SEMANTIC_SEARCH_UNAVAILABLE';
}
