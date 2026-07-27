import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../database/prisma.service.js';
import {
  KnowledgeAiRuntimeClient,
  KnowledgeAiRuntimeError,
  type KnowledgeEmbeddingBatch,
} from '../knowledge-semantic/knowledge-ai-runtime.client.js';
import { accessibleKnowledgeBaseIds } from './knowledge-access.policy.js';

const CANDIDATE_LIMIT = 40;
const RRF_K = 60;
const MINIMUM_LEXICAL_SCORE = 0.08;
const MINIMUM_SEMANTIC_SCORE = 0.35;
const MINIMUM_RERANK_SCORE = 0.15;

export type KnowledgeRetrievalMode = 'LEXICAL' | 'HYBRID';
export type KnowledgeReranker = 'LEXICAL' | 'RRF' | 'CROSS_ENCODER';

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
  readonly sourceType: 'TEXT' | 'MARKDOWN' | 'FILE';
  readonly updatedAt: Date;
  readonly keywordScore: number;
  readonly fuzzyScore: number;
  readonly semanticScore: number | null;
  readonly fusionScore: number;
  readonly rerankerScore: number | null;
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
  readonly semanticCoverage: number;
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
  source_type: 'TEXT' | 'MARKDOWN' | 'FILE';
  updated_at: Date;
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
}

interface LoadedCandidates {
  readonly accessibleKnowledgeBaseIds: readonly string[];
  readonly candidates: readonly CandidateState[];
  readonly lexicalCandidateCount: number;
  readonly vectorCandidateCount: number;
}

interface SearchInput {
  readonly tenantId: string;
  readonly userId: string;
  readonly knowledgeBaseIds: readonly string[];
  /**
   * Admin retrieval-test only. IDs must also be present in knowledgeBaseIds.
   * Agent Run callers deliberately never set this field.
   */
  readonly previewDraftKnowledgeBaseIds?: readonly string[];
  readonly query: string;
  readonly limit?: number;
}

@Injectable()
export class KnowledgeRetrievalService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(KnowledgeAiRuntimeClient) private readonly semantic: KnowledgeAiRuntimeClient,
  ) {}

  async search(input: SearchInput): Promise<KnowledgeRetrievalResponse> {
    const query = normalizeQuery(input.query);
    let embedding: KnowledgeEmbeddingBatch | null = null;
    let degradedReason: string | null = null;
    if (this.semantic.semanticEnabled) {
      try {
        embedding = await this.semantic.embed(input.tenantId, [query]);
      } catch (error) {
        degradedReason = safeSemanticErrorCode(error);
      }
    }

    const loaded = await this.prisma.withTenant(input.tenantId, (transaction) =>
      this.loadCandidates(transaction, input, query, embedding),
    );
    return this.rankCandidates(input, query, loaded, embedding, degradedReason);
  }

  /**
   * Transaction-bound compatibility path. It is intentionally lexical-only:
   * no provider HTTP request is ever made while a caller holds a DB lock.
   */
  async searchInTransaction(
    transaction: Prisma.TransactionClient,
    input: SearchInput,
  ): Promise<KnowledgeRetrievalResponse> {
    const query = normalizeQuery(input.query);
    const loaded = await this.loadCandidates(transaction, input, query, null);
    return this.rankWithoutRemote(input, loaded, null, null);
  }

  /** Re-checks source lineage and ACLs immediately before runtime dispatch. */
  async areChunksAccessibleInTransaction(
    transaction: Prisma.TransactionClient,
    input: {
      readonly tenantId: string;
      readonly userId: string;
      readonly knowledgeBaseIds: readonly string[];
      readonly chunkIds: readonly string[];
    },
  ): Promise<boolean> {
    const requestedIds = [...new Set(input.knowledgeBaseIds)].slice(0, 50);
    const chunkIds = [...new Set(input.chunkIds)].slice(0, 100);
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
        select: { id: true, parentId: true },
      }),
      transaction.knowledgeBase.findMany({
        where: { tenantId: input.tenantId, id: { in: requestedIds }, status: 'ACTIVE' },
        include: { orgUnits: true },
      }),
    ]);
    const activeOrgUnitIds = new Set(orgUnits.map((orgUnit) => orgUnit.id));
    const accessibleIds = accessibleKnowledgeBaseIds({
      userActive: user?.status === 'ACTIVE',
      memberOrgUnitIds: new Set(
        employments
          .map((employment) => employment.orgUnitId)
          .filter((orgUnitId) => activeOrgUnitIds.has(orgUnitId)),
      ),
      parentByOrgUnitId: new Map(orgUnits.map((unit) => [unit.id, unit.parentId])),
      knowledgeBases,
    });
    if (accessibleIds.length === 0) return false;
    const accessibleSql = Prisma.join(accessibleIds.map((id) => Prisma.sql`${id}::uuid`));
    const chunkSql = Prisma.join(chunkIds.map((id) => Prisma.sql`${id}::uuid`));
    const [row] = await transaction.$queryRaw<Array<{ count: number }>>(Prisma.sql`
      SELECT count(DISTINCT chunk."id")::int AS count
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
    `);
    return row?.count === chunkIds.length;
  }

  private async loadCandidates(
    transaction: Prisma.TransactionClient,
    input: SearchInput,
    query: string,
    embedding: KnowledgeEmbeddingBatch | null,
  ): Promise<LoadedCandidates> {
    const requestedIds = [...new Set(input.knowledgeBaseIds)].slice(0, 50);
    const requestedIdSet = new Set(requestedIds);
    const previewDraftIds = [...new Set(input.previewDraftKnowledgeBaseIds ?? [])]
      .filter((id) => requestedIdSet.has(id))
      .slice(0, 50);
    if (requestedIds.length === 0) {
      return {
        accessibleKnowledgeBaseIds: [],
        candidates: [],
        lexicalCandidateCount: 0,
        vectorCandidateCount: 0,
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
        select: { id: true, parentId: true },
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
    const activeOrgUnitIds = new Set(orgUnits.map((orgUnit) => orgUnit.id));
    const memberOrgUnitIds = new Set(
      employments
        .map((employment) => employment.orgUnitId)
        .filter((orgUnitId) => activeOrgUnitIds.has(orgUnitId)),
    );
    const accessibleIds = accessibleKnowledgeBaseIds({
      userActive: user?.status === 'ACTIVE',
      memberOrgUnitIds,
      parentByOrgUnitId: new Map(orgUnits.map((unit) => [unit.id, unit.parentId])),
      knowledgeBases,
    });
    if (accessibleIds.length === 0) {
      return {
        accessibleKnowledgeBaseIds: accessibleIds,
        candidates: [],
        lexicalCandidateCount: 0,
        vectorCandidateCount: 0,
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
    const keywordExpression = keywordScoreExpression(terms);
    const lexicalRows = await transaction.$queryRaw<CandidateRow[]>(Prisma.sql`
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
        version."source_type"::text AS source_type,
        coalesce(version."published_at", version."created_at") AS updated_at,
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
       AND document."current_version_id" = chunk."document_version_id"
      JOIN public."knowledge_document_versions" AS version
        ON version."tenant_id" = chunk."tenant_id"
       AND version."knowledge_base_id" = chunk."knowledge_base_id"
       AND version."document_id" = chunk."document_id"
       AND version."id" = chunk."document_version_id"
       AND version."status" = 'READY'
      WHERE chunk."tenant_id" = ${input.tenantId}::uuid
        AND chunk."knowledge_base_id" IN (${accessibleKnowledgeBaseIdSql})
      ORDER BY keyword_score DESC, fuzzy_score DESC, version."version_number" DESC, chunk."id" ASC
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
          version."source_type"::text AS source_type,
          coalesce(version."published_at", version."created_at") AS updated_at,
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
         AND document."current_version_id" = chunk."document_version_id"
        JOIN public."knowledge_document_versions" AS version
          ON version."tenant_id" = chunk."tenant_id"
         AND version."knowledge_base_id" = chunk."knowledge_base_id"
         AND version."document_id" = chunk."document_id"
         AND version."id" = chunk."document_version_id"
         AND version."status" = 'READY'
        WHERE embedding."tenant_id" = ${input.tenantId}::uuid
          AND embedding."embedding_model" = ${embedding.model}
          AND chunk."knowledge_base_id" IN (${accessibleKnowledgeBaseIdSql})
        ORDER BY embedding."embedding" <=> ${literal}::vector, chunk."id" ASC
        LIMIT ${CANDIDATE_LIMIT}
      `);
    }

    return {
      accessibleKnowledgeBaseIds: accessibleIds,
      candidates: mergeCandidates(lexicalRows, vectorRows, terms.length),
      lexicalCandidateCount: lexicalRows.length,
      vectorCandidateCount: vectorRows.length,
    };
  }

  private async rankCandidates(
    input: SearchInput,
    query: string,
    loaded: LoadedCandidates,
    embedding: KnowledgeEmbeddingBatch | null,
    degradedReason: string | null,
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

    try {
      const reranked = await this.semantic.rerank(
        input.tenantId,
        query,
        eligible.map((candidate) => ({
          id: candidate.row.chunk_id,
          text: rerankDocumentText(candidate.row),
        })),
        Math.min(20, eligible.length),
      );
      const scoreById = new Map(reranked.results.map((item) => [item.id, item.relevanceScore]));
      return buildResponse(
        input,
        loaded,
        embedding,
        'CROSS_ENCODER',
        reranked.model,
        degradedReason,
        scoreById,
      );
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
  }));
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
      const finalScore =
        rerankerScore === null
          ? hybrid
            ? candidate.fusionScore
            : candidate.lexicalScore
          : rerankerScore * 0.8 + candidate.fusionScore * 0.2;
      return { candidate, rerankerScore, finalScore };
    })
    .filter(({ candidate, rerankerScore }) =>
      rerankerScores === null
        ? hybrid
          ? isEligibleHybrid(candidate)
          : candidate.lexicalScore >= MINIMUM_LEXICAL_SCORE
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
      updatedAt: candidate.row.updated_at,
      keywordScore: candidate.row.keyword_score,
      fuzzyScore: candidate.row.fuzzy_score,
      semanticScore: candidate.semanticScore,
      fusionScore: candidate.fusionScore,
      rerankerScore,
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
    semanticCoverage:
      loaded.candidates.length === 0
        ? 0
        : loaded.candidates.filter((candidate) => candidate.semanticScore !== null).length /
          loaded.candidates.length,
    items,
  };
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
    (candidate.semanticScore !== null && candidate.semanticScore >= MINIMUM_SEMANTIC_SCORE)
  );
}

function normalizedRrf(lexicalRank: number | null, vectorRank: number | null): number {
  const raw =
    (lexicalRank === null ? 0 : 1 / (RRF_K + lexicalRank)) +
    (vectorRank === null ? 0 : 1 / (RRF_K + vectorRank));
  return raw / (2 / (RRF_K + 1));
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

function rerankDocumentText(row: CandidateRow): string {
  return [row.title, row.heading_path.join(' / '), row.content]
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

function safeSemanticErrorCode(error: unknown): string {
  return error instanceof KnowledgeAiRuntimeError
    ? error.code
    : 'KNOWLEDGE_SEMANTIC_SEARCH_UNAVAILABLE';
}
