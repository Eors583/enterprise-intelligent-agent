import { z } from 'zod';

const UUID = z.uuid();
const TIMESTAMP = z.iso.datetime();
const POSITIVE_INT = z.number().int().positive();
const REVISION = POSITIVE_INT;
const HASH = z.string().regex(/^[a-f0-9]{64}$/);
const DECIMAL = z
  .string()
  .regex(/^-?(?:0|[1-9]\d*)(?:\.\d{1,12})?$/, 'Expected an exact decimal string.');
const NON_NEGATIVE_DECIMAL = DECIMAL.refine((value) => Number(value) >= 0, {
  message: 'Amount must be non-negative.',
});
const POSITIVE_DECIMAL = DECIMAL.refine((value) => Number(value) > 0, {
  message: 'Amount must be greater than zero.',
});
const CURRENCY = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/);
const IDEMPOTENCY_KEY = z.string().trim().min(8).max(200);
const SHORT_TEXT = z.string().trim().min(1).max(500);
const LONG_TEXT = z.string().trim().min(1).max(10_000);
const SOURCE_VERSION = z.string().trim().min(1).max(200);

export const finopsResourceKindSchema = z.enum([
  'MODEL',
  'EMBEDDING',
  'RERANK',
  'TOOL',
  'API',
  'STORAGE',
  'HUMAN_REVIEW',
]);

export const finopsBillingUnitSchema = z.enum([
  'INPUT_TOKEN',
  'OUTPUT_TOKEN',
  'TOKEN',
  'REQUEST',
  'CALL',
  'SECOND',
  'MINUTE',
  'HOUR',
  'BYTE_MONTH',
  'GB_MONTH',
  'DOCUMENT',
]);

export const finopsApprovalStatusSchema = z.enum(['DRAFT', 'APPROVED', 'REJECTED', 'RETIRED']);
export const finopsCostSubjectTypeSchema = z.enum([
  'AGENT_RUN',
  'TOOL_INVOCATION',
  'KNOWLEDGE_OPERATION',
  'HUMAN_TIME',
  'API',
  'STORAGE',
]);
export const finopsVerificationStatusSchema = z.enum([
  'PENDING',
  'VERIFIED',
  'DISPUTED',
  'REJECTED',
]);
export const finopsCostVerificationBasisSchema = z.enum([
  'TRUSTED_EVIDENCE',
  'TRUSTED_SOURCE',
  'REVIEWER_JUDGMENT',
]);
export const finopsSourceAuthoritySchema = z.enum([
  'RUNTIME_ATTESTED',
  'PROVIDER_BILL',
  'TRUSTED_SYSTEM',
  'HUMAN_ATTESTED',
]);
export const finopsAllocationMethodSchema = z.enum([
  'DIRECT',
  'PROPORTIONAL_USAGE',
  'PROPORTIONAL_TIME',
  'WEIGHTED',
]);
export const finopsProposalOriginSchema = z.enum(['HUMAN', 'AI', 'TRUSTED_SYSTEM']);
export const finopsReviewStatusSchema = z.enum([
  'CANDIDATE',
  'PENDING_REVIEW',
  'CONFIRMED',
  'REJECTED',
]);
export const finopsBenefitOriginSchema = z.enum(['HUMAN', 'AI', 'TRUSTED_SYSTEM']);
export const finopsRoiCalculationStatusSchema = z.enum(['COMPUTED', 'INVALID_ZERO_COST']);
export const finopsBudgetStatusSchema = z.enum(['DRAFT', 'ACTIVE', 'REJECTED', 'CLOSED']);
export const finopsBudgetScopeTypeSchema = z.enum([
  'TENANT',
  'EMPLOYEE',
  'ROLE_ASSIGNMENT',
  'TASK',
  'PROCESS',
  'CUSTOMER',
  'PROJECT',
  'DEPARTMENT',
]);
export const finopsBudgetEventTypeSchema = z.enum([
  'RESERVATION',
  'SETTLEMENT',
  'RELEASE',
  'ADJUSTMENT',
]);
export const finopsBudgetAlertTypeSchema = z.enum([
  'THRESHOLD_REACHED',
  'HARD_LIMIT_EXCEEDED',
  'SETTLEMENT_MISMATCH',
  'UNVERIFIED_COST',
]);
export const finopsAlertStatusSchema = z.enum(['OPEN', 'ACKNOWLEDGED', 'RESOLVED']);
export const finopsRoutingSuggestionStatusSchema = z.enum([
  'PROPOSED',
  'ACCEPTED_FOR_REVIEW',
  'REJECTED',
]);

export const finopsSourceReferenceSchema = z
  .object({
    authority: finopsSourceAuthoritySchema,
    system: z.string().trim().min(1).max(100),
    recordId: z.string().trim().min(1).max(500),
    recordVersion: SOURCE_VERSION,
    contentHash: HASH,
    evidenceId: UUID.nullable().default(null),
    evidenceVersion: POSITIVE_INT.nullable().default(null),
  })
  .strict()
  .refine(
    (value) => (value.evidenceId === null) === (value.evidenceVersion === null),
    'Evidence id and version must be supplied together.',
  );

export const finopsPriceSnapshotSchema = z
  .object({
    id: UUID,
    tenantId: UUID,
    code: z.string().trim().min(3).max(100),
    version: POSITIVE_INT,
    revision: REVISION,
    resourceKind: finopsResourceKindSchema,
    provider: z.string().trim().min(1).max(100),
    sku: z.string().trim().min(1).max(200),
    currency: CURRENCY,
    billingUnit: finopsBillingUnitSchema,
    unitSize: POSITIVE_DECIMAL,
    unitPrice: NON_NEGATIVE_DECIMAL,
    effectiveFrom: TIMESTAMP,
    effectiveTo: TIMESTAMP.nullable(),
    status: finopsApprovalStatusSchema,
    source: finopsSourceReferenceSchema,
    createdByUserId: UUID,
    approvedByUserId: UUID.nullable(),
    approvedAt: TIMESTAMP.nullable(),
    createdAt: TIMESTAMP,
  })
  .strict()
  .refine(
    (value) => value.effectiveTo === null || value.effectiveTo > value.effectiveFrom,
    'Price effectiveTo must be later than effectiveFrom.',
  )
  .refine(
    (value) =>
      value.status !== 'APPROVED' ||
      (value.approvedByUserId !== null &&
        value.approvedByUserId !== value.createdByUserId &&
        value.approvedAt !== null),
    'Approved pricing requires an independent checker.',
  );

export const createFinopsPriceSnapshotRequestSchema = z
  .object({
    code: z.string().trim().toUpperCase().min(3).max(100),
    resourceKind: finopsResourceKindSchema,
    provider: z.string().trim().min(1).max(100),
    sku: z.string().trim().min(1).max(200),
    currency: CURRENCY,
    billingUnit: finopsBillingUnitSchema,
    unitSize: POSITIVE_DECIMAL,
    unitPrice: NON_NEGATIVE_DECIMAL,
    effectiveFrom: TIMESTAMP,
    effectiveTo: TIMESTAMP.nullable().default(null),
    source: finopsSourceReferenceSchema,
    idempotencyKey: IDEMPOTENCY_KEY,
  })
  .strict()
  .refine(
    (value) => value.effectiveTo === null || value.effectiveTo > value.effectiveFrom,
    'Price effectiveTo must be later than effectiveFrom.',
  );

export const approveFinopsPriceSnapshotRequestSchema = z
  .object({
    expectedRevision: REVISION,
    decision: z.enum(['APPROVE', 'REJECT']),
    comment: SHORT_TEXT,
    idempotencyKey: IDEMPOTENCY_KEY,
  })
  .strict();

export const finopsCostVerificationReviewSchema = z
  .object({
    id: UUID,
    tenantId: UUID,
    costEntryId: UUID,
    revision: REVISION,
    decision: finopsVerificationStatusSchema.exclude(['PENDING']),
    basis: finopsCostVerificationBasisSchema,
    reviewerUserId: UUID,
    evidenceId: UUID.nullable(),
    evidenceVersion: POSITIVE_INT.nullable(),
    evidenceContentHash: HASH.nullable(),
    comment: z.string().trim().min(1).max(1000),
    createdAt: TIMESTAMP,
  })
  .strict()
  .refine(
    (value) =>
      (value.evidenceId === null) === (value.evidenceVersion === null) &&
      (value.evidenceId === null) === (value.evidenceContentHash === null),
    'Review Evidence identity, version, and immutable hash must be supplied together.',
  );

export const reviewFinopsCostRequestSchema = z
  .object({
    decision: finopsVerificationStatusSchema.exclude(['PENDING']),
    basis: finopsCostVerificationBasisSchema,
    evidenceId: UUID.nullable().default(null),
    evidenceVersion: POSITIVE_INT.nullable().default(null),
    comment: z.string().trim().min(1).max(1000),
    idempotencyKey: IDEMPOTENCY_KEY,
  })
  .strict()
  .refine(
    (value) => (value.evidenceId === null) === (value.evidenceVersion === null),
    'Review Evidence id and version must be supplied together.',
  )
  .refine((value) => {
    if (value.basis === 'TRUSTED_EVIDENCE') {
      return value.evidenceId !== null;
    }
    if (value.basis === 'TRUSTED_SOURCE') {
      return (
        value.decision === 'VERIFIED' && value.evidenceId === null && value.evidenceVersion === null
      );
    }
    return (
      value.decision !== 'VERIFIED' && value.evidenceId === null && value.evidenceVersion === null
    );
  }, 'Verification requires trusted Evidence or an immutable trusted source; reviewer judgment cannot verify cost.');

export const finopsCostEntrySchema = z
  .object({
    id: UUID,
    tenantId: UUID,
    subjectType: finopsCostSubjectTypeSchema,
    subjectId: z.string().trim().min(1).max(500),
    agentRunId: UUID.nullable(),
    toolInvocationId: UUID.nullable(),
    knowledgeDocumentVersionId: UUID.nullable(),
    humanUserId: UUID.nullable(),
    priceSnapshotId: UUID,
    priceSnapshotVersion: POSITIVE_INT,
    resourceKind: finopsResourceKindSchema,
    quantity: POSITIVE_DECIMAL,
    rawUsage: z.record(z.string(), z.unknown()),
    formulaCode: z.string().trim().min(1).max(100),
    formulaVersion: POSITIVE_INT,
    formulaExpression: z.string().trim().min(1).max(500),
    currency: CURRENCY,
    calculatedAmount: NON_NEGATIVE_DECIMAL,
    verificationStatus: finopsVerificationStatusSchema,
    originalVerificationStatus: finopsVerificationStatusSchema,
    effectiveVerificationStatus: finopsVerificationStatusSchema,
    latestVerificationReview: finopsCostVerificationReviewSchema.nullable(),
    source: finopsSourceReferenceSchema,
    incurredAt: TIMESTAMP,
    recordedByUserId: UUID,
    createdAt: TIMESTAMP,
  })
  .strict()
  .refine(
    (value) => value.verificationStatus === value.originalVerificationStatus,
    'The compatibility verification status must equal the immutable original status.',
  )
  .refine(
    (value) =>
      value.latestVerificationReview === null ||
      value.latestVerificationReview.costEntryId === value.id,
    'The latest verification review must belong to the returned Cost Entry.',
  );

export const recordFinopsCostRequestSchema = z
  .object({
    subjectType: finopsCostSubjectTypeSchema,
    subjectId: z.string().trim().min(1).max(500),
    agentRunId: UUID.nullable().default(null),
    toolInvocationId: UUID.nullable().default(null),
    knowledgeDocumentVersionId: UUID.nullable().default(null),
    humanUserId: UUID.nullable().default(null),
    priceSnapshotId: UUID,
    quantity: POSITIVE_DECIMAL,
    rawUsage: z.record(z.string(), z.unknown()),
    formulaCode: z.string().trim().toUpperCase().min(1).max(100),
    formulaVersion: POSITIVE_INT,
    formulaExpression: z.literal('(quantity / unitSize) * unitPrice'),
    verificationStatus: z.literal('PENDING').default('PENDING'),
    source: finopsSourceReferenceSchema,
    incurredAt: TIMESTAMP,
    idempotencyKey: IDEMPOTENCY_KEY,
  })
  .strict()
  .refine((value) => {
    const references = [
      value.agentRunId,
      value.toolInvocationId,
      value.knowledgeDocumentVersionId,
      value.humanUserId,
    ].filter((item) => item !== null);
    if (value.subjectType === 'API' || value.subjectType === 'STORAGE') {
      return references.length === 0;
    }
    if (references.length !== 1) return false;
    return (
      (value.subjectType === 'AGENT_RUN' && value.agentRunId !== null) ||
      (value.subjectType === 'TOOL_INVOCATION' && value.toolInvocationId !== null) ||
      (value.subjectType === 'KNOWLEDGE_OPERATION' && value.knowledgeDocumentVersionId !== null) ||
      (value.subjectType === 'HUMAN_TIME' && value.humanUserId !== null)
    );
  }, 'Cost subjects must carry exactly their governed tenant-scoped reference.')
  .refine((value) => {
    const reference =
      value.agentRunId ??
      value.toolInvocationId ??
      value.knowledgeDocumentVersionId ??
      value.humanUserId;
    return reference === null || value.subjectId === reference;
  }, 'Cost subject identity must equal its governed tenant-scoped reference.')
  .refine(
    (value) => value.source.authority === 'HUMAN_ATTESTED',
    'Administrative cost recording always creates human-attested pending ledger input; trusted runtime and provider sources must use a controlled projector.',
  );

export const finopsDimensionMemberSchema = z
  .object({
    id: UUID,
    tenantId: UUID,
    dimension: z.enum(['CUSTOMER', 'PROJECT']),
    code: z.string().trim().min(1).max(100),
    name: z.string().trim().min(1).max(200),
    sourceSystem: z.string().trim().min(1).max(100),
    sourceRecordId: z.string().trim().min(1).max(500),
    sourceRecordVersion: SOURCE_VERSION,
    createdAt: TIMESTAMP,
  })
  .strict();

export const finopsAllocationRuleSchema = z
  .object({
    id: UUID,
    tenantId: UUID,
    code: z.string().trim().min(1).max(100),
    version: POSITIVE_INT,
    revision: REVISION,
    method: finopsAllocationMethodSchema,
    dimensions: z
      .array(finopsBudgetScopeTypeSchema.exclude(['TENANT']))
      .min(1)
      .max(7),
    ruleDefinition: z.record(z.string(), z.unknown()),
    status: finopsApprovalStatusSchema,
    createdByUserId: UUID,
    approvedByUserId: UUID.nullable(),
    createdAt: TIMESTAMP,
  })
  .strict();

export const createFinopsAllocationRuleRequestSchema = z
  .object({
    code: z.string().trim().toUpperCase().min(3).max(100),
    method: finopsAllocationMethodSchema,
    dimensions: z
      .array(finopsBudgetScopeTypeSchema.exclude(['TENANT']))
      .min(1)
      .max(7)
      .refine((items) => new Set(items).size === items.length, {
        message: 'Allocation dimensions must be unique.',
      }),
    ruleDefinition: z.record(z.string(), z.unknown()),
    idempotencyKey: IDEMPOTENCY_KEY,
  })
  .strict();

export const approveFinopsAllocationRuleRequestSchema = approveFinopsPriceSnapshotRequestSchema;

export const createFinopsDimensionMemberRequestSchema = z
  .object({
    dimension: z.enum(['CUSTOMER', 'PROJECT']),
    code: z.string().trim().toUpperCase().min(1).max(100),
    name: z.string().trim().min(1).max(200),
    sourceSystem: z.string().trim().min(1).max(100),
    sourceRecordId: z.string().trim().min(1).max(500),
    sourceRecordVersion: SOURCE_VERSION,
    sourceContentHash: HASH,
    idempotencyKey: IDEMPOTENCY_KEY,
  })
  .strict();

export const finopsAllocationLineInputSchema = z
  .object({
    employeeUserId: UUID.nullable().default(null),
    roleAssignmentId: UUID.nullable().default(null),
    taskId: UUID.nullable().default(null),
    taskVersion: POSITIVE_INT.nullable().default(null),
    processDefinitionId: UUID.nullable().default(null),
    processVersionId: UUID.nullable().default(null),
    processVersion: POSITIVE_INT.nullable().default(null),
    customerId: UUID.nullable().default(null),
    projectId: UUID.nullable().default(null),
    departmentOrgUnitId: UUID.nullable().default(null),
    weight: POSITIVE_DECIMAL,
    allocatedAmount: NON_NEGATIVE_DECIMAL,
    rationale: SHORT_TEXT,
  })
  .strict()
  .refine((value) => (value.taskId === null) === (value.taskVersion === null), {
    message: 'Task id and version must be supplied together.',
    path: ['taskVersion'],
  })
  .refine(
    (value) =>
      (value.processDefinitionId === null &&
        value.processVersionId === null &&
        value.processVersion === null) ||
      (value.processDefinitionId !== null &&
        value.processVersionId !== null &&
        value.processVersion !== null),
    {
      message: 'Process definition, version id, and version number must be supplied together.',
      path: ['processVersionId'],
    },
  )
  .refine(
    (value) =>
      [
        value.employeeUserId,
        value.roleAssignmentId,
        value.taskId,
        value.processDefinitionId,
        value.customerId,
        value.projectId,
        value.departmentOrgUnitId,
      ].some((item) => item !== null),
    'Every allocation line must select at least one governed dimension.',
  );

export const finopsAllocationLineSchema = finopsAllocationLineInputSchema.extend({
  id: UUID,
  tenantId: UUID,
  allocationSetId: UUID,
  createdAt: TIMESTAMP,
});

export const finopsAllocationSetSchema = z
  .object({
    id: UUID,
    tenantId: UUID,
    costEntryId: UUID,
    ruleId: UUID,
    ruleVersion: POSITIVE_INT,
    origin: finopsProposalOriginSchema,
    status: finopsReviewStatusSchema,
    revision: REVISION,
    proposedByUserId: UUID,
    proposedByAgentRunId: UUID.nullable(),
    confirmedByUserId: UUID.nullable(),
    confirmedAt: TIMESTAMP.nullable(),
    lines: z.array(finopsAllocationLineSchema).min(1),
    createdAt: TIMESTAMP,
  })
  .strict();

export const createFinopsAllocationSetRequestSchema = z
  .object({
    costEntryId: UUID,
    ruleId: UUID,
    origin: finopsProposalOriginSchema,
    proposedByAgentRunId: UUID.nullable().default(null),
    lines: z.array(finopsAllocationLineInputSchema).min(1).max(100),
    idempotencyKey: IDEMPOTENCY_KEY,
  })
  .strict()
  .refine(
    (value) => (value.origin === 'AI') === (value.proposedByAgentRunId !== null),
    'AI allocation candidates must reference the producing Agent Run.',
  );

export const reviewFinopsAllocationSetRequestSchema = z
  .object({
    expectedRevision: REVISION,
    decision: z.enum(['CONFIRM', 'REJECT']),
    comment: SHORT_TEXT,
    idempotencyKey: IDEMPOTENCY_KEY,
  })
  .strict();

export const finopsBenefitClaimSchema = z
  .object({
    id: UUID,
    tenantId: UUID,
    code: z.string().trim().min(1).max(100),
    version: POSITIVE_INT,
    revision: REVISION,
    origin: finopsBenefitOriginSchema,
    status: finopsReviewStatusSchema,
    currency: CURRENCY,
    amount: POSITIVE_DECIMAL,
    periodStart: TIMESTAMP,
    periodEnd: TIMESTAMP,
    deliverableId: UUID,
    deliverableVersion: POSITIVE_INT,
    acceptanceId: UUID,
    acceptanceVersion: POSITIVE_INT,
    evidenceId: UUID,
    evidenceVersion: POSITIVE_INT,
    valueDefinitionId: UUID,
    valueVersionId: UUID,
    valueVersion: POSITIVE_INT,
    objectiveId: UUID,
    objectiveVersion: POSITIVE_INT,
    source: finopsSourceReferenceSchema,
    agentRunId: UUID.nullable(),
    createdByUserId: UUID,
    confirmationAuthority: z.enum(['HUMAN', 'TRUSTED_SYSTEM']).nullable(),
    confirmedByUserId: UUID.nullable(),
    confirmedAt: TIMESTAMP.nullable(),
    createdAt: TIMESTAMP,
  })
  .strict()
  .refine((value) => value.periodEnd > value.periodStart, 'Benefit period must be non-empty.')
  .refine(
    (value) => value.origin !== 'AI' || value.status === 'CANDIDATE',
    'AI output can only be a benefit candidate.',
  );

export const createFinopsBenefitClaimRequestSchema = z
  .object({
    code: z.string().trim().toUpperCase().min(3).max(100),
    origin: finopsBenefitOriginSchema,
    currency: CURRENCY,
    amount: POSITIVE_DECIMAL,
    periodStart: TIMESTAMP,
    periodEnd: TIMESTAMP,
    deliverableId: UUID,
    deliverableVersion: POSITIVE_INT,
    acceptanceId: UUID,
    acceptanceVersion: POSITIVE_INT,
    evidenceId: UUID,
    evidenceVersion: POSITIVE_INT,
    valueDefinitionId: UUID,
    valueVersionId: UUID,
    valueVersion: POSITIVE_INT,
    objectiveId: UUID,
    objectiveVersion: POSITIVE_INT,
    source: finopsSourceReferenceSchema,
    agentRunId: UUID.nullable().default(null),
    idempotencyKey: IDEMPOTENCY_KEY,
  })
  .strict()
  .refine((value) => value.periodEnd > value.periodStart, 'Benefit period must be non-empty.')
  .refine(
    (value) => (value.origin === 'AI') === (value.agentRunId !== null),
    'AI benefit candidates must reference the producing Agent Run.',
  );

export const reviewFinopsBenefitClaimRequestSchema = z
  .object({
    expectedRevision: REVISION,
    decision: z.enum(['CONFIRM', 'REJECT']),
    comment: SHORT_TEXT,
    trustedImportReceipt: z
      .object({
        system: z.string().trim().min(1).max(100),
        receiptId: z.string().trim().min(1).max(500),
        contentHash: HASH,
      })
      .strict()
      .nullable()
      .default(null),
    idempotencyKey: IDEMPOTENCY_KEY,
  })
  .strict();

export const finopsRoiFormulaVersionSchema = z
  .object({
    id: UUID,
    tenantId: UUID,
    code: z.string().trim().min(1).max(100),
    version: POSITIVE_INT,
    revision: REVISION,
    expression: z.literal('(confirmedBenefit - verifiedCost) / verifiedCost'),
    status: finopsApprovalStatusSchema,
    createdByUserId: UUID,
    approvedByUserId: UUID.nullable(),
    createdAt: TIMESTAMP,
  })
  .strict();

export const createFinopsRoiFormulaVersionRequestSchema = z
  .object({
    code: z.string().trim().toUpperCase().min(3).max(100),
    expression: z.literal('(confirmedBenefit - verifiedCost) / verifiedCost'),
    idempotencyKey: IDEMPOTENCY_KEY,
  })
  .strict();

export const approveFinopsRoiFormulaVersionRequestSchema = approveFinopsPriceSnapshotRequestSchema;

export const finopsRoiSnapshotSchema = z
  .object({
    id: UUID,
    tenantId: UUID,
    formulaId: UUID,
    formulaVersion: POSITIVE_INT,
    currency: CURRENCY,
    periodStart: TIMESTAMP,
    periodEnd: TIMESTAMP,
    verifiedCost: NON_NEGATIVE_DECIMAL,
    confirmedBenefit: NON_NEGATIVE_DECIMAL,
    netBenefit: DECIMAL,
    roiRatio: DECIMAL.nullable(),
    status: finopsRoiCalculationStatusSchema,
    inputsHash: HASH,
    recalculationOfId: UUID.nullable(),
    calculatedByUserId: UUID,
    createdAt: TIMESTAMP,
  })
  .strict()
  .refine(
    (value) =>
      (Number(value.verifiedCost) === 0 &&
        value.status === 'INVALID_ZERO_COST' &&
        value.roiRatio === null) ||
      (Number(value.verifiedCost) > 0 && value.status === 'COMPUTED' && value.roiRatio !== null),
    'ROI must reject a zero denominator.',
  );

export const recomputeFinopsRoiRequestSchema = z
  .object({
    formulaId: UUID,
    currency: CURRENCY,
    periodStart: TIMESTAMP,
    periodEnd: TIMESTAMP,
    recalculationOfId: UUID.nullable().default(null),
    idempotencyKey: IDEMPOTENCY_KEY,
  })
  .strict()
  .refine((value) => value.periodEnd > value.periodStart, 'ROI period must be non-empty.');

export const finopsBudgetSchema = z
  .object({
    id: UUID,
    tenantId: UUID,
    code: z.string().trim().min(1).max(100),
    version: POSITIVE_INT,
    revision: REVISION,
    scopeType: finopsBudgetScopeTypeSchema,
    scopeId: z.string().trim().min(1).max(500),
    scopeVersion: POSITIVE_INT.nullable(),
    currency: CURRENCY,
    limitAmount: POSITIVE_DECIMAL,
    alertThresholdRatio: POSITIVE_DECIMAL,
    periodStart: TIMESTAMP,
    periodEnd: TIMESTAMP,
    status: finopsBudgetStatusSchema,
    reservedAmount: NON_NEGATIVE_DECIMAL,
    settledAmount: NON_NEGATIVE_DECIMAL,
    availableAmount: DECIMAL,
    createdByUserId: UUID,
    approvedByUserId: UUID.nullable(),
    createdAt: TIMESTAMP,
  })
  .strict();

export const createFinopsBudgetRequestSchema = z
  .object({
    code: z.string().trim().toUpperCase().min(3).max(100),
    scopeType: finopsBudgetScopeTypeSchema,
    scopeId: z.string().trim().min(1).max(500),
    scopeVersion: POSITIVE_INT.nullable().default(null),
    currency: CURRENCY,
    limitAmount: POSITIVE_DECIMAL,
    alertThresholdRatio: POSITIVE_DECIMAL.refine((value) => Number(value) <= 1, {
      message: 'Alert threshold ratio cannot exceed 1.',
    }),
    periodStart: TIMESTAMP,
    periodEnd: TIMESTAMP,
    idempotencyKey: IDEMPOTENCY_KEY,
  })
  .strict()
  .refine((value) => value.periodEnd > value.periodStart, 'Budget period must be non-empty.')
  .refine(
    (value) => (value.scopeType === 'TASK') === (value.scopeVersion !== null),
    'Task budgets must pin the exact Task version.',
  );

export const approveFinopsBudgetRequestSchema = z
  .object({
    expectedRevision: REVISION,
    decision: z.enum(['APPROVE', 'REJECT']),
    comment: SHORT_TEXT,
    idempotencyKey: IDEMPOTENCY_KEY,
  })
  .strict();

export const createFinopsBudgetEventRequestSchema = z
  .object({
    type: finopsBudgetEventTypeSchema,
    amount: POSITIVE_DECIMAL,
    reservationEventId: UUID.nullable().default(null),
    costEntryId: UUID.nullable().default(null),
    reason: SHORT_TEXT,
    idempotencyKey: IDEMPOTENCY_KEY,
  })
  .strict()
  .refine(
    (value) =>
      (value.type !== 'SETTLEMENT' && value.type !== 'RELEASE') ||
      value.reservationEventId !== null,
    'Settlement and release events must reference a reservation.',
  )
  .refine(
    (value) => value.type !== 'SETTLEMENT' || value.costEntryId !== null,
    'Settlement events must reference the settled cost entry.',
  );

export const finopsBudgetEventSchema = z
  .object({
    id: UUID,
    tenantId: UUID,
    budgetId: UUID,
    budgetVersion: POSITIVE_INT,
    type: finopsBudgetEventTypeSchema,
    currency: CURRENCY,
    amount: POSITIVE_DECIMAL,
    reservationEventId: UUID.nullable(),
    costEntryId: UUID.nullable(),
    reason: SHORT_TEXT,
    createdByUserId: UUID,
    createdAt: TIMESTAMP,
  })
  .strict();

export const finopsBudgetAlertSchema = z
  .object({
    id: UUID,
    tenantId: UUID,
    budgetId: UUID,
    budgetVersion: POSITIVE_INT,
    type: finopsBudgetAlertTypeSchema,
    status: finopsAlertStatusSchema,
    observedAmount: NON_NEGATIVE_DECIMAL,
    thresholdAmount: NON_NEGATIVE_DECIMAL,
    revision: REVISION,
    message: LONG_TEXT,
    createdAt: TIMESTAMP,
  })
  .strict();

export const acknowledgeFinopsAlertRequestSchema = z
  .object({
    expectedRevision: REVISION,
    comment: SHORT_TEXT,
    idempotencyKey: IDEMPOTENCY_KEY,
  })
  .strict();

export const finopsRoutingSuggestionSchema = z
  .object({
    id: UUID,
    tenantId: UUID,
    agentRunId: UUID.nullable(),
    currentRoute: z.string().trim().min(1).max(300),
    suggestedRoute: z.string().trim().min(1).max(300),
    currency: CURRENCY,
    estimatedSavings: NON_NEGATIVE_DECIMAL,
    qualityFloor: z.number().finite().min(0).max(1),
    policyBoundary: z.record(z.string(), z.unknown()),
    rationale: LONG_TEXT,
    status: finopsRoutingSuggestionStatusSchema,
    autoApplied: z.literal(false),
    revision: REVISION,
    createdAt: TIMESTAMP,
  })
  .strict();

export const finopsProjectionDiagnosticSchema = z
  .object({
    id: UUID,
    tenantId: UUID,
    sourceKind: z.enum(['AGENT_RUN', 'TOOL_RECEIPT']),
    sourceId: UUID,
    sourceVersion: SOURCE_VERSION,
    code: z.string().trim().min(1).max(100),
    detail: LONG_TEXT,
    metadata: z.record(z.string(), z.unknown()),
    status: finopsAlertStatusSchema,
    openedAt: TIMESTAMP,
    resolvedAt: TIMESTAMP.nullable(),
  })
  .strict()
  .refine(
    (value) =>
      (value.status !== 'RESOLVED' && value.resolvedAt === null) ||
      (value.status === 'RESOLVED' && value.resolvedAt !== null),
    'Projection diagnostic status and resolvedAt must agree.',
  );

export const createFinopsRoutingSuggestionRequestSchema = z
  .object({
    agentRunId: UUID.nullable().default(null),
    currentRoute: z.string().trim().min(1).max(300),
    suggestedRoute: z.string().trim().min(1).max(300),
    currency: CURRENCY,
    estimatedSavings: NON_NEGATIVE_DECIMAL,
    qualityFloor: z.number().finite().min(0).max(1),
    policyBoundary: z.record(z.string(), z.unknown()),
    rationale: LONG_TEXT,
    idempotencyKey: IDEMPOTENCY_KEY,
  })
  .strict()
  .refine(
    (value) => value.currentRoute !== value.suggestedRoute,
    'Suggested route must differ from the current route.',
  );

export const decideFinopsRoutingSuggestionRequestSchema = z
  .object({
    expectedRevision: REVISION,
    decision: z.enum(['ACCEPT_FOR_REVIEW', 'REJECT']),
    comment: SHORT_TEXT,
    idempotencyKey: IDEMPOTENCY_KEY,
  })
  .strict();

export const finopsDashboardSchema = z
  .object({
    generatedAt: TIMESTAMP,
    currency: CURRENCY,
    totals: z
      .object({
        verifiedCost: NON_NEGATIVE_DECIMAL,
        pendingCost: NON_NEGATIVE_DECIMAL,
        confirmedBenefit: NON_NEGATIVE_DECIMAL,
        activeBudgetLimit: NON_NEGATIVE_DECIMAL,
        activeBudgetReserved: NON_NEGATIVE_DECIMAL,
        activeBudgetSettled: NON_NEGATIVE_DECIMAL,
        openAlerts: z.number().int().nonnegative(),
        openProjectionDiagnostics: z.number().int().nonnegative(),
      })
      .strict(),
    priceSnapshots: z.array(finopsPriceSnapshotSchema),
    allocationRules: z.array(finopsAllocationRuleSchema),
    dimensionMembers: z.array(finopsDimensionMemberSchema),
    roiFormulas: z.array(finopsRoiFormulaVersionSchema),
    costEntries: z.array(finopsCostEntrySchema),
    allocationSets: z.array(finopsAllocationSetSchema),
    benefitClaims: z.array(finopsBenefitClaimSchema),
    roiSnapshots: z.array(finopsRoiSnapshotSchema),
    budgets: z.array(finopsBudgetSchema),
    alerts: z.array(finopsBudgetAlertSchema),
    projectionDiagnostics: z.array(finopsProjectionDiagnosticSchema),
    routingSuggestions: z.array(finopsRoutingSuggestionSchema),
  })
  .strict();

export const finopsDashboardQuerySchema = z
  .object({
    currency: CURRENCY.default('CNY'),
  })
  .strict();

export const finopsListResponseSchema = <T extends z.ZodType>(itemSchema: T) =>
  z
    .object({
      items: z.array(itemSchema),
    })
    .strict();

export type FinopsResourceKind = z.infer<typeof finopsResourceKindSchema>;
export type FinopsBillingUnit = z.infer<typeof finopsBillingUnitSchema>;
export type FinopsSourceReference = z.infer<typeof finopsSourceReferenceSchema>;
export type FinopsPriceSnapshot = z.infer<typeof finopsPriceSnapshotSchema>;
export type CreateFinopsPriceSnapshotRequest = z.infer<
  typeof createFinopsPriceSnapshotRequestSchema
>;
export type ApproveFinopsPriceSnapshotRequest = z.infer<
  typeof approveFinopsPriceSnapshotRequestSchema
>;
export type FinopsCostEntry = z.infer<typeof finopsCostEntrySchema>;
export type RecordFinopsCostRequest = z.infer<typeof recordFinopsCostRequestSchema>;
export type FinopsCostVerificationReview = z.infer<typeof finopsCostVerificationReviewSchema>;
export type ReviewFinopsCostRequest = z.infer<typeof reviewFinopsCostRequestSchema>;
export type FinopsAllocationRule = z.infer<typeof finopsAllocationRuleSchema>;
export type FinopsDimensionMember = z.infer<typeof finopsDimensionMemberSchema>;
export type CreateFinopsAllocationRuleRequest = z.infer<
  typeof createFinopsAllocationRuleRequestSchema
>;
export type ApproveFinopsAllocationRuleRequest = z.infer<
  typeof approveFinopsAllocationRuleRequestSchema
>;
export type CreateFinopsDimensionMemberRequest = z.infer<
  typeof createFinopsDimensionMemberRequestSchema
>;
export type FinopsAllocationLineInput = z.infer<typeof finopsAllocationLineInputSchema>;
export type FinopsAllocationLine = z.infer<typeof finopsAllocationLineSchema>;
export type FinopsAllocationSet = z.infer<typeof finopsAllocationSetSchema>;
export type CreateFinopsAllocationSetRequest = z.infer<
  typeof createFinopsAllocationSetRequestSchema
>;
export type ReviewFinopsAllocationSetRequest = z.infer<
  typeof reviewFinopsAllocationSetRequestSchema
>;
export type FinopsBenefitClaim = z.infer<typeof finopsBenefitClaimSchema>;
export type CreateFinopsBenefitClaimRequest = z.infer<typeof createFinopsBenefitClaimRequestSchema>;
export type ReviewFinopsBenefitClaimRequest = z.infer<typeof reviewFinopsBenefitClaimRequestSchema>;
export type FinopsRoiFormulaVersion = z.infer<typeof finopsRoiFormulaVersionSchema>;
export type CreateFinopsRoiFormulaVersionRequest = z.infer<
  typeof createFinopsRoiFormulaVersionRequestSchema
>;
export type ApproveFinopsRoiFormulaVersionRequest = z.infer<
  typeof approveFinopsRoiFormulaVersionRequestSchema
>;
export type FinopsRoiSnapshot = z.infer<typeof finopsRoiSnapshotSchema>;
export type RecomputeFinopsRoiRequest = z.infer<typeof recomputeFinopsRoiRequestSchema>;
export type FinopsBudget = z.infer<typeof finopsBudgetSchema>;
export type CreateFinopsBudgetRequest = z.infer<typeof createFinopsBudgetRequestSchema>;
export type ApproveFinopsBudgetRequest = z.infer<typeof approveFinopsBudgetRequestSchema>;
export type CreateFinopsBudgetEventRequest = z.infer<typeof createFinopsBudgetEventRequestSchema>;
export type FinopsBudgetEvent = z.infer<typeof finopsBudgetEventSchema>;
export type FinopsBudgetAlert = z.infer<typeof finopsBudgetAlertSchema>;
export type AcknowledgeFinopsAlertRequest = z.infer<typeof acknowledgeFinopsAlertRequestSchema>;
export type FinopsRoutingSuggestion = z.infer<typeof finopsRoutingSuggestionSchema>;
export type FinopsProjectionDiagnostic = z.infer<typeof finopsProjectionDiagnosticSchema>;
export type CreateFinopsRoutingSuggestionRequest = z.infer<
  typeof createFinopsRoutingSuggestionRequestSchema
>;
export type DecideFinopsRoutingSuggestionRequest = z.infer<
  typeof decideFinopsRoutingSuggestionRequestSchema
>;
export type FinopsDashboard = z.infer<typeof finopsDashboardSchema>;
