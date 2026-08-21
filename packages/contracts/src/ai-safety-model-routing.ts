import { z } from 'zod';

const UUID = z.uuid();
const TIMESTAMP = z.iso.datetime();
const SHA256 = z.string().regex(/^[a-f0-9]{64}$/u);
const CODE = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[A-Z0-9][A-Z0-9._-]*$/u);
const IDEMPOTENCY_KEY = z.string().trim().min(1).max(200);
const CAPABILITY = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9][a-z0-9._-]*$/u);
const UNIQUE_CAPABILITIES = z
  .array(CAPABILITY)
  .min(1)
  .max(32)
  .refine((values) => new Set(values).size === values.length, 'Capabilities must be unique.');

export const aiGovernanceStatusSchema = z.enum(['DRAFT', 'IN_REVIEW', 'PUBLISHED', 'RETIRED']);
export const aiDataClassificationSchema = z.enum([
  'PUBLIC',
  'INTERNAL',
  'CONFIDENTIAL',
  'RESTRICTED',
]);
export const aiModelProviderSchema = z.enum(['OPENAI_COMPATIBLE', 'MANUS']);
export const aiModelCircuitStateSchema = z.enum(['CLOSED', 'OPEN', 'HALF_OPEN']);
export const aiSafetyActionSchema = z.enum(['ALLOW', 'REDACT', 'BLOCK']);
export const aiSafetyDirectionSchema = z.enum(['INPUT', 'OUTPUT']);

export const credentialReferenceSchema = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u)
  .refine(
    (value) => !/(?:secret|token|key)=/iu.test(value),
    'Use a credential-vault reference, never a plaintext credential.',
  );

export const aiModelCatalogVersionSchema = z
  .object({
    id: UUID,
    tenantId: UUID,
    routeKey: CODE,
    version: z.number().int().positive(),
    revision: z.number().int().positive(),
    status: aiGovernanceStatusSchema,
    provider: aiModelProviderSchema,
    modelName: z.string().trim().min(1).max(256),
    credentialReference: credentialReferenceSchema,
    dataResidency: z.string().trim().min(2).max(80),
    maximumClassification: aiDataClassificationSchema,
    capabilities: UNIQUE_CAPABILITIES,
    maxContextTokens: z.number().int().positive().max(2_000_000),
    maxOutputTokens: z.number().int().positive().max(200_000),
    inputCostMicrosPerMillion: z.string().regex(/^\d+$/u),
    outputCostMicrosPerMillion: z.string().regex(/^\d+$/u),
    p95LatencyMs: z.number().int().positive().max(3_600_000),
    configurationHash: SHA256,
    submittedByUserId: UUID.nullable(),
    reviewedByUserId: UUID.nullable(),
    publishedByUserId: UUID.nullable(),
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  })
  .strict();

export const createAiModelCatalogVersionRequestSchema = z
  .object({
    routeKey: CODE,
    provider: aiModelProviderSchema,
    modelName: z.string().trim().min(1).max(256),
    credentialReference: credentialReferenceSchema,
    dataResidency: z.string().trim().min(2).max(80),
    maximumClassification: aiDataClassificationSchema,
    capabilities: UNIQUE_CAPABILITIES,
    maxContextTokens: z.number().int().positive().max(2_000_000),
    maxOutputTokens: z.number().int().positive().max(200_000),
    inputCostMicrosPerMillion: z.string().regex(/^\d+$/u),
    outputCostMicrosPerMillion: z.string().regex(/^\d+$/u),
    p95LatencyMs: z.number().int().positive().max(3_600_000),
    idempotencyKey: IDEMPOTENCY_KEY,
  })
  .strict();

export const aiModelCandidateSchema = z
  .object({
    ordinal: z.number().int().min(1).max(3),
    catalogVersionId: UUID,
    routeKey: CODE,
    provider: aiModelProviderSchema,
    modelName: z.string().trim().min(1).max(256),
    credentialReference: credentialReferenceSchema,
    dataResidency: z.string().trim().min(2).max(80),
    maximumClassification: aiDataClassificationSchema,
    capabilities: UNIQUE_CAPABILITIES,
    p95LatencyMs: z.number().int().positive(),
    circuitState: aiModelCircuitStateSchema,
    circuitOpenedUntil: TIMESTAMP.nullable(),
  })
  .strict();

export const aiModelRoutePolicyVersionSchema = z
  .object({
    id: UUID,
    tenantId: UUID,
    taskClass: CODE,
    version: z.number().int().positive(),
    revision: z.number().int().positive(),
    status: aiGovernanceStatusSchema,
    allowedResidencies: z.array(z.string().trim().min(2).max(80)).min(1).max(32),
    maximumClassification: aiDataClassificationSchema,
    requiredCapabilities: UNIQUE_CAPABILITIES,
    maxP95LatencyMs: z.number().int().positive().max(3_600_000),
    maxInputCostMicrosPerMillion: z.string().regex(/^\d+$/u),
    maxOutputCostMicrosPerMillion: z.string().regex(/^\d+$/u),
    maximumAttempts: z.number().int().min(1).max(3),
    circuitFailureThreshold: z.number().int().min(1).max(100),
    circuitOpenSeconds: z.number().int().min(1).max(86_400),
    policyHash: SHA256,
    submittedByUserId: UUID.nullable(),
    reviewedByUserId: UUID.nullable(),
    publishedByUserId: UUID.nullable(),
    candidates: z.array(aiModelCandidateSchema).max(3),
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  })
  .strict();

export const createAiModelRoutePolicyVersionRequestSchema = z
  .object({
    taskClass: CODE,
    allowedResidencies: z
      .array(z.string().trim().min(2).max(80))
      .min(1)
      .max(32)
      .refine((values) => new Set(values).size === values.length),
    maximumClassification: aiDataClassificationSchema,
    requiredCapabilities: UNIQUE_CAPABILITIES,
    maxP95LatencyMs: z.number().int().positive().max(3_600_000),
    maxInputCostMicrosPerMillion: z.string().regex(/^\d+$/u),
    maxOutputCostMicrosPerMillion: z.string().regex(/^\d+$/u),
    maximumAttempts: z.number().int().min(1).max(3),
    circuitFailureThreshold: z.number().int().min(1).max(100),
    circuitOpenSeconds: z.number().int().min(1).max(86_400),
    catalogVersionIds: z
      .array(UUID)
      .min(1)
      .max(3)
      .refine((values) => new Set(values).size === values.length),
    idempotencyKey: IDEMPOTENCY_KEY,
  })
  .strict()
  .refine((value) => value.catalogVersionIds.length <= value.maximumAttempts, {
    path: ['catalogVersionIds'],
    message: 'Candidate count cannot exceed maximum attempts.',
  });

export const transitionAiGovernanceVersionRequestSchema = z
  .object({
    action: z.enum(['SUBMIT', 'PUBLISH', 'RETIRE']),
    expectedRevision: z.number().int().positive(),
    reason: z.string().trim().min(1).max(1_000),
    idempotencyKey: IDEMPOTENCY_KEY,
  })
  .strict();

export const aiModelRoutingListQuerySchema = z
  .object({
    status: aiGovernanceStatusSchema.optional(),
    taskClass: CODE.optional(),
  })
  .strict();

export const createAiModelConnectivityProbeRequestSchema = z
  .object({
    idempotencyKey: IDEMPOTENCY_KEY,
  })
  .strict();

export const aiModelConnectivityProbeResultSchema = z
  .object({
    runId: UUID,
    agentId: UUID,
    targetCatalogVersionId: UUID,
    status: z.enum(['SUCCEEDED', 'FAILED', 'UNKNOWN']),
    evidenceStatus: z.enum(['VERIFIED', 'INSUFFICIENT_EVIDENCE']),
    reasonCode: z
      .string()
      .regex(/^[A-Z0-9_]{1,120}$/u)
      .nullable(),
    successfulReceiptCatalogVersionIds: z.array(UUID),
    checkedAt: TIMESTAMP,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.evidenceStatus === 'VERIFIED' &&
      (value.status !== 'SUCCEEDED' ||
        value.reasonCode !== null ||
        !value.successfulReceiptCatalogVersionIds.includes(value.targetCatalogVersionId))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['evidenceStatus'],
        message: 'Verified connectivity requires a successful target-catalog attempt receipt.',
      });
    }
  });

export const trustedModelRouteCandidateSchema = z
  .object({
    ordinal: z.number().int().min(1).max(3),
    catalogVersionId: UUID,
    routeKey: CODE,
    provider: aiModelProviderSchema,
    model: z.string().trim().min(1).max(256),
    credentialReference: credentialReferenceSchema,
  })
  .strict();

export const trustedModelRouteSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    policyVersionId: UUID,
    policyVersion: z.number().int().positive(),
    policyHash: SHA256,
    taskClass: CODE,
    maximumClassification: aiDataClassificationSchema,
    effectiveClassification: aiDataClassificationSchema.optional(),
    requiredCapabilities: UNIQUE_CAPABILITIES,
    maximumAttempts: z.number().int().min(1).max(3),
    circuitFailureThreshold: z.number().int().min(1).max(100),
    circuitOpenSeconds: z.number().int().min(1).max(86_400),
    candidates: z.array(trustedModelRouteCandidateSchema).min(1).max(3),
  })
  .strict()
  .refine((value) => value.candidates.length <= value.maximumAttempts, {
    path: ['candidates'],
    message: 'Candidate count exceeds the snapshotted attempt budget.',
  })
  .refine(
    (value) =>
      value.effectiveClassification === undefined ||
      ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'].indexOf(value.effectiveClassification) <=
        ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'].indexOf(value.maximumClassification),
    {
      path: ['effectiveClassification'],
      message: 'Effective classification exceeds the route maximum.',
    },
  );

export const aiSafetyDecisionSchema = z
  .object({
    direction: aiSafetyDirectionSchema,
    classification: aiDataClassificationSchema,
    action: aiSafetyActionSchema,
    reasonCodes: z
      .array(z.string().regex(/^[A-Z0-9_]{1,120}$/u))
      .min(1)
      .max(32),
    contentSha256: SHA256,
    redactedContentSha256: SHA256.nullable(),
    detectorVersion: z.string().trim().min(1).max(120),
    decisionHash: SHA256,
  })
  .strict();

export const aiModelRoutingDashboardSchema = z
  .object({
    catalogVersions: z.array(aiModelCatalogVersionSchema),
    routePolicies: z.array(aiModelRoutePolicyVersionSchema),
    readiness: z
      .object({
        publishedCatalogCount: z.number().int().nonnegative(),
        publishedPolicyCount: z.number().int().nonnegative(),
        activeCandidateCount: z.number().int().nonnegative(),
        invalidPublishedPolicyCount: z.number().int().nonnegative(),
        runtimeAllowlistedCandidateCount: z.number().int().nonnegative(),
        recentSuccessfulCandidateCount: z.number().int().nonnegative(),
        openCircuitCount: z.number().int().nonnegative(),
        blockedSafetyDecisionCount24h: z.number().int().nonnegative(),
        status: z.enum(['READY', 'NOT_READY']),
        evidenceStatus: z.enum(['VERIFIED', 'INSUFFICIENT_EVIDENCE']),
        ready: z.boolean(),
        reasonCodes: z.array(z.string().regex(/^[A-Z0-9_]{1,120}$/u)),
        runtime: z
          .object({
            status: z.enum(['READY', 'NOT_READY', 'UNAVAILABLE']),
            requireTrustedRoute: z.boolean().nullable(),
            providerReady: z.boolean().nullable(),
            checkedAt: TIMESTAMP.nullable(),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

export type AiGovernanceStatus = z.infer<typeof aiGovernanceStatusSchema>;
export type AiDataClassification = z.infer<typeof aiDataClassificationSchema>;
export type AiModelProvider = z.infer<typeof aiModelProviderSchema>;
export type AiModelCatalogVersion = z.infer<typeof aiModelCatalogVersionSchema>;
export type AiModelRoutePolicyVersion = z.infer<typeof aiModelRoutePolicyVersionSchema>;
export type AiModelRoutingDashboard = z.infer<typeof aiModelRoutingDashboardSchema>;
export type CreateAiModelCatalogVersionRequest = z.infer<
  typeof createAiModelCatalogVersionRequestSchema
>;
export type CreateAiModelRoutePolicyVersionRequest = z.infer<
  typeof createAiModelRoutePolicyVersionRequestSchema
>;
export type CreateAiModelConnectivityProbeRequest = z.infer<
  typeof createAiModelConnectivityProbeRequestSchema
>;
export type AiModelConnectivityProbeResult = z.infer<typeof aiModelConnectivityProbeResultSchema>;
export type TransitionAiGovernanceVersionRequest = z.infer<
  typeof transitionAiGovernanceVersionRequestSchema
>;
export type AiModelRoutingListQuery = z.infer<typeof aiModelRoutingListQuerySchema>;
export type TrustedModelRouteSnapshot = z.infer<typeof trustedModelRouteSnapshotSchema>;
export type TrustedModelRouteCandidate = z.infer<typeof trustedModelRouteCandidateSchema>;
export type AiSafetyDecision = z.infer<typeof aiSafetyDecisionSchema>;
