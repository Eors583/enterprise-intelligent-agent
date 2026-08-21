import { z } from 'zod';

const UUID = z.uuid();
const SAFE_EXTERNAL_ID = z.string().trim().min(1).max(200);

export const knowledgeProviderSchema = z.enum(['LEXIANG']);
export const knowledgeProviderConnectionStatusSchema = z.enum([
  'PENDING',
  'ACTIVE',
  'UNAVAILABLE',
  'DISABLED',
]);

export const createLexiangConnectionRequestSchema = z
  .object({
    appKey: z.string().trim().min(1).max(200),
    appSecret: z.string().min(8).max(500),
    teamId: SAFE_EXTERNAL_ID,
    operatorStaffId: SAFE_EXTERNAL_ID,
  })
  .strict();

export const discoverLexiangConnectionRequestSchema = createLexiangConnectionRequestSchema.pick({
  appKey: true,
  appSecret: true,
});

export const lexiangDiscoveryStatusSchema = z.enum(['AVAILABLE', 'FORBIDDEN']);

export const lexiangTeamCandidateSchema = z
  .object({
    id: SAFE_EXTERNAL_ID,
    code: SAFE_EXTERNAL_ID,
    name: z.string().trim().min(1).max(200),
  })
  .strict();

export const lexiangOperatorCandidateSchema = z
  .object({
    staffId: SAFE_EXTERNAL_ID,
    name: z.string().trim().min(1).max(200),
  })
  .strict();

export const lexiangConnectionDiscoveryResponseSchema = z
  .object({
    teamStatus: lexiangDiscoveryStatusSchema,
    operatorStatus: lexiangDiscoveryStatusSchema,
    teams: z.array(lexiangTeamCandidateSchema).max(1_000),
    operators: z.array(lexiangOperatorCandidateSchema).max(1_000),
  })
  .strict();

export const bindLexiangSpaceRequestSchema = z
  .object({
    knowledgeBaseId: UUID,
    externalSpaceId: SAFE_EXTERNAL_ID,
    externalRootEntryId: SAFE_EXTERNAL_ID,
  })
  .strict();

export const bindLexiangUserRequestSchema = z
  .object({
    userId: UUID,
    externalStaffId: SAFE_EXTERNAL_ID,
  })
  .strict();

export const knowledgeProviderUserBindingSchema = z
  .object({
    userId: UUID,
    displayName: z.string().trim().min(1).max(120),
    externalStaffId: SAFE_EXTERNAL_ID,
    status: z.enum(['ACTIVE', 'DISABLED']),
    updatedAt: z.iso.datetime(),
  })
  .strict();

export const knowledgeProviderUserBindingsResponseSchema = z
  .object({ bindings: z.array(knowledgeProviderUserBindingSchema).max(10_000) })
  .strict();

export const knowledgeProviderConnectionSchema = z
  .object({
    id: UUID,
    provider: knowledgeProviderSchema,
    status: knowledgeProviderConnectionStatusSchema,
    appKeyHint: z.string().min(1).max(32),
    teamId: SAFE_EXTERNAL_ID.nullable(),
    operatorStaffId: SAFE_EXTERNAL_ID.nullable(),
    credentialsConfigured: z.boolean(),
    lastHealthAt: z.iso.datetime().nullable(),
    lastHealthCode: z.string().max(120).nullable(),
  })
  .strict();

export const knowledgeProviderConnectionResponseSchema = z
  .object({
    connection: knowledgeProviderConnectionSchema.nullable(),
  })
  .strict();

export const knowledgeProviderHealthCheckResponseSchema = z
  .object({
    connection: knowledgeProviderConnectionSchema,
    reachable: z.boolean(),
    checkedAt: z.iso.datetime(),
    message: z.string().trim().min(1).max(300),
  })
  .strict();

export const lexiangSpaceSyncResponseSchema = z
  .object({
    discovered: z.number().int().nonnegative(),
    imported: z.number().int().nonnegative(),
    updated: z.number().int().nonnegative(),
    requiresPrivacyReview: z.number().int().nonnegative(),
    entriesDiscovered: z.number().int().nonnegative(),
    foldersSynchronized: z.number().int().nonnegative(),
    documentsDiscovered: z.number().int().nonnegative(),
    documentsImported: z.number().int().nonnegative(),
    documentsUpdated: z.number().int().nonnegative(),
    documentsArchived: z.number().int().nonnegative(),
  })
  .strict();

export type CreateLexiangConnectionRequest = z.infer<typeof createLexiangConnectionRequestSchema>;
export type DiscoverLexiangConnectionRequest = z.infer<
  typeof discoverLexiangConnectionRequestSchema
>;
export type LexiangConnectionDiscoveryResponse = z.infer<
  typeof lexiangConnectionDiscoveryResponseSchema
>;
export type BindLexiangSpaceRequest = z.infer<typeof bindLexiangSpaceRequestSchema>;
export type BindLexiangUserRequest = z.infer<typeof bindLexiangUserRequestSchema>;
export type KnowledgeProviderUserBinding = z.infer<typeof knowledgeProviderUserBindingSchema>;
export type KnowledgeProviderUserBindingsResponse = z.infer<
  typeof knowledgeProviderUserBindingsResponseSchema
>;
export type KnowledgeProviderConnection = z.infer<typeof knowledgeProviderConnectionSchema>;
export type KnowledgeProviderConnectionResponse = z.infer<
  typeof knowledgeProviderConnectionResponseSchema
>;
export type KnowledgeProviderHealthCheckResponse = z.infer<
  typeof knowledgeProviderHealthCheckResponseSchema
>;
export type LexiangSpaceSyncResponse = z.infer<typeof lexiangSpaceSyncResponseSchema>;
