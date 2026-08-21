import { describe, expect, it } from 'vitest';

import { applyAgentRunStreamPage } from './stream-state';

const runId = '00000000-0000-7000-8000-000000000901';
const createdAt = '2026-07-28T08:00:00.000Z';

describe('Agent Run stream replay state', () => {
  it('appends deltas once across cursors and transitions replaying to live', () => {
    const first = applyAgentRunStreamPage(
      { content: '', cursor: 0, caughtUp: false },
      {
        items: [
          {
            eventId: `${runId}:1`,
            sequence: 1,
            type: 'delta',
            delta: 'hel',
            deltaHash: 'a'.repeat(64),
            createdAt,
          },
        ],
        nextCursor: 1,
        terminal: false,
      },
    );
    expect(first).toMatchObject({
      state: { content: 'hel', cursor: 1 },
      phase: 'replaying',
    });

    const live = applyAgentRunStreamPage(first.state, {
      items: [
        {
          eventId: `${runId}:2`,
          sequence: 2,
          type: 'delta',
          delta: 'lo',
          deltaHash: 'b'.repeat(64),
          createdAt,
        },
      ],
      nextCursor: 2,
      terminal: false,
    });
    expect(live).toMatchObject({ state: { content: 'hello', cursor: 2 }, phase: 'live' });
  });

  it('labels honest terminal-only providers and rejects gaps or duplicates', () => {
    const terminal = applyAgentRunStreamPage(
      { content: '', cursor: 0, caughtUp: false },
      {
        items: [
          {
            eventId: `${runId}:1`,
            sequence: 1,
            type: 'terminal_only',
            status: 'SUCCEEDED',
            createdAt,
          },
        ],
        nextCursor: 1,
        terminal: true,
      },
    );
    expect(terminal.phase).toBe('terminal_only');

    expect(() =>
      applyAgentRunStreamPage(
        { content: 'hel', cursor: 1, caughtUp: true },
        {
          items: [
            {
              eventId: `${runId}:3`,
              sequence: 3,
              type: 'delta',
              delta: 'lo',
              deltaHash: 'c'.repeat(64),
              createdAt,
            },
          ],
          nextCursor: 3,
          terminal: false,
        },
      ),
    ).toThrow(/contiguous/);
  });

  it('resumes after an offline interval from the durable cursor without duplicating text', () => {
    const beforeDisconnect = applyAgentRunStreamPage(
      { content: '', cursor: 0, caughtUp: false },
      {
        items: [
          {
            eventId: `${runId}:1`,
            sequence: 1,
            type: 'delta',
            delta: 'durable ',
            deltaHash: 'd'.repeat(64),
            createdAt,
          },
        ],
        nextCursor: 1,
        terminal: false,
      },
    ).state;

    // A transport failure does not mutate content or cursor. The next request
    // therefore asks strictly after sequence 1 and receives sequence 2 once.
    const afterReconnect = applyAgentRunStreamPage(beforeDisconnect, {
      items: [
        {
          eventId: `${runId}:2`,
          sequence: 2,
          type: 'delta',
          delta: 'stream',
          deltaHash: 'e'.repeat(64),
          createdAt,
        },
        {
          eventId: `${runId}:3`,
          sequence: 3,
          type: 'terminal',
          status: 'SUCCEEDED',
          createdAt,
        },
      ],
      nextCursor: 3,
      terminal: true,
    });

    expect(afterReconnect).toMatchObject({
      state: { content: 'durable stream', cursor: 3 },
      phase: 'terminal',
    });
    expect(afterReconnect.state.content.match(/durable/g)).toHaveLength(1);
  });

  it('uses the final reconciliation marker after an earlier UNKNOWN terminal', () => {
    const reconciled = applyAgentRunStreamPage(
      { content: '', cursor: 0, caughtUp: false },
      {
        items: [
          {
            eventId: `${runId}:1`,
            sequence: 1,
            type: 'terminal_only',
            status: 'UNKNOWN',
            createdAt,
          },
          {
            eventId: `${runId}:2`,
            sequence: 2,
            type: 'terminal',
            status: 'SUCCEEDED',
            createdAt,
          },
        ],
        nextCursor: 2,
        terminal: true,
      },
    );

    expect(reconciled).toMatchObject({
      state: { cursor: 2 },
      phase: 'terminal',
    });
  });
});
