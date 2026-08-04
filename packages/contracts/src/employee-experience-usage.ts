import { z } from 'zod';

import { experienceStatusSchema, memorySensitivitySchema } from './memory-experience.js';

const UUID = z.uuid();
const TIMESTAMP = z.iso.datetime();
const SHA256 = z.string().regex(/^[a-f0-9]{64}$/u);
const COUNT = z.number().int().nonnegative();
const INTEGER_STRING = z.string().regex(/^(?:0|[1-9][0-9]*)$/u);
const SHORT_TEXT = z.string().trim().min(1).max(500);
const LONG_TEXT = z.string().trim().min(1).max(20_000);
const UNIQUE_UUIDS = z
  .array(UUID)
  .max(500)
  .refine((values) => new Set(values).size === values.length, 'UUID values must be unique.');
const UNIQUE_LABELS = z
  .array(z.string().trim().min(1).max(100))
  .max(100)
  .refine((values) => new Set(values).size === values.length, 'Labels must be unique.');

export const employeeExperienceListQuerySchema = z
  .object({
    cursor: UUID.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    status: experienceStatusSchema.optional(),
  })
  .strict();

export const employeeCreateExperienceRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(300),
    sourceTaskId: UUID,
    sourceDeliverableIds: UNIQUE_UUIDS,
    sourceEvidenceIds: UNIQUE_UUIDS.min(1),
    candidateSummary: LONG_TEXT,
    permissionLabels: UNIQUE_LABELS,
    sensitivity: memorySensitivitySchema,
    idempotencyKey: z.string().trim().min(8).max(200),
  })
  .strict();

export const employeeExperienceSourceQuerySchema = z
  .object({
    taskId: UUID,
  })
  .strict();

export const employeeExperienceSourceSchema = z
  .object({
    task: z
      .object({
        id: UUID,
        title: z.string().trim().min(1).max(300),
        permissionLabels: UNIQUE_LABELS,
      })
      .strict(),
    deliverables: z.array(
      z
        .object({
          id: UUID,
          version: z.number().int().positive(),
          title: z.string().trim().min(1).max(300),
          status: z.enum(['SUBMITTED', 'ACCEPTED']),
        })
        .strict(),
    ),
    evidence: z.array(
      z
        .object({
          id: UUID,
          version: z.number().int().positive(),
          code: z.string().trim().min(1).max(100),
          sourceType: z.string().trim().min(1).max(100),
          summary: z.string().trim().min(1).max(20_000),
          observedAt: TIMESTAMP,
        })
        .strict(),
    ),
  })
  .strict();

export const employeeExperienceCandidateSchema = z
  .object({
    id: UUID,
    status: experienceStatusSchema,
    revision: z.number().int().positive(),
    title: z.string().trim().min(1).max(300),
    source: z
      .object({
        taskId: UUID,
        deliverableIds: UNIQUE_UUIDS,
        evidenceIds: UNIQUE_UUIDS.min(1),
      })
      .strict(),
    sanitized: z
      .object({
        safeContent: LONG_TEXT,
        contentHash: SHA256,
        sanitizedAt: TIMESTAMP,
      })
      .strict()
      .nullable(),
    review: z
      .object({
        decision: z.enum(['APPROVED', 'REJECTED']),
        decidedAt: TIMESTAMP,
      })
      .strict()
      .nullable(),
    validation: z
      .object({
        passed: z.boolean(),
        score: z.number().finite().min(0).max(1),
        threshold: z.number().finite().min(0).max(1),
        validatedAt: TIMESTAMP,
      })
      .strict()
      .nullable(),
    publication: z
      .object({
        targetRoleTemplateIds: UNIQUE_UUIDS,
        targetOrgUnitIds: UNIQUE_UUIDS,
        publishedAt: TIMESTAMP,
      })
      .strict()
      .nullable(),
    permissionLabels: UNIQUE_LABELS,
    sensitivity: memorySensitivitySchema,
    metrics: z
      .object({
        useCount: COUNT,
        adoptionCount: COUNT,
        complaintCount: COUNT,
      })
      .strict(),
    retiredAt: TIMESTAMP.nullable(),
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  })
  .strict()
  .superRefine((candidate, context) => {
    if (
      candidate.metrics.adoptionCount > candidate.metrics.useCount ||
      candidate.metrics.complaintCount > candidate.metrics.useCount
    ) {
      context.addIssue({
        code: 'custom',
        path: ['metrics'],
        message: 'Experience monitoring counters are inconsistent.',
      });
    }
    if (candidate.status !== 'CANDIDATE' && candidate.sanitized === null) {
      context.addIssue({
        code: 'custom',
        path: ['sanitized'],
        message: 'Only an unsanitized candidate may omit safe content.',
      });
    }
    if ((candidate.status === 'RETIRED') !== (candidate.retiredAt !== null)) {
      context.addIssue({
        code: 'custom',
        path: ['retiredAt'],
        message: 'Retired experience requires retiredAt.',
      });
    }
  });

export const employeeExperienceListResponseSchema = z
  .object({
    items: z.array(employeeExperienceCandidateSchema).max(100),
    nextCursor: UUID.nullable(),
  })
  .strict();

export const employeeAiUsageQuerySchema = z
  .object({
    from: TIMESTAMP.optional(),
    to: TIMESTAMP.optional(),
    groupLimit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict()
  .superRefine((query, context) => {
    if ((query.from === undefined) !== (query.to === undefined)) {
      context.addIssue({
        code: 'custom',
        path: ['from'],
        message: 'from and to must be supplied together.',
      });
      return;
    }
    if (query.from !== undefined && query.to !== undefined) {
      const from = Date.parse(query.from);
      const to = Date.parse(query.to);
      if (from >= to) {
        context.addIssue({
          code: 'custom',
          path: ['to'],
          message: 'to must be later than from.',
        });
      } else if (to - from > 366 * 24 * 60 * 60 * 1_000) {
        context.addIssue({
          code: 'custom',
          path: ['to'],
          message: 'AI usage windows cannot exceed 366 days.',
        });
      }
    }
  });

const employeeAiUsageRunCountsSchema = z
  .object({
    total: COUNT,
    succeeded: COUNT,
    failed: COUNT,
    unknown: COUNT,
    cancelled: COUNT,
    inProgress: COUNT,
    tokenReported: COUNT,
    tokenUnreported: COUNT,
    costReported: COUNT,
    costUnreported: COUNT,
  })
  .strict()
  .superRefine((counts, context) => {
    if (
      counts.succeeded + counts.failed + counts.unknown + counts.cancelled + counts.inProgress !==
      counts.total
    ) {
      context.addIssue({
        code: 'custom',
        path: ['total'],
        message: 'AI Run status counts must add up to total.',
      });
    }
    const terminal = counts.succeeded + counts.failed + counts.unknown + counts.cancelled;
    if (
      counts.tokenReported + counts.tokenUnreported !== terminal ||
      counts.costReported + counts.costUnreported !== terminal
    ) {
      context.addIssue({
        code: 'custom',
        path: ['tokenReported'],
        message: 'Usage reporting counts must cover terminal Runs exactly.',
      });
    }
  });

const employeeAiUsageTrustedTotalsSchema = z
  .object({
    inputTokens: INTEGER_STRING,
    outputTokens: INTEGER_STRING,
    totalTokens: INTEGER_STRING,
    costMicros: INTEGER_STRING,
  })
  .strict();

const employeeAiUsageLatencySchema = z
  .object({
    sampleCount: COUNT,
    averageMs: COUNT.nullable(),
    p50Ms: COUNT.nullable(),
    p95Ms: COUNT.nullable(),
  })
  .strict()
  .superRefine((latency, context) => {
    if (
      (latency.sampleCount === 0) !==
      (latency.averageMs === null && latency.p50Ms === null && latency.p95Ms === null)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['sampleCount'],
        message: 'Latency samples and aggregates must be reported together.',
      });
    }
  });

const employeeAiUsageGroupSchema = z
  .object({
    id: UUID.nullable(),
    name: z.string().trim().min(1).max(300).nullable(),
    runs: employeeAiUsageRunCountsSchema,
    trustedUsage: employeeAiUsageTrustedTotalsSchema,
    latency: employeeAiUsageLatencySchema,
  })
  .strict();

export const employeeAiUsageSummarySchema = z
  .object({
    period: z
      .object({
        from: TIMESTAMP,
        to: TIMESTAMP,
        defaultedToCurrentMonth: z.boolean(),
      })
      .strict(),
    generatedAt: TIMESTAMP,
    runs: employeeAiUsageRunCountsSchema,
    trustedUsage: employeeAiUsageTrustedTotalsSchema,
    latency: employeeAiUsageLatencySchema,
    byAgent: z.array(employeeAiUsageGroupSchema).max(100),
    byTask: z.array(employeeAiUsageGroupSchema).max(100),
  })
  .strict();

export type EmployeeExperienceListQuery = z.infer<typeof employeeExperienceListQuerySchema>;
export type EmployeeCreateExperienceRequest = z.infer<typeof employeeCreateExperienceRequestSchema>;
export type EmployeeExperienceSourceQuery = z.infer<typeof employeeExperienceSourceQuerySchema>;
export type EmployeeExperienceSource = z.infer<typeof employeeExperienceSourceSchema>;
export type EmployeeExperienceCandidate = z.infer<typeof employeeExperienceCandidateSchema>;
export type EmployeeExperienceListResponse = z.infer<typeof employeeExperienceListResponseSchema>;
export type EmployeeAiUsageQuery = z.infer<typeof employeeAiUsageQuerySchema>;
export type EmployeeAiUsageSummary = z.infer<typeof employeeAiUsageSummarySchema>;
