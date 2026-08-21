import { describe, expect, it, vi } from 'vitest';

import {
  parseIncomingMessage,
  runImRealtime,
  type RealtimeEvent,
  type RealtimeSdk,
} from './im-realtime';

describe('runImRealtime', () => {
  it('reports an unavailable provider without opening a socket', async () => {
    const emit = vi.fn();
    const sdkFactory = vi.fn();
    await runImRealtime({
      loadSession: async () => ({
        available: false,
        provider: 'local',
        reason: 'REALTIME_NOT_CONFIGURED',
      }),
      emit,
      signal: new AbortController().signal,
      sdkFactory,
    });
    expect(sdkFactory).not.toHaveBeenCalled();
    expect(emit.mock.calls.map(([value]) => value)).toEqual([
      { kind: 'state', state: 'connecting' },
      { kind: 'state', state: 'unavailable' },
    ]);
  });

  it('forwards only transport wake-up metadata and destroys the SDK on cancellation', async () => {
    const sdk = new FakeSdk();
    const emit = vi.fn();
    const controller = new AbortController();
    const running = runImRealtime({
      loadSession: async () => ({
        available: true,
        provider: 'wukong',
        websocketUrl: 'ws://127.0.0.1:5520',
        uid: 'u_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG',
        token: 'a-secure-realtime-token',
        deviceFlag: 2,
      }),
      emit,
      signal: controller.signal,
      sdkFactory: () => sdk,
    });
    await vi.waitFor(() => expect(sdk.connect).toHaveBeenCalledOnce());
    sdk.fire('message', {
      payload: {
        type: 1,
        content: 'untrusted transport text',
        enterprise: {
          conversationId: '00000000-0000-7000-8000-000000000701',
          messageId: '00000000-0000-7000-8000-000000000801',
          eventId: '00000000-0000-7000-8000-000000000901',
        },
      },
    });
    controller.abort(new Error('test complete'));
    await running;

    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'message',
        conversationId: '00000000-0000-7000-8000-000000000701',
        messageId: '00000000-0000-7000-8000-000000000801',
        eventId: '00000000-0000-7000-8000-000000000901',
      }),
    );
    expect(JSON.stringify(emit.mock.calls)).not.toContain('untrusted transport text');
    expect(sdk.destroy).toHaveBeenCalledOnce();
  });

  it('drops malformed enterprise identifiers', () => {
    expect(
      parseIncomingMessage({
        payload: {
          enterprise: {
            conversationId: '../other-tenant',
            messageId: 'not-a-uuid',
            eventId: 123,
          },
        },
      }),
    ).toEqual({ conversationId: null, messageId: null, eventId: null });
  });
});

class FakeSdk implements RealtimeSdk {
  readonly connect = vi.fn(async () => undefined);
  readonly destroy = vi.fn();
  private readonly listeners = new Map<RealtimeEvent, Set<(...args: unknown[]) => void>>();

  on(event: RealtimeEvent, listener: (...args: unknown[]) => void): void {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  off(event: RealtimeEvent, listener: (...args: unknown[]) => void): void {
    this.listeners.get(event)?.delete(listener);
  }

  fire(event: RealtimeEvent, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}
