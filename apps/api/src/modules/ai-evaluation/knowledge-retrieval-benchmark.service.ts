import { createHash, randomUUID } from 'node:crypto';

import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  knowledgeRetrievalBenchmarkRunSchema,
  knowledgeRetrievalGroundTruthSchema,
  type AiEvaluationCase,
  type AiEvaluationListQuery,
  type BulkImportKnowledgeRetrievalEvaluationCasesRequest,
  type BulkImportKnowledgeRetrievalEvaluationCasesResult,
  type KnowledgeRetrievalBenchmarkCaseResult,
  type KnowledgeRetrievalBenchmarkMetrics,
  type KnowledgeRetrievalBenchmarkRun,
  type KnowledgeRetrievalBenchmarkRunListResponse,
  type KnowledgeRetrievalBenchmarkThresholds,
  type KnowledgeRetrievalGroundTruth,
  type RunKnowledgeRetrievalBenchmarkRequest,
} from '@enterprise/contracts';
import { Prisma } from '@prisma/client';

import { AiEvaluationRepository } from './ai-evaluation.repository.js';
import { AdminPrismaService } from '../../database/admin-prisma.service.js';
import { AdminAccessService, type AdminPrincipal } from '../admin/admin-access.service.js';
import {
  KnowledgeRetrievalGateway,
  type KnowledgeRetrievalResponse,
} from '../knowledge-gateway/knowledge-gateway.port.js';
import { runtimeHash } from '../process-orchestration/infrastructure/prisma/runtime-prisma.support.js';

type Transaction = Parameters<Parameters<AdminPrismaService['withTenant']>[1]>[0];

interface BenchmarkRunRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly dataset_version_id: string;
  readonly dataset_content_hash: string;
  readonly status: 'RUNNING' | 'PASSED' | 'FAILED';
  readonly thresholds: unknown;
  readonly metrics: unknown;
  readonly failures: unknown;
  readonly case_results: unknown;
  readonly processed_case_count: number;
  readonly total_case_count: number;
  readonly requested_by_user_id: string;
  readonly request_hash: string;
  readonly started_at: Date;
  readonly finished_at: Date | null;
  readonly created_at: Date;
}

@Injectable()
export class KnowledgeRetrievalBenchmarkService {
  constructor(
    @Inject(AiEvaluationRepository)
    private readonly evaluations: AiEvaluationRepository,
    @Inject(AdminAccessService)
    private readonly access: AdminAccessService,
    @Inject(AdminPrismaService)
    private readonly prisma: AdminPrismaService,
    @Inject(KnowledgeRetrievalGateway)
    private readonly retrieval: KnowledgeRetrievalGateway,
  ) {}

  async bulkImport(
    versionId: string,
    request: BulkImportKnowledgeRetrievalEvaluationCasesRequest,
  ): Promise<BulkImportKnowledgeRetrievalEvaluationCasesResult> {
    const principal = this.principal();
    const version = await this.evaluations.findDatasetVersion(principal, versionId);
    if (version === null) throw new NotFoundException('Evaluation Dataset Version was not found.');
    if (version.status !== 'DRAFT') {
      throw new ConflictException('Only draft evaluation datasets accept bulk imports.');
    }

    let importedCount = 0;
    let annotatedCount = 0;
    const failures: BulkImportKnowledgeRetrievalEvaluationCasesResult['failures'][number][] = [];
    for (const [index, item] of request.cases.entries()) {
      try {
        const testCase = await this.evaluations.createCase(principal, versionId, {
          caseKey: item.caseKey,
          category: 'CITATION',
          input: item.query,
          context: {
            roleAssignmentId: null,
            roleVersionId: null,
            objectiveId: null,
            objectiveVersion: null,
            processVersionId: null,
            permissionLabels: [],
            knowledgeVersionIds: [],
            toolVersionIds: [],
            structuredContext: { retrievalGroundTruth: item.groundTruth },
          },
          expectedBehavior: item.expectedAnswer,
          requiredEvidenceIds: [request.evidenceId],
          forbiddenBehaviors: [],
          scoring: {
            judgeTypes: ['DETERMINISTIC_RULE'],
            rubric: '按实际返回的切片顺序计算 Recall@5、MRR、nDCG@10 与来源支撑率。',
            metricWeights: [
              { metric: 'RETRIEVAL_RECALL_AT_5', weight: 1 },
              { metric: 'RETRIEVAL_MRR', weight: 1 },
              { metric: 'RETRIEVAL_NDCG_AT_10', weight: 1 },
              { metric: 'CITATION_SUPPORT_RATE', weight: 1 },
              { metric: 'P95_LATENCY_MS', weight: 1 },
            ],
          },
          idempotencyKey: childIdempotencyKey(request.idempotencyKey, item.caseKey, 'case'),
        });
        importedCount += 1;
        await this.evaluations.annotateCase(principal, testCase.id, {
          label: 'PASS',
          expectedScore: 1,
          rationale: request.annotationRationale,
          evidenceIds: [request.evidenceId],
          expectedRevision: 0,
          idempotencyKey: childIdempotencyKey(request.idempotencyKey, item.caseKey, 'annotation'),
        });
        annotatedCount += 1;
      } catch (error) {
        const described = describeImportError(error);
        failures.push({
          rowNumber: index + 1,
          caseKey: item.caseKey,
          code: described.code,
          message: described.message,
        });
      }
    }
    const updated = await this.evaluations.findDatasetVersion(principal, versionId);
    if (updated === null) throw new NotFoundException('Evaluation Dataset Version was not found.');
    return {
      requestedCount: request.cases.length,
      importedCount,
      annotatedCount,
      failedCount: failures.length,
      datasetCaseCount: updated.caseCount,
      annotationCoverage: updated.annotationCoverage,
      failures,
    };
  }

  async listRuns(
    versionId: string,
    query: AiEvaluationListQuery,
  ): Promise<KnowledgeRetrievalBenchmarkRunListResponse> {
    const principal = this.principal();
    return this.withPrincipal(principal, async (transaction) => {
      const rows = await transaction.$queryRaw<BenchmarkRunRow[]>(Prisma.sql`
        SELECT *
        FROM public."ai_knowledge_retrieval_benchmark_runs"
        WHERE "tenant_id" = ${principal.tenantId}::uuid
          AND "dataset_version_id" = ${versionId}::uuid
          AND (
            ${query.cursor ?? null}::uuid IS NULL
            OR ("created_at", "id") < (
              SELECT cursor_run."created_at", cursor_run."id"
              FROM public."ai_knowledge_retrieval_benchmark_runs" AS cursor_run
              WHERE cursor_run."tenant_id" = ${principal.tenantId}::uuid
                AND cursor_run."dataset_version_id" = ${versionId}::uuid
                AND cursor_run."id" = ${query.cursor ?? null}::uuid
            )
          )
        ORDER BY "created_at" DESC, "id" DESC
        LIMIT ${query.limit + 1}
      `);
      const hasNext = rows.length > query.limit;
      const selected = hasNext ? rows.slice(0, query.limit) : rows;
      const items = selected.map((row) => {
        const { caseResults: _caseResults, ...summary } = mapBenchmarkRun(row);
        return summary;
      });
      return {
        items,
        nextCursor: hasNext ? (selected.at(-1)?.id ?? null) : null,
      };
    });
  }

  async getRun(runId: string): Promise<KnowledgeRetrievalBenchmarkRun> {
    const principal = this.principal();
    const run = await this.withPrincipal(principal, (transaction) =>
      loadBenchmarkRun(transaction, principal.tenantId, runId),
    );
    if (run === null)
      throw new NotFoundException('Knowledge Retrieval Benchmark Run was not found.');
    return run;
  }

  async run(
    versionId: string,
    request: RunKnowledgeRetrievalBenchmarkRequest,
  ): Promise<KnowledgeRetrievalBenchmarkRun> {
    const principal = this.principal();
    const version = await this.evaluations.findDatasetVersion(principal, versionId);
    if (version === null) throw new NotFoundException('Evaluation Dataset Version was not found.');
    if (version.status !== 'PUBLISHED' || version.annotationCoverage !== 1) {
      throw new ConflictException(
        'A retrieval benchmark requires a fully annotated and independently published dataset.',
      );
    }
    const cases = await this.loadAllCases(principal, versionId);
    if (cases.length !== version.caseCount) {
      throw new ConflictException(
        'The evaluation dataset case count changed while preparing the run.',
      );
    }

    const requestHash = runtimeHash({
      datasetVersionId: versionId,
      datasetContentHash: version.contentHash,
      request,
    });
    const prepared = await this.beginRun(
      principal,
      versionId,
      version.contentHash,
      cases.length,
      request,
      requestHash,
    );
    if (prepared.status !== 'RUNNING') return prepared;

    try {
      const definitions = cases.map((testCase) => ({
        testCase,
        groundTruth: readGroundTruth(testCase),
      }));
      let processedCaseCount = 0;
      const caseResults = await mapConcurrent(
        definitions,
        request.concurrency,
        async ({ testCase, groundTruth }) => {
          const result = await this.executeCase(principal, testCase, groundTruth);
          processedCaseCount += 1;
          // Persist coarse progress for the administrator UI without turning
          // every individual query into an audit/outbox event.
          if (processedCaseCount % 5 === 0 || processedCaseCount === definitions.length) {
            await this.updateRunProgress(principal, prepared.id, requestHash, processedCaseCount);
          }
          return result;
        },
      );
      const evaluation = evaluateBenchmark(caseResults, definitions, request.thresholds);
      return await this.completeRun(
        principal,
        prepared.id,
        requestHash,
        evaluation.metrics,
        evaluation.failures,
        caseResults,
      );
    } catch (error) {
      return this.failRun(
        principal,
        prepared.id,
        requestHash,
        `基准执行失败：${safeErrorCode(error)}。`,
      );
    }
  }

  private async loadAllCases(
    principal: AdminPrincipal,
    versionId: string,
  ): Promise<AiEvaluationCase[]> {
    const cases: AiEvaluationCase[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.evaluations.listCases(principal, versionId, {
        limit: 200,
        ...(cursor === undefined ? {} : { cursor }),
      });
      cases.push(...page.items);
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    return cases;
  }

  private async executeCase(
    principal: AdminPrincipal,
    testCase: AiEvaluationCase,
    groundTruth: KnowledgeRetrievalGroundTruth,
  ): Promise<KnowledgeRetrievalBenchmarkCaseResult> {
    const started = performance.now();
    try {
      const response = await this.retrieval.search({
        tenantId: principal.tenantId,
        userId: groundTruth.simulatedUserId,
        knowledgeBaseIds: [groundTruth.knowledgeBaseId],
        query: testCase.input,
        limit: groundTruth.limit,
      });
      const latencyMs = Math.max(0, performance.now() - started);
      const retrievedChunkIds = response.items.map(({ chunkId }) => chunkId);
      const relevant = groundTruth.relevance;
      const answerable = !groundTruth.expectedNoAnswer;
      const routeMatched =
        groundTruth.expectedRoute === null
          ? null
          : response.queryRoute?.primary === groundTruth.expectedRoute;
      const aclEvents = collectAclEvents(groundTruth, response);
      const semanticEvidenceFailures = groundTruth.semanticRequired
        ? collectSemanticFailures(response)
        : [];
      return {
        caseId: testCase.id,
        caseKey: testCase.caseKey,
        expectedNoAnswer: groundTruth.expectedNoAnswer,
        predictedNoAnswer: response.items.length === 0,
        retrievedChunkIds,
        recallAt5: answerable ? recallAtK(retrievedChunkIds, relevant, 5) : null,
        reciprocalRank: answerable ? reciprocalRank(retrievedChunkIds, relevant) : null,
        ndcgAt10: answerable ? ndcgAtK(retrievedChunkIds, relevant, 10) : null,
        citationSupported: answerable
          ? retrievedChunkIds.slice(0, 5).some((id) => relevant[id] !== undefined)
          : null,
        routeMatched,
        latencyMs,
        aclEvents,
        semanticEvidenceFailures,
        errorCode: null,
      };
    } catch (error) {
      return {
        caseId: testCase.id,
        caseKey: testCase.caseKey,
        expectedNoAnswer: groundTruth.expectedNoAnswer,
        predictedNoAnswer: false,
        retrievedChunkIds: [],
        recallAt5: null,
        reciprocalRank: null,
        ndcgAt10: null,
        citationSupported: null,
        routeMatched: null,
        latencyMs: Math.max(0, performance.now() - started),
        aclEvents: [],
        semanticEvidenceFailures: [],
        errorCode: safeErrorCode(error),
      };
    }
  }

  private async beginRun(
    principal: AdminPrincipal,
    versionId: string,
    contentHash: string,
    totalCaseCount: number,
    request: RunKnowledgeRetrievalBenchmarkRequest,
    requestHash: string,
  ): Promise<KnowledgeRetrievalBenchmarkRun> {
    return this.withPrincipal(principal, async (transaction) => {
      const existing = await transaction.$queryRaw<BenchmarkRunRow[]>(Prisma.sql`
        SELECT *
        FROM public."ai_knowledge_retrieval_benchmark_runs"
        WHERE "tenant_id" = ${principal.tenantId}::uuid
          AND "idempotency_key" = ${request.idempotencyKey}
        FOR UPDATE
      `);
      if (existing[0] !== undefined) {
        if (existing[0].request_hash !== requestHash) {
          throw new ConflictException(
            'The benchmark idempotency key was reused for another request.',
          );
        }
        return mapBenchmarkRun(existing[0]);
      }
      const id = randomUUID();
      await transaction.$executeRaw(Prisma.sql`
        INSERT INTO public."ai_knowledge_retrieval_benchmark_runs" (
          "id", "tenant_id", "dataset_version_id", "dataset_content_hash", "status",
          "thresholds", "metrics", "failures", "case_results", "requested_by_user_id",
          "processed_case_count", "total_case_count", "idempotency_key", "request_hash"
        ) VALUES (
          ${id}::uuid, ${principal.tenantId}::uuid, ${versionId}::uuid, ${contentHash}, 'RUNNING',
          ${JSON.stringify(request.thresholds)}::jsonb, NULL, '[]'::jsonb, '[]'::jsonb,
          ${principal.userId}::uuid, 0, ${totalCaseCount}, ${request.idempotencyKey}, ${requestHash}
        )
      `);
      return requiredRun(await loadBenchmarkRun(transaction, principal.tenantId, id));
    });
  }

  private async updateRunProgress(
    principal: AdminPrincipal,
    runId: string,
    requestHash: string,
    processedCaseCount: number,
  ): Promise<void> {
    await this.withPrincipal(principal, async (transaction) => {
      const updated = await transaction.$executeRaw(Prisma.sql`
        UPDATE public."ai_knowledge_retrieval_benchmark_runs"
        SET "processed_case_count" = ${processedCaseCount}
        WHERE "tenant_id" = ${principal.tenantId}::uuid
          AND "id" = ${runId}::uuid
          AND "status" = 'RUNNING'
          AND "request_hash" = ${requestHash}
          AND "processed_case_count" < ${processedCaseCount}
      `);
      if (updated !== 1) {
        throw new ConflictException('The benchmark Run stopped accepting progress updates.');
      }
    });
  }

  private async completeRun(
    principal: AdminPrincipal,
    runId: string,
    requestHash: string,
    metrics: KnowledgeRetrievalBenchmarkMetrics,
    failures: readonly string[],
    caseResults: readonly KnowledgeRetrievalBenchmarkCaseResult[],
  ): Promise<KnowledgeRetrievalBenchmarkRun> {
    return this.withPrincipal(principal, async (transaction) => {
      const status = failures.length === 0 ? 'PASSED' : 'FAILED';
      const updated = await transaction.$executeRaw(Prisma.sql`
        UPDATE public."ai_knowledge_retrieval_benchmark_runs"
        SET "status" = ${status}, "metrics" = ${JSON.stringify(metrics)}::jsonb,
            "failures" = ${JSON.stringify(failures)}::jsonb,
            "case_results" = ${JSON.stringify(caseResults)}::jsonb,
            "processed_case_count" = "total_case_count",
            "finished_at" = CURRENT_TIMESTAMP
        WHERE "tenant_id" = ${principal.tenantId}::uuid
          AND "id" = ${runId}::uuid
          AND "status" = 'RUNNING'
          AND "request_hash" = ${requestHash}
      `);
      if (updated !== 1) {
        const replay = await loadBenchmarkRun(transaction, principal.tenantId, runId);
        if (replay !== null && replay.status !== 'RUNNING') return replay;
        throw new ConflictException('The benchmark Run changed before its results were saved.');
      }
      return requiredRun(await loadBenchmarkRun(transaction, principal.tenantId, runId));
    });
  }

  private async failRun(
    principal: AdminPrincipal,
    runId: string,
    requestHash: string,
    failure: string,
  ): Promise<KnowledgeRetrievalBenchmarkRun> {
    return this.withPrincipal(principal, async (transaction) => {
      await transaction.$executeRaw(Prisma.sql`
        UPDATE public."ai_knowledge_retrieval_benchmark_runs"
        SET "status" = 'FAILED', "failures" = ${JSON.stringify([failure])}::jsonb,
            "finished_at" = CURRENT_TIMESTAMP
        WHERE "tenant_id" = ${principal.tenantId}::uuid
          AND "id" = ${runId}::uuid
          AND "status" = 'RUNNING'
          AND "request_hash" = ${requestHash}
      `);
      return requiredRun(await loadBenchmarkRun(transaction, principal.tenantId, runId));
    });
  }

  private principal(): AdminPrincipal {
    return this.access.requireKnowledgeWrite();
  }

  private withPrincipal<T>(
    principal: AdminPrincipal,
    operation: (transaction: Transaction) => Promise<T>,
  ): Promise<T> {
    return this.prisma.withTenant(principal.tenantId, async (transaction) => {
      await transaction.$queryRaw`SELECT set_config('app.user_id', ${principal.userId}, true)`;
      return operation(transaction);
    });
  }
}

function readGroundTruth(testCase: AiEvaluationCase): KnowledgeRetrievalGroundTruth {
  const value = testCase.context.structuredContext['retrievalGroundTruth'];
  const parsed = knowledgeRetrievalGroundTruthSchema.safeParse(value);
  if (!parsed.success) {
    throw new ConflictException(
      `Evaluation Case ${testCase.caseKey} has no valid retrieval ground truth.`,
    );
  }
  return parsed.data;
}

async function loadBenchmarkRun(
  transaction: Transaction,
  tenantId: string,
  runId: string,
): Promise<KnowledgeRetrievalBenchmarkRun | null> {
  const rows = await transaction.$queryRaw<BenchmarkRunRow[]>(Prisma.sql`
    SELECT *
    FROM public."ai_knowledge_retrieval_benchmark_runs"
    WHERE "tenant_id" = ${tenantId}::uuid AND "id" = ${runId}::uuid
  `);
  return rows[0] === undefined ? null : mapBenchmarkRun(rows[0]);
}

function mapBenchmarkRun(row: BenchmarkRunRow): KnowledgeRetrievalBenchmarkRun {
  return knowledgeRetrievalBenchmarkRunSchema.parse({
    id: row.id,
    tenantId: row.tenant_id,
    datasetVersionId: row.dataset_version_id,
    datasetContentHash: row.dataset_content_hash.trim(),
    status: row.status,
    thresholds: row.thresholds,
    metrics: row.metrics,
    failures: row.failures,
    caseResults: row.case_results,
    processedCaseCount: row.processed_case_count,
    totalCaseCount: row.total_case_count,
    requestedByUserId: row.requested_by_user_id,
    startedAt: row.started_at.toISOString(),
    finishedAt: row.finished_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  });
}

function requiredRun(run: KnowledgeRetrievalBenchmarkRun | null): KnowledgeRetrievalBenchmarkRun {
  if (run === null) throw new Error('Knowledge Retrieval Benchmark Run was not persisted.');
  return run;
}

function evaluateBenchmark(
  results: readonly KnowledgeRetrievalBenchmarkCaseResult[],
  definitions: readonly {
    readonly testCase: AiEvaluationCase;
    readonly groundTruth: KnowledgeRetrievalGroundTruth;
  }[],
  thresholds: KnowledgeRetrievalBenchmarkThresholds,
): { readonly metrics: KnowledgeRetrievalBenchmarkMetrics; readonly failures: string[] } {
  const successful = results.filter(({ errorCode }) => errorCode === null);
  const answerable = successful.filter(({ expectedNoAnswer }) => !expectedNoAnswer);
  const routeResults = successful.filter(({ routeMatched }) => routeMatched !== null);
  const metrics: KnowledgeRetrievalBenchmarkMetrics = {
    recallAt5: mean(answerable.map(({ recallAt5 }) => recallAt5)),
    mrr: mean(answerable.map(({ reciprocalRank }) => reciprocalRank)),
    ndcgAt10: mean(answerable.map(({ ndcgAt10 }) => ndcgAt10)),
    citationSupportRate: mean(
      answerable.map(({ citationSupported }) => (citationSupported === true ? 1 : 0)),
    ),
    noAnswerAccuracy:
      successful.filter(({ expectedNoAnswer }) => expectedNoAnswer).length === 0
        ? null
        : successful.filter(
            ({ expectedNoAnswer, predictedNoAnswer }) => expectedNoAnswer && predictedNoAnswer,
          ).length / successful.filter(({ expectedNoAnswer }) => expectedNoAnswer).length,
    routeAccuracy: mean(routeResults.map(({ routeMatched }) => (routeMatched === true ? 1 : 0))),
    p95LatencyMs: percentile(
      successful.map(({ latencyMs }) => latencyMs),
      0.95,
    ),
    aclLeakCount: results.reduce((sum, result) => sum + result.aclEvents.length, 0),
    semanticEvidenceFailureCount: results.reduce(
      (sum, result) => sum + result.semanticEvidenceFailures.length,
      0,
    ),
    evaluatedCaseCount: successful.length,
    answerableCaseCount: definitions.filter(({ groundTruth }) => !groundTruth.expectedNoAnswer)
      .length,
    noAnswerCaseCount: definitions.filter(({ groundTruth }) => groundTruth.expectedNoAnswer).length,
    aclCaseCount: definitions.filter(({ groundTruth }) => hasAclExpectations(groundTruth)).length,
  };
  const failures: string[] = [];
  if (definitions.length < thresholds.minCaseCount) {
    failures.push(`题目总数 ${definitions.length}，低于企业基线 ${thresholds.minCaseCount}。`);
  }
  if (metrics.answerableCaseCount < thresholds.minAnswerableCount) {
    failures.push(
      `可回答题 ${metrics.answerableCaseCount}，低于企业基线 ${thresholds.minAnswerableCount}。`,
    );
  }
  if (metrics.noAnswerCaseCount < thresholds.minNoAnswerCount) {
    failures.push(
      `无答案题 ${metrics.noAnswerCaseCount}，低于企业基线 ${thresholds.minNoAnswerCount}。`,
    );
  }
  if (metrics.aclCaseCount < thresholds.minAclCaseCount) {
    failures.push(`权限反例 ${metrics.aclCaseCount}，低于企业基线 ${thresholds.minAclCaseCount}。`);
  }
  if (successful.length !== definitions.length) {
    failures.push(`仅 ${successful.length}/${definitions.length} 道题成功完成检索。`);
  }
  minimumFailure(failures, 'Recall@5', metrics.recallAt5, thresholds.minRecallAt5);
  minimumFailure(failures, 'MRR', metrics.mrr, thresholds.minMrr);
  minimumFailure(failures, 'nDCG@10', metrics.ndcgAt10, thresholds.minNdcgAt10);
  minimumFailure(
    failures,
    '来源支撑率',
    metrics.citationSupportRate,
    thresholds.minCitationSupportRate,
  );
  minimumFailure(
    failures,
    '无答案准确率',
    metrics.noAnswerAccuracy,
    thresholds.minNoAnswerAccuracy,
  );
  if (metrics.p95LatencyMs === null || metrics.p95LatencyMs > thresholds.maxP95LatencyMs) {
    failures.push(
      metrics.p95LatencyMs === null
        ? 'P95 延迟不可用。'
        : `P95 延迟 ${metrics.p95LatencyMs.toFixed(1)}ms，超过 ${thresholds.maxP95LatencyMs}ms。`,
    );
  }
  if (metrics.aclLeakCount > thresholds.maxAclLeakCount) {
    failures.push(
      `权限泄漏事件 ${metrics.aclLeakCount}，超过允许值 ${thresholds.maxAclLeakCount}。`,
    );
  }
  if (metrics.semanticEvidenceFailureCount > 0) {
    failures.push(`有 ${metrics.semanticEvidenceFailureCount} 项语义链路证据不完整。`);
  }
  return { metrics: roundMetrics(metrics), failures };
}

function collectAclEvents(
  groundTruth: KnowledgeRetrievalGroundTruth,
  response: KnowledgeRetrievalResponse,
): string[] {
  const forbiddenChunks = new Set(groundTruth.forbiddenChunkIds);
  const forbiddenDocuments = new Set(groundTruth.forbiddenDocumentIds);
  const forbiddenKnowledgeBases = new Set(groundTruth.forbiddenKnowledgeBaseIds);
  const events = new Set<string>();
  for (const item of response.items) {
    if (item.knowledgeBaseId !== groundTruth.knowledgeBaseId) {
      events.add(`UNEXPECTED_KNOWLEDGE_BASE:${item.knowledgeBaseId}`);
    }
    if (forbiddenChunks.has(item.chunkId)) events.add(`FORBIDDEN_CHUNK:${item.chunkId}`);
    if (forbiddenDocuments.has(item.documentId)) {
      events.add(`FORBIDDEN_DOCUMENT:${item.documentId}`);
    }
    if (forbiddenKnowledgeBases.has(item.knowledgeBaseId)) {
      events.add(`FORBIDDEN_KNOWLEDGE_BASE:${item.knowledgeBaseId}`);
    }
  }
  for (const knowledgeBaseId of response.accessibleKnowledgeBaseIds) {
    if (forbiddenKnowledgeBases.has(knowledgeBaseId)) {
      events.add(`FORBIDDEN_SCOPE:${knowledgeBaseId}`);
    }
  }
  return [...events].sort();
}

function collectSemanticFailures(response: KnowledgeRetrievalResponse): string[] {
  const failures: string[] = [];
  if (response.mode !== 'HYBRID') failures.push(`MODE_${response.mode}`);
  if (response.embeddingModel === null) failures.push('EMBEDDING_MODEL_MISSING');
  if (response.reranker !== 'CROSS_ENCODER') failures.push(`RERANKER_${response.reranker}`);
  if (response.rerankerModel === null) failures.push('RERANKER_MODEL_MISSING');
  if (response.degradedReason !== null) failures.push(response.degradedReason);
  // semanticCoverage is the fraction of the fused candidate union that also
  // has a vector score. Lexical-only members of that union are expected, so a
  // value below 1 is not a semantic outage. HYBRID mode and the concrete model
  // fields above are the trustworthy per-query chain evidence.
  return [...new Set(failures)];
}

function recallAtK(
  retrieved: readonly string[],
  relevance: Readonly<Record<string, number>>,
  k: number,
): number {
  const relevantIds = Object.keys(relevance);
  if (relevantIds.length === 0) return 0;
  const relevant = new Set(relevantIds);
  const found = new Set(retrieved.slice(0, k).filter((id) => relevant.has(id)));
  return found.size / relevant.size;
}

function reciprocalRank(
  retrieved: readonly string[],
  relevance: Readonly<Record<string, number>>,
): number {
  const index = retrieved.findIndex((id) => relevance[id] !== undefined);
  return index < 0 ? 0 : 1 / (index + 1);
}

function ndcgAtK(
  retrieved: readonly string[],
  relevance: Readonly<Record<string, number>>,
  k: number,
): number {
  const gains = retrieved.slice(0, k).map((id) => relevance[id] ?? 0);
  const ideal = Object.values(relevance)
    .sort((left, right) => right - left)
    .slice(0, k);
  const dcg = discountedGain(gains);
  const idealDcg = discountedGain(ideal);
  return idealDcg === 0 ? 0 : dcg / idealDcg;
}

function discountedGain(values: readonly number[]): number {
  return values.reduce((sum, value, index) => sum + (2 ** value - 1) / Math.log2(index + 2), 0);
}

function mean(values: readonly (number | null)[]): number | null {
  const available = values.filter((value): value is number => value !== null);
  return available.length === 0
    ? null
    : available.reduce((sum, value) => sum + value, 0) / available.length;
}

function percentile(values: readonly number[], percentileValue: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * percentileValue) - 1)] ?? null;
}

function minimumFailure(
  failures: string[],
  label: string,
  value: number | null,
  threshold: number,
): void {
  if (value === null) failures.push(`${label} 不可用。`);
  else if (value < threshold) failures.push(`${label} ${value.toFixed(4)}，低于 ${threshold}。`);
}

function roundMetrics(
  metrics: KnowledgeRetrievalBenchmarkMetrics,
): KnowledgeRetrievalBenchmarkMetrics {
  const rounded = (value: number | null): number | null =>
    value === null ? null : Math.round(value * 1_000_000) / 1_000_000;
  return {
    ...metrics,
    recallAt5: rounded(metrics.recallAt5),
    mrr: rounded(metrics.mrr),
    ndcgAt10: rounded(metrics.ndcgAt10),
    citationSupportRate: rounded(metrics.citationSupportRate),
    noAnswerAccuracy: rounded(metrics.noAnswerAccuracy),
    routeAccuracy: rounded(metrics.routeAccuracy),
    p95LatencyMs: rounded(metrics.p95LatencyMs),
  };
}

function hasAclExpectations(groundTruth: KnowledgeRetrievalGroundTruth): boolean {
  return (
    groundTruth.forbiddenChunkIds.length > 0 ||
    groundTruth.forbiddenDocumentIds.length > 0 ||
    groundTruth.forbiddenKnowledgeBaseIds.length > 0
  );
}

function childIdempotencyKey(batch: string, caseKey: string, kind: string): string {
  return `kre:${createHash('sha256').update(`${batch}:${caseKey}:${kind}`).digest('hex')}`;
}

function describeImportError(error: unknown): { readonly code: string; readonly message: string } {
  if (error instanceof ConflictException) {
    return { code: 'CONFLICT', message: safeMessage(error.message) };
  }
  if (error instanceof NotFoundException) {
    return { code: 'NOT_FOUND', message: safeMessage(error.message) };
  }
  return { code: safeErrorCode(error), message: '该行未导入，请检查证据、题号和标准切片。' };
}

function safeMessage(value: string): string {
  return value.replace(/[\r\n\t]+/gu, ' ').slice(0, 1_000) || '导入失败。';
}

function safeErrorCode(error: unknown): string {
  if (error instanceof Error && /^[A-Z][A-Za-z0-9]+Error$/u.test(error.name)) {
    return error.name.replace(/Error$/u, '').toUpperCase();
  }
  return 'RETRIEVAL_FAILED';
}

async function mapConcurrent<T, R>(
  items: readonly T[],
  concurrency: number,
  operation: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      const item = items[index];
      if (item !== undefined) results[index] = await operation(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}
