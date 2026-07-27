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
  status: z.enum(['ACTIVE', 'INACTIVE', 'LOCKED']),
  role: tenantRoleSchema,
  source: organizationSyncSourceSchema,
  employment: z
    .object({
      id: z.uuid(),
      organizationId: z.uuid(),
      orgUnitId: z.uuid(),
      title: z.string().nullable(),
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

export const updateOrganizationRequestSchema = z.object({
  name: z.string().trim().min(2).max(200).optional(),
  legalName: z.string().trim().max(300).nullable().optional(),
  timezone: z.string().trim().min(1).max(80).optional(),
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

export const createMemberRequestSchema = z.object({
  email: z
    .email()
    .max(320)
    .transform((value) => value.toLowerCase()),
  displayName: z.string().trim().min(1).max(120),
  password: z.string().min(10).max(128),
  role: tenantRoleSchema.default('MEMBER'),
  orgUnitId: z.uuid(),
  title: z.string().trim().min(1).max(200).optional(),
  employeeNumber: z.string().trim().min(1).max(255).optional(),
});

export const inviteMemberRequestSchema = createMemberRequestSchema.omit({ password: true });

export const memberInvitationSchema = z.object({
  id: z.uuid(),
  memberId: z.uuid(),
  email: z.email(),
  displayName: z.string().min(1),
  status: z.enum(['PENDING', 'SENT', 'DELIVERY_FAILED', 'ACCEPTED', 'EXPIRED', 'REVOKED']),
  deliveryStatus: z.enum(['NOT_CONFIGURED', 'PENDING', 'SENT', 'FAILED']),
  issuedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  consumedAt: z.iso.datetime().nullable(),
});

export const issueMemberInvitationResponseSchema = memberInvitationSchema.extend({
  // Returned once to an authorized administrator. Only its HMAC digest is persisted.
  acceptanceToken: z
    .string()
    .min(48)
    .max(160)
    .regex(/^ea_invite_[A-Za-z0-9_-]+$/),
  acceptanceUrl: z.url(),
});

export const updateMemberRequestSchema = z.object({
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
export const knowledgeDocumentStatusSchema = z.enum([
  'DRAFT',
  'PROCESSING',
  'READY',
  'FAILED',
  'ARCHIVED',
]);
export const knowledgeSourceTypeSchema = z.enum(['TEXT', 'MARKDOWN', 'FILE']);
export const knowledgeBaseOrgUnitScopeSchema = z.object({
  orgUnitId: z.uuid(),
  includeChildren: z.boolean(),
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
  ingestionJob: knowledgeIngestionJobSchema.nullable(),
});

export const knowledgeDocumentSummarySchema = z.object({
  id: z.uuid(),
  knowledgeBaseId: z.uuid(),
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
});

export const knowledgeDocumentChunkPreviewSchema = z.object({
  id: z.uuid(),
  chunkIndex: z.number().int().nonnegative(),
  headingPath: z.array(z.string()),
  content: z.string(),
  tokenCount: z.number().int().nonnegative(),
  contentHash: z.string().length(64),
  pageStart: z.number().int().positive().nullable(),
  pageEnd: z.number().int().positive().nullable(),
  embeddingModels: z.array(z.string().min(1).max(200)),
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
  provider: z.enum(['disabled', 'openai_compatible', 'cohere_compatible']),
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
  activationAllowed: z.boolean(),
  activationBlockers: z.array(knowledgeReadinessReasonSchema),
});

export const knowledgeBaseSchema = z.object({
  id: z.uuid(),
  key: z.string().min(1),
  name: z.string().min(1),
  description: z.string().nullable(),
  status: knowledgeBaseStatusSchema,
  version: z.number().int().positive(),
  orgUnitIds: z.array(z.uuid()),
  orgUnitScopes: z.array(knowledgeBaseOrgUnitScopeSchema),
  documentCount: z.number().int().nonnegative(),
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
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(4_000).nullable().optional(),
  status: knowledgeBaseStatusSchema.default('DRAFT'),
  orgUnitIds: z.array(z.uuid()).max(500).default([]),
  orgUnitScopes: z.array(knowledgeBaseOrgUnitScopeSchema).max(500).optional(),
});

export const updateKnowledgeBaseRequestSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(4_000).nullable().optional(),
  status: knowledgeBaseStatusSchema.optional(),
  orgUnitIds: z.array(z.uuid()).max(500).optional(),
  orgUnitScopes: z.array(knowledgeBaseOrgUnitScopeSchema).max(500).optional(),
  expectedVersion: z.number().int().positive(),
});

export const createKnowledgeDocumentRequestSchema = z.object({
  title: z.string().trim().min(1).max(300),
  sourceType: knowledgeSourceTypeSchema.default('TEXT'),
  mimeType: z.string().trim().max(160).optional(),
  fileName: z.string().trim().max(300).optional(),
  contentText: z.string().max(2_000_000).optional(),
  status: z.enum(['DRAFT', 'READY']).default('DRAFT'),
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

export const knowledgeEmbeddingRebuildResponseSchema = z.object({
  documentVersionId: z.uuid(),
  embeddingModel: z.string().min(1).max(200),
  dimensions: z.literal(1536),
  chunkCount: z.number().int().positive(),
});

export const knowledgeRetrievalTestRequestSchema = z.object({
  query: z.string().trim().min(2).max(2_000),
  userId: z.uuid().optional(),
  limit: z.number().int().min(1).max(20).default(8),
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
  excerpt: z.string().min(1),
  keywordScore: z.number(),
  fuzzyScore: z.number(),
  semanticScore: z.number().nullable(),
  fusionScore: z.number(),
  rerankerScore: z.number().nullable(),
  finalScore: z.number(),
});

export const knowledgeRetrievalTestResponseSchema = z.object({
  query: z.string(),
  simulatedUserId: z.uuid(),
  accessibleKnowledgeBaseIds: z.array(z.uuid()),
  mode: z.enum(['LEXICAL', 'HYBRID']),
  embeddingModel: z.string().min(1).max(200).nullable(),
  reranker: z.enum(['LEXICAL', 'RRF', 'CROSS_ENCODER']),
  rerankerModel: z.string().min(1).max(200).nullable(),
  degradedReason: z.string().max(120).nullable(),
  lexicalCandidateCount: z.number().int().nonnegative(),
  vectorCandidateCount: z.number().int().nonnegative(),
  semanticCoverage: z.number().min(0).max(1),
  noAnswer: z.boolean(),
  elapsedMs: z.number().nonnegative(),
  items: z.array(knowledgeRetrievalTestResultSchema),
});

export type AdminOrganizationResponse = z.infer<typeof adminOrganizationResponseSchema>;
export type AdminOrgUnit = z.infer<typeof adminOrgUnitSchema>;
export type AdminMember = z.infer<typeof adminMemberSchema>;
export type OrganizationSyncSource = z.infer<typeof organizationSyncSourceSchema>;
export type FeishuOrganizationSyncStatusValue = z.infer<
  typeof feishuOrganizationSyncStatusValueSchema
>;
export type FeishuOrganizationSyncRun = z.infer<typeof feishuOrganizationSyncRunSchema>;
export type FeishuOrganizationSyncStatus = z.infer<typeof feishuOrganizationSyncStatusSchema>;
export type BindFeishuOrganizationRequest = z.infer<typeof bindFeishuOrganizationRequestSchema>;
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
export type KnowledgeBaseOrgUnitScope = z.infer<typeof knowledgeBaseOrgUnitScopeSchema>;
export type KnowledgeBaseListResponse = z.infer<typeof knowledgeBaseListResponseSchema>;
export type KnowledgeDocument = z.infer<typeof knowledgeDocumentSchema>;
export type KnowledgeDocumentSummary = z.infer<typeof knowledgeDocumentSummarySchema>;
export type KnowledgeDocumentVersionSummary = z.infer<typeof knowledgeDocumentVersionSummarySchema>;
export type KnowledgeDocumentVersionDetail = z.infer<typeof knowledgeDocumentVersionDetailSchema>;
export type KnowledgeDocumentChunkPreview = z.infer<typeof knowledgeDocumentChunkPreviewSchema>;
export type KnowledgeDocumentChunkListResponse = z.infer<
  typeof knowledgeDocumentChunkListResponseSchema
>;
export type KnowledgeCapabilityStatus = z.infer<typeof knowledgeCapabilityStatusSchema>;
export type KnowledgeReadinessReason = z.infer<typeof knowledgeReadinessReasonSchema>;
export type KnowledgeCapabilityReadiness = z.infer<typeof knowledgeCapabilityReadinessSchema>;
export type KnowledgeBaseIndexReadiness = z.infer<typeof knowledgeBaseIndexReadinessSchema>;
export type KnowledgeIngestionJob = z.infer<typeof knowledgeIngestionJobSchema>;
export type CreateKnowledgeBaseRequest = z.infer<typeof createKnowledgeBaseRequestSchema>;
export type UpdateKnowledgeBaseRequest = z.infer<typeof updateKnowledgeBaseRequestSchema>;
export type CreateKnowledgeDocumentRequest = z.infer<typeof createKnowledgeDocumentRequestSchema>;
export type UpdateKnowledgeDocumentRequest = z.infer<typeof updateKnowledgeDocumentRequestSchema>;
export type RollbackKnowledgeDocumentVersionRequest = z.infer<
  typeof rollbackKnowledgeDocumentVersionRequestSchema
>;
export type KnowledgeEmbeddingRebuildResponse = z.infer<
  typeof knowledgeEmbeddingRebuildResponseSchema
>;
export type KnowledgeRetrievalTestRequest = z.infer<typeof knowledgeRetrievalTestRequestSchema>;
export type KnowledgeRetrievalTestResponse = z.infer<typeof knowledgeRetrievalTestResponseSchema>;
