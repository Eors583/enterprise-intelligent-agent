import type { PrismaService } from '../../../../database/prisma.service.js';
import { describe, expect, it, vi } from 'vitest';

import {
  appendTerminalStreamEvent,
  PrismaAgentRunStreamRepository,
} from './prisma-agent-run-stream.repository.js';

const TENANT_ID = '00000000-0000-7000-8000-000000000001';
const USER_ID = '00000000-0000-7000-8000-000000000002';
const CONVERSATION_ID = '00000000-0000-7000-8000-000000000003';
const RUN_ID = '00000000-0000-7000-8000-000000000004';

describe('PrismaAgentRunStreamRepository', () => {
  it('default-denies outside the exact tenant, conversation, and active participant scope', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const findMany = vi.fn();
    const repository = createRepository({ findFirst, findMany });

    await expect(
      repository.listForParticipant({
        tenantId: TENANT_ID,
        userId: USER_ID,
        conversationId: CONVERSATION_ID,
        runId: RUN_ID,
        cursor: 0,
        limit: 128,
      }),
    ).resolves.toBeNull();

    expect(findFirst).toHaveBeenCalledWith({
      where: {
        id: RUN_ID,
        tenantId: TENANT_ID,
        conversationId: CONVERSATION_ID,
        conversation: {
          participants: {
            some: {
              tenantId: TENANT_ID,
              type: 'USER',
              userId: USER_ID,
              leftAt: null,
            },
          },
        },
      },
      select: { status: true },
    });
    expect(findMany).not.toHaveBeenCalled();
  });

  it('does not stop a terminal Run page before its final queued events are replayed', async () => {
    const findFirst = vi.fn().mockResolvedValue({ status: 'SUCCEEDED' });
    const findMany = vi.fn().mockResolvedValue([
      {
        eventId: `${RUN_ID}:1`,
        sequence: 1,
        type: 'DELTA',
        delta: 'partial',
        deltaHash: 'a'.repeat(64),
        terminalStatus: null,
        createdAt: new Date('2026-07-28T08:00:00.000Z'),
      },
    ]);
    const repository = createRepository({ findFirst, findMany });

    const firstPage = await repository.listForParticipant({
      tenantId: TENANT_ID,
      userId: USER_ID,
      conversationId: CONVERSATION_ID,
      runId: RUN_ID,
      cursor: 0,
      limit: 1,
    });
    expect(firstPage).toMatchObject({
      nextCursor: 1,
      terminal: false,
      items: [{ sequence: 1, type: 'delta', delta: 'partial' }],
    });

    findMany.mockResolvedValueOnce([]);
    const legacyTerminalPage = await repository.listForParticipant({
      tenantId: TENANT_ID,
      userId: USER_ID,
      conversationId: CONVERSATION_ID,
      runId: RUN_ID,
      cursor: 1,
      limit: 1,
    });
    expect(legacyTerminalPage).toMatchObject({ items: [], nextCursor: 1, terminal: true });
  });

  it('keeps a prior UNKNOWN marker open while reconciliation is running', async () => {
    const findFirst = vi.fn().mockResolvedValue({ status: 'RUNNING' });
    const findMany = vi.fn().mockResolvedValue([
      {
        eventId: `${RUN_ID}:1`,
        sequence: 1,
        type: 'TERMINAL_ONLY',
        delta: null,
        deltaHash: null,
        terminalStatus: 'UNKNOWN',
        createdAt: new Date('2026-07-28T08:00:00.000Z'),
      },
    ]);
    const repository = createRepository({ findFirst, findMany });

    const reconciling = await repository.listForParticipant({
      tenantId: TENANT_ID,
      userId: USER_ID,
      conversationId: CONVERSATION_ID,
      runId: RUN_ID,
      cursor: 0,
      limit: 128,
    });
    expect(reconciling).toMatchObject({
      nextCursor: 1,
      terminal: false,
      items: [{ sequence: 1, type: 'terminal_only', status: 'UNKNOWN' }],
    });

    findFirst.mockResolvedValueOnce({ status: 'SUCCEEDED' });
    findMany.mockResolvedValueOnce([
      {
        eventId: `${RUN_ID}:2`,
        sequence: 2,
        type: 'TERMINAL_RECONCILED',
        delta: null,
        deltaHash: null,
        terminalStatus: 'SUCCEEDED',
        createdAt: new Date('2026-07-28T08:01:00.000Z'),
      },
    ]);
    const final = await repository.listForParticipant({
      tenantId: TENANT_ID,
      userId: USER_ID,
      conversationId: CONVERSATION_ID,
      runId: RUN_ID,
      cursor: 1,
      limit: 128,
    });
    expect(final).toMatchObject({
      nextCursor: 2,
      terminal: true,
      items: [{ sequence: 2, type: 'terminal', status: 'SUCCEEDED' }],
    });
  });

  it('keeps UNKNOWN open for the client even before reconciliation starts', async () => {
    const findFirst = vi.fn().mockResolvedValue({ status: 'UNKNOWN' });
    const findMany = vi.fn().mockResolvedValue([
      {
        eventId: `${RUN_ID}:1`,
        sequence: 1,
        type: 'TERMINAL_ONLY',
        delta: null,
        deltaHash: null,
        terminalStatus: 'UNKNOWN',
        createdAt: new Date('2026-07-28T08:00:00.000Z'),
      },
    ]);
    const repository = createRepository({ findFirst, findMany });

    await expect(
      repository.listForParticipant({
        tenantId: TENANT_ID,
        userId: USER_ID,
        conversationId: CONVERSATION_ID,
        runId: RUN_ID,
        cursor: 0,
        limit: 128,
      }),
    ).resolves.toMatchObject({ nextCursor: 1, terminal: false });
  });

  it('treats a repeated UNKNOWN as idempotent after reconciliation streamed deltas', async () => {
    const executeRaw = vi.fn();
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([{ lock_token: 'locked' }]),
      $executeRaw: executeRaw,
      agentRunStreamEvent: {
        aggregate: vi.fn().mockResolvedValue({ _max: { sequence: 2 } }),
        findFirst: vi.fn().mockResolvedValue({ id: 'delta-event' }),
        findMany: vi.fn().mockResolvedValue([
          {
            sequence: 1,
            type: 'TERMINAL_ONLY',
            terminalStatus: 'UNKNOWN',
          },
        ]),
      },
    };

    await appendTerminalStreamEvent(transaction as never, {
      tenantId: TENANT_ID,
      runId: RUN_ID,
      status: 'UNKNOWN',
      mode: 'live',
      createdAt: new Date('2026-07-28T08:01:00.000Z'),
    });

    expect(executeRaw).not.toHaveBeenCalled();
  });
});

function createRepository(mocks: {
  readonly findFirst: ReturnType<typeof vi.fn>;
  readonly findMany: ReturnType<typeof vi.fn>;
}): PrismaAgentRunStreamRepository {
  const transaction = {
    agentRun: { findFirst: mocks.findFirst },
    agentRunStreamEvent: { findMany: mocks.findMany },
  };
  const prisma = {
    withTenant: vi.fn(
      (_tenantId: string, operation: (value: typeof transaction) => Promise<unknown>) =>
        operation(transaction),
    ),
  } as unknown as PrismaService;
  return new PrismaAgentRunStreamRepository(prisma);
}
