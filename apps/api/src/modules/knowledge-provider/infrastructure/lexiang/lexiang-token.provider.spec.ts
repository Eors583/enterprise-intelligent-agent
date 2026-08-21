import { describe, expect, it, vi } from 'vitest';

import { LexiangTokenProvider } from './lexiang-token.provider.js';

describe('LexiangTokenProvider', () => {
  it('coalesces concurrent token refreshes and caches the 7200-second token', async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'token-value', expires_in: 7_200 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const provider = new LexiangTokenProvider(fetchImplementation, () => 1_000);
    const credential = { appKey: 'app-key', appSecret: 'write-only-secret' };

    await expect(
      Promise.all([
        provider.get('connection-1', credential),
        provider.get('connection-1', credential),
      ]),
    ).resolves.toEqual(['token-value', 'token-value']);
    await expect(provider.get('connection-1', credential)).resolves.toBe('token-value');
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(fetchImplementation.mock.calls)).not.toContain('token-value');
  });
});
