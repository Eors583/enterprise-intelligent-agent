import { z } from 'zod';

const TIMESTAMP = z.iso.datetime();
const NON_NEGATIVE_INT = z.number().int().nonnegative();
const NON_NEGATIVE_BIGINT_TEXT = z.string().regex(/^\d+$/u);

export const adminOverviewRunWindowSchema = z
  .object({
    from: TIMESTAMP,
    total: NON_NEGATIVE_INT,
    succeeded: NON_NEGATIVE_INT,
    failed: NON_NEGATIVE_INT,
    unknown: NON_NEGATIVE_INT,
    cancelled: NON_NEGATIVE_INT,
    inProgress: NON_NEGATIVE_INT,
    trustedUsageRuns: NON_NEGATIVE_INT,
    unreportedUsageRuns: NON_NEGATIVE_INT,
    quotaUpperBoundRuns: NON_NEGATIVE_INT,
    inputTokens: NON_NEGATIVE_BIGINT_TEXT,
    outputTokens: NON_NEGATIVE_BIGINT_TEXT,
    totalTokens: NON_NEGATIVE_BIGINT_TEXT,
    quotaChargedTokens: NON_NEGATIVE_BIGINT_TEXT,
    costMicros: NON_NEGATIVE_BIGINT_TEXT,
    latencySampleCount: NON_NEGATIVE_INT,
    averageLatencyMs: NON_NEGATIVE_INT.nullable(),
    p95LatencyMs: NON_NEGATIVE_INT.nullable(),
    groundedSucceededRuns: NON_NEGATIVE_INT,
    ungroundedSucceededRuns: NON_NEGATIVE_INT,
    helpfulFeedback: NON_NEGATIVE_INT,
    notHelpfulFeedback: NON_NEGATIVE_INT,
    feedbackSampleCount: NON_NEGATIVE_INT,
    helpfulRateBps: z.number().int().min(0).max(10_000).nullable(),
  })
  .strict();

export const adminOverviewAlertSchema = z
  .object({
    code: z.string().regex(/^[A-Z0-9_]{1,120}$/u),
    severity: z.enum(['INFO', 'WARNING', 'CRITICAL']),
    count: NON_NEGATIVE_INT,
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().min(1).max(1_000),
    target: z
      .enum([
        'members',
        'agents',
        'ai-model-routing',
        'knowledge',
        'organization',
        'runtime-governance',
        'identity-governance',
      ])
      .nullable(),
  })
  .strict();

export const adminOverviewResponseSchema = z
  .object({
    generatedAt: TIMESTAMP,
    people: z
      .object({
        total: NON_NEGATIVE_INT,
        active: NON_NEGATIVE_INT,
        inactive: NON_NEGATIVE_INT,
        locked: NON_NEGATIVE_INT,
        pendingInvitations: NON_NEGATIVE_INT,
        activeUsers7d: NON_NEGATIVE_INT,
      })
      .strict(),
    agents: z
      .object({
        total: NON_NEGATIVE_INT,
        configuredOnline: NON_NEGATIVE_INT,
        available: NON_NEGATIVE_INT,
        notReady: NON_NEGATIVE_INT,
        degraded: NON_NEGATIVE_INT,
        unknown: NON_NEGATIVE_INT,
      })
      .strict(),
    ai: z
      .object({
        today: adminOverviewRunWindowSchema,
        month: adminOverviewRunWindowSchema,
      })
      .strict(),
    knowledge: z
      .object({
        activeBases: NON_NEGATIVE_INT,
        totalDocuments: NON_NEGATIVE_INT,
        readyDocuments: NON_NEGATIVE_INT,
        failedDocuments: NON_NEGATIVE_INT,
        pendingParseReviews: NON_NEGATIVE_INT,
        rejectedParseReviews: NON_NEGATIVE_INT,
        failedIngestionJobs: NON_NEGATIVE_INT,
        totalChunks: NON_NEGATIVE_INT,
        chunksWithEmbeddings: NON_NEGATIVE_INT,
        chunksMissingEmbeddings: NON_NEGATIVE_INT,
      })
      .strict(),
    directory: z
      .object({
        latestRunStatus: z
          .enum(['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'DEAD_LETTER'])
          .nullable(),
        latestRunFinishedAt: TIMESTAMP.nullable(),
        failedRuns24h: NON_NEGATIVE_INT,
        pendingPreviewItems: NON_NEGATIVE_INT,
      })
      .strict(),
    operations: z
      .object({
        pendingOutboxEvents: NON_NEGATIVE_INT,
        failedOutboxEvents: NON_NEGATIVE_INT,
        unknownOutboxEvents: NON_NEGATIVE_INT,
        quarantinedOutboxEvents: NON_NEGATIVE_INT,
        unknownAgentRuns24h: NON_NEGATIVE_INT,
      })
      .strict(),
    alerts: z.array(adminOverviewAlertSchema).max(64),
  })
  .strict();

export type AdminOverviewResponse = z.infer<typeof adminOverviewResponseSchema>;
export type AdminOverviewRunWindow = z.infer<typeof adminOverviewRunWindowSchema>;
export type AdminOverviewAlert = z.infer<typeof adminOverviewAlertSchema>;
