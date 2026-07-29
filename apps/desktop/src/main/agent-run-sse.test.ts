import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import { consumeAgentRunSse } from './agent-run-sse';

const RUN_ID = '00000000-0000-7000-8000-000000000901';

describe('desktop Agent Run SSE parser', () => {
  it('decodes split frames, ignores heartbeats, and preserves contiguous cursors', async () => {
    const first = eventFrame(1, 'delta', {
      eventId: `${RUN_ID}:1`,
      sequence: 1,
      type: 'delta',
      delta: '企业',
      deltaHash: hash('企业'),
      createdAt: '2026-07-29T04:00:00.000Z',
    });
    const terminal = eventFrame(2, 'terminal', {
      eventId: `${RUN_ID}:2`,
      sequence: 2,
      type: 'terminal',
      status: 'SUCCEEDED',
      createdAt: '2026-07-29T04:00:01.000Z',
    });
    const events = vi.fn();
    const response = streamResponse([
      first.slice(0, 23),
      `${first.slice(23)}: heartbeat\n\n${terminal}`,
    ]);

    await expect(
      consumeAgentRunSse({
        response,
        runId: RUN_ID,
        cursor: 0,
        signal: new AbortController().signal,
        onEvent: events,
      }),
    ).resolves.toEqual({ cursor: 2, terminal: true });
    expect(events.mock.calls.map(([event]) => event.type)).toEqual(['delta', 'terminal']);
  });

  it('keeps UNKNOWN terminal-only as a resumable checkpoint', async () => {
    const response = streamResponse([
      eventFrame(1, 'terminal_only', {
        eventId: `${RUN_ID}:1`,
        sequence: 1,
        type: 'terminal_only',
        status: 'UNKNOWN',
        createdAt: '2026-07-29T04:00:00.000Z',
      }),
    ]);

    await expect(
      consumeAgentRunSse({
        response,
        runId: RUN_ID,
        cursor: 0,
        signal: new AbortController().signal,
        onEvent: vi.fn(),
      }),
    ).resolves.toEqual({ cursor: 1, terminal: false });
  });

  it('rejects gaps and event identities from another Run', async () => {
    const response = streamResponse([
      eventFrame(2, 'terminal', {
        eventId: `${RUN_ID}:2`,
        sequence: 2,
        type: 'terminal',
        status: 'FAILED',
        createdAt: '2026-07-29T04:00:00.000Z',
      }),
    ]);

    await expect(
      consumeAgentRunSse({
        response,
        runId: RUN_ID,
        cursor: 0,
        signal: new AbortController().signal,
        onEvent: vi.fn(),
      }),
    ).rejects.toThrow('not contiguous');
  });
});

function eventFrame(sequence: number, event: string, data: unknown): string {
  return `id: ${RUN_ID}:${sequence}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function streamResponse(chunks: readonly string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' } },
  );
}

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
