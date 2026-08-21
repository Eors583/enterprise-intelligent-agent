import { Inject, Injectable } from '@nestjs/common';
import { Prisma, type AgentRunStatus, type AgentRunStreamEventType } from '@prisma/client';
import type { AgentRunStreamEvent, AgentRunStreamPage } from '@enterprise/contracts';

import { PrismaService } from '../../../../database/prisma.service.js';
import {
  AgentRunStreamRepository,
  type AppendAgentRunDelta,
} from '../../domain/agent-run-stream.repository.js';

type Transaction = Prisma.TransactionClient;

@Injectable()
export class PrismaAgentRunStreamRepository extends AgentRunStreamRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {
    super();
  }

  cursor(tenantId: string, runId: string): Promise<number> {
    return this.prisma.withTenant(tenantId, async (transaction) => {
      const aggregate = await transaction.agentRunStreamEvent.aggregate({
        where: { tenantId, runId },
        _max: { sequence: true },
      });
      return aggregate._max.sequence ?? 0;
    });
  }

  appendDelta(input: AppendAgentRunDelta): Promise<void> {
    validateDelta(input);
    return this.prisma.withTenant(input.tenantId, async (transaction) => {
      // Acquire the per-Run lock in its own statement. Under READ COMMITTED the
      // following lookup then receives a fresh snapshot after any concurrent
      // exact replay commits, so idempotency never depends on catching a unique
      // constraint error from the INSERT statement itself.
      await lockStream(transaction, input.tenantId, input.runId);
      const existing = await transaction.agentRunStreamEvent.findFirst({
        where: {
          tenantId: input.tenantId,
          runId: input.runId,
          sequence: input.sequence,
        },
      });
      if (existing !== null) {
        if (
          existing.eventId !== input.eventId ||
          existing.type !== 'DELTA' ||
          existing.delta !== input.delta ||
          existing.deltaHash !== input.deltaHash
        ) {
          throw new Error('Agent Run stream replay conflicts with the durable event.');
        }
        return;
      }
      await transaction.$executeRaw(Prisma.sql`
        INSERT INTO public."agent_run_stream_events" (
          "id", "tenant_id", "run_id", "sequence", "event_id", "type",
          "delta", "delta_hash", "created_at"
        ) VALUES (
          gen_random_uuid(),
          ${input.tenantId}::uuid,
          ${input.runId}::uuid,
          ${input.sequence},
          ${input.eventId},
          'DELTA'::public."AgentRunStreamEventType",
          ${input.delta},
          ${input.deltaHash},
          ${input.createdAt}
        )
      `);
    });
  }

  listForParticipant(input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly conversationId: string;
    readonly runId: string;
    readonly cursor: number;
    readonly limit: number;
  }): Promise<AgentRunStreamPage | null> {
    return this.prisma.withTenant(input.tenantId, async (transaction) => {
      const run = await transaction.agentRun.findFirst({
        where: {
          id: input.runId,
          tenantId: input.tenantId,
          conversationId: input.conversationId,
          conversation: {
            participants: {
              some: {
                tenantId: input.tenantId,
                type: 'USER',
                userId: input.userId,
                leftAt: null,
              },
            },
          },
        },
        select: { status: true },
      });
      if (run === null) return null;

      const rows = await transaction.agentRunStreamEvent.findMany({
        where: {
          tenantId: input.tenantId,
          runId: input.runId,
          sequence: { gt: input.cursor },
        },
        orderBy: { sequence: 'asc' },
        take: input.limit,
      });
      const items = rows.map(mapEvent);
      const nextCursor = items.at(-1)?.sequence ?? input.cursor;
      const hasCurrentTerminal = rows.some(
        (row) =>
          row.type !== 'DELTA' && row.terminalStatus !== null && row.terminalStatus === run.status,
      );
      return {
        items,
        nextCursor,
        terminal: isTerminalStatus(run.status) && (hasCurrentTerminal || rows.length === 0),
      };
    });
  }
}

export async function appendTerminalStreamEvent(
  transaction: Transaction,
  input: {
    readonly tenantId: string;
    readonly runId: string;
    readonly status: Extract<AgentRunStatus, 'SUCCEEDED' | 'FAILED' | 'UNKNOWN' | 'CANCELLED'>;
    readonly mode: 'live' | 'terminal_only';
    readonly createdAt: Date;
  },
): Promise<void> {
  await lockStream(transaction, input.tenantId, input.runId);
  const aggregate = await transaction.agentRunStreamEvent.aggregate({
    where: { tenantId: input.tenantId, runId: input.runId },
    _max: { sequence: true },
  });
  const priorDelta = await transaction.agentRunStreamEvent.findFirst({
    where: {
      tenantId: input.tenantId,
      runId: input.runId,
      type: 'DELTA',
    },
    select: { id: true },
  });
  const effectiveMode = priorDelta === null ? input.mode : 'live';
  const existing = await transaction.agentRunStreamEvent.findMany({
    where: {
      tenantId: input.tenantId,
      runId: input.runId,
      type: { in: ['TERMINAL', 'TERMINAL_ONLY', 'TERMINAL_RECONCILED'] },
    },
    orderBy: { sequence: 'asc' },
  });
  const matching = existing.find((event) => event.terminalStatus === input.status);
  if (matching !== undefined) {
    // UNKNOWN is a durable uncertainty checkpoint, not a final client
    // terminal. A later reconciliation can stream deltas before ending in
    // UNKNOWN again; that does not reinterpret the historical marker's mode.
    if (input.status === 'UNKNOWN') return;
    const expectedType = effectiveMode === 'terminal_only' ? 'TERMINAL_ONLY' : 'TERMINAL';
    if (matching.type !== expectedType && matching.type !== 'TERMINAL_RECONCILED') {
      throw new Error('Agent Run terminal stream event conflicts with durable state.');
    }
    return;
  }
  const priorUnknown = existing.find(
    (event) =>
      (event.type === 'TERMINAL' || event.type === 'TERMINAL_ONLY') &&
      event.terminalStatus === 'UNKNOWN',
  );
  if (
    existing.length > 0 &&
    (priorUnknown === undefined || input.status === 'UNKNOWN' || existing.length > 1)
  ) {
    throw new Error('Agent Run terminal stream event conflicts with durable state.');
  }
  const sequence = (aggregate._max.sequence ?? 0) + 1;
  if (sequence > 10_001) throw new Error('Agent Run stream event limit exceeded.');
  const type =
    priorUnknown === undefined
      ? effectiveMode === 'terminal_only'
        ? 'TERMINAL_ONLY'
        : 'TERMINAL'
      : 'TERMINAL_RECONCILED';
  await transaction.$executeRaw(Prisma.sql`
    INSERT INTO public."agent_run_stream_events" (
      "id", "tenant_id", "run_id", "sequence", "event_id", "type",
      "terminal_status", "created_at"
    ) VALUES (
      gen_random_uuid(),
      ${input.tenantId}::uuid,
      ${input.runId}::uuid,
      ${sequence},
      ${`${input.runId}:${sequence}`},
      ${type}::public."AgentRunStreamEventType",
      ${input.status}::public."AgentRunStatus",
      ${input.createdAt}
    )
  `);
}

async function lockStream(
  transaction: Transaction,
  tenantId: string,
  runId: string,
): Promise<void> {
  const key = `agent-run-stream:${tenantId}:${runId}`;
  await transaction.$queryRaw(
    Prisma.sql`
      SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))::text AS lock_token
    `,
  );
}

function mapEvent(source: {
  readonly eventId: string;
  readonly sequence: number;
  readonly type: AgentRunStreamEventType;
  readonly delta: string | null;
  readonly deltaHash: string | null;
  readonly terminalStatus: AgentRunStatus | null;
  readonly createdAt: Date;
}): AgentRunStreamEvent {
  if (source.type === 'DELTA') {
    if (source.delta === null || source.deltaHash === null) {
      throw new Error('Stored Agent Run delta is incomplete.');
    }
    return {
      eventId: source.eventId,
      sequence: source.sequence,
      type: 'delta',
      delta: source.delta,
      deltaHash: source.deltaHash,
      createdAt: source.createdAt.toISOString(),
    };
  }
  if (
    source.terminalStatus !== 'SUCCEEDED' &&
    source.terminalStatus !== 'FAILED' &&
    source.terminalStatus !== 'UNKNOWN' &&
    source.terminalStatus !== 'CANCELLED'
  ) {
    throw new Error('Stored Agent Run terminal event is incomplete.');
  }
  return {
    eventId: source.eventId,
    sequence: source.sequence,
    type: source.type === 'TERMINAL_ONLY' ? 'terminal_only' : 'terminal',
    status: source.terminalStatus,
    createdAt: source.createdAt.toISOString(),
  };
}

function validateDelta(input: AppendAgentRunDelta): void {
  if (
    input.sequence < 1 ||
    input.sequence >= 10_000 ||
    input.eventId !== `${input.runId}:${input.sequence}` ||
    Buffer.byteLength(input.delta, 'utf8') < 1 ||
    Buffer.byteLength(input.delta, 'utf8') > 16_384 ||
    !/^[a-f0-9]{64}$/.test(input.deltaHash)
  ) {
    throw new Error('Invalid Agent Run stream delta.');
  }
}

function isTerminalStatus(status: AgentRunStatus): boolean {
  return ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(status);
}
