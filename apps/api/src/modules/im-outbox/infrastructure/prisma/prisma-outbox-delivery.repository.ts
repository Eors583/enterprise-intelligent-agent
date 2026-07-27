import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { OutboxPrismaService } from '../../../../database/outbox-prisma.service.js';
import { MESSAGE_CREATED_EVENT_TYPE } from '../../domain/im-delivery.provider.js';
import {
  OutboxDeliveryRepository,
  type ClaimedOutboxEvent,
} from '../../domain/outbox-delivery.repository.js';

type Transaction = Prisma.TransactionClient;

interface ClaimedRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly event_type: string;
  readonly payload: unknown;
  readonly attempts: number;
  readonly first_attempted_at: Date;
  readonly created_at: Date;
}

@Injectable()
export class PrismaOutboxDeliveryRepository extends OutboxDeliveryRepository {
  constructor(@Inject(OutboxPrismaService) private readonly prisma: OutboxPrismaService) {
    super();
  }

  claimMessageEvents(input: {
    readonly workerId: string;
    readonly batchSize: number;
    readonly claimTtlMs: number;
  }): Promise<readonly ClaimedOutboxEvent[]> {
    return this.withWorkerRole(async (transaction) => {
      const rows = await transaction.$queryRaw<ClaimedRow[]>(Prisma.sql`
        WITH candidates AS MATERIALIZED (
          SELECT event."id"
          FROM public."outbox_events" AS event
          WHERE event."event_type" = ${MESSAGE_CREATED_EVENT_TYPE}
            AND event."status" = 'PENDING'::"OutboxEventStatus"
            AND event."available_at" <= clock_timestamp()
            AND (
              event."locked_until" IS NULL
              OR event."locked_until" <= clock_timestamp()
            )
          ORDER BY event."available_at", event."created_at", event."id"
          LIMIT ${input.batchSize}
          FOR UPDATE SKIP LOCKED
        )
        UPDATE public."outbox_events" AS event
        SET
          "locked_by" = ${input.workerId},
          "locked_until" = clock_timestamp() + ${input.claimTtlMs} * INTERVAL '1 millisecond',
          "attempts" = event."attempts" + 1,
          "first_attempted_at" = COALESCE(event."first_attempted_at", clock_timestamp()),
          "last_error" = NULL
        FROM candidates
        WHERE event."id" = candidates."id"
        RETURNING
          event."id"::text AS id,
          event."tenant_id"::text AS tenant_id,
          event."event_type" AS event_type,
          event."payload" AS payload,
          event."attempts" AS attempts,
          event."first_attempted_at" AS first_attempted_at,
          event."created_at" AS created_at
      `);
      return rows.map((row) => ({
        id: row.id,
        tenantId: row.tenant_id,
        eventType: row.event_type,
        payload: row.payload,
        attempts: row.attempts,
        firstAttemptedAt: row.first_attempted_at,
        createdAt: row.created_at,
      }));
    });
  }

  markPublished(input: {
    readonly eventId: string;
    readonly workerId: string;
    readonly providerName: string;
    readonly providerReceipt: {
      readonly outcome: 'accepted' | 'skipped';
      readonly deliveredRecipientCount: number;
      readonly providerMessageId?: string;
      readonly reason?: string;
    };
  }): Promise<boolean> {
    return this.withWorkerRole(async (transaction) => {
      const updated = await transaction.$executeRaw(Prisma.sql`
        UPDATE public."outbox_events"
        SET
          "status" = 'PUBLISHED'::"OutboxEventStatus",
          "published_at" = clock_timestamp(),
          "provider_name" = ${input.providerName},
          "provider_receipt" = ${JSON.stringify(input.providerReceipt)}::jsonb,
          "locked_by" = NULL,
          "locked_until" = NULL,
          "last_error" = NULL
        WHERE "id" = ${input.eventId}::uuid
          AND "status" = 'PENDING'::"OutboxEventStatus"
          AND "locked_by" = ${input.workerId}
      `);
      return updated === 1;
    });
  }

  releaseForRetry(input: {
    readonly eventId: string;
    readonly workerId: string;
    readonly availableAt: Date;
    readonly error: string;
  }): Promise<boolean> {
    return this.withWorkerRole(async (transaction) => {
      const updated = await transaction.$executeRaw(Prisma.sql`
        UPDATE public."outbox_events"
        SET
          "available_at" = ${input.availableAt},
          "locked_by" = NULL,
          "locked_until" = NULL,
          "last_error" = ${input.error}
        WHERE "id" = ${input.eventId}::uuid
          AND "status" = 'PENDING'::"OutboxEventStatus"
          AND "locked_by" = ${input.workerId}
      `);
      return updated === 1;
    });
  }

  markFailed(input: {
    readonly eventId: string;
    readonly workerId: string;
    readonly error: string;
  }): Promise<boolean> {
    return this.withWorkerRole(async (transaction) => {
      const updated = await transaction.$executeRaw(Prisma.sql`
        UPDATE public."outbox_events"
        SET
          "status" = 'FAILED'::"OutboxEventStatus",
          "published_at" = NULL,
          "locked_by" = NULL,
          "locked_until" = NULL,
          "last_error" = ${input.error}
        WHERE "id" = ${input.eventId}::uuid
          AND "status" = 'PENDING'::"OutboxEventStatus"
          AND "locked_by" = ${input.workerId}
      `);
      return updated === 1;
    });
  }

  markUnknown(input: {
    readonly eventId: string;
    readonly workerId: string;
    readonly providerName: string;
    readonly error: string;
  }): Promise<boolean> {
    return this.withWorkerRole(async (transaction) => {
      const updated = await transaction.$executeRaw(Prisma.sql`
        UPDATE public."outbox_events"
        SET
          "status" = 'UNKNOWN'::"OutboxEventStatus",
          "published_at" = NULL,
          "provider_name" = ${input.providerName},
          "provider_receipt" = '{"outcome":"unknown","deliveredRecipientCount":0,"reason":"delivery_outcome_unknown"}'::jsonb,
          "locked_by" = NULL,
          "locked_until" = NULL,
          "last_error" = ${input.error}
        WHERE "id" = ${input.eventId}::uuid
          AND "status" = 'PENDING'::"OutboxEventStatus"
          AND "locked_by" = ${input.workerId}
      `);
      return updated === 1;
    });
  }

  private withWorkerRole<T>(operation: (transaction: Transaction) => Promise<T>): Promise<T> {
    if (!this.prisma.enabled) {
      throw new Error('The IM outbox worker requires the Prisma repository adapter.');
    }

    return this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_outbox');
      return operation(transaction);
    });
  }
}
