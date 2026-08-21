import { z } from 'zod';

const UUID = z.uuid();
const TIMESTAMP = z.iso.datetime({ offset: true });
const SHA256 = z.string().regex(/^[a-f0-9]{64}$/u);
const NONNEGATIVE_COUNT = z.number().int().nonnegative();

const documentIdentity = {
  knowledgeBaseId: UUID,
  documentId: UUID,
  documentVersionId: UUID,
} as const;

export const knowledgeParseReviewedEventSchema = z
  .object({
    eventType: z.literal('knowledge.document-version.parse-reviewed.v1'),
    payload: z
      .object({
        ...documentIdentity,
        decision: z.enum(['APPROVE', 'REJECT']),
        parseQualityScore: z.number().min(0).max(1).nullable(),
        reviewRevision: z.number().int().positive(),
        reviewedAt: TIMESTAMP,
      })
      .strict(),
  })
  .strict();

export const knowledgeGovernanceUpdatedEventSchema = z
  .object({
    eventType: z.literal('knowledge.document-version.governance-updated.v1'),
    payload: z
      .object({
        ...documentIdentity,
        previousRevision: z.number().int().nonnegative(),
        revision: z.number().int().positive(),
        previousPolicyHash: SHA256,
        policyHash: SHA256,
        reviewStatus: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'MIGRATED']),
        classification: z.enum(['PUBLIC', 'INTERNAL', 'SENSITIVE', 'CONFIDENTIAL']),
        scopeMode: z.enum(['TENANT', 'RESTRICTED']),
      })
      .strict(),
  })
  .strict();

export const knowledgeGovernanceReviewedEventSchema = z
  .object({
    eventType: z.literal('knowledge.document-version.governance-reviewed.v1'),
    payload: z
      .object({
        ...documentIdentity,
        decision: z.enum(['APPROVE', 'REJECT']),
        revision: z.number().int().positive(),
        policyHash: SHA256,
        reviewedAt: TIMESTAMP,
      })
      .strict(),
  })
  .strict();

export const knowledgePublishedEventSchema = z
  .object({
    eventType: z.literal('knowledge.document-version.published.v1'),
    payload: z
      .object({
        ...documentIdentity,
        version: z.number().int().positive(),
        graphProjectionId: UUID.nullable(),
        graphHash: SHA256.nullable(),
        publishedAt: TIMESTAMP,
      })
      .strict(),
  })
  .strict();

const sourceSyncPayload = z
  .object({
    knowledgeBaseId: UUID,
    connectorId: UUID,
    runId: UUID,
    discoveredCount: NONNEGATIVE_COUNT,
    createdCount: NONNEGATIVE_COUNT,
    updatedCount: NONNEGATIVE_COUNT,
    skippedCount: NONNEGATIVE_COUNT,
    deletedCount: NONNEGATIVE_COUNT,
    failedCount: NONNEGATIVE_COUNT,
  })
  .strict();

export const knowledgeSourceSyncSucceededEventSchema = z
  .object({
    eventType: z.literal('knowledge.source-sync.succeeded.v1'),
    payload: sourceSyncPayload.extend({ failedCount: z.literal(0) }),
  })
  .strict();

export const knowledgeSourceSyncFailedEventSchema = z
  .object({
    eventType: z.literal('knowledge.source-sync.failed.v1'),
    payload: sourceSyncPayload.extend({ failedCount: z.number().int().positive() }),
  })
  .strict();

export const knowledgePublicEventSchema = z.discriminatedUnion('eventType', [
  knowledgeParseReviewedEventSchema,
  knowledgeGovernanceUpdatedEventSchema,
  knowledgeGovernanceReviewedEventSchema,
  knowledgePublishedEventSchema,
  knowledgeSourceSyncSucceededEventSchema,
  knowledgeSourceSyncFailedEventSchema,
]);

export type KnowledgePublicEvent = z.infer<typeof knowledgePublicEventSchema>;
export type KnowledgePublicEventType = KnowledgePublicEvent['eventType'];

/** Validates the versioned public event before it enters the transactional outbox. */
export function defineKnowledgePublicEvent(event: KnowledgePublicEvent): KnowledgePublicEvent {
  return knowledgePublicEventSchema.parse(event);
}
