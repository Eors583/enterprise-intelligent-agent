import { z } from 'zod';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { apiRequest, setExpectedDesktopSessionId } from './client';

const sessionId = '00000000-0000-7000-8000-000000000001';

afterEach(() => {
  setExpectedDesktopSessionId(null);
  vi.unstubAllGlobals();
});

describe('desktop API account binding', () => {
  it('binds every proxied business request to the renderer account context', async () => {
    const proxy = vi.fn().mockResolvedValue({ status: 200, body: { ok: true } });
    vi.stubGlobal('window', { enterpriseDesktop: { apiRequest: proxy } });
    setExpectedDesktopSessionId(sessionId);

    await expect(
      apiRequest('/api/v1/bootstrap', { schema: z.object({ ok: z.boolean() }) }),
    ).resolves.toEqual({ ok: true });
    expect(proxy).toHaveBeenCalledWith({
      path: '/api/v1/bootstrap',
      method: 'GET',
      expectedSessionId: sessionId,
    });
  });

  it('preserves a recognizable stale-account error from the main process', async () => {
    const proxy = vi.fn().mockRejectedValue(new Error('STALE_ACCOUNT: account changed'));
    vi.stubGlobal('window', { enterpriseDesktop: { apiRequest: proxy } });
    setExpectedDesktopSessionId(sessionId);

    const operation = apiRequest('/api/v1/bootstrap', {
      schema: z.object({ ok: z.boolean() }),
    });
    await expect(operation).rejects.toMatchObject({ kind: 'stale-account' });
  });

  it('reports a desktop route policy rejection as a client configuration issue', async () => {
    const proxy = vi
      .fn()
      .mockRejectedValue(new Error('The requested desktop API operation is not allowed.'));
    vi.stubGlobal('window', { enterpriseDesktop: { apiRequest: proxy } });
    setExpectedDesktopSessionId(sessionId);

    const operation = apiRequest('/api/v1/messages/not-yet-supported/feedback', {
      schema: z.object({ ok: z.boolean() }),
    });
    await expect(operation).rejects.toMatchObject({
      kind: 'configuration',
      message: '桌面客户端尚未启用该操作，请重启或更新客户端。',
    });
  });
});
