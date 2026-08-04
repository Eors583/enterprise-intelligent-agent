import { z } from 'zod';

const UUID = z.uuid();
const TIMESTAMP = z.iso.datetime();
const SHA256 = z.string().regex(/^[a-f0-9]{64}$/u);
const SHORT_TEXT = z.string().trim().min(1).max(500);
const LONG_TEXT = z.string().trim().min(1).max(20_000);
const JSON_OBJECT = z.record(z.string(), z.unknown());
const UNIQUE_UUIDS = z
  .array(UUID)
  .max(500)
  .refine((values) => new Set(values).size === values.length, 'UUID values must be unique.');
const UNIQUE_LABELS = z
  .array(z.string().trim().min(1).max(100))
  .max(100)
  .refine((values) => new Set(values).size === values.length, 'Labels must be unique.');

export const memoryScopeSchema = z.enum([
  'ENTERPRISE',
  'ROLE',
  'EMPLOYEE_PRIVATE',
  'TASK',
  'CONVERSATION',
]);

export const memoryStatusSchema = z.enum(['CANDIDATE', 'ACTIVE', 'ARCHIVED', 'SEALED', 'DELETED']);

export const memorySensitivitySchema = z.enum(['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED']);

export const memoryRetentionActionSchema = z.enum(['DELETE', 'ARCHIVE', 'SUMMARIZE', 'SEAL']);

export const memoryRecordSchema = z
  .object({
    id: UUID,
    tenantId: UUID,
    scope: memoryScopeSchema,
    status: memoryStatusSchema,
    version: z.number().int().positive(),
    revision: z.number().int().positive(),
    title: z.string().trim().min(1).max(300),
    summary: LONG_TEXT,
    contentHash: SHA256,
    sourceType: z.enum([
      'KNOWLEDGE',
      'ROLE_VERSION',
      'TASK',
      'CONVERSATION',
      'DELIVERABLE',
      'EXPERIENCE',
      'USER_CONFIRMED',
    ]),
    sourceId: UUID,
    sourceVersion: z.number().int().positive(),
    sourceEvidenceIds: UNIQUE_UUIDS,
    ownerUserId: UUID.nullable(),
    roleTemplateId: UUID.nullable(),
    roleVersionId: UUID.nullable(),
    roleAssignmentId: UUID.nullable(),
    taskId: UUID.nullable(),
    conversationId: UUID.nullable(),
    permissionLabels: UNIQUE_LABELS,
    sensitivity: memorySensitivitySchema,
    consent: z
      .object({
        required: z.boolean(),
        grantedByUserId: UUID.nullable(),
        grantedAt: TIMESTAMP.nullable(),
        purpose: SHORT_TEXT.nullable(),
      })
      .strict(),
    effectiveFrom: TIMESTAMP,
    effectiveTo: TIMESTAMP.nullable(),
    expiresAt: TIMESTAMP.nullable(),
    retentionAction: memoryRetentionActionSchema,
    sealedAt: TIMESTAMP.nullable(),
    deletedAt: TIMESTAMP.nullable(),
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  })
  .strict()
  .superRefine((memory, context) => {
    const set = (value: string | null): boolean => value !== null;
    const exactScopeIdentity =
      (memory.scope === 'ENTERPRISE' &&
        !set(memory.ownerUserId) &&
        !set(memory.roleTemplateId) &&
        !set(memory.roleVersionId) &&
        !set(memory.roleAssignmentId) &&
        !set(memory.taskId) &&
        !set(memory.conversationId)) ||
      (memory.scope === 'ROLE' &&
        !set(memory.ownerUserId) &&
        set(memory.roleTemplateId) &&
        set(memory.roleVersionId) &&
        !set(memory.roleAssignmentId) &&
        !set(memory.taskId) &&
        !set(memory.conversationId)) ||
      (memory.scope === 'EMPLOYEE_PRIVATE' &&
        set(memory.ownerUserId) &&
        set(memory.roleTemplateId) &&
        set(memory.roleVersionId) &&
        set(memory.roleAssignmentId) &&
        !set(memory.taskId) &&
        !set(memory.conversationId)) ||
      (memory.scope === 'TASK' &&
        !set(memory.ownerUserId) &&
        !set(memory.roleTemplateId) &&
        !set(memory.roleVersionId) &&
        !set(memory.roleAssignmentId) &&
        set(memory.taskId) &&
        !set(memory.conversationId)) ||
      (memory.scope === 'CONVERSATION' &&
        !set(memory.ownerUserId) &&
        !set(memory.roleTemplateId) &&
        !set(memory.roleVersionId) &&
        !set(memory.roleAssignmentId) &&
        !set(memory.taskId) &&
        set(memory.conversationId));
    if (!exactScopeIdentity) {
      issue(context, ['scope'], 'Memory scope identity must be exact and unambiguous.');
    }

    if (memory.scope === 'EMPLOYEE_PRIVATE') {
      if (
        !memory.consent.required ||
        memory.consent.grantedByUserId !== memory.ownerUserId ||
        memory.consent.grantedAt === null ||
        memory.consent.purpose === null
      ) {
        issue(
          context,
          ['consent'],
          'Employee-private memory requires explicit purpose-bound owner consent.',
        );
      }
    } else if (
      memory.consent.required ||
      memory.consent.grantedByUserId !== null ||
      memory.consent.grantedAt !== null ||
      memory.consent.purpose !== null
    ) {
      issue(context, ['consent'], 'Only employee-private memory may carry owner consent.');
    }

    if (memory.scope === 'CONVERSATION' && memory.expiresAt === null) {
      issue(context, ['expiresAt'], 'Conversation memory requires a finite TTL.');
    }
    if (
      memory.effectiveTo !== null &&
      Date.parse(memory.effectiveTo) <= Date.parse(memory.effectiveFrom)
    ) {
      issue(context, ['effectiveTo'], 'effectiveTo must be later than effectiveFrom.');
    }
    if (
      memory.expiresAt !== null &&
      Date.parse(memory.expiresAt) <= Date.parse(memory.effectiveFrom)
    ) {
      issue(context, ['expiresAt'], 'expiresAt must be later than effectiveFrom.');
    }
    if (
      (memory.status === 'SEALED' && memory.sealedAt === null) ||
      (memory.status === 'DELETED') !== (memory.deletedAt !== null)
    ) {
      issue(context, ['status'], 'Sealed and deleted memory require matching timestamps.');
    }
    if (Date.parse(memory.updatedAt) < Date.parse(memory.createdAt)) {
      issue(context, ['updatedAt'], 'updatedAt cannot precede createdAt.');
    }
  });

export const experienceStatusSchema = z.enum([
  'CANDIDATE',
  'SANITIZED',
  'STRUCTURED',
  'APPROVED',
  'REJECTED',
  'VALIDATED',
  'PUBLISHED',
  'MONITORED',
  'RETIRED',
]);

export const experienceStructuredContentSchema = z
  .object({
    scenario: LONG_TEXT,
    problem: LONG_TEXT,
    steps: z.array(LONG_TEXT).min(1).max(100),
    preconditions: z.array(LONG_TEXT).max(100),
    counterexamples: z.array(LONG_TEXT).max(100),
    risks: z.array(LONG_TEXT).max(100),
    outcomes: z.array(LONG_TEXT).min(1).max(100),
    applicabilityBoundaries: z.array(LONG_TEXT).min(1).max(100),
  })
  .strict();

const experienceReviewSchema = z
  .object({
    reviewerUserId: UUID,
    reviewerRoleAssignmentId: UUID,
    decision: z.enum(['APPROVED', 'REJECTED']),
    reason: LONG_TEXT,
    evidenceIds: UNIQUE_UUIDS.min(1),
    decidedAt: TIMESTAMP,
  })
  .strict();

const experienceValidationSchema = z
  .object({
    validationRunId: UUID,
    datasetVersionId: UUID,
    passed: z.boolean(),
    score: z.number().finite().min(0).max(1),
    threshold: z.number().finite().min(0).max(1),
    sideEffects: z.array(LONG_TEXT).max(100),
    validatedByUserId: UUID,
    validatedAt: TIMESTAMP,
  })
  .strict()
  .refine((validation) => validation.passed === validation.score >= validation.threshold, {
    path: ['passed'],
    message: 'Validation pass flag must match score and threshold.',
  });

const experiencePublicationSchema = z
  .object({
    knowledgeBaseId: UUID,
    documentId: UUID,
    documentVersionId: UUID,
    documentVersion: z.number().int().positive(),
    targetRoleTemplateIds: UNIQUE_UUIDS,
    targetOrgUnitIds: UNIQUE_UUIDS,
    publicationHash: SHA256,
    publishedByUserId: UUID,
    publishedAt: TIMESTAMP,
  })
  .strict()
  .refine(
    (publication) =>
      publication.targetRoleTemplateIds.length > 0 || publication.targetOrgUnitIds.length > 0,
    {
      path: ['targetRoleTemplateIds'],
      message: 'Experience publication requires at least one governed target scope.',
    },
  );

export const experienceKnowledgeProjectionStatusSchema = z.enum([
  'CREATING',
  'PROCESSING',
  'READY',
  'PUBLISHED',
  'FAILED',
  'RETIRED',
]);

export const experienceKnowledgeProjectionSchema = z
  .object({
    id: UUID,
    experienceId: UUID,
    expectedExperienceRevision: z.number().int().positive(),
    knowledgeBaseId: UUID,
    documentId: UUID.nullable(),
    documentVersionId: UUID.nullable(),
    documentVersion: z.number().int().positive().nullable(),
    targetRoleTemplateIds: UNIQUE_UUIDS,
    targetOrgUnitIds: UNIQUE_UUIDS,
    publicationHash: SHA256,
    status: experienceKnowledgeProjectionStatusSchema,
    ingestionStatus: z.enum(['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED']).nullable(),
    governanceReviewStatus: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'MIGRATED']).nullable(),
    publishedAt: TIMESTAMP.nullable(),
    errorCode: z.string().trim().min(1).max(120).nullable(),
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  })
  .strict()
  .superRefine((projection, context) => {
    const hasKnowledgeIdentity =
      projection.documentId !== null &&
      projection.documentVersionId !== null &&
      projection.documentVersion !== null;
    if (
      ['PROCESSING', 'READY', 'PUBLISHED', 'RETIRED'].includes(projection.status) &&
      !hasKnowledgeIdentity
    ) {
      issue(
        context,
        ['documentVersionId'],
        'A materialized Experience projection requires an exact Knowledge Version identity.',
      );
    }
    if ((projection.status === 'PUBLISHED') !== (projection.publishedAt !== null)) {
      if (projection.status !== 'RETIRED') {
        issue(
          context,
          ['publishedAt'],
          'Only a published or retired Experience projection may retain publication time.',
        );
      }
    }
    if (projection.status === 'FAILED' && projection.errorCode === null) {
      issue(context, ['errorCode'], 'A failed Experience projection requires a safe error code.');
    }
  });

export const experienceCandidateSchema = z
  .object({
    id: UUID,
    tenantId: UUID,
    status: experienceStatusSchema,
    revision: z.number().int().positive(),
    title: z.string().trim().min(1).max(300),
    contributorUserId: UUID,
    contributorRoleAssignmentId: UUID,
    sourceTaskId: UUID,
    sourceDeliverableIds: UNIQUE_UUIDS,
    sourceEvidenceIds: UNIQUE_UUIDS.min(1),
    rawInputHash: SHA256,
    candidateSummary: LONG_TEXT,
    sanitization: z
      .object({
        sanitizedContent: LONG_TEXT,
        sanitizedHash: SHA256,
        piiRemoved: z.boolean(),
        secretsRemoved: z.boolean(),
        customerIdentifiersRemoved: z.boolean(),
        findings: z.array(SHORT_TEXT).max(500),
        sanitizedByUserId: UUID,
        sanitizedAt: TIMESTAMP,
      })
      .strict()
      .nullable(),
    structuredContent: experienceStructuredContentSchema.nullable(),
    structuredHash: SHA256.nullable(),
    review: experienceReviewSchema.nullable(),
    validation: experienceValidationSchema.nullable(),
    publication: experiencePublicationSchema.nullable(),
    knowledgeProjection: experienceKnowledgeProjectionSchema.nullable().optional(),
    permissionLabels: UNIQUE_LABELS,
    sensitivity: memorySensitivitySchema,
    monitoredUseCount: z.number().int().nonnegative(),
    monitoredAdoptionCount: z.number().int().nonnegative(),
    monitoredComplaintCount: z.number().int().nonnegative(),
    expiresAt: TIMESTAMP.nullable(),
    retiredAt: TIMESTAMP.nullable(),
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  })
  .strict()
  .superRefine((candidate, context) => {
    const rank = experienceRank(candidate.status);
    if (
      rank >= experienceRank('SANITIZED') &&
      candidate.status !== 'REJECTED' &&
      candidate.sanitization === null
    ) {
      issue(context, ['sanitization'], 'This experience state requires sanitization.');
    }
    if (
      candidate.sanitization !== null &&
      (!candidate.sanitization.piiRemoved ||
        !candidate.sanitization.secretsRemoved ||
        !candidate.sanitization.customerIdentifiersRemoved)
    ) {
      issue(
        context,
        ['sanitization'],
        'Experience cannot advance until PII, secrets, and customer identifiers are removed.',
      );
    }
    if (
      rank >= experienceRank('STRUCTURED') &&
      candidate.status !== 'REJECTED' &&
      (candidate.structuredContent === null || candidate.structuredHash === null)
    ) {
      issue(context, ['structuredContent'], 'This experience state requires structured content.');
    }
    if (candidate.review !== null) {
      if (
        candidate.review.reviewerUserId === candidate.contributorUserId ||
        candidate.review.reviewerRoleAssignmentId === candidate.contributorRoleAssignmentId
      ) {
        issue(context, ['review'], 'Experience review must be independent from its contributor.');
      }
      if ((candidate.status === 'REJECTED') !== (candidate.review.decision === 'REJECTED')) {
        issue(context, ['review', 'decision'], 'Rejected state must match review decision.');
      }
    }
    if (
      rank >= experienceRank('APPROVED') &&
      candidate.status !== 'REJECTED' &&
      candidate.review?.decision !== 'APPROVED'
    ) {
      issue(context, ['review'], 'This experience state requires independent expert approval.');
    }
    if (
      rank >= experienceRank('VALIDATED') &&
      candidate.status !== 'REJECTED' &&
      candidate.validation?.passed !== true
    ) {
      issue(context, ['validation'], 'This experience state requires a passing validation.');
    }
    if (
      rank >= experienceRank('PUBLISHED') &&
      candidate.status !== 'REJECTED' &&
      candidate.publication === null
    ) {
      issue(context, ['publication'], 'This experience state requires a governed publication.');
    }
    if (
      candidate.monitoredAdoptionCount > candidate.monitoredUseCount ||
      candidate.monitoredComplaintCount > candidate.monitoredUseCount
    ) {
      issue(context, ['monitoredUseCount'], 'Experience monitoring counters are inconsistent.');
    }
    if ((candidate.status === 'RETIRED') !== (candidate.retiredAt !== null)) {
      issue(context, ['retiredAt'], 'Retired experience requires retiredAt.');
    }
    if (Date.parse(candidate.updatedAt) < Date.parse(candidate.createdAt)) {
      issue(context, ['updatedAt'], 'updatedAt cannot precede createdAt.');
    }
  });

export const createMemoryCandidateRequestSchema = z
  .object({
    scope: memoryScopeSchema,
    title: z.string().trim().min(1).max(300),
    summary: LONG_TEXT,
    contentHash: SHA256,
    sourceType: memoryRecordSchema.shape.sourceType,
    sourceId: UUID,
    sourceVersion: z.number().int().positive(),
    sourceEvidenceIds: UNIQUE_UUIDS,
    roleTemplateId: UUID.optional(),
    roleVersionId: UUID.optional(),
    roleAssignmentId: UUID.optional(),
    taskId: UUID.optional(),
    conversationId: UUID.optional(),
    permissionLabels: UNIQUE_LABELS,
    sensitivity: memorySensitivitySchema,
    expiresAt: TIMESTAMP.optional(),
    retentionAction: memoryRetentionActionSchema,
    consentPurpose: SHORT_TEXT.optional(),
    idempotencyKey: z.string().trim().min(1).max(200),
  })
  .strict();

export const memoryTransitionRequestSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    action: z.enum(['ACTIVATE', 'ARCHIVE', 'SEAL', 'DELETE']),
    reason: SHORT_TEXT,
    idempotencyKey: z.string().trim().min(1).max(200),
  })
  .strict();

export const memoryListQuerySchema = z
  .object({
    cursor: UUID.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    scope: memoryScopeSchema.optional(),
    status: memoryStatusSchema.optional(),
    purpose: SHORT_TEXT.optional(),
  })
  .strict();

export const createExperienceCandidateRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(300),
    sourceTaskId: UUID,
    sourceDeliverableIds: UNIQUE_UUIDS,
    sourceEvidenceIds: UNIQUE_UUIDS.min(1),
    /**
     * @deprecated The API recomputes this value from the governed request.
     * It remains optional on the wire so older clients can upgrade without a
     * breaking request-shape migration.
     */
    rawInputHash: SHA256.optional(),
    candidateSummary: LONG_TEXT,
    permissionLabels: UNIQUE_LABELS,
    sensitivity: memorySensitivitySchema,
    idempotencyKey: z.string().trim().min(1).max(200),
  })
  .strict();

export const prepareExperienceKnowledgeProjectionRequestSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    knowledgeBaseId: UUID,
    targetRoleTemplateIds: UNIQUE_UUIDS,
    targetOrgUnitIds: UNIQUE_UUIDS,
    title: z.string().trim().min(1).max(300).optional(),
    idempotencyKey: z.string().trim().min(1).max(200),
  })
  .strict()
  .refine(
    (request) => request.targetRoleTemplateIds.length > 0 || request.targetOrgUnitIds.length > 0,
    {
      path: ['targetRoleTemplateIds'],
      message: 'Experience projection requires at least one governed target scope.',
    },
  );

export const experienceSanitizePayloadSchema = z
  .object({
    sanitizedContent: LONG_TEXT,
    sanitizedHash: SHA256,
    piiRemoved: z.literal(true),
    secretsRemoved: z.literal(true),
    customerIdentifiersRemoved: z.literal(true),
    findings: z.array(SHORT_TEXT).max(500),
  })
  .strict();

export const experienceStructurePayloadSchema = z
  .object({
    structuredContent: experienceStructuredContentSchema,
    structuredHash: SHA256,
  })
  .strict();

export const experienceReviewPayloadSchema = z
  .object({
    evidenceIds: UNIQUE_UUIDS.min(1),
  })
  .strict();

export const experienceValidatePayloadSchema = z
  .object({
    validationRunId: UUID,
    datasetVersionId: UUID,
    passed: z.literal(true),
    score: z.number().finite().min(0).max(1),
    threshold: z.number().finite().min(0).max(1),
    sideEffects: z.array(LONG_TEXT).max(100),
  })
  .strict()
  .refine((validation) => validation.score >= validation.threshold, {
    path: ['score'],
    message: 'Experience validation score must meet its threshold.',
  });

export const experiencePublishPayloadSchema = z
  .object({
    knowledgeBaseId: UUID,
    documentId: UUID,
    documentVersionId: UUID,
    documentVersion: z.number().int().positive(),
    targetRoleTemplateIds: UNIQUE_UUIDS,
    targetOrgUnitIds: UNIQUE_UUIDS,
    publicationHash: SHA256,
  })
  .strict()
  .refine(
    (publication) =>
      publication.targetRoleTemplateIds.length > 0 || publication.targetOrgUnitIds.length > 0,
    {
      path: ['targetRoleTemplateIds'],
      message: 'Experience publication requires at least one governed target scope.',
    },
  );

export const experienceMonitorPayloadSchema = z
  .object({
    useCount: z.number().int().nonnegative(),
    adoptionCount: z.number().int().nonnegative(),
    complaintCount: z.number().int().nonnegative(),
  })
  .strict()
  .refine(
    (monitoring) =>
      monitoring.adoptionCount <= monitoring.useCount &&
      monitoring.complaintCount <= monitoring.useCount,
    {
      path: ['useCount'],
      message: 'Experience monitoring counters are inconsistent.',
    },
  );

export const experienceRetirePayloadSchema = z
  .object({
    replacementExperienceId: UUID.nullable(),
    rollbackDocumentVersionId: UUID.nullable(),
  })
  .strict()
  .refine(
    (retirement) =>
      retirement.replacementExperienceId === null || retirement.rollbackDocumentVersionId === null,
    {
      path: ['replacementExperienceId'],
      message: 'Retirement must choose a replacement experience or a rollback version.',
    },
  );

export const experienceTransitionRequestSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    action: z.enum([
      'SANITIZE',
      'STRUCTURE',
      'APPROVE',
      'REJECT',
      'VALIDATE',
      'PUBLISH',
      'MONITOR',
      'RETIRE',
    ]),
    reason: SHORT_TEXT,
    payload: JSON_OBJECT,
    idempotencyKey: z.string().trim().min(1).max(200),
  })
  .strict()
  .superRefine((request, context) => {
    const payloadSchema =
      request.action === 'SANITIZE'
        ? experienceSanitizePayloadSchema
        : request.action === 'STRUCTURE'
          ? experienceStructurePayloadSchema
          : request.action === 'APPROVE' || request.action === 'REJECT'
            ? experienceReviewPayloadSchema
            : request.action === 'VALIDATE'
              ? experienceValidatePayloadSchema
              : request.action === 'PUBLISH'
                ? experiencePublishPayloadSchema
                : request.action === 'MONITOR'
                  ? experienceMonitorPayloadSchema
                  : experienceRetirePayloadSchema;
    const parsed = payloadSchema.safeParse(request.payload);
    if (!parsed.success) {
      for (const payloadIssue of parsed.error.issues) {
        issue(
          context,
          ['payload', ...payloadIssue.path],
          `Invalid ${request.action} payload: ${payloadIssue.message}`,
        );
      }
    }
  });

export const experienceListQuerySchema = z
  .object({
    cursor: UUID.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    status: experienceStatusSchema.optional(),
  })
  .strict();

export type MemoryScope = z.infer<typeof memoryScopeSchema>;
export type MemoryStatus = z.infer<typeof memoryStatusSchema>;
export type MemoryRecord = z.infer<typeof memoryRecordSchema>;
export type ExperienceStatus = z.infer<typeof experienceStatusSchema>;
export type ExperienceKnowledgeProjectionStatus = z.infer<
  typeof experienceKnowledgeProjectionStatusSchema
>;
export type ExperienceKnowledgeProjection = z.infer<typeof experienceKnowledgeProjectionSchema>;
export type ExperienceCandidate = z.infer<typeof experienceCandidateSchema>;
export type CreateMemoryCandidateRequest = z.infer<typeof createMemoryCandidateRequestSchema>;
export type MemoryTransitionRequest = z.infer<typeof memoryTransitionRequestSchema>;
export type CreateExperienceCandidateRequest = z.infer<
  typeof createExperienceCandidateRequestSchema
>;
export type ExperienceTransitionRequest = z.infer<typeof experienceTransitionRequestSchema>;
export type PrepareExperienceKnowledgeProjectionRequest = z.infer<
  typeof prepareExperienceKnowledgeProjectionRequestSchema
>;
export type MemoryListQuery = z.infer<typeof memoryListQuerySchema>;
export type ExperienceListQuery = z.infer<typeof experienceListQuerySchema>;

export interface MemoryListResponse {
  readonly items: readonly MemoryRecord[];
  readonly nextCursor: string | null;
}

export interface ExperienceListResponse {
  readonly items: readonly ExperienceCandidate[];
  readonly nextCursor: string | null;
}

function experienceRank(status: z.infer<typeof experienceStatusSchema>): number {
  const ranks: Record<z.infer<typeof experienceStatusSchema>, number> = {
    CANDIDATE: 0,
    SANITIZED: 1,
    STRUCTURED: 2,
    APPROVED: 3,
    REJECTED: 3,
    VALIDATED: 4,
    PUBLISHED: 5,
    MONITORED: 6,
    RETIRED: 7,
  };
  return ranks[status];
}

function issue(context: z.RefinementCtx, path: PropertyKey[], message: string): void {
  context.addIssue({ code: 'custom', path, message });
}
