import { describe, expect, it, vi, afterEach } from 'vitest';

import { ImRealtimeSessionService } from './im-realtime-session.service.js';

const TENANT_ID = '00000000-0000-7000-8000-000000000001';
const USER_ID = '00000000-0000-7000-8000-000000000101';

describe('ImRealtimeSessionService', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('returns an honest unavailable state for the local provider', async () => {
    const fetchMock = vi.fn();
    const requireCurrent = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const service = createService({ IM_PROVIDER: 'local' }, requireCurrent);
    await expect(service.create()).resolves.toEqual({
      available: false,
      provider: 'local',
      reason: 'REALTIME_NOT_CONFIGURED',
    });
    expect(requireCurrent).toHaveBeenCalledWith({
      action: 'conversation.realtime.connect',
      resourceTenantId: TENANT_ID,
      risk: 'MEDIUM',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('provisions a tenant-scoped WuKongIM identity without returning internal UUIDs', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const service = createService({
      IM_PROVIDER: 'wukong',
      WUKONG_IM_API_BASE_URL: 'http://127.0.0.1:5501',
      WUKONG_IM_PUBLIC_WS_URL: 'ws://127.0.0.1:5520',
      WUKONG_IM_API_TOKEN: 'internal-api-token-value',
      WUKONG_IM_TOKEN_SIGNING_SECRET: 'session-signing-secret-value',
      WUKONG_IM_HTTP_TIMEOUT_MS: 1_000,
    });
    const session = await service.create();
    expect(session).toMatchObject({
      available: true,
      provider: 'wukong',
      websocketUrl: 'ws://127.0.0.1:5520',
      deviceFlag: 2,
    });
    expect(JSON.stringify(session)).not.toContain(TENANT_ID);
    expect(JSON.stringify(session)).not.toContain(USER_ID);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('http://127.0.0.1:5501/user/token');
    expect(init?.headers).toMatchObject({ token: 'internal-api-token-value' });
    expect(JSON.parse(String(init?.body))).toMatchObject({
      uid: session.available ? session.uid : undefined,
      token: session.available ? session.token : undefined,
      device_flag: 2,
      device_level: 1,
    });
  });

  it('fails closed when provisioning does not return a valid success receipt', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ status: 400 })),
    );
    await expect(
      createService({
        IM_PROVIDER: 'wukong',
        WUKONG_IM_API_BASE_URL: 'http://127.0.0.1:5501',
        WUKONG_IM_PUBLIC_WS_URL: 'ws://127.0.0.1:5520',
        WUKONG_IM_TOKEN_SIGNING_SECRET: 'session-signing-secret-value',
        WUKONG_IM_HTTP_TIMEOUT_MS: 1_000,
      }).create(),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'WUKONG_IM_SESSION_UNAVAILABLE' }),
    });
  });
});

function createService(
  configuration: Record<string, unknown>,
  requireCurrent = vi.fn(),
): ImRealtimeSessionService {
  const defaults: Record<string, unknown> = {
    IM_PROVIDER: 'local',
    WUKONG_IM_API_BASE_URL: 'http://127.0.0.1:5501',
    WUKONG_IM_PUBLIC_WS_URL: 'ws://127.0.0.1:5520',
    WUKONG_IM_HTTP_TIMEOUT_MS: 1_000,
  };
  return new ImRealtimeSessionService(
    { get: (key: string) => ({ ...defaults, ...configuration })[key] } as never,
    {
      getCurrentIdentity: async () => ({
        tenant: { id: TENANT_ID },
        user: { id: USER_ID },
      }),
    } as never,
    { requireCurrent } as never,
  );
}
