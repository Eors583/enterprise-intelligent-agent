import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { OutboxPrismaService } from '../../../../database/outbox-prisma.service.js';
import { OUTBOX_CONSUMER, OUTBOX_LANE } from '../../../../database/outbox-routing.js';
import { AgentRunQueueRepository } from '../../domain/agent-run-queue.repository.js';
import {
  AGENT_RUN_CANCEL_REQUESTED_EVENT_TYPE,
  AGENT_RUN_REQUESTED_EVENT_TYPE,
  type ClaimedAgentRunEvent,
} from '../../domain/agent-run.models.js';

interface ClaimedRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly aggregate_id: string;
  readonly event_type: string;
  readonly payload: unknown;
  readonly attempts: number;
  readonly first_attempted_at: Date;
  readonly locked_until: Date;
  readonly created_at: Date;
}

@Injectable()
export class PrismaAgentRunQueueRepository extends AgentRunQueueRepository {
  constructor(@Inject(OutboxPrismaService) private readonly prisma: OutboxPrismaService) {
    super();
  }

  claim(input: {
    readonly workerId: string;
    readonly batchSize: number;
    readonly claimTtlMs: number;
  }): Promise<readonly ClaimedAgentRunEvent[]> {
    return this.claimEventType(input, AGENT_RUN_REQUESTED_EVENT_TYPE);
  }

  claimCancellations(input: {
    readonly workerId: string;
    readonly batchSize: number;
    readonly claimTtlMs: number;
  }): Promise<readonly ClaimedAgentRunEvent[]> {
    return this.claimEventType(input, AGENT_RUN_CANCEL_REQUESTED_EVENT_TYPE);
  }

  private claimEventType(
    input: {
      readonly workerId: string;
      readonly batchSize: number;
      readonly claimTtlMs: number;
    },
    eventType: typeof AGENT_RUN_REQUESTED_EVENT_TYPE | typeof AGENT_RUN_CANCEL_REQUESTED_EVENT_TYPE,
  ): Promise<readonly ClaimedAgentRunEvent[]> {
    const lane =
      eventType === AGENT_RUN_REQUESTED_EVENT_TYPE
        ? OUTBOX_LANE.agentRunExecution
        : OUTBOX_LANE.agentRunCancellation;
    return this.withWorkerRole(async (transaction) => {
      const rows = await transaction.$queryRaw<ClaimedRow[]>(Prisma.sql`
        WITH candidates AS MATERIALIZED (
          SELECT delivery."id"
          FROM public."outbox_event_deliveries" AS delivery
          JOIN public."outbox_events" AS event
            ON event."tenant_id" = delivery."tenant_id"
           AND event."id" = delivery."event_id"
          WHERE delivery."consumer_key" = ${OUTBOX_CONSUMER.agentRun}
            AND delivery."lane" = ${lane}
            AND event."event_type" = ${eventType}
            AND delivery."status" = 'PENDING'::"OutboxEventStatus"
            AND delivery."available_at" <= clock_timestamp()
            AND (
              delivery."locked_until" IS NULL
              OR delivery."locked_until" <= clock_timestamp()
            )
          ORDER BY delivery."available_at", delivery."created_at", delivery."id"
          LIMIT ${input.batchSize}
          FOR UPDATE OF delivery SKIP LOCKED
        ),
        claimed AS (
          UPDATE public."outbox_event_deliveries" AS delivery
          SET
            "locked_by" = ${input.workerId},
            "locked_until" =
              clock_timestamp() + ${input.claimTtlMs} * INTERVAL '1 millisecond',
            "attempts" = delivery."attempts" + 1,
            "first_attempted_at" =
              COALESCE(delivery."first_attempted_at", clock_timestamp()),
            "last_error" = NULL,
            "updated_at" = clock_timestamp()
          FROM candidates
          WHERE delivery."id" = candidates."id"
          RETURNING delivery.*
        )
        SELECT
          event."id"::text AS id,
          event."tenant_id"::text AS tenant_id,
          event."aggregate_id"::text AS aggregate_id,
          event."event_type" AS event_type,
          event."payload" AS payload,
          claimed."attempts" AS attempts,
          claimed."first_attempted_at" AS first_attempted_at,
          claimed."locked_until" AS locked_until,
          event."created_at" AS created_at
        FROM claimed
        JOIN public."outbox_events" AS event
          ON event."tenant_id" = claimed."tenant_id"
         AND event."id" = claimed."event_id"
      `);
      return rows.map((row) => ({
        id: row.id,
        tenantId: row.tenant_id,
        aggregateId: row.aggregate_id,
        eventType: row.event_type,
        payload: row.payload,
        attempts: row.attempts,
        firstAttemptedAt: row.first_attempted_at,
        leaseExpiresAt: row.locked_until,
        createdAt: row.created_at,
      }));
    });
  }

  markPublished(input: {
    readonly eventId: string;
    readonly workerId: string;
    readonly externalRunId: string | null;
  }): Promise<boolean> {
    const receipt = {
      outcome: 'accepted',
      deliveredRecipientCount: 1,
      ...(input.externalRunId === null ? {} : { providerMessageId: input.externalRunId }),
    };
    return this.transition(
      input.eventId,
      input.workerId,
      Prisma.sql`
      "status" = 'PUBLISHED'::"OutboxEventStatus",
      "acknowledged_at" = clock_timestamp(),
      "provider_name" = 'ai-runtime',
      "provider_receipt" = ${JSON.stringify(receipt)}::jsonb,
      "last_error" = NULL
    `,
    );
  }

  markFailed(input: {
    readonly eventId: string;
    readonly workerId: string;
    readonly errorCode: string;
  }): Promise<boolean> {
    return this.transition(
      input.eventId,
      input.workerId,
      Prisma.sql`
      "status" = 'FAILED'::"OutboxEventStatus",
      "acknowledged_at" = NULL,
      "provider_name" = NULL,
      "provider_receipt" = NULL,
      "last_error" = ${safeQueueError(input.errorCode)}
    `,
    );
  }

  markUnknown(input: {
    readonly eventId: string;
    readonly workerId: string;
    readonly errorCode: string;
  }): Promise<boolean> {
    return this.transition(
      input.eventId,
      input.workerId,
      Prisma.sql`
      "status" = 'UNKNOWN'::"OutboxEventStatus",
      "acknowledged_at" = NULL,
      "provider_name" = 'ai-runtime',
      "provider_receipt" = '{"outcome":"unknown","deliveredRecipientCount":0,"reason":"delivery_outcome_unknown"}'::jsonb,
      "last_error" = ${safeQueueError(input.errorCode)}
    `,
    );
  }

  defer(input: {
    readonly eventId: string;
    readonly workerId: string;
    readonly availableAt: Date;
    readonly reasonCode: string;
  }): Promise<boolean> {
    return this.transition(
      input.eventId,
      input.workerId,
      Prisma.sql`
      "available_at" = ${input.availableAt},
      "last_error" = ${safeQueueError(input.reasonCode)}
    `,
    );
  }

  private transition(eventId: string, workerId: string, assignments: Prisma.Sql): Promise<boolean> {
    return this.withWorkerRole(async (transaction) => {
      const updated = await transaction.$executeRaw(Prisma.sql`
        UPDATE public."outbox_event_deliveries"
        SET
          ${assignments},
          "locked_by" = NULL,
          "locked_until" = NULL,
          "updated_at" = clock_timestamp()
        WHERE "event_id" = ${eventId}::uuid
          AND "consumer_key" = ${OUTBOX_CONSUMER.agentRun}
          AND "status" = 'PENDING'::"OutboxEventStatus"
          AND "locked_by" = ${workerId}
      `);
      return updated === 1;
    });
  }

  private withWorkerRole<T>(
    operation: (transaction: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_outbox');
      return operation(transaction);
    });
  }
}

function safeQueueError(code: string): string {
  const safeCode = /^[A-Z0-9][A-Z0-9_]{0,119}$/.test(code) ? code : 'AGENT_RUN_FAILED';
  return `${safeCode}: Agent Run processing did not complete.`;
}
