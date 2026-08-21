import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import type {
  BusinessEventDelivery,
  BusinessEventDetailResponse,
  BusinessEventEnvelope,
} from '@enterprise/contracts';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../../../database/prisma.service.js';
import type {
  RuntimeCursorPage,
  RuntimeMutationResult,
} from '../../../process-orchestration/application/runtime-mutation-result.js';
import {
  appendRuntimeAuditAndOutbox,
  databaseErrorText,
  decodeRuntimeCursor,
  encodeRuntimeCursor,
  isDatabaseConflict,
  isDatabaseRejection,
  jsonArray,
  jsonObject,
  runtimeHash,
  withProcessTenant,
} from '../../../process-orchestration/infrastructure/prisma/runtime-prisma.support.js';
import {
  BusinessEventRepository,
  type ReplayBusinessEventDeliveryInput,
} from '../../business-event.repository.js';

@Injectable()
export class PrismaBusinessEventRepository extends BusinessEventRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {
    super();
  }

  async listEvents(
    principal: ReplayBusinessEventDeliveryInput['principal'],
    page: { readonly cursor: string | null; readonly limit: number },
  ): Promise<RuntimeCursorPage<BusinessEventEnvelope>> {
    const cursor = decodeRuntimeCursor(page.cursor);
    return this.prisma.withTenant(principal.tenantId, async (transaction) => {
      const rows = await transaction.$queryRaw<BusinessEventRow[]>(Prisma.sql`
        SELECT *
        FROM public."business_events"
        WHERE "tenant_id" = ${principal.tenantId}::uuid
          ${
            cursor === null
              ? Prisma.empty
              : Prisma.sql`
                AND ("produced_at", "id") <
                    (${cursor.timestamp}::timestamptz, ${cursor.id}::uuid)
              `
          }
        ORDER BY "produced_at" DESC, "id" DESC
        LIMIT ${page.limit + 1}
      `);
      const visible = rows.slice(0, page.limit);
      const last = visible.at(-1);
      return {
        items: visible.map(mapBusinessEventRow),
        nextCursor:
          rows.length > page.limit && last !== undefined
            ? encodeRuntimeCursor(last.produced_at, last.id)
            : null,
      };
    });
  }

  async findEvent(
    principal: ReplayBusinessEventDeliveryInput['principal'],
    eventId: string,
  ): Promise<BusinessEventDetailResponse | null> {
    return this.prisma.withTenant(principal.tenantId, async (transaction) => {
      const events = await transaction.$queryRaw<BusinessEventRow[]>`
        SELECT *
        FROM public."business_events"
        WHERE "tenant_id" = ${principal.tenantId}::uuid
          AND "id" = ${eventId}::uuid
        LIMIT 1
      `;
      const event = events[0];
      if (event === undefined) return null;
      const deliveries = await transaction.$queryRaw<BusinessEventDeliveryRow[]>`
        SELECT *
        FROM public."business_event_deliveries"
        WHERE "tenant_id" = ${principal.tenantId}::uuid
          AND "business_event_id" = ${eventId}::uuid
        ORDER BY "created_at" ASC, "id" ASC
      `;
      return {
        event: mapBusinessEventRow(event),
        deliveries: deliveries.map(mapDeliveryRow),
      };
    });
  }

  async replayDelivery(
    input: ReplayBusinessEventDeliveryInput,
  ): Promise<RuntimeMutationResult<BusinessEventDelivery>> {
    try {
      return await withProcessTenant(
        this.prisma,
        input.principal.tenantId,
        async (transaction) => {
          const replayKey = replayEventKey(input.request.idempotencyKey);
          const prior = await transaction.$queryRaw<Array<{ payload: unknown }>>`
            SELECT "payload"
            FROM public."business_events"
            WHERE "tenant_id" = ${input.principal.tenantId}::uuid
              AND "idempotency_key" = ${replayKey}
            LIMIT 1
          `;
          if (prior[0] !== undefined) {
            const payload = jsonObject(prior[0].payload);
            if (
              payload.deliveryId !== input.deliveryId ||
              payload.reason !== input.request.reason
            ) {
              return { kind: 'IDEMPOTENCY_CONFLICT' };
            }
            const current = await findDelivery(
              transaction,
              input.principal.tenantId,
              input.deliveryId,
              false,
            );
            return current === null
              ? { kind: 'NOT_FOUND' }
              : { kind: 'IDEMPOTENT_REPLAY', value: mapDeliveryRow(current) };
          }

          const current = await findDelivery(
            transaction,
            input.principal.tenantId,
            input.deliveryId,
            true,
          );
          if (current === null) return { kind: 'NOT_FOUND' };
          if (current.status !== input.request.expectedStatus) {
            return {
              kind: 'REJECTED',
              reason: 'INVALID_TRANSITION',
              detail: 'Only a dead-lettered Business Event delivery can be replayed.',
            };
          }
          const effectiveAt = new Date();
          const updatedRows = await transaction.$queryRaw<BusinessEventDeliveryRow[]>(Prisma.sql`
              UPDATE public."business_event_deliveries"
              SET "status" = 'PENDING'::public."BusinessEventDeliveryStatus",
                  "revision" = "revision" + 1,
                  "available_at" = statement_timestamp(),
                  "locked_by" = NULL,
                  "locked_until" = NULL,
                  "processed_at" = NULL,
                  "dead_lettered_at" = NULL,
                  "last_error_code" = NULL,
                  "last_error_detail" = NULL,
                  "replay_count" = "replay_count" + 1,
                  "replayed_at" = statement_timestamp(),
                  "replayed_by_user_id" = ${input.principal.userId}::uuid,
                  "replay_reason" = ${input.request.reason}
              WHERE "tenant_id" = ${input.principal.tenantId}::uuid
                AND "id" = ${input.deliveryId}::uuid
                AND "revision" = ${current.revision}
              RETURNING *
            `);
          const updated = updatedRows[0];
          if (updated === undefined) {
            return {
              kind: 'STALE_REVISION',
              currentRevision: current.revision,
            };
          }
          const sourceEvents = await transaction.$queryRaw<BusinessEventRow[]>`
            SELECT *
            FROM public."business_events"
            WHERE "tenant_id" = ${input.principal.tenantId}::uuid
              AND "id" = ${updated.business_event_id}::uuid
            LIMIT 1
          `;
          const source = sourceEvents[0];
          if (source === undefined) {
            throw new Error('Business Event delivery has no source event.');
          }
          const replayedAt = updated.replayed_at ?? effectiveAt;
          const payload = {
            deliveryId: updated.id,
            businessEventId: updated.business_event_id,
            consumerName: updated.consumer_name,
            reason: input.request.reason,
            replayCount: updated.replay_count,
            revision: updated.revision,
          };
          await insertReplayBusinessEvent(transaction, {
            id: randomUUID(),
            tenantId: input.principal.tenantId,
            source,
            payload,
            replayKey,
            occurredAt: replayedAt,
            deliveryId: updated.id,
            revision: updated.revision,
          });
          await appendRuntimeAuditAndOutbox(transaction, input.principal, {
            action: 'business_event.delivery.replay',
            resourceType: 'BUSINESS_EVENT_DELIVERY',
            resourceId: updated.id,
            eventType: 'BusinessEventDelivery.Replayed',
            payload,
            occurredAt: replayedAt,
          });
          return { kind: 'APPLIED', value: mapDeliveryRow(updated) };
        },
        input.principal.userId,
      );
    } catch (error) {
      if (isDatabaseConflict(error)) {
        return { kind: 'IDEMPOTENCY_CONFLICT' };
      }
      if (isReplayAdministratorRejection(error)) {
        return {
          kind: 'REJECTED',
          reason: 'INVARIANT_VIOLATION',
          detail: 'Dead-letter replay requires an active tenant owner or administrator.',
        };
      }
      if (isDatabaseRejection(error)) {
        return {
          kind: 'REJECTED',
          reason: 'INVARIANT_VIOLATION',
          detail: databaseErrorText(error).slice(0, 2_000),
        };
      }
      throw error;
    }
  }
}

async function findDelivery(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  deliveryId: string,
  lock: boolean,
): Promise<BusinessEventDeliveryRow | null> {
  const rows = await transaction.$queryRaw<BusinessEventDeliveryRow[]>(Prisma.sql`
    SELECT *
    FROM public."business_event_deliveries"
    WHERE "tenant_id" = ${tenantId}::uuid
      AND "id" = ${deliveryId}::uuid
    ${lock ? Prisma.sql`FOR UPDATE` : Prisma.empty}
  `);
  return rows[0] ?? null;
}

async function insertReplayBusinessEvent(
  transaction: Prisma.TransactionClient,
  input: {
    readonly id: string;
    readonly tenantId: string;
    readonly source: BusinessEventRow;
    readonly payload: Record<string, unknown>;
    readonly replayKey: string;
    readonly occurredAt: Date;
    readonly deliveryId: string;
    readonly revision: number;
  },
): Promise<void> {
  const producedAt = new Date(Math.max(input.occurredAt.getTime(), Date.now()));
  const retainUntil = new Date(producedAt);
  retainUntil.setUTCFullYear(retainUntil.getUTCFullYear() + 1);
  await transaction.$executeRaw(Prisma.sql`
    INSERT INTO public."business_events" (
      "id", "tenant_id", "event_type", "schema_version",
      "aggregate_type", "aggregate_id", "aggregate_version",
      "subject_type", "subject_id", "subject_version",
      "occurred_at", "produced_at", "organization_scope", "payload",
      "evidence_refs", "correlation_id", "causation_id", "idempotency_key",
      "sensitivity", "retain_until", "retention_action", "legal_hold",
      "source_system", "source_record_id", "source_version", "producer",
      "permission_labels", "event_hash"
    ) VALUES (
      ${input.id}::uuid,
      ${input.tenantId}::uuid,
      'BusinessEventDelivery.Replayed',
      1,
      ${input.source.aggregate_type}::public."BusinessEventSubjectType",
      ${input.source.aggregate_id}::uuid,
      ${input.source.aggregate_version},
      ${input.source.subject_type}::public."BusinessEventSubjectType",
      ${input.source.subject_id}::uuid,
      ${input.source.subject_version},
      ${input.occurredAt},
      ${producedAt},
      ${JSON.stringify(jsonObject(input.source.organization_scope))}::jsonb,
      ${JSON.stringify(input.payload)}::jsonb,
      '[]'::jsonb,
      ${input.source.correlation_id}::uuid,
      ${input.source.id}::uuid,
      ${input.replayKey},
      ${input.source.sensitivity}::public."BusinessEventSensitivity",
      ${retainUntil},
      'ARCHIVE'::public."BusinessEventRetentionAction",
      false,
      'enterprise-api',
      ${input.deliveryId},
      ${String(input.revision)},
      'business-event-governance',
      ${JSON.stringify(jsonArray(input.source.permission_labels))}::jsonb,
      ${runtimeHash(input)}
    )
  `);
}

function replayEventKey(idempotencyKey: string): string {
  return `delivery-replay:${runtimeHash(idempotencyKey)}`;
}

function isReplayAdministratorRejection(error: unknown): boolean {
  const text = databaseErrorText(error);
  return (
    text.includes('business_event_deliveries_replay_actor_v2_check') ||
    text.includes('dead-letter replay attribution requires the active tenant administrator')
  );
}

function mapBusinessEventRow(row: BusinessEventRow): BusinessEventEnvelope {
  return {
    eventId: row.id,
    tenantId: row.tenant_id,
    eventType: row.event_type,
    schemaVersion: row.schema_version,
    aggregate: {
      type: row.aggregate_type,
      id: row.aggregate_id,
      version: row.aggregate_version,
    },
    subject: {
      type: row.subject_type,
      id: row.subject_id,
      version: row.subject_version,
    },
    occurredAt: row.occurred_at.toISOString(),
    producedAt: row.produced_at.toISOString(),
    organizationScope: jsonObject(
      row.organization_scope,
    ) as BusinessEventEnvelope['organizationScope'],
    payload: jsonObject(row.payload),
    correlationId: row.correlation_id,
    causationId: row.causation_id,
    idempotencyKey: row.idempotency_key,
    sensitivity: row.sensitivity,
    retention: {
      retainUntil: row.retain_until.toISOString(),
      action: row.retention_action,
      legalHold: row.legal_hold,
    },
    source: {
      system: row.source_system,
      recordId: row.source_record_id,
      version: row.source_version,
      producer: row.producer,
    },
    evidenceRefs: jsonArray(row.evidence_refs) as BusinessEventEnvelope['evidenceRefs'],
  };
}

function mapDeliveryRow(row: BusinessEventDeliveryRow): BusinessEventDelivery {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    businessEventId: row.business_event_id,
    consumerName: row.consumer_name,
    status: row.status,
    revision: row.revision,
    attempts: row.attempts,
    availableAt: row.available_at.toISOString(),
    lockedBy: row.locked_by,
    lockedUntil: iso(row.locked_until),
    processedAt: iso(row.processed_at),
    deadLetteredAt: iso(row.dead_lettered_at),
    lastErrorCode: row.last_error_code,
    lastErrorDetail: row.last_error_detail,
    replayCount: row.replay_count,
    replayedAt: iso(row.replayed_at),
    replayedByUserId: row.replayed_by_user_id,
    replayReason: row.replay_reason,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function iso(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

interface BusinessEventRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly event_type: string;
  readonly schema_version: number;
  readonly aggregate_type: BusinessEventEnvelope['aggregate']['type'];
  readonly aggregate_id: string;
  readonly aggregate_version: number | null;
  readonly subject_type: BusinessEventEnvelope['subject']['type'];
  readonly subject_id: string;
  readonly subject_version: number | null;
  readonly occurred_at: Date;
  readonly produced_at: Date;
  readonly organization_scope: unknown;
  readonly payload: unknown;
  readonly evidence_refs: unknown;
  readonly correlation_id: string;
  readonly causation_id: string | null;
  readonly idempotency_key: string;
  readonly sensitivity: BusinessEventEnvelope['sensitivity'];
  readonly retain_until: Date;
  readonly retention_action: BusinessEventEnvelope['retention']['action'];
  readonly legal_hold: boolean;
  readonly source_system: string;
  readonly source_record_id: string;
  readonly source_version: string;
  readonly producer: string;
  readonly permission_labels: unknown;
}

interface BusinessEventDeliveryRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly business_event_id: string;
  readonly consumer_name: string;
  readonly status: BusinessEventDelivery['status'];
  readonly revision: number;
  readonly attempts: number;
  readonly available_at: Date;
  readonly locked_by: string | null;
  readonly locked_until: Date | null;
  readonly processed_at: Date | null;
  readonly dead_lettered_at: Date | null;
  readonly last_error_code: string | null;
  readonly last_error_detail: string | null;
  readonly replay_count: number;
  readonly replayed_at: Date | null;
  readonly replayed_by_user_id: string | null;
  readonly replay_reason: string | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}
