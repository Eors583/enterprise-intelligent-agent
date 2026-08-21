import { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EnvironmentVariables } from '../../config/environment.js';
import { ModelRoutingRuntimeReadinessClient } from './model-routing-runtime-readiness.client.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ModelRoutingRuntimeReadinessClient', () => {
  it('accepts only fresh authenticated Runtime allowlist evidence', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 'ready',
          require_trusted_route: true,
          provider_ready: true,
          evidence: 'local_configuration_probe',
          external_connectivity_verified: false,
          checked_at: new Date().toISOString(),
          routes: [
            {
              route_key: 'GENERAL.PRIMARY',
              catalog_version_id: '00000000-0000-7000-8000-000000000991',
              provider: 'OPENAI_COMPATIBLE',
              model: 'model-a',
              configuration_sha256: 'a'.repeat(64),
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const evidence = await client().inspect();

    expect(evidence).toMatchObject({
      status: 'READY',
      requireTrustedRoute: true,
      providerReady: true,
      routes: [
        {
          routeKey: 'GENERAL.PRIMARY',
          catalogVersionId: '00000000-0000-7000-8000-000000000991',
          configurationSha256: 'a'.repeat(64),
        },
      ],
    });
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.href).toBe('http://127.0.0.1:8100/internal/v1/model-routing/readiness');
    expect(new Headers(init.headers).get('Authorization')).toBe(
      'Bearer runtime-service-token-at-least-32-characters',
    );
    expect(init.cache).toBe('no-store');
  });

  it('returns explicit unavailable evidence for stale or malformed responses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            status: 'ready',
            require_trusted_route: true,
            provider_ready: true,
            evidence: 'local_configuration_probe',
            external_connectivity_verified: false,
            checked_at: new Date(Date.now() - 120_000).toISOString(),
            routes: [],
          }),
          { status: 200 },
        ),
      ),
    );

    await expect(client().inspect()).resolves.toEqual({
      status: 'UNAVAILABLE',
      requireTrustedRoute: null,
      providerReady: null,
      checkedAt: null,
      routes: [],
    });
  });
});

function client(): ModelRoutingRuntimeReadinessClient {
  const config = new ConfigService<EnvironmentVariables, true>({
    AI_RUNTIME_URL: 'http://127.0.0.1:8100',
    AI_RUNTIME_HTTP_TIMEOUT_MS: 90_000,
    AI_RUNTIME_SERVICE_TOKEN: 'runtime-service-token-at-least-32-characters',
  } as EnvironmentVariables);
  return new ModelRoutingRuntimeReadinessClient(config);
}
