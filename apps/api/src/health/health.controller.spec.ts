import { ServiceUnavailableException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HealthController } from './health.controller.js';

function controller(input?: {
  workerEnabled?: boolean;
  ping?: () => Promise<void>;
}): HealthController {
  const values = {
    REPOSITORY_DRIVER: 'prisma',
    AGENT_RUN_WORKER_ENABLED: input?.workerEnabled ?? true,
    AI_RUNTIME_URL: 'http://127.0.0.1:8100',
    AI_RUNTIME_HTTP_TIMEOUT_MS: 90_000,
  } as const;
  const config = {
    get: (key: keyof typeof values): (typeof values)[keyof typeof values] => values[key],
  };
  const prisma = { ping: input?.ping ?? (async () => undefined) };
  return new HealthController(config as never, prisma as never);
}

describe('HealthController readiness', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('does not claim readiness when the enabled AI Runtime is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection refused')));

    await expect(controller().ready()).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('requires a valid ready response from the enabled AI Runtime', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ status: 'not_ready' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    await expect(controller().ready()).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('reports both dependencies when the AI Runtime is ready', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: 'ready' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(controller().ready()).resolves.toMatchObject({
      status: 'ready',
      checks: { repository: 'up', adapter: 'prisma', aiRuntime: 'up' },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      new URL('http://127.0.0.1:8100/health/ready'),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('makes the AI dependency explicit when the worker is disabled', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(controller({ workerEnabled: false }).ready()).resolves.toMatchObject({
      checks: { repository: 'up', adapter: 'prisma', aiRuntime: 'disabled' },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails before checking the runtime when the repository is unavailable', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      controller({ ping: async () => Promise.reject(new Error('database unavailable')) }).ready(),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
