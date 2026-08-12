import { z } from 'zod';

const UUID = z.uuid();
const SHA256 = z.string().regex(/^[a-f0-9]{64}$/u);
const IDEMPOTENCY_KEY = z.string().trim().min(8).max(200);
const TIMESTAMP = z.iso.datetime({ offset: true });
const CODE = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const LONG_TEXT = z.string().trim().min(1).max(20_000);
const UNIQUE_UUIDS = z
  .array(UUID)
  .max(100)
  .refine((items) => new Set(items).size === items.length, 'UUID values must be unique.');

export const knowledgeRetrievalEvaluationRouteSchema = z.enum([
  'DOCUMENT',
  'SQL',
  'RELATIONSHIP',
  'BUSINESS_API',
]);

export const knowledgeRetrievalGroundTruthSchema = z
  .object({
    schemaVersion: z.literal(1),
    knowledgeBaseId: UUID,
    simulatedUserId: UUID,
    expectedNoAnswer: z.boolean(),
    semanticRequired: z.boolean().default(true),
    relevance: z.record(UUID, z.number().int().min(1).max(3)),
    forbiddenChunkIds: UNIQUE_UUIDS.default([]),
    forbiddenDocumentIds: UNIQUE_UUIDS.default([]),
    forbiddenKnowledgeBaseIds: UNIQUE_UUIDS.default([]),
    expectedRoute: knowledgeRetrievalEvaluationRouteSchema.nullable().default(null),
    limit: z.number().int().min(10).max(20).default(10),
  })
  .strict()
  .superRefine((value, context) => {
    const relevantCount = Object.keys(value.relevance).length;
    if (value.expectedNoAnswer && relevantCount > 0) {
      context.addIssue({
        code: 'custom',
        path: ['relevance'],
        message: 'No-answer cases cannot define relevant chunks.',
      });
    }
    if (!value.expectedNoAnswer && relevantCount === 0) {
      context.addIssue({
        code: 'custom',
        path: ['relevance'],
        message: 'Answerable cases require at least one relevant chunk.',
      });
    }
  });

export const bulkKnowledgeRetrievalEvaluationCaseSchema = z
  .object({
    caseKey: CODE,
    query: LONG_TEXT,
    expectedAnswer: LONG_TEXT,
    groundTruth: knowledgeRetrievalGroundTruthSchema,
  })
  .strict();

export const bulkImportKnowledgeRetrievalEvaluationCasesRequestSchema = z
  .object({
    evidenceId: UUID,
    annotationRationale: LONG_TEXT,
    cases: z.array(bulkKnowledgeRetrievalEvaluationCaseSchema).min(1).max(500),
    idempotencyKey: IDEMPOTENCY_KEY,
  })
  .strict()
  .superRefine((value, context) => {
    const keys = value.cases.map(({ caseKey }) => caseKey);
    if (new Set(keys).size !== keys.length) {
      context.addIssue({
        code: 'custom',
        path: ['cases'],
        message: 'Case keys must be unique inside a bulk import.',
      });
    }
  });

export const bulkKnowledgeRetrievalEvaluationImportFailureSchema = z
  .object({
    rowNumber: z.number().int().positive(),
    caseKey: CODE,
    code: z.string().min(1).max(120),
    message: z.string().min(1).max(1_000),
  })
  .strict();

export const bulkImportKnowledgeRetrievalEvaluationCasesResultSchema = z
  .object({
    requestedCount: z.number().int().positive().max(500),
    importedCount: z.number().int().nonnegative().max(500),
    annotatedCount: z.number().int().nonnegative().max(500),
    failedCount: z.number().int().nonnegative().max(500),
    datasetCaseCount: z.number().int().nonnegative(),
    annotationCoverage: z.number().min(0).max(1),
    failures: z.array(bulkKnowledgeRetrievalEvaluationImportFailureSchema).max(500),
  })
  .strict();

export const knowledgeRetrievalBenchmarkThresholdsSchema = z
  .object({
    minRecallAt5: z.number().min(0).max(1).default(0.8),
    minMrr: z.number().min(0).max(1).default(0.7),
    minNdcgAt10: z.number().min(0).max(1).default(0.7),
    minCitationSupportRate: z.number().min(0).max(1).default(0.9),
    minNoAnswerAccuracy: z.number().min(0).max(1).default(0.9),
    maxP95LatencyMs: z.number().positive().max(120_000).default(3_000),
    maxAclLeakCount: z.number().int().nonnegative().max(10_000).default(0),
    minCaseCount: z.number().int().nonnegative().max(500).default(200),
    minAnswerableCount: z.number().int().nonnegative().max(500).default(150),
    minNoAnswerCount: z.number().int().nonnegative().max(500).default(25),
    minAclCaseCount: z.number().int().nonnegative().max(500).default(25),
  })
  .strict();

export const runKnowledgeRetrievalBenchmarkRequestSchema = z
  .object({
    thresholds: knowledgeRetrievalBenchmarkThresholdsSchema.default({
      minRecallAt5: 0.8,
      minMrr: 0.7,
      minNdcgAt10: 0.7,
      minCitationSupportRate: 0.9,
      minNoAnswerAccuracy: 0.9,
      maxP95LatencyMs: 3_000,
      maxAclLeakCount: 0,
      minCaseCount: 200,
      minAnswerableCount: 150,
      minNoAnswerCount: 25,
      minAclCaseCount: 25,
    }),
    concurrency: z.number().int().min(1).max(8).default(4),
    idempotencyKey: IDEMPOTENCY_KEY,
  })
  .strict();

export const knowledgeRetrievalBenchmarkMetricsSchema = z
  .object({
    recallAt5: z.number().min(0).max(1).nullable(),
    mrr: z.number().min(0).max(1).nullable(),
    ndcgAt10: z.number().min(0).max(1).nullable(),
    citationSupportRate: z.number().min(0).max(1).nullable(),
    noAnswerAccuracy: z.number().min(0).max(1).nullable(),
    routeAccuracy: z.number().min(0).max(1).nullable(),
    p95LatencyMs: z.number().nonnegative().nullable(),
    aclLeakCount: z.number().int().nonnegative(),
    semanticEvidenceFailureCount: z.number().int().nonnegative(),
    evaluatedCaseCount: z.number().int().nonnegative(),
    answerableCaseCount: z.number().int().nonnegative(),
    noAnswerCaseCount: z.number().int().nonnegative(),
    aclCaseCount: z.number().int().nonnegative(),
  })
  .strict();

export const knowledgeRetrievalBenchmarkCaseResultSchema = z
  .object({
    caseId: UUID,
    caseKey: CODE,
    expectedNoAnswer: z.boolean(),
    predictedNoAnswer: z.boolean(),
    retrievedChunkIds: z.array(UUID).max(20),
    recallAt5: z.number().min(0).max(1).nullable(),
    reciprocalRank: z.number().min(0).max(1).nullable(),
    ndcgAt10: z.number().min(0).max(1).nullable(),
    citationSupported: z.boolean().nullable(),
    routeMatched: z.boolean().nullable(),
    latencyMs: z.number().nonnegative(),
    aclEvents: z.array(z.string().min(1).max(500)).max(300),
    semanticEvidenceFailures: z.array(z.string().min(1).max(500)).max(20),
    errorCode: z.string().min(1).max(120).nullable(),
  })
  .strict();

export const knowledgeRetrievalBenchmarkRunSchema = z
  .object({
    id: UUID,
    tenantId: UUID,
    datasetVersionId: UUID,
    datasetContentHash: SHA256,
    status: z.enum(['RUNNING', 'PASSED', 'FAILED']),
    thresholds: knowledgeRetrievalBenchmarkThresholdsSchema,
    metrics: knowledgeRetrievalBenchmarkMetricsSchema.nullable(),
    failures: z.array(z.string().min(1).max(1_000)).max(100),
    caseResults: z.array(knowledgeRetrievalBenchmarkCaseResultSchema).max(500),
    processedCaseCount: z.number().int().nonnegative().max(500),
    totalCaseCount: z.number().int().nonnegative().max(500),
    requestedByUserId: UUID,
    startedAt: TIMESTAMP,
    finishedAt: TIMESTAMP.nullable(),
    createdAt: TIMESTAMP,
  })
  .strict();

export const knowledgeRetrievalBenchmarkRunListResponseSchema = z
  .object({
    items: z.array(knowledgeRetrievalBenchmarkRunSchema.omit({ caseResults: true })),
    nextCursor: UUID.nullable(),
  })
  .strict();

export type KnowledgeRetrievalEvaluationRoute = z.infer<
  typeof knowledgeRetrievalEvaluationRouteSchema
>;
export type KnowledgeRetrievalGroundTruth = z.infer<typeof knowledgeRetrievalGroundTruthSchema>;
export type BulkKnowledgeRetrievalEvaluationCase = z.infer<
  typeof bulkKnowledgeRetrievalEvaluationCaseSchema
>;
export type BulkImportKnowledgeRetrievalEvaluationCasesRequest = z.infer<
  typeof bulkImportKnowledgeRetrievalEvaluationCasesRequestSchema
>;
export type BulkImportKnowledgeRetrievalEvaluationCasesResult = z.infer<
  typeof bulkImportKnowledgeRetrievalEvaluationCasesResultSchema
>;
export type KnowledgeRetrievalBenchmarkThresholds = z.infer<
  typeof knowledgeRetrievalBenchmarkThresholdsSchema
>;
export type RunKnowledgeRetrievalBenchmarkRequest = z.infer<
  typeof runKnowledgeRetrievalBenchmarkRequestSchema
>;
export type KnowledgeRetrievalBenchmarkMetrics = z.infer<
  typeof knowledgeRetrievalBenchmarkMetricsSchema
>;
export type KnowledgeRetrievalBenchmarkCaseResult = z.infer<
  typeof knowledgeRetrievalBenchmarkCaseResultSchema
>;
export type KnowledgeRetrievalBenchmarkRun = z.infer<typeof knowledgeRetrievalBenchmarkRunSchema>;
export type KnowledgeRetrievalBenchmarkRunSummary = Omit<
  KnowledgeRetrievalBenchmarkRun,
  'caseResults'
>;
export type KnowledgeRetrievalBenchmarkRunListResponse = z.infer<
  typeof knowledgeRetrievalBenchmarkRunListResponseSchema
>;
