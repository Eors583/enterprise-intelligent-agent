import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { EnvironmentVariables } from '../../config/environment.js';
import { OidcDiscoveryClient } from './oidc-discovery.client.js';

describe('OidcDiscoveryClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('loads matching discovery metadata and rejects unsafe JWKS keys', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          issuer: 'https://login.example.test/',
          authorization_endpoint: 'https://login.example.test/authorize',
          token_endpoint: 'https://login.example.test/token',
          jwks_uri: 'https://login.example.test/jwks',
          response_types_supported: ['code'],
          id_token_signing_alg_values_supported: ['RS256'],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          keys: [{ kty: 'RSA', kid: 'signing-key', use: 'sig', alg: 'RS256', n: 'AQ', e: 'AQAB' }],
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const client = createClient();

    const discovered = await client.discover(
      'https://login.example.test/.well-known/openid-configuration',
      'https://login.example.test',
    );
    const jwks = await client.jwks(discovered.document.jwks_uri);

    expect(discovered.document).toMatchObject({
      issuer: 'https://login.example.test/',
      response_types_supported: ['code'],
      id_token_signing_alg_values_supported: ['RS256'],
    });
    expect(discovered.documentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.documentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://login.example.test/.well-known/openid-configuration',
      expect.objectContaining({ redirect: 'error', cache: 'no-store' }),
    );
  });

  it.each([
    {
      name: 'issuer mismatch',
      document: {
        issuer: 'https://attacker.example.test',
        authorization_endpoint: 'https://login.example.test/authorize',
        token_endpoint: 'https://login.example.test/token',
        jwks_uri: 'https://login.example.test/jwks',
        response_types_supported: ['code'],
      },
      message: 'issuer does not match',
    },
    {
      name: 'missing authorization code support',
      document: {
        issuer: 'https://login.example.test',
        authorization_endpoint: 'https://login.example.test/authorize',
        token_endpoint: 'https://login.example.test/token',
        jwks_uri: 'https://login.example.test/jwks',
        response_types_supported: ['id_token'],
      },
      message: 'authorization code flow',
    },
    {
      name: 'symmetric signing algorithm',
      document: {
        issuer: 'https://login.example.test',
        authorization_endpoint: 'https://login.example.test/authorize',
        token_endpoint: 'https://login.example.test/token',
        jwks_uri: 'https://login.example.test/jwks',
        response_types_supported: ['code'],
        id_token_signing_alg_values_supported: ['HS256'],
      },
      message: 'unsafe ID-token algorithm',
    },
  ])('fails closed for $name', async ({ document, message }) => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(document)));
    await expect(
      createClient().discover(
        'https://login.example.test/.well-known/openid-configuration',
        'https://login.example.test',
      ),
    ).rejects.toThrow(message);
  });

  it('blocks private-network metadata targets and symmetric JWKS material', async () => {
    const client = createClient('production');
    expect(() =>
      client.assertSafeProviderUrl('https://127.0.0.1/.well-known/openid-configuration'),
    ).toThrow(BadRequestException);

    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(jsonResponse({ keys: [{ kty: 'oct', kid: 'shared', k: 'c2VjcmV0' }] })),
    );
    await expect(client.jwks('https://login.example.test/jwks')).rejects.toThrow(
      'unsupported signing key',
    );
  });

  it('does not follow redirects or accept unavailable metadata', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response('unavailable', { status: 503, headers: { 'content-type': 'text/plain' } }),
        ),
    );
    await expect(
      createClient().discover(
        'https://login.example.test/.well-known/openid-configuration',
        'https://login.example.test',
      ),
    ).rejects.toThrow(ServiceUnavailableException);
  });
});

function createClient(environment: 'test' | 'production' = 'test'): OidcDiscoveryClient {
  return new OidcDiscoveryClient(
    new ConfigService<EnvironmentVariables, true>({
      NODE_ENV: environment,
      IDENTITY_OIDC_HTTP_TIMEOUT_MS: 1_000,
    } as EnvironmentVariables),
  );
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
