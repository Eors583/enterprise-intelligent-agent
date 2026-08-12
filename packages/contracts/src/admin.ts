import { z } from 'zod';
import { tenantRoleSchema } from './auth.js';

export const adminOrganizationSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1),
  legalName: z.string().nullable(),
  timezone: z.string().min(1),
  version: z.number().int().positive(),
});

export const organizationSyncSourceSchema = z.enum(['LOCAL', 'FEISHU']);

export const employmentTypeSchema = z.enum([
  'REGULAR',
  'INTERN',
  'OUTSOURCED',
  'LABOR',
  'CONSULTANT',
]);

export const adminOrgUnitSchema = z.object({
  id: z.uuid(),
  organizationId: z.uuid(),
  parentId: z.uuid().nullable(),
  name: z.string().min(1),
  sortOrder: z.number().int(),
  status: z.enum(['ACTIVE', 'ARCHIVED']),
  version: z.number().int().positive(),
  memberCount: z.number().int().nonnegative(),
  source: organizationSyncSourceSchema,
});

export const adminMemberSchema = z.object({
  id: z.uuid(),
  email: z.email(),
  displayName: z.string().min(1),
  phone: z.string().nullable().optional(),
  avatarUrl: z.url().nullable().optional(),
  status: z.enum(['ACTIVE', 'INACTIVE', 'LOCKED']),
  role: tenantRoleSchema,
  source: organizationSyncSourceSchema,
  employment: z
    .object({
      id: z.uuid(),
      organizationId: z.uuid(),
      orgUnitId: z.uuid(),
      title: z.string().nullable(),
      employeeNumber: z.string().nullable().optional(),
      employmentType: employmentTypeSchema.nullable().optional(),
      hireDate: z.iso.date().nullable().optional(),
      countryOrRegion: z.string().nullable().optional(),
      city: z.string().nullable().optional(),
      directManager: z
        .object({ userId: z.uuid(), displayName: z.string().min(1) })
        .nullable()
        .optional(),
      dottedLineManager: z
        .object({ userId: z.uuid(), displayName: z.string().min(1) })
        .nullable()
        .optional(),
      status: z.enum(['PENDING', 'ACTIVE', 'SUSPENDED', 'TERMINATED']),
    })
    .nullable(),
  invitation: z
    .object({
      id: z.uuid(),
      status: z.enum(['PENDING', 'SENT', 'DELIVERY_FAILED', 'ACCEPTED', 'EXPIRED', 'REVOKED']),
      deliveryStatus: z.enum(['NOT_CONFIGURED', 'PENDING', 'SENT', 'FAILED']),
      issuedAt: z.iso.datetime(),
      expiresAt: z.iso.datetime(),
      consumedAt: z.iso.datetime().nullable(),
    })
    .nullable()
    .optional(),
});

export const adminOrganizationResponseSchema = z.object({
  organization: adminOrganizationSchema,
  orgUnits: z.array(adminOrgUnitSchema),
  members: z.array(adminMemberSchema),
});

export const feishuOrganizationSyncStatusValueSchema = z.enum([
  'NOT_CONFIGURED',
  'READY',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
]);

export const feishuDepartmentSyncCountsSchema = z.object({
  created: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  archived: z.number().int().nonnegative(),
  unchanged: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
});

export const feishuMemberSyncCountsSchema = z.object({
  created: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  deactivated: z.number().int().nonnegative(),
  unchanged: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
});

export const feishuOrganizationSyncRunSchema = z.object({
  id: z.uuid(),
  status: z.enum(['RUNNING', 'SUCCEEDED', 'FAILED']),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  departments: feishuDepartmentSyncCountsSchema,
  members: feishuMemberSyncCountsSchema,
  conflictCount: z.number().int().nonnegative(),
  errorMessage: z.string().nullable(),
});

export const feishuOrganizationSyncStatusSchema = z
  .object({
    status: feishuOrganizationSyncStatusValueSchema,
    tenantName: z.string().min(1).nullable(),
    lastSuccessfulAt: z.iso.datetime().nullable(),
    run: feishuOrganizationSyncRunSchema.nullable(),
    connectionSource: z.enum(['ADMIN', 'ENVIRONMENT']).nullable().optional(),
    appIdMasked: z.string().nullable().optional(),
  })
  .superRefine((value, context) => {
    const requiresRun = ['RUNNING', 'SUCCEEDED', 'FAILED'].includes(value.status);
    if (requiresRun !== (value.run !== null)) {
      context.addIssue({
        code: 'custom',
        path: ['run'],
        message: `${value.status} requires a matching synchronization run.`,
      });
      return;
    }
    if (value.run !== null && value.run.status !== value.status) {
      context.addIssue({
        code: 'custom',
        path: ['run', 'status'],
        message: 'Run status must match the top-level synchronization status.',
      });
    }
  });

export const bindFeishuOrganizationRequestSchema = z.object({
  appId: z
    .string()
    .trim()
    .min(3)
    .max(200)
    .regex(/^cli_[A-Za-z0-9_-]+$/),
  appSecret: z.string().trim().min(8).max(512),
});

export const feishuDirectoryChangeActionSchema = z.enum([
  'CREATE',
  'UPDATE',
  'ARCHIVE',
  'DEACTIVATE',
  'CONFLICT',
]);

export const feishuDirectoryPreviewItemSchema = z.object({
  id: z.uuid(),
  sequence: z.number().int().nonnegative(),
  entityType: z.enum(['DEPARTMENT', 'MEMBER']),
  action: feishuDirectoryChangeActionSchema,
  externalId: z.string().min(1).max(200),
  displayName: z.string().min(1).max(200),
  localResourceType: z.string().min(1).max(80).nullable(),
  localResourceId: z.uuid().nullable(),
  fieldChanges: z.record(z.string(), z.unknown()),
  diagnosticCode: z.string().min(1).max(120).nullable(),
  applyStatus: z.enum(['PENDING', 'APPLIED', 'FAILED']),
});

export const feishuDirectoryPreviewSchema = z.object({
  id: z.uuid(),
  status: z.enum(['READY', 'APPLIED', 'EXPIRED']),
  snapshotCursor: z.string().regex(/^[a-f0-9]{64}$/u),
  summary: z.object({
    created: z.number().int().nonnegative(),
    updated: z.number().int().nonnegative(),
    archived: z.number().int().nonnegative(),
    deactivated: z.number().int().nonnegative(),
    conflicts: z.number().int().nonnegative(),
    unchanged: z.number().int().nonnegative(),
  }),
  expiresAt: z.iso.datetime(),
  appliedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  items: z.array(feishuDirectoryPreviewItemSchema),
});

export const applyFeishuDirectoryPreviewRequestSchema = z.object({
  previewId: z.uuid(),
  idempotencyKey: z.string().trim().min(8).max(200),
});

export const feishuDirectorySyncRunDetailSchema = z.object({
  id: z.uuid(),
  previewId: z.uuid(),
  status: z.enum(['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'DEAD_LETTER']),
  attempts: z.number().int().nonnegative(),
  maxAttempts: z.number().int().positive(),
  expectedSnapshotCursor: z.string().regex(/^[a-f0-9]{64}$/u),
  lastErrorCode: z.string().max(120).nullable(),
  summary: z.record(z.string(), z.unknown()).nullable(),
  startedAt: z.iso.datetime().nullable(),
  finishedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});

export const feishuDirectorySyncRunListSchema = z.object({
  items: z.array(feishuDirectorySyncRunDetailSchema),
});

export const updateOrganizationRequestSchema = z.object({
  name: z.string().trim().min(2).max(200).optional(),
  legalName: z.string().trim().max(300).nullable().optional(),
  timezone: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .refine(isIanaTimeZone, 'timezone must be a valid IANA time zone.')
    .optional(),
  expectedVersion: z.number().int().positive(),
});

export const createOrgUnitRequestSchema = z.object({
  name: z.string().trim().min(1).max(200),
  parentId: z.uuid().nullable().optional(),
  sortOrder: z.number().int().min(0).max(1_000_000).default(0),
});

export const updateOrgUnitRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    parentId: z.uuid().nullable().optional(),
    sortOrder: z.number().int().min(0).max(1_000_000).optional(),
    expectedVersion: z.number().int().positive(),
  })
  .refine(
    (value) =>
      value.name !== undefined || value.parentId !== undefined || value.sortOrder !== undefined,
    'At least one org unit field must change.',
  );

/**
 * @deprecated Prefer inviteMemberRequestSchema for the default member onboarding flow.
 * This legacy contract remains available for controlled break-glass provisioning.
 */
const memberOnboardingRequestShape = {
  email: z
    .email()
    .max(320)
    .transform((value) => value.toLowerCase()),
  displayName: z.string().trim().min(1).max(120),
  role: tenantRoleSchema.default('MEMBER'),
  orgUnitId: z.uuid(),
  title: z.string().trim().min(1).max(200).optional(),
  employeeNumber: z.string().trim().min(1).max(255).optional(),
  phone: z.string().trim().min(5).max(40).optional(),
  avatarUrl: z.url().max(2_048).optional(),
  employmentType: employmentTypeSchema.default('REGULAR'),
  hireDate: z.iso.date().optional(),
  countryOrRegion: z.string().trim().min(1).max(120).optional(),
  city: z.string().trim().min(1).max(120).optional(),
  directManagerUserId: z.uuid().optional(),
  dottedLineManagerUserId: z.uuid().optional(),
};

function validateDistinctManagers(
  value: {
    directManagerUserId?: string | undefined;
    dottedLineManagerUserId?: string | undefined;
  },
  context: z.RefinementCtx,
): void {
  if (
    value.directManagerUserId !== undefined &&
    value.directManagerUserId === value.dottedLineManagerUserId
  ) {
    context.addIssue({
      code: 'custom',
      path: ['dottedLineManagerUserId'],
      message: 'Direct and dotted-line managers must be different members.',
    });
  }
}

export const createMemberRequestSchema = z
  .object({
    ...memberOnboardingRequestShape,
    password: z.string().min(10).max(128),
  })
  .superRefine(validateDistinctManagers);

export const inviteMemberRequestSchema = z
  .object(memberOnboardingRequestShape)
  .superRefine(validateDistinctManagers);

export const memberInvitationSchema = z.object({
  id: z.uuid(),
  memberId: z.uuid(),
  email: z.email(),
  displayName: z.string().min(1),
  status: z.enum(['PENDING', 'SENT', 'DELIVERY_FAILED', 'ACCEPTED', 'EXPIRED', 'REVOKED']),
  deliveryStatus: z.enum(['NOT_CONFIGURED', 'PENDING', 'SENT', 'FAILED']),
  deliveryTargetEvidence: z.enum(['ISSUED', 'LEGACY_INFERRED']),
  issuedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  consumedAt: z.iso.datetime().nullable(),
});

const invitationManualFallbackSchema = z.object({
  kind: z.literal('MANUAL_FALLBACK'),
  // Returned once only when email delivery is unavailable. The capability is
  // embedded in the URL fragment and the API never returns a separate raw token.
  acceptanceUrl: z.url(),
  expiresAt: z.iso.datetime(),
});

export const issueMemberInvitationResponseSchema = z.discriminatedUnion('deliveryKind', [
  memberInvitationSchema
    .extend({
      deliveryKind: z.literal('EMAIL_SENT'),
      fallback: z.null(),
    })
    .strict(),
  memberInvitationSchema
    .extend({
      deliveryKind: z.literal('MANUAL_FALLBACK'),
      fallback: invitationManualFallbackSchema,
    })
    .strict(),
]);

export const updateMemberRequestSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email().max(320)).optional(),
  displayName: z.string().trim().min(1).max(120).optional(),
  role: tenantRoleSchema.optional(),
  status: z.enum(['ACTIVE', 'INACTIVE', 'LOCKED']).optional(),
  orgUnitId: z.uuid().optional(),
  title: z.string().trim().min(1).max(200).optional(),
});

export const resetMemberPasswordRequestSchema = z.object({
  temporaryPassword: z.string().min(10).max(128),
});

export const resetMemberPasswordResponseSchema = z.object({
  memberId: z.uuid(),
  passwordChangeRequired: z.literal(true),
  revokedSessionCount: z.number().int().nonnegative(),
});

export const knowledgeBaseStatusSchema = z.enum(['DRAFT', 'ACTIVE', 'ARCHIVED']);

export const knowledgeRetrievalModeSchema = z.enum(['HYBRID', 'VECTOR', 'FULL_TEXT']);

export const knowledgeRetrievalConfigSchema = z
  .object({
    mode: knowledgeRetrievalModeSchema.default('HYBRID'),
    topK: z.number().int().min(1).max(20).default(8),
    scoreThreshold: z.number().min(0).max(1).default(0.08),
    semanticWeight: z.number().min(0).max(1).default(0.7),
    keywordWeight: z.number().min(0).max(1).default(0.3),
    rerankEnabled: z.boolean().default(true),
    relationshipRetrievalEnabled: z.boolean().default(true),
    maxChunksPerDocument: z.number().int().min(1).max(10).default(3),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.mode !== 'HYBRID') return;
    if (Math.abs(value.semanticWeight + value.keywordWeight - 1) > 0.0001) {
      context.addIssue({
        code: 'custom',
        path: ['semanticWeight'],
        message: 'Hybrid semanticWeight and keywordWeight must add up to 1.',
      });
    }
  });

export const knowledgeChunkingConfigSchema = z
  .object({
    targetTokens: z.number().int().min(100).max(2_000).default(500),
    overlapTokens: z.number().int().min(0).max(500).default(80),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.overlapTokens >= value.targetTokens) {
      context.addIssue({
        code: 'custom',
        path: ['overlapTokens'],
        message: 'overlapTokens must be smaller than targetTokens.',
      });
    }
  });

export const knowledgeEmbeddingProviderSchema = z.enum(['openai_compatible', 'local_fastembed']);

export const knowledgeEmbeddingIndexStatusSchema = z.enum([
  'BUILDING',
  'ACTIVE',
  'RETIRED',
  'FAILED',
]);

export const knowledgeEmbeddingIndexConfigSchema = z
  .object({
    provider: knowledgeEmbeddingProviderSchema,
    model: z.string().trim().min(1).max(200),
    dimensions: z.number().int().min(1).max(16_000),
    distance: z.literal('COSINE').default('COSINE'),
    normalization: z.enum(['L2', 'NONE']).default('L2'),
  })
  .strict();

export const knowledgeEmbeddingIndexVersionSchema = z.object({
  id: z.uuid(),
  version: z.number().int().positive(),
  status: knowledgeEmbeddingIndexStatusSchema,
  provider: z.string().trim().min(1).max(40),
  model: z.string().trim().min(1).max(200),
  dimensions: z.number().int().min(1).max(16_000),
  distance: z.literal('COSINE'),
  normalization: z.enum(['L2', 'NONE']),
  collectionName: z.string().trim().min(1).max(200).nullable(),
  createdAt: z.iso.datetime(),
  activatedAt: z.iso.datetime().nullable(),
  retiredAt: z.iso.datetime().nullable(),
  failureCode: z.string().trim().min(1).max(120).nullable(),
});

export const createKnowledgeEmbeddingIndexVersionRequestSchema =
  knowledgeEmbeddingIndexConfigSchema;

export const knowledgeEmbeddingIndexVersionListResponseSchema = z.object({
  items: z.array(knowledgeEmbeddingIndexVersionSchema),
});
export const knowledgeDocumentStatusSchema = z.enum([
  'DRAFT',
  'PROCESSING',
  'READY',
  'FAILED',
  'ARCHIVED',
]);
export const knowledgeSourceTypeSchema = z.enum(['TEXT', 'MARKDOWN', 'FILE', 'WEB']);
export const knowledgeParseReviewStatusSchema = z.enum([
  'NOT_REQUIRED',
  'PENDING',
  'APPROVED',
  'REJECTED',
]);
export const knowledgeClassificationSchema = z.enum([
  'PUBLIC',
  'INTERNAL',
  'SENSITIVE',
  'CONFIDENTIAL',
]);
export const knowledgeScopeModeSchema = z.enum(['TENANT', 'RESTRICTED']);
export const knowledgeRetentionActionSchema = z.enum(['ARCHIVE', 'REVIEW_DELETE', 'LEGAL_HOLD']);
export const knowledgeGovernanceReviewStatusSchema = z.enum([
  'PENDING',
  'APPROVED',
  'REJECTED',
  'MIGRATED',
]);
const knowledgeGovernanceUuidListSchema = z
  .array(z.uuid())
  .max(500)
  .refine((values) => new Set(values).size === values.length, {
    message: 'Governance scope identifiers must be unique.',
  });
const knowledgeGovernanceLabelListSchema = z
  .array(
    z
      .string()
      .trim()
      .min(1)
      .max(120)
      .regex(/^[A-Za-z0-9][A-Za-z0-9:._/-]*$/u),
  )
  .max(500)
  .refine((values) => new Set(values).size === values.length, {
    message: 'Governance data labels must be unique.',
  });
export const knowledgeDocumentGovernancePolicySchema = z
  .object({
    ownerUserId: z.uuid(),
    classification: knowledgeClassificationSchema,
    scopeMode: knowledgeScopeModeSchema,
    organizationScopeIds: knowledgeGovernanceUuidListSchema,
    projectScopeIds: knowledgeGovernanceUuidListSchema,
    taskScopeIds: knowledgeGovernanceUuidListSchema,
    roleTemplateScopeIds: knowledgeGovernanceUuidListSchema,
    dataLabels: knowledgeGovernanceLabelListSchema,
    effectiveFrom: z.iso.datetime(),
    expiresAt: z.iso.datetime().nullable(),
    retentionUntil: z.iso.datetime().nullable(),
    retentionAction: knowledgeRetentionActionSchema,
    supersedesVersionId: z.uuid().nullable(),
  })
  .strict()
  .superRefine((policy, context) => {
    const restricted =
      policy.organizationScopeIds.length > 0 ||
      policy.projectScopeIds.length > 0 ||
      policy.taskScopeIds.length > 0 ||
      policy.roleTemplateScopeIds.length > 0 ||
      policy.dataLabels.length > 0;
    if (policy.scopeMode === 'TENANT' && restricted) {
      context.addIssue({
        code: 'custom',
        path: ['scopeMode'],
        message: 'Tenant-wide knowledge cannot contain restricted scope identifiers or labels.',
      });
    }
    if (
      policy.scopeMode === 'TENANT' &&
      (policy.classification === 'SENSITIVE' || policy.classification === 'CONFIDENTIAL')
    ) {
      context.addIssue({
        code: 'custom',
        path: ['classification'],
        message: 'Sensitive and confidential knowledge must use restricted scope.',
      });
    }
    if (policy.scopeMode === 'RESTRICTED' && !restricted) {
      context.addIssue({
        code: 'custom',
        path: ['scopeMode'],
        message: 'Restricted knowledge requires at least one governed target scope or data label.',
      });
    }
    const effectiveFrom = Date.parse(policy.effectiveFrom);
    if (policy.expiresAt !== null && Date.parse(policy.expiresAt) <= effectiveFrom) {
      context.addIssue({
        code: 'custom',
        path: ['expiresAt'],
        message: 'Knowledge expiry must be later than its effective time.',
      });
    }
    if (policy.retentionUntil !== null && Date.parse(policy.retentionUntil) < effectiveFrom) {
      context.addIssue({
        code: 'custom',
        path: ['retentionUntil'],
        message: 'Knowledge retention cannot end before its effective time.',
      });
    }
  });
export const knowledgeDocumentGovernanceSchema = knowledgeDocumentGovernancePolicySchema.extend({
  revision: z.number().int().positive(),
  reviewStatus: knowledgeGovernanceReviewStatusSchema,
  reviewedById: z.uuid().nullable(),
  reviewedAt: z.iso.datetime().nullable(),
  reviewNote: z.string().trim().min(1).max(2_000).nullable(),
  policyHash: z.string().regex(/^[a-f0-9]{64}$/u),
});
export const knowledgeBaseOrgUnitScopeSchema = z.object({
  orgUnitId: z.uuid(),
  includeChildren: z.boolean(),
});
export const knowledgeBaseMemberScopeSchema = z.object({
  userId: z.uuid(),
});

export const knowledgeIngestionJobSchema = z.object({
  id: z.uuid(),
  documentVersionId: z.uuid(),
  stage: z.enum(['UPLOADED', 'SECURITY_CHECK', 'PARSING', 'CHUNKING', 'INDEXING', 'READY']),
  status: z.enum(['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED']),
  progress: z.number().int().min(0).max(100),
  attempts: z.number().int().nonnegative(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  startedAt: z.iso.datetime().nullable(),
  finishedAt: z.iso.datetime().nullable(),
});

export const knowledgeDocumentVersionSummarySchema = z.object({
  id: z.uuid(),
  versionNumber: z.number().int().positive(),
  sourceType: knowledgeSourceTypeSchema,
  mimeType: z.string().nullable(),
  fileName: z.string().nullable(),
  checksum: z.string().nullable(),
  status: z.enum(['DRAFT', 'PROCESSING', 'READY', 'FAILED', 'ARCHIVED']),
  changeSummary: z.string().nullable(),
  chunkCount: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
  publishedAt: z.iso.datetime().nullable(),
  evaluationRunId: z.uuid().nullable(),
  evaluationDatasetVersionId: z.uuid().nullable(),
  evaluationSnapshotHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .nullable(),
  sourceUri: z.url().max(2_048).nullable().default(null),
  parserName: z.string().trim().min(1).max(120).nullable().default(null),
  parseQualityScore: z.number().min(0).max(1).nullable().default(null),
  parseReviewStatus: knowledgeParseReviewStatusSchema.default('NOT_REQUIRED'),
  parseReviewRevision: z.number().int().positive().default(1),
  parseReviewedById: z.uuid().nullable().default(null),
  parseReviewedAt: z.iso.datetime().nullable().default(null),
  parseReviewNote: z.string().trim().min(1).max(2_000).nullable().default(null),
  parseDiagnostics: z.record(z.string(), z.unknown()).default({}),
  structuredArtifact: z
    .object({
      format: z.string().trim().min(1).max(120),
      size: z.number().int().nonnegative(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    })
    .nullable()
    .optional(),
  governance: knowledgeDocumentGovernanceSchema,
  ingestionJob: knowledgeIngestionJobSchema.nullable(),
});

export const knowledgeDocumentSummarySchema = z.object({
  id: z.uuid(),
  knowledgeBaseId: z.uuid(),
  folderId: z.uuid().nullable(),
  folderPath: z.string().max(2_000).nullable(),
  title: z.string().min(1),
  sourceType: knowledgeSourceTypeSchema,
  mimeType: z.string().nullable(),
  fileName: z.string().nullable(),
  checksum: z.string().nullable(),
  status: knowledgeDocumentStatusSchema,
  documentVersion: z.number().int().positive(),
  currentVersionId: z.uuid().nullable(),
  versions: z.array(knowledgeDocumentVersionSummarySchema),
  updatedAt: z.iso.datetime(),
});

export const knowledgeDocumentSchema = knowledgeDocumentSummarySchema.extend({
  contentText: z.string().nullable(),
});

export const knowledgeDocumentVersionDetailSchema = knowledgeDocumentVersionSummarySchema.extend({
  documentId: z.uuid(),
  contentText: z.string().nullable(),
  graphProjectionId: z.uuid().nullable(),
  graphProjectionStatus: z.enum(['CANDIDATE', 'ACTIVE', 'OBSOLETE']).nullable(),
  graphProjectionHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .nullable(),
});

export const knowledgeDocumentChunkPreviewSchema = z.object({
  id: z.uuid(),
  parentChunkId: z.uuid(),
  previousChunkId: z.uuid().nullable(),
  nextChunkId: z.uuid().nullable(),
  chunkIndex: z.number().int().nonnegative(),
  headingPath: z.array(z.string()),
  parentHeadingPath: z.array(z.string()),
  parentExcerpt: z.string(),
  content: z.string(),
  tokenCount: z.number().int().nonnegative(),
  contentHash: z.string().length(64),
  pageStart: z.number().int().positive().nullable(),
  pageEnd: z.number().int().positive().nullable(),
  sheetName: z.string().min(1).max(200).nullable(),
  embeddingModels: z.array(z.string().min(1).max(200)),
});

export const knowledgeStructuredDocumentPreviewSchema = z.object({
  documentVersionId: z.uuid(),
  format: z.string().trim().min(1).max(120),
  size: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  truncated: z.boolean(),
  content: z.unknown(),
});

export const knowledgeDocumentChunkListResponseSchema = z.object({
  documentVersionId: z.uuid(),
  total: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  limit: z.number().int().min(1).max(100),
  embeddedChunkCount: z.number().int().nonnegative(),
  semanticCoverage: z.number().min(0).max(1),
  items: z.array(knowledgeDocumentChunkPreviewSchema),
});

export const inspectKnowledgeUploadRequestSchema = z
  .object({
    fileName: z.string().trim().min(1).max(300),
    size: z.number().int().positive().max(2_147_483_647),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    documentId: z.uuid().optional(),
    folderId: z.uuid().nullable().optional(),
  })
  .strict();

export const knowledgeUploadInspectionSchema = z
  .object({
    decision: z.enum(['NEW_DOCUMENT', 'NEW_VERSION_CANDIDATE', 'EXACT_DUPLICATE']),
    matchingDocument: z
      .object({
        id: z.uuid(),
        title: z.string().min(1),
        fileName: z.string().nullable(),
        currentVersion: z.number().int().positive(),
        matchedVersion: z.number().int().positive(),
        updatedAt: z.iso.datetime(),
      })
      .strict()
      .nullable(),
  })
  .strict();

export const knowledgeCapabilityStatusSchema = z.enum([
  'DISABLED',
  'READY',
  'NOT_READY',
  'UNAVAILABLE',
]);

export const knowledgeReadinessReasonSchema = z.enum([
  'DOCUMENTS_PROCESSING',
  'DOCUMENTS_FAILED',
  'NO_PUBLISHED_CHUNKS',
  'EMBEDDING_DISABLED',
  'EMBEDDING_PROVIDER_NOT_READY',
  'EMBEDDING_PROVIDER_UNAVAILABLE',
  'EMBEDDING_MODEL_UNAVAILABLE',
  'EMBEDDING_COVERAGE_INCOMPLETE',
  'RERANK_DISABLED',
  'RERANK_PROVIDER_NOT_READY',
  'RERANK_PROVIDER_UNAVAILABLE',
]);

export const knowledgeCapabilityReadinessSchema = z.object({
  status: knowledgeCapabilityStatusSchema,
  provider: z.enum(['disabled', 'openai_compatible', 'cohere_compatible', 'local_fastembed']),
  model: z.string().min(1).max(200).nullable(),
  dimensions: z.number().int().positive().nullable(),
});

export const knowledgeBaseIndexReadinessSchema = z.object({
  knowledgeBaseId: z.uuid(),
  documents: z.object({
    total: z.number().int().nonnegative(),
    ready: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    processing: z.number().int().nonnegative(),
    draft: z.number().int().nonnegative(),
    archived: z.number().int().nonnegative(),
  }),
  publishedChunkCount: z.number().int().nonnegative(),
  embeddedChunkCount: z.number().int().nonnegative(),
  semanticCoverage: z.number().min(0).max(1),
  embedding: knowledgeCapabilityReadinessSchema,
  rerank: knowledgeCapabilityReadinessSchema,
  retrievalMode: z.enum(['LEXICAL', 'HYBRID']),
  degradedReason: knowledgeReadinessReasonSchema.nullable(),
});

export const knowledgeGraphStatusSchema = z.enum([
  'NOT_BUILT',
  'BUILDING',
  'READY',
  'DEGRADED',
  'FAILED',
]);

export const knowledgeGraphReadinessReasonSchema = z.enum([
  'NO_ENTITIES',
  'NO_RELATIONS',
  'NO_PUBLISHED_ONTOLOGY',
  'UNGOVERNED_RELATIONS',
  'OPEN_GRAPH_CONFLICTS',
  'MENTION_COVERAGE_INCOMPLETE',
  'RELATIONS_WITHOUT_EVIDENCE',
  'GRAPH_EXTRACTION_PROCESSING',
  'GRAPH_EXTRACTION_FAILED',
]);

export const knowledgeGraphTypeCountSchema = z.object({
  type: z.string().trim().min(1).max(120),
  count: z.number().int().nonnegative(),
});

export const knowledgeGraphRelationTypeCountSchema = z.object({
  predicate: z.string().trim().min(1).max(160),
  count: z.number().int().nonnegative(),
});

export const knowledgeGraphOverviewSchema = z
  .object({
    knowledgeBaseId: z.uuid(),
    status: knowledgeGraphStatusSchema,
    entityCount: z.number().int().nonnegative(),
    relationCount: z.number().int().nonnegative(),
    mentionCount: z.number().int().nonnegative(),
    evidenceCount: z.number().int().nonnegative(),
    orphanEntityCount: z.number().int().nonnegative(),
    relationsWithoutEvidenceCount: z.number().int().nonnegative(),
    publishedChunkCount: z.number().int().nonnegative(),
    linkedChunkCount: z.number().int().nonnegative(),
    mentionCoverage: z.number().min(0).max(1),
    evidenceCoverage: z.number().min(0).max(1),
    entityTypes: z.array(knowledgeGraphTypeCountSchema),
    relationTypes: z.array(knowledgeGraphRelationTypeCountSchema),
    diagnostics: z.array(knowledgeGraphReadinessReasonSchema),
    lastBuiltAt: z.iso.datetime().nullable(),
  })
  .superRefine((value, context) => {
    if (value.orphanEntityCount > value.entityCount) {
      context.addIssue({
        code: 'custom',
        path: ['orphanEntityCount'],
        message: 'Orphan entities cannot exceed total entities.',
      });
    }
    if (value.relationsWithoutEvidenceCount > value.relationCount) {
      context.addIssue({
        code: 'custom',
        path: ['relationsWithoutEvidenceCount'],
        message: 'Relations without evidence cannot exceed total relations.',
      });
    }
    if (value.linkedChunkCount > value.publishedChunkCount) {
      context.addIssue({
        code: 'custom',
        path: ['linkedChunkCount'],
        message: 'Linked chunks cannot exceed published chunks.',
      });
    }
  });

export const knowledgeGraphEntitySchema = z.object({
  id: z.uuid(),
  entityType: z.string().trim().min(1).max(120),
  canonicalName: z.string().trim().min(1).max(500),
  description: z.string().max(4_000).nullable(),
  aliases: z.array(z.string().trim().min(1).max(500)).max(100),
  attributes: z.record(z.string(), z.unknown()),
  confidence: z.number().min(0).max(1),
  mentionCount: z.number().int().nonnegative(),
  relationCount: z.number().int().nonnegative(),
  updatedAt: z.iso.datetime(),
});

export const knowledgeGraphRelationEvidencePreviewSchema = z.object({
  id: z.uuid(),
  chunkId: z.uuid(),
  documentId: z.uuid(),
  documentVersionId: z.uuid(),
  excerpt: z.string().trim().min(1).max(2_000),
  confidence: z.number().min(0).max(1),
});

export const knowledgeGraphRelationSchema = z.object({
  id: z.uuid(),
  subjectEntityId: z.uuid(),
  subjectEntityName: z.string().trim().min(1).max(500),
  predicate: z.string().trim().min(1).max(160),
  objectEntityId: z.uuid(),
  objectEntityName: z.string().trim().min(1).max(500),
  attributes: z.record(z.string(), z.unknown()),
  confidence: z.number().min(0).max(1),
  evidenceCount: z.number().int().nonnegative(),
  evidence: z.array(knowledgeGraphRelationEvidencePreviewSchema).max(10),
  updatedAt: z.iso.datetime(),
});

export const knowledgeGraphQuerySchema = z.object({
  query: z.string().trim().max(500).optional(),
  entityType: z.string().trim().min(1).max(120).optional(),
  focusEntityId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const knowledgeGraphResponseSchema = z.object({
  knowledgeBaseId: z.uuid(),
  query: z.string().max(500).nullable(),
  entityType: z.string().max(120).nullable(),
  focusEntityId: z.uuid().nullable(),
  totalEntities: z.number().int().nonnegative(),
  totalRelations: z.number().int().nonnegative(),
  entities: z.array(knowledgeGraphEntitySchema),
  relations: z.array(knowledgeGraphRelationSchema),
});

export const knowledgeSpaceTypeSchema = z.enum(['COMPANY', 'DEPARTMENT', 'PROJECT', 'MEMBER']);

export const knowledgeSpaceSchema = z
  .object({
    type: knowledgeSpaceTypeSchema,
    targetId: z.uuid(),
    targetName: z.string().trim().min(1).max(200),
  })
  .strict();

export const knowledgeSpaceSelectionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('COMPANY') }).strict(),
  z.object({ type: z.literal('DEPARTMENT'), targetId: z.uuid() }).strict(),
  z
    .object({
      type: z.literal('PROJECT'),
      targetId: z.uuid().optional(),
      targetName: z.string().trim().min(1).max(200),
    })
    .strict(),
  z.object({ type: z.literal('MEMBER'), targetId: z.uuid() }).strict(),
]);

export const knowledgeFolderSchema = z.object({
  id: z.uuid(),
  knowledgeBaseId: z.uuid(),
  parentId: z.uuid().nullable(),
  name: z.string().min(1).max(200),
  path: z.string().min(1).max(2_000),
  directDocumentCount: z.number().int().nonnegative(),
  directChildCount: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const ensureKnowledgeFoldersRequestSchema = z
  .object({
    paths: z.array(z.string().trim().min(1).max(2_000)).min(1).max(1_000),
  })
  .strict();

export const knowledgeFolderListResponseSchema = z.object({
  items: z.array(knowledgeFolderSchema),
});

export const knowledgeBaseSchema = z.object({
  id: z.uuid(),
  key: z.string().min(1),
  name: z.string().min(1),
  description: z.string().nullable(),
  status: knowledgeBaseStatusSchema,
  space: knowledgeSpaceSchema,
  version: z.number().int().positive(),
  retrievalConfig: knowledgeRetrievalConfigSchema,
  chunkingConfig: knowledgeChunkingConfigSchema,
  activeEmbeddingIndexVersion: knowledgeEmbeddingIndexVersionSchema.nullable(),
  pendingEmbeddingIndexVersion: knowledgeEmbeddingIndexVersionSchema.nullable(),
  orgUnitIds: z.array(z.uuid()),
  orgUnitScopes: z.array(knowledgeBaseOrgUnitScopeSchema),
  memberUserIds: z.array(z.uuid()),
  documentCount: z.number().int().nonnegative(),
  folders: z.array(knowledgeFolderSchema),
  documents: z.array(knowledgeDocumentSummarySchema),
  updatedAt: z.iso.datetime(),
});

export const knowledgeBaseListResponseSchema = z.object({ items: z.array(knowledgeBaseSchema) });

export const createKnowledgeBaseRequestSchema = z.object({
  key: z
    .string()
    .trim()
    .min(2)
    .max(100)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .optional(),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(4_000).nullable().optional(),
  status: knowledgeBaseStatusSchema.default('ACTIVE'),
  space: knowledgeSpaceSelectionSchema.optional(),
  orgUnitIds: z.array(z.uuid()).max(500).default([]),
  orgUnitScopes: z.array(knowledgeBaseOrgUnitScopeSchema).max(500).optional(),
  memberUserIds: z.array(z.uuid()).max(500).default([]),
  retrievalConfig: knowledgeRetrievalConfigSchema.optional(),
  chunkingConfig: knowledgeChunkingConfigSchema.optional(),
});

export const updateKnowledgeBaseRequestSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(4_000).nullable().optional(),
  status: knowledgeBaseStatusSchema.optional(),
  space: knowledgeSpaceSelectionSchema.optional(),
  orgUnitIds: z.array(z.uuid()).max(500).optional(),
  orgUnitScopes: z.array(knowledgeBaseOrgUnitScopeSchema).max(500).optional(),
  memberUserIds: z.array(z.uuid()).max(500).optional(),
  retrievalConfig: knowledgeRetrievalConfigSchema.optional(),
  chunkingConfig: knowledgeChunkingConfigSchema.optional(),
  expectedVersion: z.number().int().positive(),
});

export const createKnowledgeDocumentRequestSchema = z.object({
  title: z.string().trim().min(1).max(300),
  sourceType: knowledgeSourceTypeSchema.default('TEXT'),
  mimeType: z.string().trim().max(160).optional(),
  fileName: z.string().trim().max(300).optional(),
  contentText: z.string().max(2_000_000).optional(),
  status: z.enum(['DRAFT', 'READY']).default('DRAFT'),
  folderId: z.uuid().nullable().optional(),
  governance: knowledgeDocumentGovernancePolicySchema.optional(),
});

export const importKnowledgeWebDocumentRequestSchema = z
  .object({
    url: z
      .url()
      .max(2_048)
      .refine((value) => new URL(value).protocol === 'https:', {
        message: 'Only HTTPS knowledge sources are allowed.',
      }),
    title: z.string().trim().min(1).max(300).optional(),
    changeSummary: z.string().trim().min(1).max(500).optional(),
    governance: knowledgeDocumentGovernancePolicySchema.optional(),
  })
  .strict();

export const reviewKnowledgeDocumentParseRequestSchema = z
  .object({
    decision: z.enum(['APPROVE', 'REJECT']),
    expectedReviewRevision: z.number().int().positive(),
    note: z.string().trim().min(1).max(2_000).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.decision === 'REJECT' && value.note === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['note'],
        message: 'A rejection reason is required.',
      });
    }
  });

export const updateKnowledgeDocumentVersionGovernanceRequestSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    policy: knowledgeDocumentGovernancePolicySchema,
  })
  .strict();

export const updateKnowledgeDocumentAccessRequestSchema = z
  .object({
    mode: z.enum(['INHERIT', 'RESTRICTED']),
    orgUnitIds: z.array(z.uuid()).max(500),
    memberUserIds: z.array(z.uuid()).max(500),
    expectedGovernanceRevision: z.number().int().positive(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.mode === 'RESTRICTED' &&
      value.orgUnitIds.length === 0 &&
      value.memberUserIds.length === 0
    ) {
      context.addIssue({
        code: 'custom',
        path: ['mode'],
        message: 'Restricted document access requires at least one department or member.',
      });
    }
    if (
      value.mode === 'INHERIT' &&
      (value.orgUnitIds.length > 0 || value.memberUserIds.length > 0)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['mode'],
        message: 'Inherited document access cannot contain additional scopes.',
      });
    }
  });

export const reviewKnowledgeDocumentGovernanceRequestSchema = z
  .object({
    decision: z.enum(['APPROVE', 'REJECT']),
    expectedRevision: z.number().int().positive(),
    note: z.string().trim().min(1).max(2_000).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.decision === 'REJECT' && value.note === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['note'],
        message: 'A governance rejection reason is required.',
      });
    }
  });

export const knowledgeParseReviewQueueResponseSchema = z.object({
  items: z.array(knowledgeDocumentVersionDetailSchema),
});

export const updateKnowledgeDocumentRequestSchema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  contentText: z.string().max(2_000_000).optional(),
  status: z.enum(['DRAFT', 'READY', 'ARCHIVED']).optional(),
  expectedVersion: z.number().int().positive(),
});

export const rollbackKnowledgeDocumentVersionRequestSchema = z.object({
  expectedCurrentVersionId: z.uuid(),
});

export const publishKnowledgeDocumentVersionRequestSchema = z.object({}).strict();

export const knowledgeEmbeddingRebuildResponseSchema = z.object({
  documentVersionId: z.uuid(),
  embeddingIndexVersionId: z.uuid(),
  embeddingIndexVersion: z.number().int().positive(),
  embeddingModel: z.string().min(1).max(200),
  dimensions: z.number().int().min(1).max(16_000),
  chunkCount: z.number().int().positive(),
});

export const knowledgeGraphRebuildResponseSchema = z.object({
  documentVersionId: z.uuid(),
  entityCount: z.number().int().nonnegative(),
  relationCount: z.number().int().nonnegative(),
  mentionCount: z.number().int().nonnegative(),
  evidenceCount: z.number().int().nonnegative(),
});

export const knowledgeRetrievalTestRequestSchema = z.object({
  query: z.string().trim().min(2).max(2_000),
  userId: z.uuid().optional(),
  documentVersionId: z.uuid().optional(),
  limit: z.number().int().min(1).max(20).default(8),
});

export const knowledgeRelationshipPathEdgeSchema = z
  .object({
    relationId: z.uuid(),
    predicate: z.string().trim().min(1).max(160),
    direction: z.enum(['OUTBOUND', 'INBOUND']),
    sourceEntityId: z.uuid(),
    sourceEntityName: z.string().trim().min(1).max(500),
    targetEntityId: z.uuid(),
    targetEntityName: z.string().trim().min(1).max(500),
  })
  .strict();

export const knowledgeRelationshipEvidenceSchema = z
  .object({
    relationId: z.uuid(),
    relationType: z.string().trim().min(1).max(160),
    sourceChunkId: z.uuid(),
    sourceEntityName: z.string().trim().min(1).max(500),
    targetEntityName: z.string().trim().min(1).max(500),
    direction: z.enum(['OUTBOUND', 'INBOUND']),
    hopDistance: z.union([z.literal(1), z.literal(2)]),
    confidence: z.number().min(0).max(1),
    contribution: z.number().min(0).max(1),
    path: z.array(knowledgeRelationshipPathEdgeSchema).min(1).max(2),
  })
  .superRefine((evidence, context) => {
    if (evidence.path.length !== evidence.hopDistance) {
      context.addIssue({
        code: 'custom',
        path: ['path'],
        message: 'Relationship path length must match hopDistance.',
      });
    }
  });

export const knowledgeRetrievalDiagnosticSchema = z.object({
  stage: z.enum(['ROUTER', 'LEXICAL', 'VECTOR', 'SQL', 'RELATIONSHIP', 'BUSINESS_API', 'RERANK']),
  status: z.enum(['APPLIED', 'SKIPPED', 'DEGRADED']),
  code: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .regex(/^[A-Z0-9_]+$/),
  candidateCount: z.number().int().nonnegative(),
});

export const knowledgeRetrievalTestResultSchema = z.object({
  chunkId: z.uuid(),
  knowledgeBaseId: z.uuid(),
  knowledgeBaseName: z.string().min(1),
  documentId: z.uuid(),
  documentVersionId: z.uuid(),
  documentVersion: z.number().int().positive(),
  title: z.string().min(1),
  headingPath: z.array(z.string()),
  pageStart: z.number().int().positive().nullable(),
  pageEnd: z.number().int().positive().nullable(),
  sheetName: z.string().min(1).max(200).nullable(),
  sourceMimeType: z.string().trim().min(1).max(255).nullable(),
  sourceFileName: z.string().trim().min(1).max(500).nullable(),
  sourceUri: z.url().max(2_048).nullable(),
  sourceDownloadAvailable: z.boolean(),
  structuredPreviewAvailable: z.boolean(),
  excerpt: z.string().min(1),
  keywordScore: z.number(),
  fuzzyScore: z.number(),
  semanticScore: z.number().nullable(),
  fusionScore: z.number(),
  rerankerScore: z.number().nullable(),
  relationshipScore: z.number().min(0).max(1).optional(),
  relationshipEvidence: z.array(knowledgeRelationshipEvidenceSchema).max(50).optional(),
  finalScore: z.number(),
});

export const knowledgeRetrievalTestResponseSchema = z.object({
  query: z.string(),
  simulatedUserId: z.uuid(),
  accessibleKnowledgeBaseIds: z.array(z.uuid()),
  mode: z.enum(['LEXICAL', 'HYBRID']),
  embeddingModel: z.string().min(1).max(200).nullable(),
  reranker: z.enum(['LEXICAL', 'WEIGHTED_SCORE', 'CROSS_ENCODER']),
  rerankerModel: z.string().min(1).max(200).nullable(),
  degradedReason: z.string().max(120).nullable(),
  lexicalCandidateCount: z.number().int().nonnegative(),
  vectorCandidateCount: z.number().int().nonnegative(),
  relationshipCandidateCount: z.number().int().nonnegative().optional(),
  relationshipExpandedCount: z.number().int().nonnegative().optional(),
  diagnostics: z.array(knowledgeRetrievalDiagnosticSchema).max(20).optional(),
  queryRoute: z
    .object({
      primary: z.enum(['DOCUMENT', 'SQL', 'RELATIONSHIP', 'BUSINESS_API']),
      fallback: z.array(z.enum(['DOCUMENT', 'SQL', 'RELATIONSHIP', 'BUSINESS_API'])).max(3),
      reasonCode: z.string().regex(/^[A-Z0-9_]+$/u),
    })
    .strict()
    .optional(),
  structuredQuerySql: z.string().max(10_000).nullable().optional(),
  semanticCoverage: z.number().min(0).max(1),
  noAnswer: z.boolean(),
  elapsedMs: z.number().nonnegative(),
  items: z.array(knowledgeRetrievalTestResultSchema),
});

export type AdminOrganizationResponse = z.infer<typeof adminOrganizationResponseSchema>;
export type AdminOrgUnit = z.infer<typeof adminOrgUnitSchema>;
export type AdminMember = z.infer<typeof adminMemberSchema>;
export type OrganizationSyncSource = z.infer<typeof organizationSyncSourceSchema>;
export type EmploymentType = z.infer<typeof employmentTypeSchema>;
export type FeishuOrganizationSyncStatusValue = z.infer<
  typeof feishuOrganizationSyncStatusValueSchema
>;
export type FeishuOrganizationSyncRun = z.infer<typeof feishuOrganizationSyncRunSchema>;
export type FeishuOrganizationSyncStatus = z.infer<typeof feishuOrganizationSyncStatusSchema>;
export type BindFeishuOrganizationRequest = z.infer<typeof bindFeishuOrganizationRequestSchema>;
export type FeishuDirectoryPreview = z.infer<typeof feishuDirectoryPreviewSchema>;
export type FeishuDirectoryPreviewItem = z.infer<typeof feishuDirectoryPreviewItemSchema>;
export type ApplyFeishuDirectoryPreviewRequest = z.infer<
  typeof applyFeishuDirectoryPreviewRequestSchema
>;
export type FeishuDirectorySyncRunDetail = z.infer<typeof feishuDirectorySyncRunDetailSchema>;
export type FeishuDirectorySyncRunList = z.infer<typeof feishuDirectorySyncRunListSchema>;
export type UpdateOrganizationRequest = z.infer<typeof updateOrganizationRequestSchema>;
export type CreateOrgUnitRequest = z.infer<typeof createOrgUnitRequestSchema>;
export type UpdateOrgUnitRequest = z.infer<typeof updateOrgUnitRequestSchema>;
export type CreateMemberRequest = z.infer<typeof createMemberRequestSchema>;
export type InviteMemberRequest = z.infer<typeof inviteMemberRequestSchema>;
export type MemberInvitation = z.infer<typeof memberInvitationSchema>;
export type IssueMemberInvitationResponse = z.infer<typeof issueMemberInvitationResponseSchema>;
export type UpdateMemberRequest = z.infer<typeof updateMemberRequestSchema>;
export type ResetMemberPasswordRequest = z.infer<typeof resetMemberPasswordRequestSchema>;
export type ResetMemberPasswordResponse = z.infer<typeof resetMemberPasswordResponseSchema>;
export type KnowledgeBase = z.infer<typeof knowledgeBaseSchema>;
export type KnowledgeFolder = z.infer<typeof knowledgeFolderSchema>;
export type EnsureKnowledgeFoldersRequest = z.infer<typeof ensureKnowledgeFoldersRequestSchema>;
export type KnowledgeFolderListResponse = z.infer<typeof knowledgeFolderListResponseSchema>;
export type KnowledgeSpace = z.infer<typeof knowledgeSpaceSchema>;
export type KnowledgeSpaceType = z.infer<typeof knowledgeSpaceTypeSchema>;
export type KnowledgeSpaceSelection = z.infer<typeof knowledgeSpaceSelectionSchema>;
export type KnowledgeEmbeddingIndexConfig = z.infer<typeof knowledgeEmbeddingIndexConfigSchema>;
export type KnowledgeEmbeddingIndexVersion = z.infer<typeof knowledgeEmbeddingIndexVersionSchema>;
export type KnowledgeEmbeddingIndexVersionListResponse = z.infer<
  typeof knowledgeEmbeddingIndexVersionListResponseSchema
>;
export type KnowledgeBaseOrgUnitScope = z.infer<typeof knowledgeBaseOrgUnitScopeSchema>;
export type KnowledgeBaseMemberScope = z.infer<typeof knowledgeBaseMemberScopeSchema>;
export type KnowledgeRetrievalMode = z.infer<typeof knowledgeRetrievalModeSchema>;
export type KnowledgeRetrievalConfig = z.infer<typeof knowledgeRetrievalConfigSchema>;
export type KnowledgeChunkingConfig = z.infer<typeof knowledgeChunkingConfigSchema>;
export type KnowledgeBaseListResponse = z.infer<typeof knowledgeBaseListResponseSchema>;
export type KnowledgeDocument = z.infer<typeof knowledgeDocumentSchema>;
export type KnowledgeDocumentSummary = z.infer<typeof knowledgeDocumentSummarySchema>;
export type KnowledgeDocumentVersionSummary = z.infer<typeof knowledgeDocumentVersionSummarySchema>;
export type KnowledgeDocumentVersionDetail = z.infer<typeof knowledgeDocumentVersionDetailSchema>;
export type KnowledgeParseReviewStatus = z.infer<typeof knowledgeParseReviewStatusSchema>;
export type KnowledgeParseReviewQueueResponse = z.infer<
  typeof knowledgeParseReviewQueueResponseSchema
>;
export type KnowledgeDocumentChunkPreview = z.infer<typeof knowledgeDocumentChunkPreviewSchema>;
export type KnowledgeStructuredDocumentPreview = z.infer<
  typeof knowledgeStructuredDocumentPreviewSchema
>;
export type KnowledgeDocumentChunkListResponse = z.infer<
  typeof knowledgeDocumentChunkListResponseSchema
>;
export type InspectKnowledgeUploadRequest = z.infer<typeof inspectKnowledgeUploadRequestSchema>;
export type KnowledgeUploadInspection = z.infer<typeof knowledgeUploadInspectionSchema>;
export type KnowledgeCapabilityStatus = z.infer<typeof knowledgeCapabilityStatusSchema>;
export type KnowledgeReadinessReason = z.infer<typeof knowledgeReadinessReasonSchema>;
export type KnowledgeCapabilityReadiness = z.infer<typeof knowledgeCapabilityReadinessSchema>;
export type KnowledgeBaseIndexReadiness = z.infer<typeof knowledgeBaseIndexReadinessSchema>;
export type KnowledgeGraphStatus = z.infer<typeof knowledgeGraphStatusSchema>;
export type KnowledgeGraphReadinessReason = z.infer<typeof knowledgeGraphReadinessReasonSchema>;
export type KnowledgeGraphOverview = z.infer<typeof knowledgeGraphOverviewSchema>;
export type KnowledgeGraphEntity = z.infer<typeof knowledgeGraphEntitySchema>;
export type KnowledgeGraphRelation = z.infer<typeof knowledgeGraphRelationSchema>;
export type KnowledgeGraphQuery = z.infer<typeof knowledgeGraphQuerySchema>;
export type KnowledgeGraphResponse = z.infer<typeof knowledgeGraphResponseSchema>;
export type KnowledgeIngestionJob = z.infer<typeof knowledgeIngestionJobSchema>;
export type CreateKnowledgeBaseRequest = z.infer<typeof createKnowledgeBaseRequestSchema>;
export type CreateKnowledgeEmbeddingIndexVersionRequest = z.infer<
  typeof createKnowledgeEmbeddingIndexVersionRequestSchema
>;
export type UpdateKnowledgeBaseRequest = z.infer<typeof updateKnowledgeBaseRequestSchema>;
export type CreateKnowledgeDocumentRequest = z.infer<typeof createKnowledgeDocumentRequestSchema>;
export type ImportKnowledgeWebDocumentRequest = z.infer<
  typeof importKnowledgeWebDocumentRequestSchema
>;
export type ReviewKnowledgeDocumentParseRequest = z.infer<
  typeof reviewKnowledgeDocumentParseRequestSchema
>;
export type KnowledgeDocumentGovernancePolicy = z.infer<
  typeof knowledgeDocumentGovernancePolicySchema
>;
export type KnowledgeDocumentGovernance = z.infer<typeof knowledgeDocumentGovernanceSchema>;
export type UpdateKnowledgeDocumentVersionGovernanceRequest = z.infer<
  typeof updateKnowledgeDocumentVersionGovernanceRequestSchema
>;
export type UpdateKnowledgeDocumentAccessRequest = z.infer<
  typeof updateKnowledgeDocumentAccessRequestSchema
>;
export type ReviewKnowledgeDocumentGovernanceRequest = z.infer<
  typeof reviewKnowledgeDocumentGovernanceRequestSchema
>;
export type UpdateKnowledgeDocumentRequest = z.infer<typeof updateKnowledgeDocumentRequestSchema>;
export type PublishKnowledgeDocumentVersionRequest = z.infer<
  typeof publishKnowledgeDocumentVersionRequestSchema
>;
export type RollbackKnowledgeDocumentVersionRequest = z.infer<
  typeof rollbackKnowledgeDocumentVersionRequestSchema
>;
export type KnowledgeEmbeddingRebuildResponse = z.infer<
  typeof knowledgeEmbeddingRebuildResponseSchema
>;
export type KnowledgeGraphRebuildResponse = z.infer<typeof knowledgeGraphRebuildResponseSchema>;
export type KnowledgeRetrievalTestRequest = z.infer<typeof knowledgeRetrievalTestRequestSchema>;
export type KnowledgeRelationshipPathEdge = z.infer<typeof knowledgeRelationshipPathEdgeSchema>;
export type KnowledgeRelationshipEvidence = z.infer<typeof knowledgeRelationshipEvidenceSchema>;
export type KnowledgeRetrievalDiagnostic = z.infer<typeof knowledgeRetrievalDiagnosticSchema>;
export type KnowledgeRetrievalTestResponse = z.infer<typeof knowledgeRetrievalTestResponseSchema>;

function isIanaTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}
