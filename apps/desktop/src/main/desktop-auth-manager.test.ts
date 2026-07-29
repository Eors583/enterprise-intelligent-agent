import type { AuthAccount, AuthSessionResponse } from '@enterprise/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AccountStore } from './account-store';
import { DesktopAuthManager } from './desktop-auth-manager';

describe('DesktopAuthManager account isolation', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('keeps MFA challenges out of storage and accepts a session only after verification', async () => {
    const put = vi.fn(async () => undefined);
    const store = {
      load: vi.fn(async () => undefined),
      get activeId() {
        return null;
      },
      get: vi.fn(),
      list: vi.fn(() => []),
      put,
      get persistentStorageAvailable() {
        return true;
      },
    } as unknown as AccountStore;
    const challenge = {
      kind: 'MFA_REQUIRED' as const,
      challenge: `ea_mfa_${'c'.repeat(52)}`,
      expiresAt: '2031-01-01T00:05:00.000Z',
      methods: ['TOTP', 'RECOVERY_CODE'] as const,
    };
    const bundle: AuthSessionResponse = {
      accessToken: `ea_access_${'a'.repeat(43)}`,
      refreshToken: `ea_refresh_${'b'.repeat(43)}`,
      account: account(1),
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(challenge))
      .mockResolvedValueOnce(jsonResponse(bundle));
    vi.stubGlobal('fetch', fetchMock);
    const manager = new DesktopAuthManager(store, 'http://127.0.0.1:3000');
    await manager.initialize();

    const result = await manager.login({
      tenantSlug: 'example',
      email: 'member@example.test',
      password: 'password',
      sessionLabel: '桌面应用',
    });

    expect(result).toEqual(challenge);
    expect(put).not.toHaveBeenCalled();

    const state = await manager.verifyMfaLogin({
      challenge: challenge.challenge,
      code: '123456',
      method: 'TOTP',
      sessionLabel: '桌面应用',
    });

    expect(put).toHaveBeenCalledWith(bundle.account, bundle.refreshToken);
    expect(state.accounts).toEqual([]);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      'http://127.0.0.1:3000/api/v1/auth/login',
      'http://127.0.0.1:3000/api/v1/auth/mfa/login/verify',
    ]);
  });

  it('keeps OIDC discovery and authorization unauthenticated, then stores only the validated callback bundle', async () => {
    const put = vi.fn(async () => undefined);
    const store = {
      load: vi.fn(async () => undefined),
      get activeId() {
        return null;
      },
      get: vi.fn(),
      list: vi.fn(() => []),
      put,
      get persistentStorageAvailable() {
        return true;
      },
    } as unknown as AccountStore;
    const providers = {
      items: [{ key: 'work-sso', displayName: 'Work SSO', protocol: 'OIDC' as const }],
    };
    const started = {
      authorizationUrl: 'https://idp.example.test/authorize?state=opaque',
      expiresAt: '2031-01-01T00:10:00.000Z',
    };
    const bundle: AuthSessionResponse = {
      accessToken: `ea_access_${'a'.repeat(43)}`,
      refreshToken: `ea_refresh_${'b'.repeat(43)}`,
      account: account(1),
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(providers))
      .mockResolvedValueOnce(jsonResponse(started))
      .mockResolvedValueOnce(jsonResponse(bundle));
    vi.stubGlobal('fetch', fetchMock);
    const manager = new DesktopAuthManager(store, 'http://127.0.0.1:3000');
    await manager.initialize();

    await expect(manager.listOidcProviders('example')).resolves.toEqual(providers);
    await expect(
      manager.startOidcLogin({
        tenantSlug: 'example',
        providerKey: 'work-sso',
        redirectUri: 'https://app.example.test/oidc/callback',
        sessionLabel: '桌面应用',
      }),
    ).resolves.toEqual(started);
    expect(put).not.toHaveBeenCalled();

    await manager.completeOidcLogin({
      state: 's'.repeat(32),
      code: 'authorization-code',
      sessionLabel: '桌面应用',
    });

    expect(put).toHaveBeenCalledWith(bundle.account, bundle.refreshToken);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      'http://127.0.0.1:3000/api/v1/auth/oidc/providers/example',
      'http://127.0.0.1:3000/api/v1/auth/oidc/start',
      'http://127.0.0.1:3000/api/v1/auth/oidc/callback',
    ]);
  });

  it('uses the non-activating credential update path for a background refresh', async () => {
    const first = account(1);
    const second = account(2);
    let activeSessionId: string | null = first.sessionId;
    const updateCredentials = vi.fn(async () => undefined);
    const activatingPut = vi.fn(async (value: AuthAccount) => {
      activeSessionId = value.sessionId;
    });
    const store = {
      load: vi.fn(async () => undefined),
      get activeId() {
        return activeSessionId;
      },
      get: vi.fn((sessionId: string) =>
        sessionId === second.sessionId
          ? { account: second, refreshToken: 'ea_refresh_previous' }
          : undefined,
      ),
      list: vi.fn(() => [first, second]),
      get persistentStorageAvailable() {
        return true;
      },
      put: activatingPut,
      updateCredentials,
    } as unknown as AccountStore;
    const bundle: AuthSessionResponse = {
      accessToken: `ea_access_${'a'.repeat(43)}`,
      refreshToken: `ea_refresh_${'b'.repeat(43)}`,
      account: {
        ...second,
        accessExpiresAt: '2031-01-01T00:15:00.000Z',
      },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(bundle), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    const manager = new DesktopAuthManager(store, 'http://127.0.0.1:3000');
    await manager.initialize();

    const refresh = Reflect.get(manager, 'refresh') as (sessionId: string) => Promise<void>;
    await refresh.call(manager, second.sessionId);

    expect(updateCredentials).toHaveBeenCalledWith(bundle.account, bundle.refreshToken);
    expect(activatingPut).not.toHaveBeenCalled();
    expect(manager.state().activeSessionId).toBe(first.sessionId);
    expect(JSON.stringify(manager.state())).not.toContain(bundle.accessToken);
    expect(JSON.stringify(manager.state())).not.toContain(bundle.refreshToken);
  });

  it('changes the active account password and preserves its current refresh token', async () => {
    let storedAccount: AuthAccount = { ...account(1), passwordChangeRequired: true };
    const refreshToken = `ea_refresh_${'r'.repeat(43)}`;
    const accessToken = `ea_access_${'a'.repeat(43)}`;
    const updateCredentials = vi.fn(async (next: AuthAccount, nextRefreshToken: string) => {
      storedAccount = next;
      expect(nextRefreshToken).toBe(refreshToken);
    });
    const states = vi.fn();
    const store = {
      load: vi.fn(async () => undefined),
      get activeId() {
        return storedAccount.sessionId;
      },
      get: vi.fn(() => ({ account: storedAccount, refreshToken })),
      list: vi.fn(() => [storedAccount]),
      updateCredentials,
      get persistentStorageAvailable() {
        return true;
      },
    } as unknown as AccountStore;
    const changedAccount: AuthAccount = {
      ...storedAccount,
      passwordChangeRequired: false,
    };
    const fetchMock = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('http://127.0.0.1:3000/api/v1/auth/change-password');
      expect(init?.headers).toMatchObject({ Authorization: `Bearer ${accessToken}` });
      expect(JSON.parse(String(init?.body))).toEqual({
        currentPassword: '1234567890',
        newPassword: 'a-unique-new-password',
      });
      return Promise.resolve(jsonResponse({ account: changedAccount, revokedSessionCount: 2 }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const manager = new DesktopAuthManager(store, 'http://127.0.0.1:3000', states);
    await manager.initialize();
    const accessTokens = Reflect.get(manager, 'accessTokens') as Map<
      string,
      { token: string; expiresAt: number }
    >;
    accessTokens.set(storedAccount.sessionId, {
      token: accessToken,
      expiresAt: Date.now() + 60_000,
    });

    const result = await manager.changePassword({
      currentPassword: '1234567890',
      newPassword: 'a-unique-new-password',
    });

    expect(result).toEqual({
      state: {
        accounts: [changedAccount],
        activeSessionId: changedAccount.sessionId,
        persistentStorageAvailable: true,
      },
      revokedSessionCount: 2,
    });
    expect(updateCredentials).toHaveBeenCalledWith(changedAccount, refreshToken);
    expect(states).toHaveBeenLastCalledWith(result.state);
    expect(JSON.stringify(result)).not.toContain('1234567890');
    expect(JSON.stringify(result)).not.toContain(refreshToken);
  });

  it('rejects a delayed renderer request instead of executing it as the newly active account', async () => {
    const first = account(1);
    const second = account(2);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const store = {
      load: vi.fn(async () => undefined),
      get activeId() {
        return second.sessionId;
      },
      get: vi.fn(),
      list: vi.fn(() => [first, second]),
      get persistentStorageAvailable() {
        return true;
      },
    } as unknown as AccountStore;
    const manager = new DesktopAuthManager(store, 'http://127.0.0.1:3000');
    await manager.initialize();

    await expect(
      manager.apiRequest({
        path: '/api/v1/conversations',
        method: 'POST',
        expectedSessionId: first.sessionId,
        body: { type: 'direct' },
      }),
    ).rejects.toThrow('STALE_ACCOUNT:');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('allows the renderer messaging routes through the authenticated desktop proxy', async () => {
    const first = account(1);
    const accessToken = `ea_access_${'a'.repeat(43)}`;
    const store = {
      load: vi.fn(async () => undefined),
      get activeId() {
        return first.sessionId;
      },
      get: vi.fn(() => ({ account: first, refreshToken: 'ea_refresh_previous' })),
      list: vi.fn(() => [first]),
      get persistentStorageAvailable() {
        return true;
      },
    } as unknown as AccountStore;
    const fetchMock = vi.fn((_url: string | URL | Request) =>
      Promise.resolve(jsonResponse({ ok: true })),
    );
    vi.stubGlobal('fetch', fetchMock);
    const manager = new DesktopAuthManager(store, 'http://127.0.0.1:3000');
    await manager.initialize();
    const accessTokens = Reflect.get(manager, 'accessTokens') as Map<
      string,
      { token: string; expiresAt: number }
    >;
    accessTokens.set(first.sessionId, {
      token: accessToken,
      expiresAt: Date.now() + 60_000,
    });
    const conversationId = '30000000-0000-7000-8000-000000000001';
    const runId = '40000000-0000-7000-8000-000000000001';
    const messageId = '50000000-0000-7000-8000-000000000001';
    const versionId = '60000000-0000-7000-8000-000000000001';
    const chunkId = '70000000-0000-7000-8000-000000000001';
    const collaborationId = '80000000-0000-7000-8000-000000000001';
    const correctionId = '90000000-0000-7000-8000-000000000001';
    const memoryId = 'a0000000-0000-7000-8000-000000000001';
    const invocationId = 'b0000000-0000-7000-8000-000000000001';
    const requests = [
      { path: '/api/v1/role-assignments/me', method: 'GET' as const },
      { path: '/api/v1/workbench/objectives', method: 'GET' as const },
      { path: '/api/v1/workbench/tasks', method: 'GET' as const },
      {
        path: `/api/v1/workbench/tasks/${runId}/trace`,
        method: 'GET' as const,
      },
      {
        path: `/api/v1/workbench/tasks/${runId}/collaborations`,
        method: 'GET' as const,
      },
      {
        path: `/api/v1/workbench/tasks/${runId}/collaborations/${collaborationId}`,
        method: 'GET' as const,
      },
      {
        path: `/api/v1/workbench/tasks/${runId}/corrections`,
        method: 'GET' as const,
      },
      {
        path: `/api/v1/workbench/tasks/${runId}/corrections/${correctionId}/feedback`,
        method: 'POST' as const,
        body: { expectedRevision: 1, action: 'ACKNOWLEDGE' },
      },
      {
        path: '/api/v1/workbench/memories?limit=100&scope=EMPLOYEE_PRIVATE&purpose=assist',
        method: 'GET' as const,
      },
      { path: '/api/v1/workbench/memories', method: 'POST' as const, body: { scope: 'TASK' } },
      { path: `/api/v1/workbench/memories/${memoryId}`, method: 'GET' as const },
      {
        path: `/api/v1/workbench/memories/${memoryId}/transitions`,
        method: 'POST' as const,
        body: { action: 'CONFIRM' },
      },
      { path: '/api/v1/workbench/experiences?limit=25', method: 'GET' as const },
      {
        path: '/api/v1/workbench/experiences',
        method: 'POST' as const,
        body: { sourceTaskId: runId },
      },
      {
        path: `/api/v1/workbench/experience-sources?taskId=${runId}`,
        method: 'GET' as const,
      },
      {
        path: '/api/v1/workbench/ai-usage?groupLimit=25&from=2026-07-01T00%3A00%3A00.000Z&to=2026-07-28T00%3A00%3A00.000Z',
        method: 'GET' as const,
      },
      { path: `/api/v1/workbench/tools?taskId=${runId}`, method: 'GET' as const },
      { path: `/api/v1/workbench/tool-approvals?taskId=${runId}`, method: 'GET' as const },
      { path: '/api/v1/workbench/tool-invocations', method: 'GET' as const },
      {
        path: '/api/v1/workbench/tool-invocations',
        method: 'POST' as const,
        body: { toolVersionId: versionId, taskId: runId },
      },
      {
        path: `/api/v1/workbench/tool-invocations/${invocationId}`,
        method: 'GET' as const,
      },
      {
        path: `/api/v1/workbench/tool-invocations/${invocationId}/actions`,
        method: 'POST' as const,
        body: { action: 'CONFIRM' },
      },
      { path: `/api/v1/messages/${messageId}/feedback`, method: 'GET' as const },
      {
        path: `/api/v1/messages/${messageId}/feedback`,
        method: 'PUT' as const,
        body: { rating: 'HELPFUL' },
      },
      {
        path: `/api/v1/conversations/${conversationId}/runs/${runId}/cancel`,
        method: 'POST' as const,
      },
      {
        path: `/api/v1/conversations/${conversationId}/runs/${runId}/retry`,
        method: 'POST' as const,
      },
      {
        path: `/api/v1/conversations/${conversationId}/runs/${runId}/events?cursor=10001&limit=128`,
        method: 'GET' as const,
      },
      {
        path: `/api/v1/knowledge-citations/${versionId}/chunks/${chunkId}`,
        method: 'GET' as const,
      },
    ];

    await expect(
      Promise.all(
        requests.map((request) =>
          manager.apiRequest({ ...request, expectedSessionId: first.sessionId }),
        ),
      ),
    ).resolves.toHaveLength(requests.length);
    expect(fetchMock).toHaveBeenCalledTimes(requests.length);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual(
      requests.map(({ path }) => `http://127.0.0.1:3000${path}`),
    );
  });

  it('keeps near-match messaging routes blocked by the desktop proxy', async () => {
    const first = account(1);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const store = {
      load: vi.fn(async () => undefined),
      get activeId() {
        return first.sessionId;
      },
      get: vi.fn(),
      list: vi.fn(() => [first]),
      get persistentStorageAvailable() {
        return true;
      },
    } as unknown as AccountStore;
    const manager = new DesktopAuthManager(store, 'http://127.0.0.1:3000');
    await manager.initialize();

    await expect(
      manager.apiRequest({
        path: '/api/v1/messages/not-a-uuid/feedback',
        method: 'GET',
        expectedSessionId: first.sessionId,
      }),
    ).rejects.toThrow('The requested desktop API operation is not allowed.');
    await expect(
      manager.apiRequest({
        path: '/api/v1/workbench/tools?taskId=not-a-uuid',
        method: 'GET',
        expectedSessionId: first.sessionId,
      }),
    ).rejects.toThrow('The requested desktop API operation is not allowed.');
    await expect(
      manager.apiRequest({
        path: '/api/v1/workbench/memories?next=https://attacker.example',
        method: 'GET',
        expectedSessionId: first.sessionId,
      }),
    ).rejects.toThrow('The requested desktop API operation is not allowed.');
    await expect(
      manager.apiRequest({
        path: '/api/v1/workbench/experiences?next=https://attacker.example',
        method: 'GET',
        expectedSessionId: first.sessionId,
      }),
    ).rejects.toThrow('The requested desktop API operation is not allowed.');
    await expect(
      manager.apiRequest({
        path: '/api/v1/workbench/experience-sources?taskId=not-a-uuid',
        method: 'GET',
        expectedSessionId: first.sessionId,
      }),
    ).rejects.toThrow('The requested desktop API operation is not allowed.');
    await expect(
      manager.apiRequest({
        path: '/api/v1/workbench/ai-usage?next=https://attacker.example',
        method: 'GET',
        expectedSessionId: first.sessionId,
      }),
    ).rejects.toThrow('The requested desktop API operation is not allowed.');
    await expect(
      manager.apiRequest({
        path: '/api/v1/workbench/tasks/not-a-uuid/trace',
        method: 'GET',
        expectedSessionId: first.sessionId,
      }),
    ).rejects.toThrow('The requested desktop API operation is not allowed.');
    await expect(
      manager.apiRequest({
        path: '/api/v1/workbench/tasks',
        method: 'POST',
        expectedSessionId: first.sessionId,
      }),
    ).rejects.toThrow('The requested desktop API operation is not allowed.');
    await expect(
      manager.apiRequest({
        path: '/api/v1/workbench/tasks/40000000-0000-7000-8000-000000000001/collaborations',
        method: 'POST',
        expectedSessionId: first.sessionId,
      }),
    ).rejects.toThrow('The requested desktop API operation is not allowed.');
    await expect(
      manager.apiRequest({
        path: '/api/v1/workbench/tasks/40000000-0000-7000-8000-000000000001/corrections/not-a-uuid/feedback',
        method: 'POST',
        expectedSessionId: first.sessionId,
      }),
    ).rejects.toThrow('The requested desktop API operation is not allowed.');
    await expect(
      manager.apiRequest({
        path: '/api/v1/workbench/tasks/40000000-0000-7000-8000-000000000001/corrections/90000000-0000-7000-8000-000000000001/feedback',
        method: 'GET',
        expectedSessionId: first.sessionId,
      }),
    ).rejects.toThrow('The requested desktop API operation is not allowed.');
    await expect(
      manager.apiRequest({
        path: '/api/v1/messages/50000000-0000-7000-8000-000000000001/feedback',
        method: 'DELETE',
        expectedSessionId: first.sessionId,
      }),
    ).rejects.toThrow('The requested desktop API operation is not allowed.');
    await expect(
      manager.apiRequest({
        path: '/api/v1/conversations/30000000-0000-7000-8000-000000000001/runs/40000000-0000-7000-8000-000000000001/events?cursor=17&limit=999',
        method: 'GET',
        expectedSessionId: first.sessionId,
      }),
    ).rejects.toThrow('The requested desktop API operation is not allowed.');
    await expect(
      manager.apiRequest({
        path: '/api/v1/conversations/30000000-0000-7000-8000-000000000001/runs/40000000-0000-7000-8000-000000000001/events?cursor=10002&limit=128',
        method: 'GET',
        expectedSessionId: first.sessionId,
      }),
    ).rejects.toThrow('The requested desktop API operation is not allowed.');
    await expect(
      manager.apiRequest({
        path: '/api/v1/conversations/30000000-0000-7000-8000-000000000001/runs/40000000-0000-7000-8000-000000000001/events?cursor=17&limit=128&next=https://attacker.example',
        method: 'GET',
        expectedSessionId: first.sessionId,
      }),
    ).rejects.toThrow('The requested desktop API operation is not allowed.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('publishes a token-free signed-out state when refresh invalidates an account', async () => {
    const first = account(1);
    let activeSessionId: string | null = first.sessionId;
    let accounts: AuthAccount[] = [first];
    const states = vi.fn();
    const store = {
      load: vi.fn(async () => undefined),
      get activeId() {
        return activeSessionId;
      },
      get: vi.fn(() => ({ account: first, refreshToken: 'ea_refresh_expired' })),
      list: vi.fn(() => accounts),
      remove: vi.fn(async () => {
        activeSessionId = null;
        accounts = [];
      }),
      get persistentStorageAvailable() {
        return true;
      },
    } as unknown as AccountStore;
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ message: 'Authentication required.' }), { status: 401 }),
        ),
    );
    const manager = new DesktopAuthManager(store, 'http://127.0.0.1:3000', states);
    await manager.initialize();

    await expect(
      manager.apiRequest({
        path: '/api/v1/bootstrap',
        method: 'GET',
        expectedSessionId: first.sessionId,
      }),
    ).rejects.toThrow('Authentication required.');
    expect(states).toHaveBeenLastCalledWith({
      accounts: [],
      activeSessionId: null,
      persistentStorageAvailable: true,
    });
    expect(JSON.stringify(states.mock.calls)).not.toContain('ea_refresh_expired');
  });

  it('reuses the newer access token when an older concurrent request returns 401 late', async () => {
    const first = account(1);
    const oldAccessToken = `ea_access_${'0'.repeat(43)}`;
    const newAccessToken = `ea_access_${'1'.repeat(43)}`;
    const leftInitial = deferred<Response>();
    const rightInitial = deferred<Response>();
    const businessTokens: string[] = [];
    let businessCalls = 0;
    let refreshCalls = 0;
    const store = {
      load: vi.fn(async () => undefined),
      get activeId() {
        return first.sessionId;
      },
      get: vi.fn(() => ({ account: first, refreshToken: 'ea_refresh_previous' })),
      list: vi.fn(() => [first]),
      updateCredentials: vi.fn(async () => undefined),
      get persistentStorageAvailable() {
        return true;
      },
    } as unknown as AccountStore;
    const rotated: AuthSessionResponse = {
      accessToken: newAccessToken,
      refreshToken: `ea_refresh_${'2'.repeat(43)}`,
      account: { ...first, accessExpiresAt: '2031-01-01T00:15:00.000Z' },
    };
    const fetchMock = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/api/v1/auth/refresh')) {
        refreshCalls += 1;
        return Promise.resolve(jsonResponse(rotated));
      }
      const headers = init?.headers as Record<string, string>;
      businessTokens.push(headers.Authorization!.replace(/^Bearer /, ''));
      businessCalls += 1;
      if (businessCalls === 1) return leftInitial.promise;
      if (businessCalls === 2) return rightInitial.promise;
      return Promise.resolve(jsonResponse({ ok: true }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const manager = new DesktopAuthManager(store, 'http://127.0.0.1:3000');
    await manager.initialize();
    const accessTokens = Reflect.get(manager, 'accessTokens') as Map<
      string,
      { token: string; expiresAt: number }
    >;
    accessTokens.set(first.sessionId, {
      token: oldAccessToken,
      expiresAt: Date.now() + 60_000,
    });
    const request = {
      path: '/api/v1/bootstrap',
      method: 'GET' as const,
      expectedSessionId: first.sessionId,
    };

    const left = manager.apiRequest(request);
    const right = manager.apiRequest(request);
    await vi.waitFor(() => expect(businessTokens).toHaveLength(2));
    leftInitial.resolve(new Response(null, { status: 401 }));
    await vi.waitFor(() => expect(businessTokens).toHaveLength(3));
    expect(refreshCalls).toBe(1);
    rightInitial.resolve(new Response(null, { status: 401 }));

    await expect(Promise.all([left, right])).resolves.toEqual([
      expect.objectContaining({ status: 200 }),
      expect.objectContaining({ status: 200 }),
    ]);
    expect(refreshCalls).toBe(1);
    expect(businessTokens).toEqual([
      oldAccessToken,
      oldAccessToken,
      newAccessToken,
      newAccessToken,
    ]);
  });
});

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function account(index: number): AuthAccount {
  const suffix = String(index).padStart(12, '0');
  return {
    sessionId: `00000000-0000-7000-8000-${suffix}`,
    tenantId: `10000000-0000-7000-8000-${suffix}`,
    tenantSlug: `workspace-${index}`,
    tenantName: `Workspace ${index}`,
    userId: `20000000-0000-7000-8000-${suffix}`,
    email: `user-${index}@example.test`,
    displayName: `User ${index}`,
    role: index === 1 ? 'OWNER' : 'MEMBER',
    passwordChangeRequired: false,
    accessExpiresAt: '2030-01-01T00:15:00.000Z',
    refreshExpiresAt: '2030-01-31T00:00:00.000Z',
  };
}
