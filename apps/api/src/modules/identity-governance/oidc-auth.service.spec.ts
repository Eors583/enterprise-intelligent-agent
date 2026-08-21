import { createHash, createHmac } from 'node:crypto';

import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { JWK, JWTPayload } from 'jose';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

import type { EnvironmentVariables } from '../../config/environment.js';
import type { AuthPrismaService } from '../../database/auth-prisma.service.js';
import type { TokenService } from '../auth/application/token.service.js';
import type { IdentitySecretVault } from './identity-secret-vault.js';
import type { OidcDiscoveryClient } from './oidc-discovery.client.js';
import { OidcAuthService } from './oidc-auth.service.js';

const pepper = 'oidc-unit-test-pepper';
const tenantId = '00000000-0000-7000-8000-00000000d001';
const providerId = '00000000-0000-7000-8000-00000000d101';
const transactionId = '00000000-0000-7000-8000-00000000d201';
const issuer = 'https://login.example.test';
const clientId = 'enterprise-agent';
const nonce = 'nonce-that-must-be-bound-to-the-transaction';

interface VerificationContext {
  readonly id: string;
  readonly tenant_id: string;
  readonly provider_id: string;
  readonly nonce_hash: string;
  readonly pkce_verifier_ciphertext: Uint8Array;
  readonly redirect_uri: string;
  readonly jit_mode: 'DISABLED' | 'EXISTING_USERS_ONLY' | 'CREATE_USERS';
  readonly allow_verified_email_linking: boolean;
  readonly allowed_email_domains: string[];
  readonly issuer: string;
  readonly token_endpoint: string;
  readonly jwks_uri: string;
  readonly client_id: string;
  readonly clock_skew_seconds: number;
  readonly secret_ciphertext: Uint8Array;
}

interface PrivateOidcAuthService {
  verifyIdToken(
    context: VerificationContext,
    idToken: string,
  ): Promise<{
    readonly payload: JWTPayload;
    readonly keyThumbprint: string;
    readonly tokenHash: string;
    readonly subjectHash: string;
    readonly claimsHash: string;
    readonly evidenceHash: string;
  }>;
  exchangeCode(context: VerificationContext, code: string): Promise<string>;
  loadTransaction(stateHash: string): Promise<VerificationContext>;
}

describe('OidcAuthService cryptographic boundary', () => {
  let privateKey: CryptoKey;
  let publicJwk: JWK;

  beforeAll(async () => {
    const pair = await generateKeyPair('RS256');
    privateKey = pair.privateKey;
    publicJwk = {
      ...(await exportJWK(pair.publicKey)),
      kid: 'test-signing-key',
      alg: 'RS256',
      use: 'sig',
    };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('verifies signature, issuer, audience, nonce, time window, and selected JWKS key', async () => {
    const { service } = createService();
    const token = await signToken({ nonce });
    const result = await privateService(service).verifyIdToken(contextFixture(), token);

    expect(result.payload).toMatchObject({
      iss: issuer,
      aud: clientId,
      sub: 'subject-123',
      nonce,
    });
    expect(result).toMatchObject({
      keyThumbprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      tokenHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      subjectHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      claimsHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      evidenceHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it.each([
    {
      name: 'wrong issuer',
      claims: { issuer: 'https://attacker.example.test', audience: clientId, nonce },
    },
    {
      name: 'wrong audience',
      claims: { issuer, audience: 'different-client', nonce },
    },
    {
      name: 'wrong nonce',
      claims: { issuer, audience: clientId, nonce: 'replayed-nonce' },
    },
  ])('fails closed for a validly signed token with $name', async ({ claims }) => {
    const { service } = createService();
    const token = await signToken(claims);
    await expect(privateService(service).verifyIdToken(contextFixture(), token)).rejects.toThrow();
  });

  it('uses S256 PKCE at authorization and returns the exact verifier at token exchange', async () => {
    let encryptedVerifier = '';
    const startTransaction = {
      $queryRaw: vi
        .fn()
        .mockResolvedValueOnce([{ id: tenantId }])
        .mockResolvedValueOnce([{ set_config: tenantId }])
        .mockResolvedValueOnce([
          {
            provider_id: providerId,
            tenant_id: tenantId,
            issuer,
            authorization_endpoint: `${issuer}/authorize`,
            token_endpoint: `${issuer}/token`,
            jwks_uri: `${issuer}/jwks`,
            client_id: clientId,
            scopes: ['openid', 'email'],
            clock_skew_seconds: 30,
          },
        ]),
      $executeRaw: vi.fn().mockResolvedValue(1),
    };
    const prisma = authPrisma(startTransaction);
    const vault = {
      encrypt: vi.fn((value: string) => {
        encryptedVerifier = value;
        return { ciphertext: Buffer.from('encrypted'), keyId: 'test', formatVersion: 1 as const };
      }),
      decrypt: vi.fn(
        (
          _ciphertext: Uint8Array,
          context: { readonly purpose: 'OIDC_PKCE_VERIFIER' | 'OIDC_CLIENT_SECRET' },
        ) => (context.purpose === 'OIDC_PKCE_VERIFIER' ? encryptedVerifier : 'client-secret'),
      ),
    };
    const { service } = createService({ prisma, vault });

    const started = await service.start({
      tenantSlug: 'workspace',
      providerKey: 'corporate',
      redirectUri: 'https://app.example.test/oidc/callback',
    });
    const authorization = new URL(started.authorizationUrl);
    expect(authorization.searchParams.get('response_type')).toBe('code');
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorization.searchParams.get('state')).toHaveLength(43);
    expect(authorization.searchParams.get('nonce')).toHaveLength(43);
    expect(authorization.searchParams.get('code_challenge')).toBe(
      createHash('sha256').update(encryptedVerifier).digest('base64url'),
    );
    expect(encryptedVerifier.length).toBeGreaterThanOrEqual(43);

    let tokenRequest: RequestInit | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
        tokenRequest = init;
        return new Response(JSON.stringify({ id_token: 'signed-id-token' }), { status: 200 });
      }),
    );
    const exchanged = await privateService(service).exchangeCode(contextFixture(), 'auth-code');
    const body = new URLSearchParams(String(tokenRequest?.body));
    expect(exchanged).toBe('signed-id-token');
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code_verifier')).toBe(encryptedVerifier);
    expect(tokenRequest?.redirect).toBe('error');
  });

  it('selects only unconsumed, unfailed, unexpired state and rejects replay', async () => {
    const query = vi.fn().mockResolvedValueOnce([contextFixture()]).mockResolvedValueOnce([]);
    const { service } = createService({
      prisma: authPrisma({ $queryRaw: query }),
    });

    await expect(privateService(service).loadTransaction('state-hash')).resolves.toMatchObject({
      id: transactionId,
    });
    await expect(privateService(service).loadTransaction('state-hash')).rejects.toThrow(
      UnauthorizedException,
    );
    const sql = (query.mock.calls[0]?.[0] as TemplateStringsArray).join(' ');
    expect(sql).toContain('"consumed_at" IS NULL');
    expect(sql).toContain('"failed_at" IS NULL');
    expect(sql).toContain('"expires_at" > CURRENT_TIMESTAMP');
    expect(sql).toContain('"verified_configuration_hash" = provider."configuration_hash"');
  });

  async function signToken(claims: {
    readonly issuer?: string;
    readonly audience?: string;
    readonly nonce: string;
  }): Promise<string> {
    return new SignJWT({
      nonce: claims.nonce,
      email: 'person@example.test',
      email_verified: true,
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-signing-key', typ: 'JWT' })
      .setIssuer(claims.issuer ?? issuer)
      .setAudience(claims.audience ?? clientId)
      .setSubject('subject-123')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);
  }

  function createService(overrides?: {
    readonly prisma?: AuthPrismaService;
    readonly vault?: {
      encrypt: ReturnType<typeof vi.fn>;
      decrypt: ReturnType<typeof vi.fn>;
    };
  }): { service: OidcAuthService } {
    const discovery = {
      jwks: vi.fn().mockResolvedValue({
        keys: [publicJwk],
        documentHash: 'd'.repeat(64),
      }),
      assertSafeProviderUrl: vi.fn((value: string) => new URL(value)),
    } as unknown as OidcDiscoveryClient;
    const vault =
      overrides?.vault ??
      ({
        encrypt: vi.fn(),
        decrypt: vi.fn(),
      } as const);
    return {
      service: new OidcAuthService(
        overrides?.prisma ?? authPrisma({}),
        vault as unknown as IdentitySecretVault,
        discovery,
        {} as TokenService,
        new ConfigService<EnvironmentVariables, true>({
          AUTH_TOKEN_PEPPER: pepper,
          AUTH_PUBLIC_APP_URL: 'https://app.example.test',
          IDENTITY_OIDC_HTTP_TIMEOUT_MS: 1_000,
          AUTH_ACCESS_TTL_SECONDS: 900,
          AUTH_REFRESH_TTL_SECONDS: 2_592_000,
        } as EnvironmentVariables),
      ),
    };
  }
});

function authPrisma(transaction: object): AuthPrismaService {
  return {
    withAuth: <T>(operation: (value: object) => Promise<T>) => operation(transaction),
  } as unknown as AuthPrismaService;
}

function privateService(service: OidcAuthService): PrivateOidcAuthService {
  return service as unknown as PrivateOidcAuthService;
}

function contextFixture(): VerificationContext {
  return {
    id: transactionId,
    tenant_id: tenantId,
    provider_id: providerId,
    nonce_hash: oidcHash('oidc-nonce', nonce),
    pkce_verifier_ciphertext: Buffer.from('pkce-envelope'),
    redirect_uri: 'https://app.example.test/oidc/callback',
    jit_mode: 'EXISTING_USERS_ONLY',
    allow_verified_email_linking: false,
    allowed_email_domains: ['example.test'],
    issuer,
    token_endpoint: `${issuer}/token`,
    jwks_uri: `${issuer}/jwks`,
    client_id: clientId,
    clock_skew_seconds: 30,
    secret_ciphertext: Buffer.from('secret-envelope'),
  };
}

function oidcHash(namespace: string, value: string): string {
  return createHmac('sha256', pepper)
    .update(`enterprise-agent:${namespace}:v1\0`)
    .update(value)
    .digest('hex');
}
