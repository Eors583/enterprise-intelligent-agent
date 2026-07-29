import { describe, expect, it } from 'vitest';

import { agentRunStreamPageSchema } from '../src/agent-run.js';

const runId = '00000000-0000-7000-8000-000000000901';

describe('Agent Run stream contracts', () => {
  it('accepts ordered delta and terminal cursor pages', () => {
    expect(
      agentRunStreamPageSchema.parse({
        items: [
          {
            eventId: `${runId}:1`,
            sequence: 1,
            type: 'delta',
            delta: 'hello',
            deltaHash: 'a'.repeat(64),
            createdAt: '2026-07-28T08:00:00.000Z',
          },
          {
            eventId: `${runId}:2`,
            sequence: 2,
            type: 'terminal',
            status: 'SUCCEEDED',
            createdAt: '2026-07-28T08:00:01.000Z',
          },
        ],
        nextCursor: 2,
        terminal: true,
      }).nextCursor,
    ).toBe(2);
  });

  it('rejects duplicate or unbounded events and false terminal pages', () => {
    const malformed = {
      items: [
        {
          eventId: `${runId}:1`,
          sequence: 1,
          type: 'terminal',
          status: 'SUCCEEDED',
          createdAt: '2026-07-28T08:00:00.000Z',
        },
      ],
      nextCursor: 1,
      terminal: false,
    };
    expect(agentRunStreamPageSchema.safeParse(malformed).success).toBe(false);
    expect(
      agentRunStreamPageSchema.safeParse({
        ...malformed,
        items: [
          {
            eventId: `${runId}:1`,
            sequence: 1,
            type: 'delta',
            delta: 'x'.repeat(16_385),
            deltaHash: 'a'.repeat(64),
            createdAt: '2026-07-28T08:00:00.000Z',
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('reserves sequence 10000 and 10001 for UNKNOWN and its final reconciliation', () => {
    const common = {
      eventId: `${runId}:10000`,
      sequence: 10_000,
      createdAt: '2026-07-28T08:00:00.000Z',
    };
    expect(
      agentRunStreamPageSchema.safeParse({
        items: [
          {
            ...common,
            type: 'delta',
            delta: 'no terminal capacity',
            deltaHash: 'a'.repeat(64),
          },
        ],
        nextCursor: 10_000,
        terminal: false,
      }).success,
    ).toBe(false);
    expect(
      agentRunStreamPageSchema.safeParse({
        items: [{ ...common, type: 'terminal', status: 'SUCCEEDED' }],
        nextCursor: 10_000,
        terminal: true,
      }).success,
    ).toBe(true);
    expect(
      agentRunStreamPageSchema.safeParse({
        items: [
          { ...common, type: 'terminal', status: 'UNKNOWN' },
          {
            ...common,
            eventId: `${runId}:10001`,
            sequence: 10_001,
            type: 'terminal',
            status: 'SUCCEEDED',
          },
        ],
        nextCursor: 10_001,
        terminal: true,
      }).success,
    ).toBe(true);
  });

  it('allows an append-only UNKNOWN marker to be reconciled by one final terminal', () => {
    const unknown = {
      eventId: `${runId}:1`,
      sequence: 1,
      type: 'terminal_only' as const,
      status: 'UNKNOWN' as const,
      createdAt: '2026-07-28T08:00:00.000Z',
    };
    const succeeded = {
      eventId: `${runId}:2`,
      sequence: 2,
      type: 'terminal' as const,
      status: 'SUCCEEDED' as const,
      createdAt: '2026-07-28T08:01:00.000Z',
    };

    expect(
      agentRunStreamPageSchema.safeParse({
        items: [unknown],
        nextCursor: 1,
        terminal: false,
      }).success,
    ).toBe(true);
    expect(
      agentRunStreamPageSchema.safeParse({
        items: [unknown, succeeded],
        nextCursor: 2,
        terminal: true,
      }).success,
    ).toBe(true);
    expect(
      agentRunStreamPageSchema.safeParse({
        items: [{ ...unknown, status: 'FAILED' }, succeeded],
        nextCursor: 2,
        terminal: true,
      }).success,
    ).toBe(false);
  });
});
