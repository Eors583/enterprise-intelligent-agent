import { z } from 'zod';

const UUID = z.uuid();
const TIMESTAMP = z.iso.datetime();
const SHA256 = z.string().regex(/^[a-f0-9]{64}$/);

export const auditActorTypeSchema = z.enum(['USER', 'AGENT', 'SERVICE']);

const auditActorTypeFilterSchema = z
  .enum(['USER', 'AGENT', 'SERVICE', 'SYSTEM'])
  .transform((value) => (value === 'SYSTEM' ? 'SERVICE' : value));

export const auditEventRecordSchema = z
  .object({
    id: UUID,
    tenantId: UUID,
    actorType: auditActorTypeSchema,
    actorId: UUID,
    action: z.string().min(1).max(160),
    resourceType: z.string().min(1).max(100),
    resourceId: UUID,
    metadata: z.record(z.string(), z.unknown()),
    occurredAt: TIMESTAMP,
    chainSequence: z.string().regex(/^[1-9][0-9]*$/),
    previousHash: SHA256.nullable(),
    eventHash: SHA256,
  })
  .strict();

export const auditEventFilterSchema = z
  .object({
    actorType: auditActorTypeFilterSchema.optional(),
    actorId: UUID.optional(),
    action: z.string().trim().min(1).max(160).optional(),
    resourceType: z.string().trim().min(1).max(100).optional(),
    resourceId: UUID.optional(),
    occurredFrom: TIMESTAMP.optional(),
    occurredTo: TIMESTAMP.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.occurredFrom === undefined ||
      value.occurredTo === undefined ||
      Date.parse(value.occurredTo) > Date.parse(value.occurredFrom),
    {
      message: 'occurredTo must be later than occurredFrom.',
      path: ['occurredTo'],
    },
  );

export const auditEventListQuerySchema = auditEventFilterSchema
  .extend({
    cursor: z.string().trim().min(1).max(512).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();

export const auditEventListResponseSchema = z
  .object({
    items: z.array(auditEventRecordSchema),
    nextCursor: z.string().nullable(),
  })
  .strict();

export const createAuditExportRequestSchema = auditEventFilterSchema
  .extend({
    maximumRecords: z.number().int().min(1).max(10_000).default(10_000),
    reason: z.string().trim().min(3).max(500),
  })
  .strict();

export const auditExportResponseSchema = z
  .object({
    exportId: UUID,
    generatedAt: TIMESTAMP,
    recordCount: z.number().int().nonnegative(),
    truncated: z.boolean(),
    sha256: SHA256,
    mediaType: z.literal('text/csv; charset=utf-8'),
    fileName: z.string().min(1).max(240),
    csv: z.string(),
  })
  .strict();

export const auditIntegrityResponseSchema = z
  .object({
    checkedAt: TIMESTAMP,
    checkedRecords: z.number().int().nonnegative(),
    valid: z.boolean(),
    firstInvalidEventId: UUID.nullable(),
    headSequence: z.string().regex(/^(0|[1-9][0-9]*)$/),
    headHash: SHA256.nullable(),
  })
  .strict();

export type AuditActorType = z.infer<typeof auditActorTypeSchema>;
export type AuditEventRecord = z.infer<typeof auditEventRecordSchema>;
export type AuditEventFilter = z.infer<typeof auditEventFilterSchema>;
export type AuditEventListQuery = z.infer<typeof auditEventListQuerySchema>;
export type AuditEventListResponse = z.infer<typeof auditEventListResponseSchema>;
export type CreateAuditExportRequest = z.infer<typeof createAuditExportRequestSchema>;
export type AuditExportResponse = z.infer<typeof auditExportResponseSchema>;
export type AuditIntegrityResponse = z.infer<typeof auditIntegrityResponseSchema>;
