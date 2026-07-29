import { z } from 'zod';

const UUID = z.string().uuid();
const CODE = z
  .string()
  .trim()
  .min(2)
  .max(100)
  .regex(/^[A-Z0-9][A-Z0-9._-]*$/);
const NAME = z.string().trim().min(1).max(200);
const TEXT = z.string().trim().min(1).max(10_000);
const REVISION = z.number().int().positive();
const ISO_DATE_TIME = z.string().datetime({ offset: true });
const SHA256 = z.string().regex(/^[a-f0-9]{64}$/);
const MONEY = z.number().finite().nonnegative();

export const marketingObservationDimensionSchema = z.enum([
  'INDUSTRY',
  'MARKET',
  'CUSTOMER',
  'COMPETITION',
  'SELF',
]);
export const marketingAssertionTypeSchema = z.enum(['FACT', 'HYPOTHESIS', 'INFERENCE']);
export const marketingCandidateOriginSchema = z.enum(['HUMAN', 'AI']);
export const marketingEvidenceLinkTypeSchema = z.enum(['SUPPORTS', 'REFUTES', 'QUALIFIES']);
export const marketingInsightStatusSchema = z.enum([
  'CANDIDATE',
  'UNDER_REVIEW',
  'APPROVED',
  'REJECTED',
  'PUBLISHED',
  'RETIRED',
]);
export const marketingInsightActionSchema = z.enum([
  'SUBMIT',
  'APPROVE',
  'REJECT',
  'PUBLISH',
  'RETIRE',
]);
export const marketingMasterDataStatusSchema = z.enum(['ACTIVE', 'RETIRED']);
export const marketingTargetAxisSchema = z.enum(['REGION', 'CUSTOMER_SEGMENT']);
export const marketingTargetStatusSchema = z.enum(['DRAFT', 'ACTIVE', 'CLOSED', 'CANCELLED']);
export const marketingActionPlanStatusSchema = z.enum([
  'DRAFT',
  'ACTIVE',
  'COMPLETED',
  'CANCELLED',
]);
export const marketingActionItemStatusSchema = z.enum([
  'PLANNED',
  'ACTIVE',
  'BLOCKED',
  'COMPLETED',
  'CANCELLED',
]);
export const marketingContributionTypeSchema = z.enum([
  'RESPONSIBLE',
  'ACCOUNTABLE',
  'CONSULTED',
  'INFORMED',
]);

export const marketingObservationEvidenceSchema = z.object({
  evidenceId: UUID,
  evidenceVersion: z.number().int().positive(),
  linkType: marketingEvidenceLinkTypeSchema,
  sourceSystem: z.string().min(1).max(100),
  sourceRecordId: z.string().min(1).max(500),
  sourceVersion: z.string().min(1).max(200),
  contentHash: SHA256,
});

export const marketingObservationSchema = z.object({
  id: UUID,
  code: CODE,
  version: z.number().int().positive(),
  dimension: marketingObservationDimensionSchema,
  assertionType: marketingAssertionTypeSchema,
  statement: TEXT,
  confidence: z.number().min(0).max(1),
  origin: marketingCandidateOriginSchema,
  agentRunId: UUID.nullable(),
  createdByUserId: UUID,
  createdAt: ISO_DATE_TIME,
  evidence: z.array(marketingObservationEvidenceSchema).min(1),
});

export const createMarketingObservationRequestSchema = z
  .object({
    code: CODE,
    dimension: marketingObservationDimensionSchema,
    assertionType: marketingAssertionTypeSchema,
    statement: TEXT,
    confidence: z.number().min(0).max(1),
    origin: marketingCandidateOriginSchema,
    agentRunId: UUID.nullable().default(null),
    evidence: z
      .array(
        z.object({
          evidenceId: UUID,
          evidenceVersion: z.number().int().positive(),
          linkType: marketingEvidenceLinkTypeSchema,
          expectedContentHash: SHA256,
        }),
      )
      .min(1)
      .max(100),
    idempotencyKey: z.string().trim().min(8).max(200),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.origin === 'AI' && value.agentRunId === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['agentRunId'],
        message: 'AI observations require a traceable Agent Run.',
      });
    }
    if (value.origin === 'HUMAN' && value.agentRunId !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['agentRunId'],
        message: 'Human observations cannot claim an Agent Run.',
      });
    }
  });

export const marketingInsightSchema = z.object({
  id: UUID,
  code: CODE,
  version: z.number().int().positive(),
  revision: REVISION,
  title: NAME,
  statement: TEXT,
  origin: marketingCandidateOriginSchema,
  agentRunId: UUID.nullable(),
  status: marketingInsightStatusSchema,
  createdByUserId: UUID,
  reviewRequestedByUserId: UUID.nullable(),
  reviewedByUserId: UUID.nullable(),
  publishedByUserId: UUID.nullable(),
  reviewComment: z.string().nullable(),
  createdAt: ISO_DATE_TIME,
  updatedAt: ISO_DATE_TIME,
  observationIds: z.array(UUID).min(1),
});

export const createMarketingInsightRequestSchema = z
  .object({
    code: CODE,
    title: NAME,
    statement: TEXT,
    origin: marketingCandidateOriginSchema,
    agentRunId: UUID.nullable().default(null),
    observationIds: z.array(UUID).min(1).max(200),
    idempotencyKey: z.string().trim().min(8).max(200),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.origin === 'AI' && value.agentRunId === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['agentRunId'],
        message: 'AI insight candidates require a traceable Agent Run.',
      });
    }
    if (value.origin === 'HUMAN' && value.agentRunId !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['agentRunId'],
        message: 'Human insight candidates cannot claim an Agent Run.',
      });
    }
  });

export const transitionMarketingInsightRequestSchema = z
  .object({
    action: marketingInsightActionSchema,
    expectedRevision: REVISION,
    comment: z.string().trim().min(3).max(1000),
  })
  .strict();

export const marketingMasterDataSchema = z.object({
  id: UUID,
  code: CODE,
  name: NAME,
  description: z.string(),
  status: marketingMasterDataStatusSchema,
  revision: REVISION,
  createdAt: ISO_DATE_TIME,
  updatedAt: ISO_DATE_TIME,
});

export const createMarketingMasterDataRequestSchema = z
  .object({
    code: CODE,
    name: NAME,
    description: z.string().trim().max(4000).default(''),
    idempotencyKey: z.string().trim().min(8).max(200),
  })
  .strict();

export const updateMarketingMasterDataRequestSchema = z
  .object({
    expectedRevision: REVISION,
    name: NAME.optional(),
    description: z.string().trim().max(4000).optional(),
    status: marketingMasterDataStatusSchema.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.name !== undefined || value.description !== undefined || value.status !== undefined,
    'At least one master-data field must change.',
  );

export const marketingTargetSchema = z.object({
  id: UUID,
  code: CODE,
  revision: REVISION,
  status: marketingTargetStatusSchema,
  productId: UUID,
  axis: marketingTargetAxisSchema,
  regionId: UUID.nullable(),
  customerSegmentId: UUID.nullable(),
  strategyId: UUID,
  strategyVersion: z.number().int().positive(),
  objectiveId: UUID,
  objectiveVersion: z.number().int().positive(),
  valueDefinitionId: UUID,
  valueVersionId: UUID,
  valueVersionNumber: z.number().int().positive(),
  responsibleRoleAssignmentId: UUID,
  metricDefinitionId: UUID,
  metricDefinitionVersion: z.number().int().positive(),
  baselineValue: z.number().nullable(),
  targetValue: z.number(),
  unit: z.string().min(1).max(50),
  periodStart: ISO_DATE_TIME,
  periodEnd: ISO_DATE_TIME,
  budgetAmount: z.number().nullable(),
  budgetCurrency: z.string().length(3).nullable(),
  createdAt: ISO_DATE_TIME,
  updatedAt: ISO_DATE_TIME,
});

export const createMarketingTargetRequestSchema = z
  .object({
    code: CODE,
    productId: UUID,
    axis: marketingTargetAxisSchema,
    regionId: UUID.nullable(),
    customerSegmentId: UUID.nullable(),
    strategyId: UUID,
    strategyVersion: z.number().int().positive(),
    objectiveId: UUID,
    objectiveVersion: z.number().int().positive(),
    valueDefinitionId: UUID,
    valueVersionId: UUID,
    valueVersionNumber: z.number().int().positive(),
    responsibleRoleAssignmentId: UUID,
    metricDefinitionId: UUID,
    metricDefinitionVersion: z.number().int().positive(),
    baselineValue: z.number().finite().nullable().default(null),
    targetValue: z.number().finite(),
    unit: z.string().trim().min(1).max(50),
    periodStart: ISO_DATE_TIME,
    periodEnd: ISO_DATE_TIME,
    budgetAmount: MONEY.nullable().default(null),
    budgetCurrency: z.string().trim().length(3).toUpperCase().nullable().default(null),
    idempotencyKey: z.string().trim().min(8).max(200),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Date(value.periodEnd) <= new Date(value.periodStart)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['periodEnd'],
        message: 'Target period end must be after its start.',
      });
    }
    const correctAxis =
      (value.axis === 'REGION' && value.regionId !== null && value.customerSegmentId === null) ||
      (value.axis === 'CUSTOMER_SEGMENT' &&
        value.regionId === null &&
        value.customerSegmentId !== null);
    if (!correctAxis) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['axis'],
        message: 'Target axis must bind exactly one matching Region or Customer Segment.',
      });
    }
    if ((value.budgetAmount === null) !== (value.budgetCurrency === null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['budgetCurrency'],
        message: 'Budget amount and currency must be supplied together.',
      });
    }
  });

export const transitionMarketingTargetRequestSchema = z
  .object({
    action: z.enum(['ACTIVATE', 'CLOSE', 'CANCEL']),
    expectedRevision: REVISION,
    comment: z.string().trim().min(3).max(1000),
  })
  .strict();

export const marketingActionItemSchema = z.object({
  id: UUID,
  code: CODE,
  revision: REVISION,
  ordinal: z.number().int().nonnegative(),
  title: NAME,
  description: TEXT,
  status: marketingActionItemStatusSchema,
  responsibleRoleAssignmentId: UUID,
  linkedTaskId: UUID.nullable(),
  linkedTaskVersion: z.number().int().positive().nullable(),
  contributionType: marketingContributionTypeSchema,
  acceptanceCriteria: TEXT,
  acceptanceEvidenceId: UUID.nullable(),
  acceptanceEvidenceVersion: z.number().int().positive().nullable(),
  dueAt: ISO_DATE_TIME,
  createdAt: ISO_DATE_TIME,
  updatedAt: ISO_DATE_TIME,
});

export const marketingActionPlanSchema = z.object({
  id: UUID,
  code: CODE,
  version: z.number().int().positive(),
  revision: REVISION,
  targetId: UUID,
  title: NAME,
  description: TEXT,
  status: marketingActionPlanStatusSchema,
  responsibleRoleAssignmentId: UUID,
  periodStart: ISO_DATE_TIME,
  periodEnd: ISO_DATE_TIME,
  plannedBudgetAmount: z.number().nullable(),
  plannedBudgetCurrency: z.string().length(3).nullable(),
  createdAt: ISO_DATE_TIME,
  updatedAt: ISO_DATE_TIME,
  items: z.array(marketingActionItemSchema),
});

export const createMarketingActionPlanRequestSchema = z
  .object({
    code: CODE,
    targetId: UUID,
    title: NAME,
    description: TEXT,
    responsibleRoleAssignmentId: UUID,
    periodStart: ISO_DATE_TIME,
    periodEnd: ISO_DATE_TIME,
    plannedBudgetAmount: MONEY.nullable().default(null),
    plannedBudgetCurrency: z.string().trim().length(3).toUpperCase().nullable().default(null),
    idempotencyKey: z.string().trim().min(8).max(200),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Date(value.periodEnd) <= new Date(value.periodStart)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['periodEnd'],
        message: 'Plan period end must be after its start.',
      });
    }
    if ((value.plannedBudgetAmount === null) !== (value.plannedBudgetCurrency === null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['plannedBudgetCurrency'],
        message: 'Plan budget amount and currency must be supplied together.',
      });
    }
  });

export const transitionMarketingActionPlanRequestSchema = z
  .object({
    action: z.enum(['ACTIVATE', 'COMPLETE', 'CANCEL']),
    expectedRevision: REVISION,
    comment: z.string().trim().min(3).max(1000),
  })
  .strict();

export const createMarketingActionItemRequestSchema = z
  .object({
    code: CODE,
    ordinal: z.number().int().nonnegative(),
    title: NAME,
    description: TEXT,
    responsibleRoleAssignmentId: UUID,
    linkedTaskId: UUID.nullable().default(null),
    linkedTaskVersion: z.number().int().positive().nullable().default(null),
    contributionType: marketingContributionTypeSchema,
    acceptanceCriteria: TEXT,
    dueAt: ISO_DATE_TIME,
    idempotencyKey: z.string().trim().min(8).max(200),
  })
  .strict()
  .refine((value) => (value.linkedTaskId === null) === (value.linkedTaskVersion === null), {
    path: ['linkedTaskVersion'],
    message: 'Linked Task id and version must be supplied together.',
  });

export const transitionMarketingActionItemRequestSchema = z
  .object({
    action: z.enum(['START', 'BLOCK', 'UNBLOCK', 'COMPLETE', 'CANCEL']),
    expectedRevision: REVISION,
    comment: z.string().trim().min(3).max(1000),
    acceptanceEvidenceId: UUID.nullable().default(null),
    acceptanceEvidenceVersion: z.number().int().positive().nullable().default(null),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.acceptanceEvidenceId === null) !== (value.acceptanceEvidenceVersion === null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['acceptanceEvidenceVersion'],
        message: 'Acceptance Evidence id and version must be supplied together.',
      });
    }
    if (value.action === 'COMPLETE' && value.acceptanceEvidenceId === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['acceptanceEvidenceId'],
        message: 'Completing an Action Item requires governed acceptance Evidence.',
      });
    }
    if (value.action !== 'COMPLETE' && value.acceptanceEvidenceId !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['acceptanceEvidenceId'],
        message: 'Acceptance Evidence is only valid for completion.',
      });
    }
  });

export const marketingActionItemContributorSchema = z.object({
  actionItemId: UUID,
  roleAssignmentId: UUID,
  contributionType: marketingContributionTypeSchema,
  createdAt: ISO_DATE_TIME,
});

export const createMarketingActionItemContributorRequestSchema = z
  .object({
    roleAssignmentId: UUID,
    contributionType: marketingContributionTypeSchema,
  })
  .strict();

export const marketingActionItemDependencySchema = z.object({
  id: UUID,
  planId: UUID,
  predecessorItemId: UUID,
  successorItemId: UUID,
  createdAt: ISO_DATE_TIME,
});

export const createMarketingActionItemDependencyRequestSchema = z
  .object({
    predecessorItemId: UUID,
    successorItemId: UUID,
    idempotencyKey: z.string().trim().min(8).max(200),
  })
  .strict()
  .refine((value) => value.predecessorItemId !== value.successorItemId, {
    path: ['successorItemId'],
    message: 'An Action Item cannot depend on itself.',
  });

export const marketingListResponseSchema = <T extends z.ZodTypeAny>(item: T) =>
  z.object({ items: z.array(item) });

export type MarketingObservationDimension = z.infer<typeof marketingObservationDimensionSchema>;
export type MarketingObservation = z.infer<typeof marketingObservationSchema>;
export type CreateMarketingObservationRequest = z.infer<
  typeof createMarketingObservationRequestSchema
>;
export type MarketingInsight = z.infer<typeof marketingInsightSchema>;
export type CreateMarketingInsightRequest = z.infer<typeof createMarketingInsightRequestSchema>;
export type TransitionMarketingInsightRequest = z.infer<
  typeof transitionMarketingInsightRequestSchema
>;
export type MarketingMasterData = z.infer<typeof marketingMasterDataSchema>;
export type CreateMarketingMasterDataRequest = z.infer<
  typeof createMarketingMasterDataRequestSchema
>;
export type UpdateMarketingMasterDataRequest = z.infer<
  typeof updateMarketingMasterDataRequestSchema
>;
export type MarketingTarget = z.infer<typeof marketingTargetSchema>;
export type CreateMarketingTargetRequest = z.infer<typeof createMarketingTargetRequestSchema>;
export type TransitionMarketingTargetRequest = z.infer<
  typeof transitionMarketingTargetRequestSchema
>;
export type MarketingActionItem = z.infer<typeof marketingActionItemSchema>;
export type MarketingActionPlan = z.infer<typeof marketingActionPlanSchema>;
export type CreateMarketingActionPlanRequest = z.infer<
  typeof createMarketingActionPlanRequestSchema
>;
export type TransitionMarketingActionPlanRequest = z.infer<
  typeof transitionMarketingActionPlanRequestSchema
>;
export type CreateMarketingActionItemRequest = z.infer<
  typeof createMarketingActionItemRequestSchema
>;
export type TransitionMarketingActionItemRequest = z.infer<
  typeof transitionMarketingActionItemRequestSchema
>;
export type MarketingActionItemContributor = z.infer<typeof marketingActionItemContributorSchema>;
export type CreateMarketingActionItemContributorRequest = z.infer<
  typeof createMarketingActionItemContributorRequestSchema
>;
export type MarketingActionItemDependency = z.infer<typeof marketingActionItemDependencySchema>;
export type CreateMarketingActionItemDependencyRequest = z.infer<
  typeof createMarketingActionItemDependencyRequestSchema
>;
