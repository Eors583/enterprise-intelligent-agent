import { z } from 'zod';

export const adminAgentRunSummarySchema = z.object({
  id: z.uuid(),
  status: z.enum([
    'QUEUED',
    'DISPATCHING',
    'RUNNING',
    'SUCCEEDED',
    'FAILED',
    'UNKNOWN',
    'CANCELLED',
  ]),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  createdAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
});

export const adminAgentSchema = z.object({
  id: z.uuid(),
  kind: z.enum(['MEMBER', 'DEPARTMENT']),
  name: z.string().min(1),
  summary: z.string().nullable(),
  status: z.enum(['ONLINE', 'OFFLINE', 'DISABLED']),
  visibility: z.enum(['tenant', 'owner', 'department']),
  owner: z
    .object({
      id: z.uuid(),
      displayName: z.string().min(1),
      status: z.enum(['ACTIVE', 'INACTIVE', 'LOCKED']),
    })
    .nullable(),
  department: z
    .object({
      id: z.uuid(),
      name: z.string().min(1),
      status: z.enum(['ACTIVE', 'ARCHIVED']),
    })
    .nullable(),
  versionId: z.uuid(),
  version: z.number().int().positive(),
  versionStatus: z.enum(['DRAFT', 'TESTING', 'PUBLISHED', 'ARCHIVED', 'RETIRED']),
  systemPrompt: z.string().min(1),
  modelRoute: z.string().min(1),
  configurationGovernance: z.enum(['LEGACY', 'GOVERNED']),
  knowledgeBaseIds: z.array(z.uuid()),
  lastRun: adminAgentRunSummarySchema.nullable(),
  updatedAt: z.iso.datetime(),
});

export const adminAgentListResponseSchema = z.object({ items: z.array(adminAgentSchema) });

const nonNegativeIntegerStringSchema = z.string().regex(/^\d+$/);

export const adminAgentUsageSummarySchema = z.object({
  periodStart: z.iso.datetime(),
  generatedAt: z.iso.datetime(),
  limits: z.object({
    concurrentRuns: z.number().int().positive(),
    runsPerMinute: z.number().int().positive(),
    monthlyTokens: nonNegativeIntegerStringSchema,
    updatedAt: z.iso.datetime(),
  }),
  current: z.object({
    activeRuns: z.number().int().nonnegative(),
    runsLastMinute: z.number().int().nonnegative(),
    completedRuns: z.number().int().nonnegative(),
    failedRuns: z.number().int().nonnegative(),
    unknownRuns: z.number().int().nonnegative(),
    unverifiedUsageRuns: z.number().int().nonnegative(),
    quotaUpperBoundRuns: z.number().int().nonnegative(),
    unreportedCostRuns: z.number().int().nonnegative(),
    inputTokens: nonNegativeIntegerStringSchema,
    outputTokens: nonNegativeIntegerStringSchema,
    totalTokens: nonNegativeIntegerStringSchema,
    quotaChargedTokens: nonNegativeIntegerStringSchema,
    reservedTokens: nonNegativeIntegerStringSchema,
    costMicros: nonNegativeIntegerStringSchema,
    averageLatencyMs: z.number().int().nonnegative().nullable(),
  }),
  byProviderModel: z.array(
    z.object({
      provider: z.string().nullable(),
      model: z.string().nullable(),
      runCount: z.number().int().nonnegative(),
      totalTokens: nonNegativeIntegerStringSchema,
      costMicros: nonNegativeIntegerStringSchema,
      averageLatencyMs: z.number().int().nonnegative().nullable(),
    }),
  ),
});

export const updateAgentUsageLimitsRequestSchema = z.object({
  concurrentRuns: z.number().int().min(1).max(1_000),
  runsPerMinute: z.number().int().min(1).max(100_000),
  monthlyTokens: z.string().regex(/^[1-9]\d{0,18}$/),
  expectedUpdatedAt: z.iso.datetime(),
});

export const agentUsageLimitsSchema = adminAgentUsageSummarySchema.shape.limits;

export const updateAdminAgentRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    summary: z.string().trim().max(2_000).nullable().optional(),
    status: z.enum(['ONLINE', 'OFFLINE', 'DISABLED']).optional(),
    visibility: z.enum(['tenant', 'owner', 'department']).optional(),
    systemPrompt: z.string().trim().min(20).max(20_000).optional(),
    knowledgeBaseIds: z.array(z.uuid()).max(50).optional(),
    expectedVersionId: z.uuid(),
  })
  .refine(
    (value) =>
      value.name !== undefined ||
      value.summary !== undefined ||
      value.status !== undefined ||
      value.visibility !== undefined ||
      value.systemPrompt !== undefined ||
      value.knowledgeBaseIds !== undefined,
    'At least one agent field must change.',
  );

export const createDepartmentAgentRequestSchema = z.object({
  name: z.string().trim().min(1).max(200),
  summary: z.string().trim().max(2_000).nullable().optional(),
  orgUnitId: z.uuid(),
  knowledgeBaseIds: z.array(z.uuid()).min(1).max(50),
  systemPrompt: z.string().trim().min(20).max(20_000).optional(),
  status: z.enum(['ONLINE', 'OFFLINE']).default('ONLINE'),
});

export type AdminAgent = z.infer<typeof adminAgentSchema>;
export type AdminAgentListResponse = z.infer<typeof adminAgentListResponseSchema>;
export type AdminAgentUsageSummary = z.infer<typeof adminAgentUsageSummarySchema>;
export type AgentUsageLimits = z.infer<typeof agentUsageLimitsSchema>;
export type UpdateAgentUsageLimitsRequest = z.infer<typeof updateAgentUsageLimitsRequestSchema>;
export type UpdateAdminAgentRequest = z.infer<typeof updateAdminAgentRequestSchema>;
export type CreateDepartmentAgentRequest = z.infer<typeof createDepartmentAgentRequestSchema>;
