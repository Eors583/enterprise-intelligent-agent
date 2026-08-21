import { z } from 'zod';

const safeKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9][a-z0-9._-]*$/);
const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/);
const opaqueMfaChallengeSchema = z
  .string()
  .min(48)
  .max(200)
  .regex(/^ea_mfa_[A-Za-z0-9_-]+$/);
const totpCodeSchema = z
  .string()
  .trim()
  .regex(/^\d{6}$/);
const recoveryCodeSchema = z
  .string()
  .trim()
  .min(12)
  .max(64)
  .transform((value) => value.toUpperCase().replaceAll(/\s|-/g, ''));

export const identityDeviceRegistrationSchema = z
  .object({
    fingerprint: z.string().min(16).max(512),
    label: z.string().trim().min(1).max(120).optional(),
    platform: z.string().trim().min(1).max(80).optional(),
    deviceClass: z.string().trim().min(1).max(40).optional(),
  })
  .strict();

export const mfaLoginChallengeResponseSchema = z
  .object({
    kind: z.literal('MFA_REQUIRED'),
    challenge: opaqueMfaChallengeSchema,
    expiresAt: z.iso.datetime(),
    methods: z.array(z.enum(['TOTP', 'RECOVERY_CODE'])).min(1),
  })
  .strict();

export const mfaLoginVerifyRequestSchema = z
  .object({
    challenge: opaqueMfaChallengeSchema,
    code: z.string().trim().min(6).max(64),
    method: z.enum(['TOTP', 'RECOVERY_CODE']),
    sessionLabel: z.string().trim().min(1).max(120).optional(),
    device: identityDeviceRegistrationSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const parsed =
      value.method === 'TOTP'
        ? totpCodeSchema.safeParse(value.code)
        : recoveryCodeSchema.safeParse(value.code);
    if (!parsed.success) {
      context.addIssue({
        code: 'custom',
        message:
          value.method === 'TOTP'
            ? 'The authenticator code must contain six digits.'
            : 'The recovery code is invalid.',
        path: ['code'],
      });
    }
  });

export const mfaEnrollmentStartRequestSchema = z
  .object({
    label: z.string().trim().min(1).max(120).optional(),
  })
  .strict();

export const mfaEnrollmentStartResponseSchema = z
  .object({
    factorId: z.uuid(),
    otpauthUri: z.string().startsWith('otpauth://totp/').max(2048),
    secret: z.string().regex(/^[A-Z2-7]{16,128}$/),
    expiresAt: z.iso.datetime(),
  })
  .strict();

export const mfaEnrollmentVerifyRequestSchema = z
  .object({
    factorId: z.uuid(),
    code: totpCodeSchema,
  })
  .strict();

export const mfaEnrollmentVerifyResponseSchema = z
  .object({
    factor: z
      .object({
        id: z.uuid(),
        method: z.literal('TOTP'),
        status: z.literal('ACTIVE'),
        label: z.string().nullable(),
        verifiedAt: z.iso.datetime(),
        revision: z.number().int().positive(),
      })
      .strict(),
    recoveryCodes: z.array(z.string().min(12).max(64)).min(8).max(20),
  })
  .strict();

export const mfaFactorMetadataSchema = z
  .object({
    id: z.uuid(),
    method: z.literal('TOTP'),
    status: z.enum(['PENDING', 'ACTIVE', 'DISABLED']),
    label: z.string().nullable(),
    verifiedAt: z.iso.datetime().nullable(),
    disabledAt: z.iso.datetime().nullable(),
    blockedUntil: z.iso.datetime().nullable(),
    revision: z.number().int().positive(),
  })
  .strict();

export const mfaStatusResponseSchema = z
  .object({
    factors: z.array(mfaFactorMetadataSchema),
    recoveryCodesRemaining: z.number().int().nonnegative(),
    recentMfaAt: z.iso.datetime().nullable(),
  })
  .strict();

export const recentMfaChallengeRequestSchema = z
  .object({
    purpose: z.string().trim().min(1).max(120),
  })
  .strict();

export const recentMfaChallengeResponseSchema = z
  .object({
    challenge: opaqueMfaChallengeSchema,
    expiresAt: z.iso.datetime(),
    methods: z.array(z.enum(['TOTP', 'RECOVERY_CODE'])).min(1),
  })
  .strict();

export const recentMfaVerifyRequestSchema = z
  .object({
    challenge: opaqueMfaChallengeSchema,
    code: z.string().trim().min(6).max(64),
    method: z.enum(['TOTP', 'RECOVERY_CODE']),
  })
  .strict()
  .superRefine((value, context) => {
    const parsed =
      value.method === 'TOTP'
        ? totpCodeSchema.safeParse(value.code)
        : recoveryCodeSchema.safeParse(value.code);
    if (!parsed.success) {
      context.addIssue({
        code: 'custom',
        message:
          value.method === 'TOTP'
            ? 'The authenticator code must contain six digits.'
            : 'The recovery code is invalid.',
        path: ['code'],
      });
    }
  });

export const recentMfaVerifyResponseSchema = z
  .object({
    verifiedAt: z.iso.datetime(),
    method: z.enum(['TOTP', 'RECOVERY_CODE']),
  })
  .strict();

export const identityDeviceSchema = z
  .object({
    id: z.uuid(),
    label: z.string().nullable(),
    platform: z.string().nullable(),
    deviceClass: z.string().nullable(),
    status: z.enum(['ACTIVE', 'REVOKED']),
    firstSeenAt: z.iso.datetime(),
    lastSeenAt: z.iso.datetime(),
    revokedAt: z.iso.datetime().nullable(),
    revokeReason: z.string().nullable(),
    revision: z.number().int().positive(),
  })
  .strict();

export const identitySessionSchema = z
  .object({
    id: z.uuid(),
    deviceId: z.uuid().nullable(),
    label: z.string().nullable(),
    accessExpiresAt: z.iso.datetime(),
    refreshExpiresAt: z.iso.datetime(),
    lastUsedAt: z.iso.datetime(),
    lastMfaAt: z.iso.datetime().nullable(),
    lastMfaMethod: z.enum(['TOTP', 'RECOVERY_CODE']).nullable(),
    refreshGeneration: z.number().int().positive(),
    refreshReplayDetectedAt: z.iso.datetime().nullable(),
    revokedAt: z.iso.datetime().nullable(),
    revokedReason: z.string().nullable(),
    createdAt: z.iso.datetime(),
    current: z.boolean(),
    version: z.number().int().positive(),
  })
  .strict();

export const identitySecurityOverviewSchema = z
  .object({
    mfa: mfaStatusResponseSchema,
    devices: z.array(identityDeviceSchema),
    sessions: z.array(identitySessionSchema),
  })
  .strict();

export const revokeIdentityResourceRequestSchema = z
  .object({
    reason: z.string().trim().min(1).max(500),
    expectedRevision: z.number().int().positive(),
  })
  .strict();

export const revokeIdentityResourceResponseSchema = z
  .object({
    revokedAt: z.iso.datetime(),
    revokedSessionCount: z.number().int().nonnegative(),
    revision: z.number().int().positive(),
  })
  .strict();

export const identityPublicationStatusSchema = z.enum([
  'DRAFT',
  'IN_REVIEW',
  'PUBLISHED',
  'RETIRED',
]);
export const identityVerificationStatusSchema = z.enum(['NOT_VERIFIED', 'VERIFIED', 'FAILED']);

export const identityPolicySchema = z
  .object({
    id: z.uuid(),
    publicationStatus: identityPublicationStatusSchema,
    mfaRequirement: z.enum(['OPTIONAL', 'ADMINS', 'ALL_USERS']),
    requireRecentMfaForAdmin: z.boolean(),
    recentMfaMaxAgeSeconds: z.number().int().min(60).max(3600),
    totpAllowedDriftSteps: z.number().int().min(0).max(1),
    totpMaxAttempts: z.number().int().min(3).max(20),
    totpAttemptWindowSeconds: z.number().int().min(60).max(3600),
    allowLocalPasswordFallback: z.boolean(),
    revision: z.number().int().positive(),
    proposedByUserId: z.uuid(),
    approvedByUserId: z.uuid().nullable(),
    approvedAt: z.iso.datetime().nullable(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

export const upsertIdentityPolicyRequestSchema = z
  .object({
    mfaRequirement: z.enum(['OPTIONAL', 'ADMINS', 'ALL_USERS']),
    requireRecentMfaForAdmin: z.boolean(),
    recentMfaMaxAgeSeconds: z.number().int().min(60).max(3600),
    totpAllowedDriftSteps: z.number().int().min(0).max(1),
    totpMaxAttempts: z.number().int().min(3).max(20),
    totpAttemptWindowSeconds: z.number().int().min(60).max(3600),
    allowLocalPasswordFallback: z.boolean(),
    expectedRevision: z.number().int().nonnegative(),
    idempotencyKey: z.string().trim().min(8).max(200),
  })
  .strict();

const httpsUrlSchema = z
  .url()
  .max(1000)
  .refine((value) => new URL(value).protocol === 'https:', 'HTTPS is required.');

export const oidcProviderInputSchema = z
  .object({
    key: safeKeySchema,
    displayName: z.string().trim().min(1).max(200),
    issuer: httpsUrlSchema,
    discoveryUrl: httpsUrlSchema,
    clientId: z.string().trim().min(1).max(500),
    clientSecret: z.string().min(8).max(4096).optional(),
    scopes: z.array(z.string().trim().min(1).max(100)).min(1).max(20),
    jitMode: z.enum(['DISABLED', 'EXISTING_USERS_ONLY', 'CREATE_USERS']),
    allowVerifiedEmailLinking: z.boolean(),
    allowedEmailDomains: z
      .array(
        z
          .string()
          .trim()
          .toLowerCase()
          .regex(/^[a-z0-9.-]+\.[a-z]{2,}$/),
      )
      .max(100),
    clockSkewSeconds: z.number().int().min(0).max(300),
    expectedRevision: z.number().int().nonnegative(),
    idempotencyKey: z.string().trim().min(8).max(200),
  })
  .strict()
  .refine((value) => value.scopes.includes('openid'), {
    message: 'OIDC scopes must include openid.',
    path: ['scopes'],
  });

export const identityProviderSchema = z
  .object({
    id: z.uuid(),
    key: safeKeySchema,
    displayName: z.string(),
    protocol: z.enum(['OIDC', 'SAML']),
    verificationStatus: identityVerificationStatusSchema,
    publicationStatus: identityPublicationStatusSchema,
    verificationErrorCode: z.string().nullable(),
    verifiedAt: z.iso.datetime().nullable(),
    jitMode: z.enum(['DISABLED', 'EXISTING_USERS_ONLY', 'CREATE_USERS']),
    allowVerifiedEmailLinking: z.boolean(),
    allowedEmailDomains: z.array(z.string()),
    revision: z.number().int().positive(),
    proposedByUserId: z.uuid(),
    approvedByUserId: z.uuid().nullable(),
    approvedAt: z.iso.datetime().nullable(),
    secretConfigured: z.boolean(),
    oidc: z
      .object({
        issuer: z.string(),
        discoveryUrl: z.string(),
        authorizationEndpoint: z.string(),
        tokenEndpoint: z.string(),
        jwksUri: z.string(),
        clientId: z.string(),
        scopes: z.array(z.string()),
        discoveredAt: z.iso.datetime(),
        clockSkewSeconds: z.number().int(),
      })
      .strict()
      .nullable(),
    samlFailClosed: z.boolean(),
  })
  .strict();

export const identityProviderListResponseSchema = z
  .object({ items: z.array(identityProviderSchema) })
  .strict();

export const identityProviderCommandRequestSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    idempotencyKey: z.string().trim().min(8).max(200),
  })
  .strict();

export const breakGlassScopeSchema = z.enum([
  'IDENTITY_PROVIDER_RECOVERY',
  'AUTHENTICATION_POLICY_RECOVERY',
  'SESSION_REVOCATION',
  'SCIM_RECOVERY',
]);

export const breakGlassStatusSchema = z.enum([
  'PENDING_APPROVAL',
  'APPROVED',
  'ACTIVE',
  'REVIEW_PENDING',
  'CLOSED',
  'REJECTED',
]);

export const breakGlassRequestSchema = z
  .object({
    id: z.uuid(),
    requesterUserId: z.uuid(),
    scopes: z.array(breakGlassScopeSchema).min(1).max(8),
    reason: z.string(),
    requestedDurationSeconds: z.number().int().min(60).max(900),
    status: breakGlassStatusSchema,
    approvedByUserId: z.uuid().nullable(),
    approvalComment: z.string().nullable(),
    approvedAt: z.iso.datetime().nullable(),
    rejectedByUserId: z.uuid().nullable(),
    rejectionReason: z.string().nullable(),
    rejectedAt: z.iso.datetime().nullable(),
    activatedAt: z.iso.datetime().nullable(),
    activeUntil: z.iso.datetime().nullable(),
    effective: z.boolean(),
    terminationKind: z.enum(['EXPIRED', 'REVOKED']).nullable(),
    terminatedAt: z.iso.datetime().nullable(),
    revokedByUserId: z.uuid().nullable(),
    revocationReason: z.string().nullable(),
    reviewedByUserId: z.uuid().nullable(),
    reviewOutcome: z.enum(['NO_ISSUE', 'FOLLOW_UP_REQUIRED', 'CONTROL_GAP_FOUND']).nullable(),
    reviewSummary: z.string().nullable(),
    reviewedAt: z.iso.datetime().nullable(),
    closedAt: z.iso.datetime().nullable(),
    revision: z.number().int().positive(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

export const breakGlassListResponseSchema = z
  .object({ items: z.array(breakGlassRequestSchema) })
  .strict();

export const createBreakGlassRequestSchema = z
  .object({
    scopes: z.array(breakGlassScopeSchema).min(1).max(8),
    reason: z.string().trim().min(20).max(1000),
    requestedDurationSeconds: z.number().int().min(60).max(900),
    idempotencyKey: z.string().trim().min(8).max(200),
  })
  .strict();

export const breakGlassDecisionRequestSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    idempotencyKey: z.string().trim().min(8).max(200),
    comment: z.string().trim().min(10).max(1000),
  })
  .strict();

export const breakGlassActivateRequestSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    idempotencyKey: z.string().trim().min(8).max(200),
  })
  .strict();

export const breakGlassRevokeRequestSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    idempotencyKey: z.string().trim().min(8).max(200),
    reason: z.string().trim().min(10).max(1000),
  })
  .strict();

export const closeBreakGlassReviewRequestSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    idempotencyKey: z.string().trim().min(8).max(200),
    outcome: z.enum(['NO_ISSUE', 'FOLLOW_UP_REQUIRED', 'CONTROL_GAP_FOUND']),
    summary: z.string().trim().min(20).max(2000),
  })
  .strict();

export const activeBreakGlassGrantSchema = z
  .object({
    scope: breakGlassScopeSchema,
    active: z.boolean(),
  })
  .strict();

export const oidcLoginStartRequestSchema = z
  .object({
    tenantSlug: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .transform((value) => value.toLowerCase()),
    providerKey: safeKeySchema,
    redirectUri: httpsUrlSchema,
    sessionLabel: z.string().trim().min(1).max(120).optional(),
  })
  .strict();

export const oidcPublicProviderListResponseSchema = z
  .object({
    items: z.array(
      z
        .object({
          key: safeKeySchema,
          displayName: z.string().min(1).max(200),
          protocol: z.literal('OIDC'),
        })
        .strict(),
    ),
  })
  .strict();

export const oidcLoginStartResponseSchema = z
  .object({
    authorizationUrl: httpsUrlSchema,
    expiresAt: z.iso.datetime(),
  })
  .strict();

export const oidcLoginCallbackRequestSchema = z
  .object({
    state: z.string().min(32).max(512),
    code: z.string().min(1).max(4096),
    sessionLabel: z.string().trim().min(1).max(120).optional(),
  })
  .strict();

export const scimConnectorSchema = z
  .object({
    id: z.uuid(),
    key: safeKeySchema,
    displayName: z.string().min(1).max(200),
    status: z.enum(['DRAFT', 'IN_REVIEW', 'ACTIVE', 'SUSPENDED', 'RETIRED']),
    basePath: z.string().startsWith('/api/v1/scim/'),
    allowUserCreate: z.boolean(),
    allowGroupCreate: z.boolean(),
    deactivateUserOnScimDisable: z.boolean(),
    revision: z.number().int().positive(),
    proposedByUserId: z.uuid(),
    approvedByUserId: z.uuid().nullable(),
    approvedAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

export const scimConnectorCreateRequestSchema = z
  .object({
    key: safeKeySchema,
    displayName: z.string().trim().min(1).max(200),
    allowUserCreate: z.boolean(),
    allowGroupCreate: z.boolean(),
    deactivateUserOnScimDisable: z.boolean(),
    expectedRevision: z.literal(0),
    idempotencyKey: z.string().trim().min(8).max(200),
  })
  .strict();

export const scimConnectorUpdateRequestSchema = z
  .object({
    displayName: z.string().trim().min(1).max(200),
    allowUserCreate: z.boolean(),
    allowGroupCreate: z.boolean(),
    deactivateUserOnScimDisable: z.boolean(),
    expectedRevision: z.number().int().positive(),
    idempotencyKey: z.string().trim().min(8).max(200),
  })
  .strict();

export const scimConnectorCommandRequestSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    idempotencyKey: z.string().trim().min(8).max(200),
  })
  .strict();

export const scimConnectorListResponseSchema = z
  .object({ items: z.array(scimConnectorSchema) })
  .strict();

export const scimScopeSchema = z.enum([
  'scim.users.read',
  'scim.users.write',
  'scim.groups.read',
  'scim.groups.write',
]);

export const scimServiceTokenMetadataSchema = z
  .object({
    id: z.uuid(),
    connectorId: z.uuid(),
    tokenHint: z.string().min(4).max(12),
    status: z.enum(['ACTIVE', 'REVOKED', 'EXPIRED']),
    scopes: z.array(scimScopeSchema).min(1).max(4),
    createdByUserId: z.uuid(),
    expiresAt: z.iso.datetime().nullable(),
    lastUsedAt: z.iso.datetime().nullable(),
    revokedAt: z.iso.datetime().nullable(),
    revision: z.number().int().positive(),
    createdAt: z.iso.datetime(),
  })
  .strict();

export const scimServiceTokenListResponseSchema = z
  .object({ items: z.array(scimServiceTokenMetadataSchema) })
  .strict();

const scimServiceTokenConfigurationSchema = z
  .object({
    scopes: z.array(scimScopeSchema).min(1).max(4),
    expiresAt: z.iso.datetime().nullable(),
    idempotencyKey: z.string().trim().min(8).max(200),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.scopes).size !== value.scopes.length) {
      context.addIssue({
        code: 'custom',
        message: 'SCIM service-token scopes must be unique.',
        path: ['scopes'],
      });
    }
  });

export const createScimServiceTokenRequestSchema = scimServiceTokenConfigurationSchema;

export const rotateScimServiceTokenRequestSchema = scimServiceTokenConfigurationSchema.safeExtend({
  expectedRevision: z.number().int().positive(),
});

export const revokeScimServiceTokenRequestSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    idempotencyKey: z.string().trim().min(8).max(200),
  })
  .strict();

export const scimResourceMetadataSchema = z
  .object({
    resourceType: z.string(),
    created: z.iso.datetime(),
    lastModified: z.iso.datetime(),
    version: z.string().regex(/^W\/"[0-9a-f]{64}"$/),
    location: z.string(),
  })
  .strict();

export const scimUserSchema = z
  .object({
    schemas: z.array(z.literal('urn:ietf:params:scim:schemas:core:2.0:User')).length(1),
    id: z.string().min(1),
    externalId: z.string().optional(),
    userName: z.string().min(1),
    displayName: z.string().min(1),
    active: z.boolean(),
    meta: scimResourceMetadataSchema,
  })
  .passthrough();

export const scimGroupSchema = z
  .object({
    schemas: z.array(z.literal('urn:ietf:params:scim:schemas:core:2.0:Group')).length(1),
    id: z.string().min(1),
    externalId: z.string().optional(),
    displayName: z.string().min(1),
    members: z
      .array(
        z
          .object({
            value: z.string().min(1),
            display: z.string().optional(),
          })
          .strict(),
      )
      .default([]),
    meta: scimResourceMetadataSchema,
  })
  .strict();

export const scimListResponseSchema = z
  .object({
    schemas: z.array(z.literal('urn:ietf:params:scim:api:messages:2.0:ListResponse')).length(1),
    totalResults: z.number().int().nonnegative(),
    startIndex: z.number().int().positive(),
    itemsPerPage: z.number().int().nonnegative(),
    Resources: z.array(z.unknown()),
  })
  .strict();

export const scimErrorSchema = z
  .object({
    schemas: z.array(z.literal('urn:ietf:params:scim:api:messages:2.0:Error')).length(1),
    status: z.string().regex(/^[45]\d\d$/),
    scimType: z.string().optional(),
    detail: z.string(),
  })
  .strict();

export const SCIM_BULK_MAX_OPERATIONS = 100;
export const SCIM_BULK_MAX_PAYLOAD_BYTES = 98_304;

export const scimBulkOperationSchema = z
  .object({
    method: z.enum(['POST', 'PUT', 'PATCH', 'DELETE']),
    bulkId: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[A-Za-z0-9._~-]+$/)
      .optional(),
    path: z.string().trim().min(1).max(1000),
    version: z
      .string()
      .regex(/^W\/"[0-9a-f]{64}"$/)
      .optional(),
    data: z.unknown().optional(),
  })
  .strict()
  .superRefine((operation, context) => {
    if (operation.method === 'POST' && operation.bulkId === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'POST Bulk operations require bulkId.',
        path: ['bulkId'],
      });
    }
    if (operation.method !== 'POST' && operation.bulkId !== undefined) {
      context.addIssue({
        code: 'custom',
        message: 'bulkId is only valid for POST Bulk operations.',
        path: ['bulkId'],
      });
    }
    if (operation.method === 'DELETE' && operation.data !== undefined) {
      context.addIssue({
        code: 'custom',
        message: 'DELETE Bulk operations cannot include data.',
        path: ['data'],
      });
    }
    if (operation.method !== 'DELETE' && operation.data === undefined) {
      context.addIssue({
        code: 'custom',
        message: `${operation.method} Bulk operations require data.`,
        path: ['data'],
      });
    }
  });

export const scimBulkRequestSchema = z
  .object({
    schemas: z.array(z.literal('urn:ietf:params:scim:api:messages:2.0:BulkRequest')).length(1),
    failOnErrors: z.number().int().min(0).max(SCIM_BULK_MAX_OPERATIONS).optional(),
    Operations: z.array(scimBulkOperationSchema).min(1).max(SCIM_BULK_MAX_OPERATIONS),
  })
  .strict();

export const scimBulkResponseOperationSchema = z
  .object({
    method: z.enum(['POST', 'PUT', 'PATCH', 'DELETE']),
    bulkId: z.string().min(1).max(100).optional(),
    location: z.string().min(1).max(2000).optional(),
    version: z
      .string()
      .regex(/^W\/"[0-9a-f]{64}"$/)
      .optional(),
    status: z.string().regex(/^[1-5]\d\d$/),
    response: z.unknown().optional(),
  })
  .strict();

export const scimBulkResponseSchema = z
  .object({
    schemas: z.array(z.literal('urn:ietf:params:scim:api:messages:2.0:BulkResponse')).length(1),
    Operations: z.array(scimBulkResponseOperationSchema),
  })
  .strict();

export const scimServiceTokenCreatedSchema = z
  .object({
    id: z.uuid(),
    connectorId: z.uuid(),
    token: z.string().regex(/^ea_scim_[A-Za-z0-9_-]{32,}$/),
    tokenHint: z.string().min(4).max(12),
    status: z.literal('ACTIVE'),
    scopes: z.array(scimScopeSchema).min(1).max(4),
    createdByUserId: z.uuid(),
    expiresAt: z.iso.datetime().nullable(),
    lastUsedAt: z.null(),
    revokedAt: z.null(),
    revision: z.literal(1),
    createdAt: z.iso.datetime(),
  })
  .strict();

export type MfaLoginChallengeResponse = z.infer<typeof mfaLoginChallengeResponseSchema>;
export type IdentityDeviceRegistration = z.infer<typeof identityDeviceRegistrationSchema>;
export type MfaLoginVerifyRequest = z.infer<typeof mfaLoginVerifyRequestSchema>;
export type MfaEnrollmentStartRequest = z.infer<typeof mfaEnrollmentStartRequestSchema>;
export type MfaEnrollmentStartResponse = z.infer<typeof mfaEnrollmentStartResponseSchema>;
export type MfaEnrollmentVerifyRequest = z.infer<typeof mfaEnrollmentVerifyRequestSchema>;
export type MfaEnrollmentVerifyResponse = z.infer<typeof mfaEnrollmentVerifyResponseSchema>;
export type MfaStatusResponse = z.infer<typeof mfaStatusResponseSchema>;
export type RecentMfaChallengeRequest = z.infer<typeof recentMfaChallengeRequestSchema>;
export type RecentMfaChallengeResponse = z.infer<typeof recentMfaChallengeResponseSchema>;
export type RecentMfaVerifyRequest = z.infer<typeof recentMfaVerifyRequestSchema>;
export type RecentMfaVerifyResponse = z.infer<typeof recentMfaVerifyResponseSchema>;
export type IdentitySecurityOverview = z.infer<typeof identitySecurityOverviewSchema>;
export type RevokeIdentityResourceRequest = z.infer<typeof revokeIdentityResourceRequestSchema>;
export type RevokeIdentityResourceResponse = z.infer<typeof revokeIdentityResourceResponseSchema>;
export type IdentityPolicy = z.infer<typeof identityPolicySchema>;
export type UpsertIdentityPolicyRequest = z.infer<typeof upsertIdentityPolicyRequestSchema>;
export type OidcProviderInput = z.infer<typeof oidcProviderInputSchema>;
export type IdentityProvider = z.infer<typeof identityProviderSchema>;
export type IdentityProviderCommandRequest = z.infer<typeof identityProviderCommandRequestSchema>;
export type BreakGlassScope = z.infer<typeof breakGlassScopeSchema>;
export type BreakGlassRequest = z.infer<typeof breakGlassRequestSchema>;
export type CreateBreakGlassRequest = z.infer<typeof createBreakGlassRequestSchema>;
export type BreakGlassDecisionRequest = z.infer<typeof breakGlassDecisionRequestSchema>;
export type BreakGlassActivateRequest = z.infer<typeof breakGlassActivateRequestSchema>;
export type BreakGlassRevokeRequest = z.infer<typeof breakGlassRevokeRequestSchema>;
export type CloseBreakGlassReviewRequest = z.infer<typeof closeBreakGlassReviewRequestSchema>;
export type OidcLoginStartRequest = z.infer<typeof oidcLoginStartRequestSchema>;
export type OidcLoginStartResponse = z.infer<typeof oidcLoginStartResponseSchema>;
export type OidcLoginCallbackRequest = z.infer<typeof oidcLoginCallbackRequestSchema>;
export type OidcPublicProviderListResponse = z.infer<typeof oidcPublicProviderListResponseSchema>;
export type ScimConnector = z.infer<typeof scimConnectorSchema>;
export type ScimConnectorCreateRequest = z.infer<typeof scimConnectorCreateRequestSchema>;
export type ScimConnectorUpdateRequest = z.infer<typeof scimConnectorUpdateRequestSchema>;
export type ScimConnectorCommandRequest = z.infer<typeof scimConnectorCommandRequestSchema>;
export type ScimScope = z.infer<typeof scimScopeSchema>;
export type ScimServiceTokenMetadata = z.infer<typeof scimServiceTokenMetadataSchema>;
export type CreateScimServiceTokenRequest = z.infer<typeof createScimServiceTokenRequestSchema>;
export type RotateScimServiceTokenRequest = z.infer<typeof rotateScimServiceTokenRequestSchema>;
export type RevokeScimServiceTokenRequest = z.infer<typeof revokeScimServiceTokenRequestSchema>;
export type ScimUser = z.infer<typeof scimUserSchema>;
export type ScimGroup = z.infer<typeof scimGroupSchema>;
export type ScimBulkOperation = z.infer<typeof scimBulkOperationSchema>;
export type ScimBulkRequest = z.infer<typeof scimBulkRequestSchema>;
export type ScimBulkResponseOperation = z.infer<typeof scimBulkResponseOperationSchema>;
export type ScimBulkResponse = z.infer<typeof scimBulkResponseSchema>;
export type ScimServiceTokenCreated = z.infer<typeof scimServiceTokenCreatedSchema>;

export { recoveryCodeSchema, sha256HexSchema, totpCodeSchema };
