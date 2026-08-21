import { describe, expect, it, vi } from 'vitest';

import { LexiangClient } from './lexiang.client.js';
import { LexiangTokenProvider } from './lexiang-token.provider.js';

const input = {
  connectionId: 'connection-1',
  credential: { appKey: 'app-key', appSecret: 'secret-value' },
  staffId: 'staff-1001',
  query: '企业战略是什么？',
  targets: [{ type: 'space', id: 'space-1' }] as const,
};

describe('LexiangClient', () => {
  it('always sends trusted staff identity and an explicit single-space target', async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          code: 0,
          message: 'success',
          data: {
            list: [
              {
                title: '战略',
                content: '战略正文',
                url: 'https://lexiang.example/entry/1',
                score: 0.9,
              },
            ],
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const tokens = { get: vi.fn().mockResolvedValue('access-token'), invalidate: vi.fn() };
    const client = new LexiangClient(
      tokens as unknown as LexiangTokenProvider,
      fetchImplementation,
    );

    const result = await client.search(input);

    expect(result[0]).toMatchObject({ externalSpaceId: 'space-1' });
    expect(fetchImplementation).toHaveBeenCalledWith(
      'https://lxapi.lexiangla.com/cgi-bin/v1/ai/search',
      expect.objectContaining({
        headers: expect.objectContaining({ 'x-staff-id': 'staff-1001' }),
        body: JSON.stringify({
          query: '企业战略是什么？',
          targets: [{ type: 'space', id: 'space-1' }],
          top_n: 10,
          with_score: true,
        }),
      }),
    );
  });

  it('refreshes once on 401 and never retries a 403', async () => {
    const fetchImplementation = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(null, { status: 403 }));
    const tokens = { get: vi.fn().mockResolvedValue('token'), invalidate: vi.fn() };
    const client = new LexiangClient(
      tokens as unknown as LexiangTokenProvider,
      fetchImplementation,
    );

    await expect(client.search(input)).rejects.toMatchObject({ code: 'LEXIANG_FORBIDDEN' });
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    expect(tokens.invalidate).toHaveBeenCalledTimes(1);
  });

  it('retries transient transport failures before returning evidence', async () => {
    const fetchImplementation = vi
      .fn()
      .mockRejectedValueOnce(new DOMException('timed out', 'TimeoutError'))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: 0,
            message: 'success',
            data: {
              list: [
                {
                  title: '华为销售管理',
                  content: '销售管理正文',
                  url: 'https://lexiang.example/entry/2',
                  score: 0.88,
                },
              ],
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    const tokens = { get: vi.fn().mockResolvedValue('access-token'), invalidate: vi.fn() };
    const delay = vi.fn().mockResolvedValue(undefined);
    const client = new LexiangClient(
      tokens as unknown as LexiangTokenProvider,
      fetchImplementation,
      delay,
    );

    await expect(client.search(input)).resolves.toMatchObject([
      { title: '华为销售管理', externalSpaceId: 'space-1' },
    ]);
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    expect(delay).toHaveBeenCalledWith(150);
  });

  it('fails closed when identity or the explicit target is absent', async () => {
    const client = new LexiangClient({} as LexiangTokenProvider, vi.fn());
    await expect(client.search({ ...input, staffId: '' })).rejects.toMatchObject({
      code: 'LEXIANG_STAFF_ID_REQUIRED',
    });
    await expect(client.search({ ...input, targets: [] as never })).rejects.toMatchObject({
      code: 'LEXIANG_SINGLE_SPACE_TARGET_REQUIRED',
    });
  });
});
