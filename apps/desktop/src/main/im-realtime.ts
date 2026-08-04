import { imRealtimeSessionSchema, type ImRealtimeSession } from '@enterprise/contracts';
import WKSDK, {
  ConnectStatus,
  type ConnectStatusListener,
  type Message,
  type MessageListener,
} from 'wukongimjssdk';

import type { DesktopImRealtimePayload } from '../shared/desktop-api';

export interface RealtimeSdk {
  connect(): Promise<void>;
  destroy(): void;
  on(event: RealtimeEvent, listener: (...args: unknown[]) => void): void;
  off(event: RealtimeEvent, listener: (...args: unknown[]) => void): void;
}

export type RealtimeEvent = 'connect' | 'disconnect' | 'message' | 'error' | 'reconnecting';

export type RealtimeSdkFactory = (
  session: Extract<ImRealtimeSession, { available: true }>,
) => RealtimeSdk;

export async function runImRealtime(input: {
  readonly loadSession: () => Promise<unknown>;
  readonly emit: (payload: DesktopImRealtimePayload) => void;
  readonly signal: AbortSignal;
  readonly sdkFactory?: RealtimeSdkFactory;
}): Promise<void> {
  input.emit({ kind: 'state', state: 'connecting' });
  const session = imRealtimeSessionSchema.parse(await input.loadSession());
  if (!session.available) {
    input.emit({ kind: 'state', state: 'unavailable' });
    return;
  }

  const sdk = (input.sdkFactory ?? createSdk)(session);
  const onConnect = (): void => input.emit({ kind: 'state', state: 'connected' });
  const onReconnecting = (): void => input.emit({ kind: 'state', state: 'reconnecting' });
  const onDisconnect = (): void => {
    if (!input.signal.aborted) input.emit({ kind: 'state', state: 'reconnecting' });
  };
  const onError = (): void => {
    if (!input.signal.aborted) {
      input.emit({
        kind: 'state',
        state: 'reconnecting',
        error: 'Realtime messaging connection was interrupted.',
      });
    }
  };
  const onMessage = (value: unknown): void => {
    const received = parseIncomingMessage(value);
    input.emit({
      kind: 'message',
      ...received,
      receivedAt: new Date().toISOString(),
    });
  };
  sdk.on('connect', onConnect);
  sdk.on('reconnecting', onReconnecting);
  sdk.on('disconnect', onDisconnect);
  sdk.on('error', onError);
  sdk.on('message', onMessage);

  try {
    await Promise.race([sdk.connect(), abortPromise(input.signal)]);
    if (!input.signal.aborted) input.emit({ kind: 'state', state: 'connected' });
    await waitForAbort(input.signal);
  } finally {
    sdk.off('connect', onConnect);
    sdk.off('reconnecting', onReconnecting);
    sdk.off('disconnect', onDisconnect);
    sdk.off('error', onError);
    sdk.off('message', onMessage);
    sdk.destroy();
    input.emit({ kind: 'state', state: 'closed' });
  }
}

function createSdk(session: Extract<ImRealtimeSession, { available: true }>): RealtimeSdk {
  return new WuKongSdkAdapter(session);
}

export function parseIncomingMessage(value: unknown): {
  readonly conversationId: string | null;
  readonly messageId: string | null;
  readonly eventId: string | null;
} {
  const payload = isRecord(value) ? Reflect.get(value, 'payload') : undefined;
  const content = isRecord(value) ? Reflect.get(value, 'content') : undefined;
  const raw = isRecord(payload) ? payload : isRecord(content) ? content : undefined;
  const enterprise = isRecord(raw) && isRecord(raw.enterprise) ? raw.enterprise : null;
  return {
    conversationId: readUuid(enterprise?.conversationId),
    messageId: readUuid(enterprise?.messageId),
    eventId: readUuid(enterprise?.eventId),
  };
}

class WuKongSdkAdapter implements RealtimeSdk {
  private readonly sdk = WKSDK.shared();
  private readonly listeners = new Map<RealtimeEvent, Set<(...args: unknown[]) => void>>();
  private readonly statusListener: ConnectStatusListener;
  private readonly messageListener: MessageListener;
  private connectResolve: (() => void) | undefined;
  private connectReject: ((error: Error) => void) | undefined;
  private connectTimer: NodeJS.Timeout | undefined;
  private destroyed = false;

  constructor(session: Extract<ImRealtimeSession, { available: true }>) {
    if (this.sdk.connectManager.connected()) this.sdk.disconnect();
    this.sdk.config.uid = session.uid;
    this.sdk.config.token = session.token;
    this.sdk.config.deviceFlag = session.deviceFlag;
    this.sdk.config.debug = false;
    this.sdk.config.provider.connectAddrCallback = (callback) => callback(session.websocketUrl);
    this.statusListener = (status, reasonCode) => this.handleStatus(status, reasonCode);
    this.messageListener = (message: Message) => this.emit('message', message);
    this.sdk.connectManager.addConnectStatusListener(this.statusListener);
    this.sdk.chatManager.addMessageListener(this.messageListener);
  }

  connect(): Promise<void> {
    if (this.destroyed) return Promise.reject(new Error('Realtime SDK has been destroyed.'));
    return new Promise((resolve, reject) => {
      this.connectResolve = resolve;
      this.connectReject = reject;
      this.connectTimer = setTimeout(
        () => this.rejectConnect(new Error('WuKongIM websocket connection timed out.')),
        15_000,
      );
      this.connectTimer.unref();
      this.sdk.connect();
    });
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.connectTimer !== undefined) clearTimeout(this.connectTimer);
    this.connectTimer = undefined;
    this.sdk.connectManager.removeConnectStatusListener(this.statusListener);
    this.sdk.chatManager.removeMessageListener(this.messageListener);
    this.sdk.disconnect();
    this.listeners.clear();
  }

  on(event: RealtimeEvent, listener: (...args: unknown[]) => void): void {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  off(event: RealtimeEvent, listener: (...args: unknown[]) => void): void {
    this.listeners.get(event)?.delete(listener);
  }

  private handleStatus(status: ConnectStatus, reasonCode?: number): void {
    if (this.destroyed) return;
    if (status === ConnectStatus.Connected) {
      if (this.connectTimer !== undefined) clearTimeout(this.connectTimer);
      this.connectTimer = undefined;
      this.connectResolve?.();
      this.connectResolve = undefined;
      this.connectReject = undefined;
      this.emit('connect');
      return;
    }
    if (status === ConnectStatus.Connecting) {
      this.emit('reconnecting');
      return;
    }
    if (status === ConnectStatus.ConnectFail || status === ConnectStatus.ConnectKick) {
      const error = new Error(`WuKongIM connection was rejected (reason ${String(reasonCode)}).`);
      this.rejectConnect(error);
      this.emit('error', error);
      return;
    }
    this.emit('disconnect');
  }

  private rejectConnect(error: Error): void {
    if (this.connectTimer !== undefined) clearTimeout(this.connectTimer);
    this.connectTimer = undefined;
    this.connectReject?.(error);
    this.connectResolve = undefined;
    this.connectReject = undefined;
  }

  private emit(event: RealtimeEvent, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}

function readUuid(value: unknown): string | null {
  return typeof value === 'string' && UUID_PATTERN.test(value) ? value : null;
}

function abortPromise(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) {
      reject(
        signal.reason instanceof Error ? signal.reason : new Error('Realtime stream stopped.'),
      );
      return;
    }
    signal.addEventListener(
      'abort',
      () =>
        reject(
          signal.reason instanceof Error ? signal.reason : new Error('Realtime stream stopped.'),
        ),
      { once: true },
    );
  });
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
