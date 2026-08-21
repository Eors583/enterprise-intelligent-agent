import { createHash } from 'node:crypto';

import { Inject, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  AiDataClassification,
  KnowledgeRetrievalConfig,
  KnowledgeRetrievalMode as ConfiguredKnowledgeRetrievalMode,
} from '@enterprise/contracts';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../database/prisma.service.js';
import type { EnvironmentVariables } from '../../config/environment.js';
import {
  isExternalKnowledgeAiApproved,
  knowledgeClassificationToAi,
  maximumAiDataClassification,
  type KnowledgeDataClassification,
} from '../ai-safety-model-routing/ai-data-classification.js';
import { classifyTextForAiEgress } from '../ai-safety-model-routing/ai-safety-policy.js';
import { AuthorizationDecisionService } from '../authorization/authorization-decision.service.js';
import {
  KnowledgeAiRuntimeClient,
  KnowledgeAiRuntimeError,
  type KnowledgeEmbeddingBatch,
} from '../knowledge-semantic/knowledge-ai-runtime.client.js';
import {
  KnowledgeSearchIndex,
  type KnowledgeSearchIndexHit,
  type KnowledgeSearchIndexProfile,
} from '../knowledge-search-index/knowledge-search-index.port.js';
import {
  KnowledgeProviderRetrievalError,
  KnowledgeProviderRetrievalService,
  type ExternalKnowledgeEvidence,
} from '../knowledge-provider/application/knowledge-provider-retrieval.service.js';
import type {
  KnowledgeEvidenceRecheckInput,
  KnowledgeRetrievalAuthorizationContext,
  KnowledgeRetrievalDiagnostic,
  KnowledgeRetrievalDiagnosticStage,
  KnowledgeRetrievalMode,
  KnowledgeRetrievalResponse,
  KnowledgeRetrievalResult,
  KnowledgeReranker,
  KnowledgeSearchInput,
} from '../knowledge-gateway/knowledge-gateway.port.js';
import { KnowledgeRetrievalUnavailableError } from '../knowledge-gateway/knowledge-gateway.port.js';
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
import { routeKnowledgeQuery, type KnowledgeQueryRoute } from './domain/knowledge-query-router.js';
import { KnowledgeStructuredQueryService } from './knowledge-structured-query.service.js';
import {
  knowledgeFiltersFromDecision,
  knowledgeVersionResourcePolicyAllowed,
  knowledgeVersionResourcePolicySnapshotSql,
  knowledgeVersionResourcePolicySql,
  type KnowledgeResourceAuthorizationFilters,
  withResolvedOrganizationIds,
} from './knowledge-resource-authorization.js';

const CANDIDATE_LIMIT = 40;
// Recall still comes from the larger lexical/vector/relationship union. Limit
// the local CPU cross-encoder to the three strongest fused candidates so the
// interactive path stays within its measured P95 budget; GPU deployments can
// raise this value after their own benchmark.
const RERANK_CANDIDATE_LIMIT = 3;
const RERANK_INTERACTIVE_BUDGET_MS = 3_000;
const RERANK_TIMEOUT_COOLDOWN_MS = 60_000;
const RELATIONSHIP_SEED_LIMIT = 20;
const RELATIONSHIP_CANDIDATE_LIMIT = 80;
const MINIMUM_LEXICAL_SCORE = 0.08;
const MINIMUM_FUZZY_CANDIDATE_SCORE = 0.05;
const MINIMUM_SEMANTIC_SCORE = 0.35;
const MINIMUM_RERANK_SCORE = 0.15;
const MINIMUM_RELATIONSHIP_SCORE = 0.08;
const MINIMUM_RELATIONSHIP_SEED_LEXICAL_SCORE = 0.35;
const MINIMUM_RELATIONSHIP_SEED_SEMANTIC_SCORE = 0.6;
const MINIMUM_DIRECT_TERM_COVERAGE = 0.5;
const MINIMUM_DIRECT_FUZZY_SCORE = 0.25;
const ENGLISH_QUERY_STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'at',
  'does',
  'for',
  'how',
  'in',
  'is',
  'it',
  'of',
  'on',
  'or',
  'the',
  'to',
  'what',
  'when',
  'where',
  'which',
  'who',
  'why',
  'with',
]);

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
  readonly policy: KnowledgeBaseRetrievalPolicy;
}

interface KnowledgeBaseRetrievalPolicy extends KnowledgeRetrievalConfig {
  readonly knowledgeBaseId: string;
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
  readonly searchIndexDegradedReason: string | null;
  readonly policies: readonly KnowledgeBaseRetrievalPolicy[];
}

interface PrefetchedSearchIndexCandidates {
  readonly hits: readonly KnowledgeSearchIndexHit[] | null;
  readonly degradedReason: string | null;
}

interface ResolvedEmbeddingIndexProfile {
  readonly model: string;
  readonly dimensions: number;
  readonly indexVersionIds: readonly string[];
  readonly searchIndexScopes: readonly {
    readonly knowledgeBaseIds: readonly string[];
    readonly profile: KnowledgeSearchIndexProfile;
  }[];
}

const DEFAULT_RETRIEVAL_CONFIG: KnowledgeRetrievalConfig = {
  mode: 'HYBRID',
  topK: 8,
  scoreThreshold: 0.08,
  semanticWeight: 0.7,
  keywordWeight: 0.3,
  rerankEnabled: true,
  relationshipRetrievalEnabled: true,
  maxChunksPerDocument: 3,
};

@Injectable()
export class KnowledgeRetrievalService {
  private rerankCooldownUntil = 0;
  private readonly localBackendEnabled: boolean;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(KnowledgeAiRuntimeClient) private readonly semantic: KnowledgeAiRuntimeClient,
    @Inject(KnowledgeSearchIndex) private readonly searchIndex: KnowledgeSearchIndex,
    @Inject(KnowledgeRelationshipExpander)
    private readonly relationships: KnowledgeRelationshipExpander,
    @Inject(AuthorizationDecisionService)
    private readonly authorization: AuthorizationDecisionService,
    @Inject(KnowledgeStructuredQueryService)
    private readonly structured: KnowledgeStructuredQueryService,
    @Optional()
    @Inject(ConfigService)
    config?: ConfigService<EnvironmentVariables, true>,
    @Optional()
    @Inject(KnowledgeProviderRetrievalService)
    private readonly providerRetrieval?: KnowledgeProviderRetrievalService,
  ) {
    this.localBackendEnabled =
      config?.get('KNOWLEDGE_LOCAL_BACKEND_ENABLED', { infer: true }) ?? true;
  }

  async resolveAccessibleKnowledgeBaseIds(input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly authorization?: KnowledgeRetrievalAuthorizationContext;
  }): Promise<readonly string[]> {
    const authorizationFilters = this.authorizeRetrieval(input);
    return this.prisma.withTenant(input.tenantId, async (transaction) => {
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
          where: { tenantId: input.tenantId, status: 'ACTIVE' },
          include: { orgUnits: true, members: true },
          orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
        }),
      ]);
      const parentByOrgUnitId = new Map(orgUnits.map((unit) => [unit.id, unit.parentId]));
      const resolvedAuthorization = resolveOrganizationAuthorization(
        authorizationFilters,
        employments,
        orgUnits,
      );
      const activeOrgUnitIds = new Set(orgUnits.map((orgUnit) => orgUnit.id));
      const scopedKnowledgeBases = filterKnowledgeBasesByAssignmentOrganization(
        knowledgeBases,
        resolvedAuthorization.assignmentOrgUnitIds,
        parentByOrgUnitId,
      );
      return accessibleKnowledgeBaseIds({
        userActive: user?.status === 'ACTIVE',
        memberUserId: input.userId,
        memberOrgUnitIds: new Set(
          employments
            .map((employment) => employment.orgUnitId)
            .filter((orgUnitId) => activeOrgUnitIds.has(orgUnitId)),
        ),
        parentByOrgUnitId,
        knowledgeBases: scopedKnowledgeBases,
      }).slice(0, 50);
    });
  }

  async search(input: KnowledgeSearchInput): Promise<KnowledgeRetrievalResponse> {
    if (!this.localBackendEnabled) {
      const requested = new Set(input.knowledgeBaseIds);
      const accessibleKnowledgeBaseIds = (
        await this.resolveAccessibleKnowledgeBaseIds({
          tenantId: input.tenantId,
          userId: input.userId,
          ...(input.authorization === undefined ? {} : { authorization: input.authorization }),
        })
      ).filter((id) => requested.has(id));
      const query = normalizeQuery(input.query);
      return this.mergeExternalResults(
        input,
        localBackendDisabledResponse(accessibleKnowledgeBaseIds),
        resolveOutboundClassification(input, query),
      );
    }
    const authorizationFilters = this.authorizeRetrieval(input);
    const query = normalizeQuery(input.query);
    const queryRoute = routeKnowledgeQuery(input.query);
    const outboundClassification = resolveOutboundClassification(input, query);
    const embeddingProfile = await this.resolveEmbeddingProfile(input);
    let embedding: KnowledgeEmbeddingBatch | null = null;
    let degradedReason: string | null = null;
    if (queryRoute.primary === 'SQL') {
      // Exact workbook analysis does not send table contents to a model provider.
      // Authorized lexical candidates are sufficient to locate the structured artifact.
      embedding = null;
    } else if (
      this.semantic.semanticEnabled &&
      !isExternalKnowledgeAiApproved(outboundClassification)
    ) {
      degradedReason = 'KNOWLEDGE_EMBEDDING_CLASSIFICATION_NOT_APPROVED';
    } else if (this.semantic.semanticEnabled && embeddingProfile === null) {
      degradedReason = 'KNOWLEDGE_EMBEDDING_INDEX_PROFILE_UNAVAILABLE';
    } else if (this.semantic.semanticEnabled) {
      try {
        embedding = await this.semantic.embed(
          input.tenantId,
          [query],
          outboundClassification,
          undefined,
          embeddingProfile ?? undefined,
        );
      } catch (error) {
        degradedReason = safeSemanticErrorCode(error);
      }
    }

    const prefetchedSearchIndex = await this.prefetchSearchIndex(
      input,
      query,
      embedding,
      embeddingProfile,
    );
    const loaded = await this.prisma.withTenant(input.tenantId, (transaction) =>
      this.loadCandidates(
        transaction,
        input,
        query,
        queryRoute,
        embedding,
        embeddingProfile,
        authorizationFilters,
        prefetchedSearchIndex,
      ),
    );
    const ranked = await this.rankCandidates(
      input,
      query,
      loaded,
      embedding,
      degradedReason ??
        prefetchedSearchIndex.degradedReason ??
        loaded.searchIndexDegradedReason ??
        loaded.relationshipDegradedReason,
      outboundClassification,
    );
    const routed = await this.applyQueryRoute(input, ranked);
    return this.mergeExternalResults(input, routed, outboundClassification);
  }

  async areChunksAccessible(input: KnowledgeEvidenceRecheckInput): Promise<boolean> {
    // A Run with no knowledge evidence has nothing to re-authorize. Selected
    // Knowledge Base ids are not model context; any evidence that is present is
    // still rechecked below and fails closed when its backend is unavailable.
    if (input.chunks.length === 0) return true;
    const externalChunks = input.chunks.filter((chunk) => chunk.sourceProvider === 'LEXIANG');
    if (externalChunks.length > 0) {
      if (
        this.providerRetrieval === undefined ||
        externalChunks.some(
          (chunk) =>
            chunk.knowledgeBaseId === undefined ||
            chunk.governanceHash !== externalGovernanceHash(input.tenantId, chunk.knowledgeBaseId),
        )
      ) {
        return false;
      }
      const externalKnowledgeBaseIds = [
        ...new Set(externalChunks.flatMap((chunk) => chunk.knowledgeBaseId ?? [])),
      ];
      const accessibleKnowledgeBaseIds = new Set(
        await this.resolveAccessibleKnowledgeBaseIds({
          tenantId: input.tenantId,
          userId: input.userId,
          ...(input.authorization === undefined ? {} : { authorization: input.authorization }),
        }),
      );
      if (
        externalKnowledgeBaseIds.some((id) => !accessibleKnowledgeBaseIds.has(id)) ||
        !(await this.providerRetrieval.areKnowledgeBasesRetrievable(
          input.tenantId,
          input.userId,
          externalKnowledgeBaseIds,
        ))
      ) {
        return false;
      }
    }
    const localChunks = input.chunks.filter((chunk) => chunk.sourceProvider !== 'LEXIANG');
    if (localChunks.length === 0) return true;
    if (!this.localBackendEnabled) return false;
    return this.prisma.withTenant(input.tenantId, (transaction) =>
      this.areChunksAccessibleInTransaction(transaction, { ...input, chunks: localChunks }),
    );
  }

  private async mergeExternalResults(
    input: KnowledgeSearchInput,
    local: KnowledgeRetrievalResponse,
    outboundClassification: AiDataClassification,
  ): Promise<KnowledgeRetrievalResponse> {
    if (
      local.accessibleKnowledgeBaseIds.length === 0 ||
      !isExternalKnowledgeAiApproved(outboundClassification)
    ) {
      return local;
    }
    if (this.providerRetrieval === undefined) {
      if (!this.localBackendEnabled && local.items.length === 0) {
        throw new KnowledgeRetrievalUnavailableError('KNOWLEDGE_PROVIDER_RETRIEVAL_UNAVAILABLE');
      }
      return local;
    }
    const limit = Math.min(20, Math.max(1, input.limit ?? DEFAULT_RETRIEVAL_CONFIG.topK));
    try {
      const external = await this.providerRetrieval.search({
        tenantId: input.tenantId,
        userId: input.userId,
        knowledgeBaseIds: local.accessibleKnowledgeBaseIds,
        query: input.query,
        limit,
      });
      if (external.searchedKnowledgeBaseIds.length === 0) {
        if (local.items.length === 0) {
          throw new KnowledgeRetrievalUnavailableError('LEXIANG_SEARCH_TARGET_UNAVAILABLE');
        }
        return local;
      }
      const externalItems = external.items.map((item, index) =>
        externalRetrievalResult(input.tenantId, item, index, external.items.length),
      );
      const allExternal = local.accessibleKnowledgeBaseIds.every((id) =>
        external.searchedKnowledgeBaseIds.includes(id),
      );
      return {
        ...local,
        mode: 'HYBRID',
        reranker: 'WEIGHTED_SCORE',
        degradedReason:
          allExternal &&
          (local.degradedReason === 'KNOWLEDGE_EMBEDDING_INDEX_PROFILE_UNAVAILABLE' ||
            local.degradedReason === 'KNOWLEDGE_LOCAL_BACKEND_DISABLED')
            ? null
            : local.degradedReason,
        diagnostics: [
          ...local.diagnostics,
          {
            stage: 'EXTERNAL',
            status: 'APPLIED',
            code: 'LEXIANG_AI_SEARCH_APPLIED',
            candidateCount: externalItems.length,
          },
        ],
        items: [...local.items, ...externalItems]
          .sort(
            (left, right) =>
              right.finalScore - left.finalScore || left.chunkId.localeCompare(right.chunkId),
          )
          .slice(0, limit),
      };
    } catch (error) {
      if (error instanceof KnowledgeRetrievalUnavailableError) throw error;
      if (!(error instanceof KnowledgeProviderRetrievalError)) throw error;
      // An unavailable remote-only source is not the same as a successful
      // search with zero matches. Let Agent Run keep the event queued and retry
      // instead of publishing a false "no enterprise knowledge" answer.
      if (local.items.length === 0) throw new KnowledgeRetrievalUnavailableError(error.code);
      return {
        ...local,
        degradedReason: error.code,
        diagnostics: [
          ...local.diagnostics,
          {
            stage: 'EXTERNAL',
            status: 'DEGRADED',
            code: error.code,
            candidateCount: 0,
          },
        ],
      };
    }
  }

  private async resolveEmbeddingProfile(
    input: KnowledgeSearchInput,
  ): Promise<ResolvedEmbeddingIndexProfile | null> {
    const requestedIds = [...new Set(input.knowledgeBaseIds)].slice(0, 50);
    if (requestedIds.length === 0) return null;
    const indexes = await this.prisma.withTenant(input.tenantId, (transaction) =>
      transaction.knowledgeBase.findMany({
        where: { tenantId: input.tenantId, id: { in: requestedIds } },
        select: {
          id: true,
          activeEmbeddingIndexVersion: {
            select: {
              id: true,
              provider: true,
              model: true,
              dimensions: true,
              distance: true,
              collectionName: true,
            },
          },
        },
      }),
    );
    const active = indexes.flatMap((item) =>
      item.activeEmbeddingIndexVersion == null
        ? []
        : [{ knowledgeBaseId: item.id, ...item.activeEmbeddingIndexVersion }],
    );
    if (active.length === 0) return null;
    const first = active[0];
    if (first === undefined || first.distance !== 'COSINE') return null;
    const compatible = active.every(
      (item) =>
        item.model === first.model &&
        item.dimensions === first.dimensions &&
        item.distance === first.distance,
    );
    if (!compatible) return null;
    const scopesByCollection = new Map<string, typeof active>();
    for (const item of active) {
      const key = item.collectionName ?? '';
      const scope = scopesByCollection.get(key);
      if (scope === undefined) scopesByCollection.set(key, [item]);
      else scope.push(item);
    }
    return {
      model: first.model,
      dimensions: first.dimensions,
      indexVersionIds: active.map((item) => item.id),
      searchIndexScopes: [...scopesByCollection.values()].map((scope) => {
        const scopeFirst = scope[0];
        if (scopeFirst === undefined)
          throw new Error('KNOWLEDGE_EMBEDDING_INDEX_PROFILE_UNAVAILABLE');
        return {
          knowledgeBaseIds: scope.map((item) => item.knowledgeBaseId),
          profile: {
            indexVersionId: scopeFirst.id,
            ...(scope.every((item) => item.provider === 'legacy_runtime')
              ? {}
              : { compatibleIndexVersionIds: scope.map((item) => item.id) }),
            collectionName: scopeFirst.collectionName,
            dimensions: scopeFirst.dimensions,
            distance: 'COSINE' as const,
          },
        };
      }),
    };
  }

  private async applyQueryRoute(
    input: KnowledgeSearchInput,
    response: KnowledgeRetrievalResponse,
  ): Promise<KnowledgeRetrievalResponse> {
    const queryRoute = routeKnowledgeQuery(input.query);
    const routerDiagnostic: KnowledgeRetrievalDiagnostic = {
      stage: 'ROUTER',
      status: 'APPLIED',
      code: queryRoute.reasonCode,
      candidateCount: response.items.length,
    };
    if (queryRoute.primary !== 'SQL') {
      return {
        ...response,
        queryRoute,
        structuredQuerySql: null,
        diagnostics: [...response.diagnostics, routerDiagnostic],
      };
    }
    try {
      const structured = await this.structured.tryQuery({
        tenantId: input.tenantId,
        query: input.query,
        candidates: response.items.map((item) => ({
          documentVersionId: item.documentVersionId,
          chunkId: item.chunkId,
        })),
      });
      if (structured === null) {
        return {
          ...response,
          queryRoute,
          structuredQuerySql: null,
          diagnostics: [
            ...response.diagnostics,
            routerDiagnostic,
            {
              stage: 'SQL',
              status: 'SKIPPED',
              code: 'KNOWLEDGE_SQL_NO_MATCHING_WORKBOOK_PLAN',
              candidateCount: 0,
            },
          ],
        };
      }
      const source = response.items.find(
        (item) =>
          item.documentVersionId === structured.documentVersionId &&
          item.chunkId === structured.chunkId,
      );
      if (source === undefined) return response;
      return {
        ...response,
        queryRoute,
        structuredQuerySql: structured.sql,
        diagnostics: [
          ...response.diagnostics,
          routerDiagnostic,
          {
            stage: 'SQL',
            status: 'APPLIED',
            code: 'KNOWLEDGE_SQL_WORKBOOK_QUERY_APPLIED',
            candidateCount: 1,
          },
        ],
        items: [
          {
            ...source,
            headingPath: [`工作表：${structured.sheetName}`],
            sheetName: structured.sheetName,
            content: structured.content,
            finalScore: 1,
          },
          ...response.items.filter((item) => item.chunkId !== source.chunkId),
        ],
      };
    } catch {
      return {
        ...response,
        queryRoute,
        structuredQuerySql: null,
        degradedReason: response.degradedReason ?? 'KNOWLEDGE_SQL_CHANNEL_UNAVAILABLE',
        diagnostics: [
          ...response.diagnostics,
          routerDiagnostic,
          {
            stage: 'SQL',
            status: 'DEGRADED',
            code: 'KNOWLEDGE_SQL_CHANNEL_UNAVAILABLE',
            candidateCount: 0,
          },
        ],
      };
    }
  }

  /**
   * Transaction-bound compatibility path. It is intentionally lexical-only:
   * no provider HTTP request is ever made while a caller holds a DB lock.
   */
  async searchInTransaction(
    transaction: Prisma.TransactionClient,
    input: KnowledgeSearchInput,
  ): Promise<KnowledgeRetrievalResponse> {
    const authorizationFilters = this.authorizeRetrieval(input);
    const query = normalizeQuery(input.query);
    const queryRoute = routeKnowledgeQuery(input.query);
    const loaded = await this.loadCandidates(
      transaction,
      input,
      query,
      queryRoute,
      null,
      null,
      authorizationFilters,
      { hits: null, degradedReason: null },
    );
    return this.rankWithoutRemote(
      input,
      loaded,
      null,
      loaded.searchIndexDegradedReason ?? loaded.relationshipDegradedReason,
    );
  }

  /** Re-checks source lineage and ACLs immediately before runtime dispatch. */
  async areChunksAccessibleInTransaction(
    transaction: Prisma.TransactionClient,
    input: KnowledgeEvidenceRecheckInput,
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
        include: { orgUnits: true, members: true },
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
      memberUserId: input.userId,
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
      input.userId,
    );
  }

  private async loadCandidates(
    transaction: Prisma.TransactionClient,
    input: KnowledgeSearchInput,
    query: string,
    queryRoute: KnowledgeQueryRoute,
    embedding: KnowledgeEmbeddingBatch | null,
    embeddingProfile: ResolvedEmbeddingIndexProfile | null,
    authorizationFilters: KnowledgeResourceAuthorizationFilters,
    prefetchedSearchIndex: PrefetchedSearchIndexCandidates,
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
        searchIndexDegradedReason: null,
        policies: [],
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
        include: { orgUnits: true, members: true },
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
      memberUserId: input.userId,
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
        searchIndexDegradedReason: null,
        policies: [],
      };
    }

    const accessibleIdSet = new Set(accessibleIds);
    const policies = scopedKnowledgeBases
      .filter((knowledgeBase) => accessibleIdSet.has(knowledgeBase.id))
      .map(resolveKnowledgeBaseRetrievalPolicy);
    const policyByKnowledgeBaseId = new Map(
      policies.map((policy) => [policy.knowledgeBaseId, policy]),
    );

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
    const lexicalCandidateFilter = lexicalCandidateFilterExpression(terms);
    const resourceFilterSql = knowledgeVersionResourcePolicySql(
      Prisma.sql`version`,
      resolvedAuthorization.filters,
    );
    const versionPolicySql = knowledgeVersionResourcePolicySnapshotSql(Prisma.sql`version`);
    const requiresPostgresLexical =
      this.searchIndex.driver === 'postgres' ||
      prefetchedSearchIndex.hits === null ||
      policies.some((policy) => policy.mode === 'FULL_TEXT');
    const lexicalRows = requiresPostgresLexical
      ? await transaction.$queryRaw<CandidateRow[]>(Prisma.sql`
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
          AND (${lexicalCandidateFilter})
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
    `)
      : [];

    let vectorRows: VectorCandidateRow[] = [];
    let searchIndexDegradedReason = prefetchedSearchIndex.degradedReason;
    let usePostgresVector =
      this.searchIndex.driver === 'postgres' ||
      (this.searchIndex.driver === 'qdrant' && prefetchedSearchIndex.hits === null);
    const queryVector = embedding?.vectors[0];
    if (
      embedding !== null &&
      embeddingProfile !== null &&
      queryVector !== undefined &&
      this.searchIndex.driver === 'qdrant'
    ) {
      try {
        const hits = prefetchedSearchIndex.hits ?? [];
        if (hits.length > 0) {
          const maximumScore = Math.max(...hits.map((hit) => hit.score), Number.EPSILON);
          const scoredChunks = Prisma.join(
            hits.map(
              (hit, index) =>
                Prisma.sql`(${hit.chunkId}::uuid, ${hit.score / maximumScore}::double precision, ${index + 1}::int)`,
            ),
          );
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
              scored.semantic_score
            FROM (VALUES ${scoredChunks}) AS scored(chunk_id, semantic_score, search_rank)
            JOIN public."knowledge_chunks" AS chunk
              ON chunk."tenant_id" = ${input.tenantId}::uuid
             AND chunk."id" = scored.chunk_id
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
            WHERE chunk."knowledge_base_id" IN (${accessibleKnowledgeBaseIdSql})
              AND ${resourceFilterSql}
            ORDER BY scored.search_rank, chunk."id"
            LIMIT ${CANDIDATE_LIMIT}
          `);
        }
      } catch {
        searchIndexDegradedReason = 'KNOWLEDGE_QDRANT_UNAVAILABLE';
        usePostgresVector = true;
      }
    }
    if (
      embedding !== null &&
      embeddingProfile !== null &&
      queryVector !== undefined &&
      usePostgresVector
    ) {
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
      const embeddingIndexVersionIdSql = Prisma.join(
        embeddingProfile.indexVersionIds.map((id) => Prisma.sql`${id}::uuid`),
      );
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
          AND embedding."embedding_index_version_id" IN (${embeddingIndexVersionIdSql})
          AND embedding."embedding_model" = ${embedding.model}
          AND embedding."embedding_dimension" = ${embeddingProfile.dimensions}
          AND chunk."knowledge_base_id" IN (${accessibleKnowledgeBaseIdSql})
          AND ${resourceFilterSql}
        ORDER BY embedding."embedding" <=> ${literal}::vector, chunk."id" ASC
        LIMIT ${CANDIDATE_LIMIT}
      `);
    }

    const authorizedLexicalRows = lexicalRows.filter((row) =>
      knowledgeVersionResourcePolicyAllowed(row.resource_policy, resolvedAuthorization.filters),
    );
    const authorizedVectorRows = vectorRows.filter(
      (row) =>
        knowledgeVersionResourcePolicyAllowed(row.resource_policy, resolvedAuthorization.filters) &&
        retrievalPolicy(policyByKnowledgeBaseId, row.knowledge_base_id).mode !== 'FULL_TEXT',
    );
    const knowledgeBasesWithVectorCandidates = new Set(
      authorizedVectorRows.map((row) => row.knowledge_base_id),
    );
    const effectiveLexicalRows = authorizedLexicalRows.filter((row) => {
      const policy = retrievalPolicy(policyByKnowledgeBaseId, row.knowledge_base_id);
      return (
        policy.mode !== 'VECTOR' || !knowledgeBasesWithVectorCandidates.has(row.knowledge_base_id)
      );
    });
    const baseCandidates = mergeCandidates(
      effectiveLexicalRows,
      authorizedVectorRows,
      terms.length,
      policyByKnowledgeBaseId,
    );
    const seeds = relationshipSeeds(baseCandidates);

    // Graph expansion is materially more expensive than dense/sparse document
    // retrieval. Keep it on the hot path only for an explicit relationship
    // question, while preserving entity-name graph discovery when ordinary
    // retrieval could not find any seed candidates.
    if (queryRoute.primary !== 'RELATIONSHIP' && baseCandidates.length > 0) {
      return {
        accessibleKnowledgeBaseIds: accessibleIds,
        candidates: baseCandidates,
        lexicalCandidateCount: effectiveLexicalRows.length,
        vectorCandidateCount: authorizedVectorRows.length,
        relationshipCandidateCount: 0,
        relationshipExpandedCount: 0,
        relationshipDiagnostic: relationshipDiagnostic(
          'SKIPPED',
          'KNOWLEDGE_RELATIONSHIP_ROUTE_NOT_SELECTED',
          0,
        ),
        relationshipDegradedReason: null,
        searchIndexDegradedReason,
        policies,
      };
    }

    const relationshipKnowledgeBaseIds = accessibleIds.filter(
      (knowledgeBaseId) =>
        retrievalPolicy(policyByKnowledgeBaseId, knowledgeBaseId).relationshipRetrievalEnabled,
    );
    if (relationshipKnowledgeBaseIds.length === 0) {
      return {
        accessibleKnowledgeBaseIds: accessibleIds,
        candidates: baseCandidates,
        lexicalCandidateCount: effectiveLexicalRows.length,
        vectorCandidateCount: authorizedVectorRows.length,
        relationshipCandidateCount: 0,
        relationshipExpandedCount: 0,
        relationshipDiagnostic: relationshipDiagnostic(
          'SKIPPED',
          'KNOWLEDGE_RELATIONSHIP_RETRIEVAL_DISABLED',
          0,
        ),
        relationshipDegradedReason: null,
        searchIndexDegradedReason,
        policies,
      };
    }

    try {
      const relationshipTargets = await this.relationships.expand(transaction, {
        tenantId: input.tenantId,
        accessibleKnowledgeBaseIds: relationshipKnowledgeBaseIds,
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
        accessibleKnowledgeBaseIds: relationshipKnowledgeBaseIds,
      });
      const baseIds = new Set(baseCandidates.map((candidate) => candidate.row.chunk_id));
      return {
        accessibleKnowledgeBaseIds: accessibleIds,
        candidates: mergeRelationshipCandidates(
          baseCandidates,
          rankedTargets,
          policyByKnowledgeBaseId,
        ),
        lexicalCandidateCount: effectiveLexicalRows.length,
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
        searchIndexDegradedReason,
        policies,
      };
    } catch {
      return {
        accessibleKnowledgeBaseIds: accessibleIds,
        candidates: baseCandidates,
        lexicalCandidateCount: effectiveLexicalRows.length,
        vectorCandidateCount: authorizedVectorRows.length,
        relationshipCandidateCount: 0,
        relationshipExpandedCount: 0,
        relationshipDiagnostic: relationshipDiagnostic(
          'DEGRADED',
          'KNOWLEDGE_RELATIONSHIP_GRAPH_UNAVAILABLE',
          0,
        ),
        relationshipDegradedReason: 'KNOWLEDGE_RELATIONSHIP_GRAPH_UNAVAILABLE',
        searchIndexDegradedReason,
        policies,
      };
    }
  }

  /**
   * External search must finish before opening the tenant transaction. Holding an
   * interactive Prisma transaction across an HTTP call makes database availability
   * depend on Qdrant latency and can expire the transaction before ACL verification.
   * PostgreSQL still performs the authoritative tenant, publication and resource-policy
   * checks for every returned chunk id.
   */
  private async prefetchSearchIndex(
    input: KnowledgeSearchInput,
    query: string,
    embedding: KnowledgeEmbeddingBatch | null,
    embeddingProfile: ResolvedEmbeddingIndexProfile | null,
  ): Promise<PrefetchedSearchIndexCandidates> {
    const vector = embedding?.vectors[0];
    if (this.searchIndex.driver !== 'qdrant' || vector === undefined || embeddingProfile === null) {
      return { hits: null, degradedReason: null };
    }
    try {
      const knowledgeBaseIds = [...new Set(input.knowledgeBaseIds)].slice(0, 50);
      if (knowledgeBaseIds.length === 0) return { hits: [], degradedReason: null };
      const previewDocumentVersionIds = [...new Set(input.previewKnowledgeVersionIds ?? [])].slice(
        0,
        20,
      );
      const hitsByScope = await Promise.all(
        embeddingProfile.searchIndexScopes.map((scope) =>
          this.searchIndex.query({
            profile: scope.profile,
            tenantId: input.tenantId,
            knowledgeBaseIds: scope.knowledgeBaseIds.filter((id) => knowledgeBaseIds.includes(id)),
            ...(previewDocumentVersionIds.length === 0 ? {} : { previewDocumentVersionIds }),
            query,
            vector,
            limit: CANDIDATE_LIMIT,
          }),
        ),
      );
      const scoreByChunkId = new Map<string, number>();
      for (const hit of hitsByScope.flat()) {
        scoreByChunkId.set(hit.chunkId, Math.max(scoreByChunkId.get(hit.chunkId) ?? 0, hit.score));
      }
      const hits = [...scoreByChunkId.entries()]
        .map(([chunkId, score]) => ({ chunkId, score }))
        .sort(
          (left, right) => right.score - left.score || left.chunkId.localeCompare(right.chunkId),
        )
        .slice(0, CANDIDATE_LIMIT);
      return { hits, degradedReason: null };
    } catch {
      return { hits: null, degradedReason: 'KNOWLEDGE_QDRANT_UNAVAILABLE' };
    }
  }

  private async rankCandidates(
    input: KnowledgeSearchInput,
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
    const eligible = eligibleHybridCandidates(loaded.candidates)
      .filter((candidate) => candidate.policy.rerankEnabled)
      .slice(0, RERANK_CANDIDATE_LIMIT);
    if (!this.semantic.rerankEnabled || eligible.length === 0) {
      return this.rankWithoutRemote(input, loaded, embedding, degradedReason);
    }
    if (Date.now() < this.rerankCooldownUntil) {
      return this.rankWithoutRemote(
        input,
        loaded,
        embedding,
        'KNOWLEDGE_RERANK_CIRCUIT_OPEN_FALLBACK',
      );
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

    const rerankController = new AbortController();
    const rerankTimer = setTimeout(() => rerankController.abort(), RERANK_INTERACTIVE_BUDGET_MS);
    rerankTimer.unref?.();
    try {
      const reranked = await this.semantic.rerank(
        input.tenantId,
        query,
        eligible.map((candidate) => ({
          id: candidate.row.chunk_id,
          text: rerankDocumentText(candidate, query),
        })),
        Math.min(20, eligible.length),
        rerankClassification,
        rerankController.signal,
      );
      if (reranked.results.every((item) => item.relevanceScore < MINIMUM_RERANK_SCORE)) {
        return this.rankWithoutRemote(
          input,
          loaded,
          embedding,
          'KNOWLEDGE_RERANK_NO_RESULT_FALLBACK',
        );
      }
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
      if (rerankController.signal.aborted) {
        this.rerankCooldownUntil = Date.now() + RERANK_TIMEOUT_COOLDOWN_MS;
      }
      return this.rankWithoutRemote(
        input,
        loaded,
        embedding,
        rerankController.signal.aborted
          ? 'KNOWLEDGE_RERANK_TIMEOUT_FALLBACK'
          : safeSemanticErrorCode(error),
      );
    } finally {
      clearTimeout(rerankTimer);
    }
  }

  private rankWithoutRemote(
    input: KnowledgeSearchInput,
    loaded: LoadedCandidates,
    embedding: KnowledgeEmbeddingBatch | null,
    degradedReason: string | null,
  ): KnowledgeRetrievalResponse {
    return buildResponse(
      input,
      loaded,
      embedding,
      embedding === null ? 'LEXICAL' : 'WEIGHTED_SCORE',
      null,
      degradedReason,
      null,
    );
  }
}

function localBackendDisabledResponse(
  accessibleKnowledgeBaseIds: readonly string[] = [],
): KnowledgeRetrievalResponse {
  return {
    accessibleKnowledgeBaseIds,
    mode: 'LEXICAL',
    embeddingModel: null,
    reranker: 'LEXICAL',
    rerankerModel: null,
    degradedReason: 'KNOWLEDGE_LOCAL_BACKEND_DISABLED',
    lexicalCandidateCount: 0,
    vectorCandidateCount: 0,
    relationshipCandidateCount: 0,
    relationshipExpandedCount: 0,
    semanticCoverage: 0,
    diagnostics: [],
    items: [],
  };
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
  policyByKnowledgeBaseId: ReadonlyMap<string, KnowledgeBaseRetrievalPolicy>,
): CandidateState[] {
  const byId = new Map<
    string,
    {
      row: CandidateRow;
      lexicalRank: number | null;
      vectorRank: number | null;
      lexicalScore: number;
      semanticScore: number | null;
      policy: KnowledgeBaseRetrievalPolicy;
    }
  >();
  lexicalRows.forEach((row, index) => {
    const normalizedKeyword = Math.min(1, row.keyword_score / Math.max(1, Math.min(termCount, 6)));
    byId.set(row.chunk_id, {
      row,
      lexicalRank: index + 1,
      vectorRank: null,
      lexicalScore: normalizedKeyword * 0.65 + row.fuzzy_score * 0.35,
      semanticScore: null,
      policy: retrievalPolicy(policyByKnowledgeBaseId, row.knowledge_base_id),
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
        policy: retrievalPolicy(policyByKnowledgeBaseId, row.knowledge_base_id),
      });
    } else {
      existing.vectorRank = index + 1;
      existing.semanticScore = clampScore(row.semantic_score);
    }
  });
  return [...byId.values()].map((candidate) => ({
    ...candidate,
    fusionScore: weightedFusionScore(
      candidate.lexicalScore,
      candidate.semanticScore,
      candidate.policy,
    ),
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
  policyByKnowledgeBaseId: ReadonlyMap<string, KnowledgeBaseRetrievalPolicy>,
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
      policy: retrievalPolicy(policyByKnowledgeBaseId, relationship.target.knowledgeBaseId),
    });
  }
  return [...candidates.values()];
}

function buildResponse(
  input: KnowledgeSearchInput,
  loaded: LoadedCandidates,
  embedding: KnowledgeEmbeddingBatch | null,
  reranker: KnowledgeReranker,
  rerankerModel: string | null,
  degradedReason: string | null,
  rerankerScores: ReadonlyMap<string, number> | null,
): KnowledgeRetrievalResponse {
  const documentCounts = new Map<string, number>();
  const configuredTopK =
    loaded.policies.length === 0
      ? DEFAULT_RETRIEVAL_CONFIG.topK
      : loaded.policies.reduce((maximum, policy) => Math.max(maximum, policy.topK), 1);
  const limit = Math.min(20, Math.max(1, input.limit ?? configuredTopK));
  const hybrid = embedding !== null && loaded.vectorCandidateCount > 0;
  const evidenceTerms = queryTerms(input.query);
  const items = loaded.candidates
    .map((candidate) => {
      const rerankerScore = rerankerScores?.get(candidate.row.chunk_id) ?? null;
      const usesWeightedHybridFusion = hybrid && candidate.policy.mode === 'HYBRID';
      const candidateHasSemanticScore = candidate.semanticScore !== null;
      const baseScore = usesWeightedHybridFusion
        ? candidate.fusionScore
        : candidateHasSemanticScore
          ? candidate.fusionScore
          : candidate.lexicalScore;
      const relationshipWeight = usesWeightedHybridFusion || candidateHasSemanticScore ? 0.24 : 0.3;
      const relationshipEnhancedScore =
        1 -
        (1 - clampUnitScore(baseScore)) * (1 - candidate.relationshipScore * relationshipWeight);
      const finalScore =
        rerankerScore === null
          ? relationshipEnhancedScore
          : Math.max(
              rerankerScore * 0.65 + relationshipEnhancedScore * 0.35,
              // A compact CPU reranker can under-score tables, identifiers and formulas.
              // Preserve strong hybrid evidence as a floor so reranking refines recall
              // instead of deleting an exact lexical/vector match.
              relationshipEnhancedScore * 0.9,
            );
      const directEvidence = directEvidenceStrength(candidate, evidenceTerms);
      return { candidate, rerankerScore, relationshipEnhancedScore, directEvidence, finalScore };
    })
    .filter(
      ({ candidate, rerankerScore, relationshipEnhancedScore, directEvidence, finalScore }) => {
        const baseEligible =
          candidate.semanticScore !== null
            ? isEligibleHybrid(candidate)
            : candidate.lexicalScore >= MINIMUM_LEXICAL_SCORE ||
              candidate.relationshipScore >= MINIMUM_RELATIONSHIP_SCORE;
        const rerankEligible =
          rerankerScore === null ||
          rerankerScore >= MINIMUM_RERANK_SCORE ||
          relationshipEnhancedScore >= 0.5;
        const hasRelationshipEvidence =
          candidate.relationshipScore >= MINIMUM_RELATIONSHIP_SCORE &&
          candidate.relationshipEvidence.some((evidence) => evidence.sourceSeedScore > 0);
        const hasExactChineseTerm =
          /\p{Script=Han}/u.test(input.query) && candidate.row.keyword_score > 0;
        const evidenceEligible =
          (rerankerScore !== null && rerankerScore >= MINIMUM_RERANK_SCORE) ||
          directEvidence.termCoverage >= MINIMUM_DIRECT_TERM_COVERAGE ||
          directEvidence.fuzzyScore >= MINIMUM_DIRECT_FUZZY_SCORE ||
          hasRelationshipEvidence ||
          hasExactChineseTerm;
        return (
          baseEligible &&
          rerankEligible &&
          evidenceEligible &&
          finalScore >= candidate.policy.scoreThreshold
        );
      },
    )
    .sort(
      (left, right) =>
        right.finalScore - left.finalScore ||
        right.directEvidence.termCoverage - left.directEvidence.termCoverage ||
        right.directEvidence.fuzzyScore - left.directEvidence.fuzzyScore ||
        left.candidate.row.chunk_id.localeCompare(right.candidate.row.chunk_id),
    )
    .filter(({ candidate }) => {
      const count = documentCounts.get(candidate.row.document_id) ?? 0;
      if (count >= candidate.policy.maxChunksPerDocument) return false;
      documentCounts.set(candidate.row.document_id, count + 1);
      return true;
    })
    .slice(0, limit)
    .map(({ candidate, rerankerScore, finalScore }) => {
      const locator = readRetrievalSourceLocator(candidate.row.metadata);
      return {
        chunkId: candidate.row.chunk_id,
        knowledgeBaseId: candidate.row.knowledge_base_id,
        knowledgeBaseName: candidate.row.knowledge_base_name,
        documentId: candidate.row.document_id,
        documentVersionId: candidate.row.document_version_id,
        documentVersion: candidate.row.document_version,
        title: candidate.row.title,
        headingPath: candidate.row.heading_path,
        pageStart: locator.pageStart,
        pageEnd: locator.pageEnd,
        sheetName: locator.sheetName,
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
      };
    });
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

function externalRetrievalResult(
  tenantId: string,
  evidence: ExternalKnowledgeEvidence,
  index: number,
  total: number,
): KnowledgeRetrievalResult {
  const score = clampUnitScore(evidence.score ?? Math.max(0.05, 1 - index / Math.max(1, total)));
  const documentIdentity = `${evidence.knowledgeBaseId}\0${evidence.sourceUri}`;
  return {
    chunkId: deterministicUuid(`lexiang-chunk\0${evidence.evidenceId}`),
    knowledgeBaseId: evidence.knowledgeBaseId,
    knowledgeBaseName: evidence.knowledgeBaseName,
    documentId: deterministicUuid(`lexiang-document\0${documentIdentity}`),
    documentVersionId: deterministicUuid(`lexiang-version\0${documentIdentity}`),
    documentVersion: 1,
    title: evidence.title.trim() || '腾讯乐享知识',
    headingPath: [],
    pageStart: null,
    pageEnd: null,
    sheetName: null,
    content: evidence.content,
    sourceProvider: 'LEXIANG',
    sourceUri: evidence.sourceUri,
    sourceType: 'WEB',
    classification: 'INTERNAL',
    governanceHash: externalGovernanceHash(tenantId, evidence.knowledgeBaseId),
    contentHash: createHash('sha256').update(evidence.content.normalize('NFC')).digest('hex'),
    updatedAt: evidence.updatedAt,
    keywordScore: 0,
    fuzzyScore: 0,
    semanticScore: score,
    fusionScore: score,
    rerankerScore: score,
    relationshipScore: 0,
    relationshipEvidence: [],
    finalScore: score,
  };
}

function externalGovernanceHash(tenantId: string, knowledgeBaseId: string): string {
  return createHash('sha256')
    .update(`lexiang-governance\0${tenantId}\0${knowledgeBaseId}`)
    .digest('hex');
}

function deterministicUuid(value: string): string {
  const bytes = createHash('sha256').update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function resolveOutboundClassification(
  input: KnowledgeSearchInput,
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

function weightedFusionScore(
  lexicalScore: number,
  semanticScore: number | null,
  policy: KnowledgeBaseRetrievalPolicy,
): number {
  if (policy.mode === 'FULL_TEXT') return clampUnitScore(lexicalScore);
  if (policy.mode === 'VECTOR') {
    return clampUnitScore(semanticScore ?? lexicalScore);
  }
  return clampUnitScore(
    lexicalScore * policy.keywordWeight + (semanticScore ?? 0) * policy.semanticWeight,
  );
}

function retrievalPolicy(
  policies: ReadonlyMap<string, KnowledgeBaseRetrievalPolicy>,
  knowledgeBaseId: string,
): KnowledgeBaseRetrievalPolicy {
  return policies.get(knowledgeBaseId) ?? { knowledgeBaseId, ...DEFAULT_RETRIEVAL_CONFIG };
}

function resolveKnowledgeBaseRetrievalPolicy(knowledgeBase: {
  readonly id: string;
  readonly retrievalMode?: string;
  readonly retrievalTopK?: number;
  readonly retrievalScoreThreshold?: Prisma.Decimal | number;
  readonly retrievalSemanticWeight?: Prisma.Decimal | number;
  readonly retrievalKeywordWeight?: Prisma.Decimal | number;
  readonly retrievalRerankEnabled?: boolean;
  readonly relationshipRetrievalEnabled?: boolean;
  readonly maxChunksPerDocument?: number;
}): KnowledgeBaseRetrievalPolicy {
  const mode = isConfiguredRetrievalMode(knowledgeBase.retrievalMode)
    ? knowledgeBase.retrievalMode
    : DEFAULT_RETRIEVAL_CONFIG.mode;
  return {
    knowledgeBaseId: knowledgeBase.id,
    mode,
    topK: boundedInteger(knowledgeBase.retrievalTopK, 1, 20, DEFAULT_RETRIEVAL_CONFIG.topK),
    scoreThreshold: boundedNumber(
      knowledgeBase.retrievalScoreThreshold,
      0,
      1,
      DEFAULT_RETRIEVAL_CONFIG.scoreThreshold,
    ),
    semanticWeight: boundedNumber(
      knowledgeBase.retrievalSemanticWeight,
      0,
      1,
      DEFAULT_RETRIEVAL_CONFIG.semanticWeight,
    ),
    keywordWeight: boundedNumber(
      knowledgeBase.retrievalKeywordWeight,
      0,
      1,
      DEFAULT_RETRIEVAL_CONFIG.keywordWeight,
    ),
    rerankEnabled: knowledgeBase.retrievalRerankEnabled ?? DEFAULT_RETRIEVAL_CONFIG.rerankEnabled,
    relationshipRetrievalEnabled:
      knowledgeBase.relationshipRetrievalEnabled ??
      DEFAULT_RETRIEVAL_CONFIG.relationshipRetrievalEnabled,
    maxChunksPerDocument: boundedInteger(
      knowledgeBase.maxChunksPerDocument,
      1,
      10,
      DEFAULT_RETRIEVAL_CONFIG.maxChunksPerDocument,
    ),
  };
}

function isConfiguredRetrievalMode(
  value: string | undefined,
): value is ConfiguredKnowledgeRetrievalMode {
  return value === 'HYBRID' || value === 'VECTOR' || value === 'FULL_TEXT';
}

function boundedInteger(
  value: number | undefined,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  return Number.isInteger(value) && value !== undefined && value >= minimum && value <= maximum
    ? value
    : fallback;
}

function boundedNumber(
  value: Prisma.Decimal | number | undefined,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= minimum && numeric <= maximum ? numeric : fallback;
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
      : reranker === 'WEIGHTED_SCORE'
        ? 'KNOWLEDGE_WEIGHTED_FUSION_APPLIED'
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

function lexicalCandidateFilterExpression(terms: readonly string[]): Prisma.Sql {
  // The GIN pg_trgm index is defined on the original content column. Applying
  // lower(content) or calculating similarity before narrowing the row set makes
  // PostgreSQL score every chunk. Three-character terms give pg_trgm a selective,
  // indexable prefilter; shorter outage-mode queries fail fast instead of causing
  // an unbounded tenant-wide scan.
  const indexableTerms = terms.filter((term) => Array.from(term).length >= 3).slice(0, 16);
  if (indexableTerms.length === 0) return Prisma.sql`false`;
  return Prisma.join(
    indexableTerms.map(
      (term) => Prisma.sql`chunk."content" ILIKE ${`%${escapeLike(term)}%`} ESCAPE '\\'`,
    ),
    ' OR ',
  );
}

function rerankDocumentText(candidate: CandidateState, query: string): string {
  const relationshipContext = candidate.relationshipEvidence
    .flatMap((evidence) =>
      evidence.path.map(
        (edge) => `${edge.sourceEntityName} ${edge.predicate} ${edge.targetEntityName}`,
      ),
    )
    .join('\n');
  const content = relevantContentWindow(candidate.row.content, query, 1_000);
  return [candidate.row.title, candidate.row.heading_path.join(' / '), relationshipContext, content]
    .filter(Boolean)
    .join('\n')
    .slice(0, 1_500);
}

function relevantContentWindow(content: string, query: string, maximumLength: number): string {
  if (content.length <= maximumLength) return content;
  const terms = queryTerms(query).sort((left, right) => right.length - left.length);
  const normalizedContent = content.toLowerCase();
  const match = terms
    .map((term) => normalizedContent.indexOf(term))
    .find((position) => position >= 0);
  if (match === undefined) return content.slice(0, maximumLength);
  const start = Math.max(0, match - Math.floor(maximumLength * 0.35));
  const windowStart = Math.min(start, content.length - maximumLength);
  return content.slice(windowStart, windowStart + maximumLength);
}

function normalizeQuery(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 2_000);
}

function queryTerms(value: string): string[] {
  const lowered = evidenceQueryText(value).toLowerCase();
  const words = (lowered.match(/[a-z0-9][a-z0-9._-]{1,31}/g) ?? []).filter(
    (word) => !ENGLISH_QUERY_STOP_WORDS.has(word),
  );
  const chineseContent = lowered.replace(
    /(?:我想知道|我想了解|请问|麻烦介绍|告诉我|什么是|是什么|什么意思|的含义|如何|怎么|怎样|关于)/gu,
    ' ',
  );
  const chineseRuns = chineseContent.match(/[\p{Script=Han}]+/gu) ?? [];
  const completeRuns = chineseRuns.filter((run) => run.length >= 2 && run.length <= 16);
  const bigrams = chineseRuns.flatMap((run) =>
    Array.from({ length: Math.max(0, run.length - 1) }, (_, index) => run.slice(index, index + 2)),
  );
  const trigrams = chineseRuns.flatMap((run) =>
    Array.from({ length: Math.max(0, run.length - 2) }, (_, index) => run.slice(index, index + 3)),
  );
  return [...new Set([...words, ...completeRuns, ...trigrams, ...bigrams])].slice(0, 64);
}

function evidenceQueryText(value: string): string {
  // Source-grounded questions commonly wrap the evidence in document/title
  // instructions. Those instructions are useful to route and retrieve, but
  // counting their Chinese n-grams as required evidence can reject an exact
  // sparse hit. Prefer the quoted source excerpt, or the text after the
  // explanation colon, while leaving ordinary questions unchanged.
  const explanation = value.match(/(?:含义|原文内容)\s*[：:]\s*(.{8,})$/u)?.[1]?.trim();
  if (explanation) return explanation;

  const quotedSegments = [...value.matchAll(/[“"]([^”"]{8,})[”"]/gu)]
    .map((match) => match[1]?.trim() ?? '')
    .filter(Boolean);
  return quotedSegments.length > 0 ? quotedSegments.join(' ') : value;
}

function directEvidenceStrength(
  candidate: CandidateState,
  terms: readonly string[],
): { readonly termCoverage: number; readonly fuzzyScore: number } {
  if (terms.length === 0) {
    return { termCoverage: 0, fuzzyScore: clampUnitScore(candidate.row.fuzzy_score) };
  }
  const searchable = [
    candidate.row.title,
    candidate.row.heading_path.join(' '),
    candidate.row.content,
  ]
    .join('\n')
    .toLowerCase();
  const matchedTerms = terms.filter((term) => searchable.includes(term)).length;
  return {
    termCoverage: matchedTerms / terms.length,
    fuzzyScore: clampUnitScore(candidate.row.fuzzy_score),
  };
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

function readRetrievalSourceLocator(metadata: Prisma.JsonValue): {
  readonly pageStart: number | null;
  readonly pageEnd: number | null;
  readonly sheetName: string | null;
} {
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
    return { pageStart: null, pageEnd: null, sheetName: null };
  }
  const pageStart = positiveSourcePage(metadata.pageStart) ?? positiveSourcePage(metadata.page);
  const pageEnd = positiveSourcePage(metadata.pageEnd) ?? pageStart;
  const sheetName =
    typeof metadata.sheetName === 'string' && metadata.sheetName.trim().length > 0
      ? metadata.sheetName.trim().slice(0, 200)
      : null;
  return { pageStart, pageEnd, sheetName };
}

function positiveSourcePage(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : null;
}

function safeSemanticErrorCode(error: unknown): string {
  return error instanceof KnowledgeAiRuntimeError
    ? error.code
    : 'KNOWLEDGE_SEMANTIC_SEARCH_UNAVAILABLE';
}
