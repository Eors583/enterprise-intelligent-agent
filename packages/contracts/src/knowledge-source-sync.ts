import { z } from 'zod';

const UUID = z.uuid();
const TIMESTAMP = z.iso.datetime({ offset: true });
const SHA256 = z.string().regex(/^[a-f0-9]{64}$/u);
const HTTPS_MANIFEST_URL = z
  .url()
  .max(2_000)
  .refine((value) => new URL(value).protocol === 'https:', 'Manifest URL must use HTTPS.');

export const knowledgeSourceConnectorStatusSchema = z.enum(['ACTIVE', 'PAUSED']);
export const knowledgeSourceSyncRunStatusSchema = z.enum(['RUNNING', 'SUCCEEDED', 'FAILED']);

export const createKnowledgeSourceConnectorRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    manifestUrl: HTTPS_MANIFEST_URL,
  })
  .strict();

export const updateKnowledgeSourceConnectorRequestSchema = z
  .object({ status: knowledgeSourceConnectorStatusSchema })
  .strict();

export const knowledgeSourceSyncFailureSchema = z
  .object({
    externalId: z.string().trim().min(1).max(300).nullable(),
    code: z.string().trim().min(1).max(120),
    message: z.string().trim().min(1).max(1_000),
  })
  .strict();

export const knowledgeSourceSyncRunSchema = z
  .object({
    id: UUID,
    connectorId: UUID,
    status: knowledgeSourceSyncRunStatusSchema,
    cursorBefore: z.string().max(2_000).nullable(),
    cursorAfter: z.string().max(2_000).nullable(),
    discoveredCount: z.number().int().nonnegative(),
    createdCount: z.number().int().nonnegative(),
    updatedCount: z.number().int().nonnegative(),
    skippedCount: z.number().int().nonnegative(),
    deletedCount: z.number().int().nonnegative(),
    failedCount: z.number().int().nonnegative(),
    failures: z.array(knowledgeSourceSyncFailureSchema).max(500),
    startedAt: TIMESTAMP,
    finishedAt: TIMESTAMP.nullable(),
  })
  .strict();

export const knowledgeSourceConnectorSchema = z
  .object({
    id: UUID,
    knowledgeBaseId: UUID,
    name: z.string().min(1).max(120),
    providerType: z.literal('HTTPS_MANIFEST'),
    manifestUrl: z.url().max(2_000),
    status: knowledgeSourceConnectorStatusSchema,
    cursor: z.string().max(2_000).nullable(),
    itemCount: z.number().int().nonnegative(),
    lastSyncedAt: TIMESTAMP.nullable(),
    lastRun: knowledgeSourceSyncRunSchema.nullable(),
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  })
  .strict();

export const knowledgeSourceConnectorListResponseSchema = z
  .object({ items: z.array(knowledgeSourceConnectorSchema) })
  .strict();

export const knowledgeSourceManifestItemSchema = z
  .object({
    externalId: z.string().trim().min(1).max(300),
    title: z.string().trim().min(1).max(300),
    fileName: z.string().trim().min(1).max(300),
    mimeType: z.string().trim().min(1).max(160),
    downloadUrl: z.url().max(4_000).nullable(),
    sourceUri: z.url().max(4_000).nullable().default(null),
    sourceRevision: z.string().trim().min(1).max(300),
    sha256: SHA256.nullable().default(null),
    modifiedAt: TIMESTAMP.nullable().default(null),
    deleted: z.boolean().default(false),
  })
  .strict()
  .superRefine((item, context) => {
    if (!item.deleted && item.downloadUrl === null) {
      context.addIssue({
        code: 'custom',
        path: ['downloadUrl'],
        message: 'Active manifest items require a download URL.',
      });
    }
  });

export const knowledgeSourceManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    nextCursor: z.string().trim().min(1).max(2_000).nullable(),
    hasMore: z.boolean(),
    items: z.array(knowledgeSourceManifestItemSchema).max(1_000),
  })
  .strict()
  .superRefine((manifest, context) => {
    if (manifest.hasMore && manifest.nextCursor === null) {
      context.addIssue({
        code: 'custom',
        path: ['nextCursor'],
        message: 'A paged manifest requires the next cursor.',
      });
    }
    const ids = manifest.items.map((item) => item.externalId);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: 'custom',
        path: ['items'],
        message: 'External IDs must be unique inside a manifest page.',
      });
    }
  });

export type CreateKnowledgeSourceConnectorRequest = z.infer<
  typeof createKnowledgeSourceConnectorRequestSchema
>;
export type UpdateKnowledgeSourceConnectorRequest = z.infer<
  typeof updateKnowledgeSourceConnectorRequestSchema
>;
export type KnowledgeSourceConnector = z.infer<typeof knowledgeSourceConnectorSchema>;
export type KnowledgeSourceConnectorListResponse = z.infer<
  typeof knowledgeSourceConnectorListResponseSchema
>;
export type KnowledgeSourceSyncRun = z.infer<typeof knowledgeSourceSyncRunSchema>;
export type KnowledgeSourceSyncFailure = z.infer<typeof knowledgeSourceSyncFailureSchema>;
export type KnowledgeSourceManifest = z.infer<typeof knowledgeSourceManifestSchema>;
export type KnowledgeSourceManifestItem = z.infer<typeof knowledgeSourceManifestItemSchema>;
