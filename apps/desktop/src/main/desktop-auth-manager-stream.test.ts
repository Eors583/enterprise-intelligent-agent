import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AuthAccount, AuthSessionResponse } from '@enterprise/contracts';
import type { AccountStore } from './account-store';
import { DesktopAuthManager } from './desktop-auth-manager';

const SESSION_ID = '00000000-0000-7000-8000-000000000001';
const CONVERSATION_ID = '00000000-0000-7000-8000-000000000002';
const RUN_ID = '00000000-0000-7000-8000-000000000003';
const OLD_TOKEN = `ea_access_${'a'.repeat(43)}`;
const NEW_TOKEN = `ea_access_${'b'.repeat(43)}`;

describe('DesktopAuthManager Agent Run SSE', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reconnects with the durable cursor instead of REST polling', async () => {
    const requests: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchMock = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      requests.push({ url: String(url), headers });
      if (requests.length === 1) {
        return Promise.resolve(
          sseResponse([
            frame(1, 'delta', {
              eventId: `${RUN_ID}:1`,
              sequence: 1,
              type: 'delta',
              delta: '可信',
              deltaHash: hash('可信'),
              createdAt: '2026-07-29T04:00:00.000Z',
            }),
          ]),
        );
      }
      return Promise.resolve(
        sseResponse([
          frame(2, 'terminal', {
            eventId: `${RUN_ID}:2`,
            sequence: 2,
            type: 'terminal',
            status: 'SUCCEEDED',
            createdAt: '2026-07-29T04:00:01.000Z',
          }),
        ]),
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const manager = managerWithToken(OLD_TOKEN);
    const updates = vi.fn();

    await manager.streamAgentRun(
      {
        conversationId: CONVERSATION_ID,
        runId: RUN_ID,
        expectedSessionId: SESSION_ID,
        cursor: 0,
      },
      updates,
      new AbortController().signal,
    );

    expect(requests.map(({ url }) => url)).toEqual([
      `http://127.0.0.1:3000/api/v1/conversations/${CONVERSATION_ID}/runs/${RUN_ID}/stream?cursor=0`,
      `http://127.0.0.1:3000/api/v1/conversations/${CONVERSATION_ID}/runs/${RUN_ID}/stream?cursor=1`,
    ]);
    expect(requests[1]?.headers['Last-Event-ID']).toBe(`${RUN_ID}:1`);
    expect(
      updates.mock.calls
        .map(([update]) => update)
        .filter((update) => update.kind === 'event')
        .map((update) => update.event.type),
    ).toEqual(['delta', 'terminal']);
  });

  it('refreshes once after an SSE 401 and never exposes the bearer token to the renderer', async () => {
    const account = accountFixture();
    const tokens: string[] = [];
    const bundle: AuthSessionResponse = {
      accessToken: NEW_TOKEN,
      refreshToken: `ea_refresh_${'c'.repeat(43)}`,
      account,
    };
    const store = storeFixture(account);
    const fetchMock = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/api/v1/auth/refresh')) {
        return Promise.resolve(
          new Response(JSON.stringify(bundle), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      const headers = init?.headers as Record<string, string>;
      tokens.push(headers.Authorization ?? '');
      if (tokens.length === 1) return Promise.resolve(new Response(null, { status: 401 }));
      return Promise.resolve(
        sseResponse([
          frame(1, 'terminal_only', {
            eventId: `${RUN_ID}:1`,
            sequence: 1,
            type: 'terminal_only',
            status: 'SUCCEEDED',
            createdAt: '2026-07-29T04:00:01.000Z',
          }),
        ]),
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const manager = new DesktopAuthManager(store, 'http://127.0.0.1:3000');
    await manager.initialize();
    seedAccessToken(manager, OLD_TOKEN);
    const updates = vi.fn();

    await manager.streamAgentRun(
      {
        conversationId: CONVERSATION_ID,
        runId: RUN_ID,
        expectedSessionId: SESSION_ID,
        cursor: 0,
      },
      updates,
      new AbortController().signal,
    );

    expect(tokens).toEqual([`Bearer ${OLD_TOKEN}`, `Bearer ${NEW_TOKEN}`]);
    expect(JSON.stringify(updates.mock.calls)).not.toContain(OLD_TOKEN);
    expect(JSON.stringify(updates.mock.calls)).not.toContain(NEW_TOKEN);
  });
});

function managerWithToken(token: string): DesktopAuthManager {
  const account = accountFixture();
  const manager = new DesktopAuthManager(storeFixture(account), 'http://127.0.0.1:3000');
  seedAccessToken(manager, token);
  return manager;
}

function seedAccessToken(manager: DesktopAuthManager, token: string): void {
  const accessTokens = Reflect.get(manager, 'accessTokens') as Map<
    string,
    { token: string; expiresAt: number }
  >;
  accessTokens.set(SESSION_ID, { token, expiresAt: Date.now() + 600_000 });
}

function storeFixture(account: AuthAccount): AccountStore {
  return {
    load: vi.fn(async () => undefined),
    get activeId() {
      return SESSION_ID;
    },
    get: vi.fn(() => ({ account, refreshToken: `ea_refresh_${'d'.repeat(43)}` })),
    list: vi.fn(() => [account]),
    updateCredentials: vi.fn(async () => undefined),
    get persistentStorageAvailable() {
      return true;
    },
  } as unknown as AccountStore;
}

function accountFixture(): AuthAccount {
  return {
    sessionId: SESSION_ID,
    tenantId: '10000000-0000-7000-8000-000000000001',
    tenantSlug: 'workspace',
    tenantName: 'Workspace',
    userId: '20000000-0000-7000-8000-000000000001',
    email: 'member@example.test',
    displayName: 'Member',
    role: 'MEMBER',
    passwordChangeRequired: false,
    accessExpiresAt: '2031-01-01T00:15:00.000Z',
    refreshExpiresAt: '2031-01-31T00:00:00.000Z',
  };
}

function frame(sequence: number, event: string, data: unknown): string {
  return `id: ${RUN_ID}:${sequence}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function sseResponse(frames: readonly string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) controller.enqueue(encoder.encode(frame));
        controller.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
