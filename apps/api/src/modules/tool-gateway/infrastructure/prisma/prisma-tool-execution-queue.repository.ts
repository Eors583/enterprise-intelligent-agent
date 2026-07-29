import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { OutboxPrismaService } from '../../../../database/outbox-prisma.service.js';
import { OUTBOX_CONSUMER, OUTBOX_LANE } from '../../../../database/outbox-routing.js';
import { ToolExecutionQueueRepository } from '../../domain/tool-execution-queue.repository.js';
import {
  TOOL_INVOCATION_COMMAND_EVENT_TYPE,
  type ClaimedToolExecutionEvent,
} from '../../domain/tool-execution.models.js';

interface ClaimedRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly aggregate_id: string;
  readonly event_type: typeof TOOL_INVOCATION_COMMAND_EVENT_TYPE;
  readonly payload: unknown;
  readonly attempts: number;
  readonly first_attempted_at: Date;
  readonly locked_until: Date;
  readonly created_at: Date;
}

@Injectable()
export class PrismaToolExecutionQueueRepository extends ToolExecutionQueueRepository {
  constructor(@Inject(OutboxPrismaService) private readonly prisma: OutboxPrismaService) {
    super();
  }

  claim(input: {
    readonly workerId: string;
    readonly batchSize: number;
    readonly claimTtlMs: number;
  }): Promise<readonly ClaimedToolExecutionEvent[]> {
    return this.withWorkerRole(async (transaction) => {
      const rows = await transaction.$queryRaw<ClaimedRow[]>(Prisma.sql`
        WITH candidates AS MATERIALIZED (
          SELECT delivery."id"
          FROM public."outbox_event_deliveries" AS delivery
          JOIN public."outbox_events" AS event
            ON event."tenant_id" = delivery."tenant_id"
           AND event."id" = delivery."event_id"
          WHERE delivery."consumer_key" = ${OUTBOX_CONSUMER.toolExecution}
            AND delivery."lane" = ${OUTBOX_LANE.toolExecution}
            AND event."event_type" = ${TOOL_INVOCATION_COMMAND_EVENT_TYPE}
            AND event."aggregate_type" = 'TOOL_INVOCATION'
            AND delivery."status" = 'PENDING'::public."OutboxEventStatus"
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
    readonly providerRequestId: string | null;
    readonly outcome: 'executed' | 'skipped' | 'failed';
    readonly reasonCode: string;
  }): Promise<boolean> {
    const receipt = {
      outcome: input.outcome,
      reasonCode: safeCode(input.reasonCode),
      ...(input.providerRequestId === null ? {} : { providerRequestId: input.providerRequestId }),
    };
    return this.transition(
      input.eventId,
      input.workerId,
      Prisma.sql`
        "status" = 'PUBLISHED'::public."OutboxEventStatus",
        "acknowledged_at" = clock_timestamp(),
        "provider_name" = 'tool-gateway',
        "provider_receipt" = ${JSON.stringify(receipt)}::jsonb,
        "last_error" = NULL
      `,
    );
  }

  markUnknown(input: {
    readonly eventId: string;
    readonly workerId: string;
    readonly providerRequestId: string | null;
    readonly reasonCode: string;
  }): Promise<boolean> {
    return this.transition(
      input.eventId,
      input.workerId,
      Prisma.sql`
        "status" = 'UNKNOWN'::public."OutboxEventStatus",
        "acknowledged_at" = NULL,
        "provider_name" = 'tool-gateway',
        "provider_receipt" =
          '{"outcome":"unknown","deliveredRecipientCount":0,"reason":"delivery_outcome_unknown"}'::jsonb,
        "last_error" = ${queueError(input.reasonCode)}
      `,
    );
  }

  markFailed(input: {
    readonly eventId: string;
    readonly workerId: string;
    readonly reasonCode: string;
  }): Promise<boolean> {
    return this.transition(
      input.eventId,
      input.workerId,
      Prisma.sql`
        "status" = 'FAILED'::public."OutboxEventStatus",
        "acknowledged_at" = NULL,
        "provider_name" = NULL,
        "provider_receipt" = NULL,
        "last_error" = ${queueError(input.reasonCode)}
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
        "last_error" = ${queueError(input.reasonCode)}
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
          AND "consumer_key" = ${OUTBOX_CONSUMER.toolExecution}
          AND "status" = 'PENDING'::public."OutboxEventStatus"
          AND "locked_by" = ${workerId}
      `);
      return updated === 1;
    });
  }

  private withWorkerRole<T>(
    operation: (transaction: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    if (!this.prisma.enabled) {
      throw new Error('The Tool Execution worker requires the Prisma repository adapter.');
    }
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_outbox');
      return operation(transaction);
    });
  }
}

function safeCode(value: string): string {
  return /^[A-Z0-9_]{1,120}$/u.test(value) ? value : 'TOOL_EXECUTION_FAILED';
}

function queueError(value: string): string {
  return `${safeCode(value)}: Tool execution event did not complete.`;
}
