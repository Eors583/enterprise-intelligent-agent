import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

import {
  BadGatewayException,
  BadRequestException,
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { calculateJwkThumbprint, createLocalJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type {
  AuthSessionResponse,
  OidcLoginCallbackRequest,
  OidcLoginStartRequest,
  OidcLoginStartResponse,
} from '@enterprise/contracts';

import type { EnvironmentVariables } from '../../config/environment.js';
import { AuthPrismaService } from '../../database/auth-prisma.service.js';
import { TokenService } from '../auth/application/token.service.js';
import { IdentitySecretVault } from './identity-secret-vault.js';
import { OidcDiscoveryClient } from './oidc-discovery.client.js';

const TOKEN_RESPONSE_BYTES = 1_048_576;
const OIDC_ALGORITHMS = [
  'RS256',
  'RS384',
  'RS512',
  'PS256',
  'PS384',
  'PS512',
  'ES256',
  'ES384',
  'ES512',
  'EdDSA',
] as const;

@Injectable()
export class OidcAuthService {
  private readonly pepper: string;
  private readonly publicAppUrl: URL;
  private readonly timeoutMs: number;
  private readonly accessTtlSeconds: number;
  private readonly refreshTtlSeconds: number;

  constructor(
    @Inject(AuthPrismaService) private readonly prisma: AuthPrismaService,
    @Inject(IdentitySecretVault) private readonly vault: IdentitySecretVault,
    @Inject(OidcDiscoveryClient) private readonly discovery: OidcDiscoveryClient,
    @Inject(TokenService) private readonly tokens: TokenService,
    @Inject(ConfigService)
    config: ConfigService<EnvironmentVariables, true>,
  ) {
    this.pepper = config.get('AUTH_TOKEN_PEPPER', { infer: true });
    this.publicAppUrl = new URL(config.get('AUTH_PUBLIC_APP_URL', { infer: true }));
    this.timeoutMs = config.get('IDENTITY_OIDC_HTTP_TIMEOUT_MS', { infer: true });
    this.accessTtlSeconds = config.get('AUTH_ACCESS_TTL_SECONDS', { infer: true });
    this.refreshTtlSeconds = config.get('AUTH_REFRESH_TTL_SECONDS', { infer: true });
  }

  async publicProviders(
    tenantSlug: string,
  ): Promise<{ items: Array<{ key: string; displayName: string; protocol: 'OIDC' }> }> {
    return this.prisma.withAuth(async (transaction) => {
      const tenants = await transaction.$queryRaw<Array<{ id: string }>>`
        SELECT "id"
        FROM public."tenants"
        WHERE "slug" = ${tenantSlug}
          AND "status" = 'ACTIVE'
        LIMIT 1
      `;
      const tenant = tenants[0];
      if (tenant === undefined) return { items: [] };
      await setTenant(transaction, tenant.id);
      const rows = await transaction.$queryRaw<Array<{ key: string; display_name: string }>>`
        SELECT "key", "display_name"
        FROM public."enterprise_identity_providers"
        WHERE "tenant_id" = ${tenant.id}::uuid
          AND "protocol" = 'OIDC'
          AND "verification_status" = 'VERIFIED'
          AND "publication_status" = 'PUBLISHED'
        ORDER BY "display_name", "key"
      `;
      return {
        items: rows.map((row) => ({
          key: row.key,
          displayName: row.display_name,
          protocol: 'OIDC' as const,
        })),
      };
    });
  }

  async start(request: OidcLoginStartRequest): Promise<OidcLoginStartResponse> {
    const redirectUri = this.validateRedirectUri(request.redirectUri);
    const state = randomBytes(32).toString('base64url');
    const nonce = randomBytes(32).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const transactionId = randomUUID();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 10 * 60 * 1000);
    const configuration = await this.prisma.withAuth(async (transaction) => {
      const tenants = await transaction.$queryRaw<Array<{ id: string }>>`
        SELECT "id"
        FROM public."tenants"
        WHERE "slug" = ${request.tenantSlug}
          AND "status" = 'ACTIVE'
        LIMIT 1
      `;
      const tenant = tenants[0];
      if (tenant === undefined) throw oidcUnavailable();
      await setTenant(transaction, tenant.id);
      const rows = await transaction.$queryRaw<OidcConfigurationRow[]>`
        SELECT provider."id" AS "provider_id", provider."tenant_id",
               oidc."issuer", oidc."authorization_endpoint",
               oidc."token_endpoint", oidc."jwks_uri", oidc."client_id",
               oidc."scopes", oidc."clock_skew_seconds"
        FROM public."enterprise_identity_providers" AS provider
        JOIN public."oidc_provider_configs" AS oidc
          ON oidc."tenant_id" = provider."tenant_id"
         AND oidc."provider_id" = provider."id"
        WHERE provider."tenant_id" = ${tenant.id}::uuid
          AND provider."key" = ${request.providerKey}
          AND provider."protocol" = 'OIDC'
          AND provider."verification_status" = 'VERIFIED'
          AND provider."publication_status" = 'PUBLISHED'
          AND provider."verified_configuration_hash" = provider."configuration_hash"
        LIMIT 1
      `;
      const provider = rows[0];
      if (provider === undefined) throw oidcUnavailable();
      const encrypted = this.vault.encrypt(verifier, {
        tenantId: tenant.id,
        resourceId: transactionId,
        purpose: 'OIDC_PKCE_VERIFIER',
      });
      await transaction.$executeRaw`
        INSERT INTO public."oidc_auth_transactions" (
          "id", "tenant_id", "provider_id", "state_hash", "nonce_hash",
          "pkce_verifier_ciphertext", "pkce_key_id", "redirect_uri",
          "issued_at", "expires_at"
        ) VALUES (
          ${transactionId}::uuid, ${tenant.id}::uuid, ${provider.provider_id}::uuid,
          ${this.hash('oidc-state', state)}, ${this.hash('oidc-nonce', nonce)},
          ${encrypted.ciphertext}, ${encrypted.keyId}, ${redirectUri.toString()},
          ${now}, ${expiresAt}
        )
      `;
      return provider;
    });
    const authorizationUrl = this.discovery.assertSafeProviderUrl(
      configuration.authorization_endpoint,
    );
    authorizationUrl.searchParams.set('response_type', 'code');
    authorizationUrl.searchParams.set('client_id', configuration.client_id);
    authorizationUrl.searchParams.set('redirect_uri', redirectUri.toString());
    authorizationUrl.searchParams.set('scope', configuration.scopes.join(' '));
    authorizationUrl.searchParams.set('state', state);
    authorizationUrl.searchParams.set('nonce', nonce);
    authorizationUrl.searchParams.set('code_challenge', challenge);
    authorizationUrl.searchParams.set('code_challenge_method', 'S256');
    return { authorizationUrl: authorizationUrl.toString(), expiresAt: expiresAt.toISOString() };
  }

  async callback(request: OidcLoginCallbackRequest): Promise<AuthSessionResponse> {
    const stateHash = this.hash('oidc-state', request.state);
    const context = await this.loadTransaction(stateHash);
    let idToken: string;
    try {
      idToken = await this.exchangeCode(context, request.code);
    } catch (error) {
      await this.failTransaction(context, 'OIDC_TOKEN_EXCHANGE_FAILED');
      throw error;
    }

    let verified: {
      readonly payload: JWTPayload;
      readonly keyThumbprint: string;
      readonly tokenHash: string;
      readonly subjectHash: string;
      readonly claimsHash: string;
      readonly evidenceHash: string;
    };
    try {
      verified = await this.verifyIdToken(context, idToken);
    } catch {
      await this.recordFailedToken(context, idToken, 'OIDC_ID_TOKEN_INVALID');
      throw new UnauthorizedException('OIDC ID token validation failed.');
    }

    const result = await this.prisma.withAuth<AuthSessionResponse | { readonly failure: string }>(
      async (transaction) => {
        await setTenant(transaction, context.tenant_id);
        const locked = await transaction.$queryRaw<Array<{ id: string }>>`
        SELECT "id"
        FROM public."oidc_auth_transactions"
        WHERE "id" = ${context.id}::uuid
          AND "consumed_at" IS NULL
          AND "failed_at" IS NULL
          AND "expires_at" > CURRENT_TIMESTAMP
        FOR UPDATE
      `;
        if (locked.length !== 1) return { failure: 'OIDC_TRANSACTION_ALREADY_USED' };
        const receiptId = randomUUID();
        await transaction.$executeRaw`
        INSERT INTO public."oidc_token_validation_receipts" (
          "id", "tenant_id", "provider_id", "auth_transaction_id",
          "id_token_hash", "subject_hash", "claims_hash", "nonce_hash",
          "jwks_key_thumbprint", "validation_status", "signature_valid",
          "jwks_key_valid", "issuer_valid", "audience_valid", "nonce_valid",
          "time_window_valid", "verifier_evidence_hash", "verified_at"
        ) VALUES (
          ${receiptId}::uuid, ${context.tenant_id}::uuid,
          ${context.provider_id}::uuid, ${context.id}::uuid,
          ${verified.tokenHash}, ${verified.subjectHash}, ${verified.claimsHash},
          ${context.nonce_hash}, ${verified.keyThumbprint}, 'VERIFIED',
          true, true, true, true, true, true, ${verified.evidenceHash}, CURRENT_TIMESTAMP
        )
      `;
        const userId = await this.resolveAccount(
          transaction,
          context,
          verified.payload,
          verified.subjectHash,
          verified.claimsHash,
          receiptId,
        );
        if (userId === null) {
          await transaction.$executeRaw`
          UPDATE public."oidc_auth_transactions"
          SET "failed_at" = CURRENT_TIMESTAMP,
              "failure_code" = 'OIDC_ACCOUNT_NOT_LINKED',
              "pkce_verifier_ciphertext" = NULL,
              "pkce_verifier_ref" = NULL,
              "pkce_key_id" = NULL
          WHERE "id" = ${context.id}::uuid
        `;
          return { failure: 'OIDC_ACCOUNT_NOT_LINKED' };
        }
        const tenant = await transaction.tenant.findUnique({
          where: { id: context.tenant_id },
          select: { id: true, slug: true, name: true, status: true },
        });
        const user = await transaction.user.findUnique({
          where: { tenantId_id: { tenantId: context.tenant_id, id: userId } },
          select: { id: true, email: true, displayName: true, role: true, status: true },
        });
        if (
          tenant === null ||
          tenant.status !== 'ACTIVE' ||
          user === null ||
          user.status !== 'ACTIVE'
        ) {
          return { failure: 'OIDC_ACCOUNT_INACTIVE' };
        }
        const pair = this.tokens.issuePair();
        const now = new Date();
        const accessExpiresAt = addSeconds(now, this.accessTtlSeconds);
        const refreshExpiresAt = addSeconds(now, this.refreshTtlSeconds);
        const session = await transaction.authSession.create({
          data: {
            tenantId: tenant.id,
            userId: user.id,
            accessTokenHash: pair.access.hash,
            refreshTokenHash: pair.refresh.hash,
            accessExpiresAt,
            refreshExpiresAt,
            ...(request.sessionLabel === undefined ? {} : { label: request.sessionLabel }),
          },
          select: { id: true },
        });
        await transaction.$executeRaw`
        UPDATE public."oidc_auth_transactions"
        SET "consumed_at" = ${now},
            "authorization_code_hash" = ${this.hash('oidc-code', request.code)},
            "pkce_verifier_ciphertext" = NULL,
            "pkce_verifier_ref" = NULL,
            "pkce_key_id" = NULL
        WHERE "id" = ${context.id}::uuid
      `;
        await transaction.$executeRaw`
        UPDATE public."oidc_account_bindings"
        SET "last_login_at" = ${now}
        WHERE "tenant_id" = ${tenant.id}::uuid
          AND "provider_id" = ${context.provider_id}::uuid
          AND "user_id" = ${user.id}::uuid
      `;
        await transaction.auditEvent.create({
          data: {
            tenantId: tenant.id,
            actorType: 'USER',
            actorId: user.id,
            action: 'auth.oidc_login_completed',
            resourceType: 'auth_session',
            resourceId: session.id,
            metadata: { providerId: context.provider_id, receiptId },
          },
        });
        return {
          accessToken: pair.access.value,
          refreshToken: pair.refresh.value,
          account: {
            sessionId: session.id,
            tenantId: tenant.id,
            tenantSlug: tenant.slug,
            tenantName: tenant.name,
            userId: user.id,
            email: user.email,
            displayName: user.displayName,
            role: user.role,
            passwordChangeRequired: false,
            accessExpiresAt: accessExpiresAt.toISOString(),
            refreshExpiresAt: refreshExpiresAt.toISOString(),
          },
        };
      },
    );
    if ('failure' in result) {
      throw new UnauthorizedException('OIDC account is not authorized for this workspace.');
    }
    return result;
  }

  private async loadTransaction(stateHash: string): Promise<OidcAuthContextRow> {
    return this.prisma.withAuth(async (transaction) => {
      const rows = await transaction.$queryRaw<OidcAuthContextRow[]>`
        SELECT tx."id", tx."tenant_id", tx."provider_id", tx."nonce_hash",
               tx."pkce_verifier_ciphertext", tx."redirect_uri",
               provider."jit_mode", provider."allow_verified_email_linking",
               provider."allowed_email_domains", oidc."issuer", oidc."token_endpoint",
               oidc."jwks_uri", oidc."client_id", oidc."clock_skew_seconds",
               secret."secret_ciphertext"
        FROM public."oidc_auth_transactions" AS tx
        JOIN public."enterprise_identity_providers" AS provider
          ON provider."tenant_id" = tx."tenant_id"
         AND provider."id" = tx."provider_id"
        JOIN public."oidc_provider_configs" AS oidc
          ON oidc."tenant_id" = tx."tenant_id"
         AND oidc."provider_id" = tx."provider_id"
        JOIN public."identity_provider_secrets" AS secret
          ON secret."tenant_id" = tx."tenant_id"
         AND secret."provider_id" = tx."provider_id"
         AND secret."kind" = 'OIDC_CLIENT_SECRET'
        WHERE tx."state_hash" = ${stateHash}
          AND tx."consumed_at" IS NULL
          AND tx."failed_at" IS NULL
          AND tx."expires_at" > CURRENT_TIMESTAMP
          AND provider."publication_status" = 'PUBLISHED'
          AND provider."verification_status" = 'VERIFIED'
          AND provider."verified_configuration_hash" = provider."configuration_hash"
        LIMIT 1
      `;
      const context = rows[0];
      if (context === undefined) {
        throw new UnauthorizedException('OIDC authorization state is invalid or expired.');
      }
      return context;
    });
  }

  private async exchangeCode(context: OidcAuthContextRow, code: string): Promise<string> {
    const verifier = this.vault.decrypt(context.pkce_verifier_ciphertext, {
      tenantId: context.tenant_id,
      resourceId: context.id,
      purpose: 'OIDC_PKCE_VERIFIER',
    });
    const clientSecret = this.vault.decrypt(context.secret_ciphertext, {
      tenantId: context.tenant_id,
      resourceId: context.provider_id,
      purpose: 'OIDC_CLIENT_SECRET',
    });
    const tokenEndpoint = this.discovery.assertSafeProviderUrl(context.token_endpoint);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(tokenEndpoint, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          Authorization: `Basic ${Buffer.from(
            `${encodeURIComponent(context.client_id)}:${encodeURIComponent(clientSecret)}`,
          ).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: context.redirect_uri,
          code_verifier: verifier,
        }),
        cache: 'no-store',
        redirect: 'error',
        signal: controller.signal,
      });
      if (!response.ok) throw new BadGatewayException('OIDC token exchange was rejected.');
      const text = await response.text();
      if (Buffer.byteLength(text, 'utf8') > TOKEN_RESPONSE_BYTES) {
        throw new BadGatewayException('OIDC token response exceeds the size limit.');
      }
      const body: unknown = JSON.parse(text);
      if (!isRecord(body) || typeof body.id_token !== 'string' || body.id_token.length > 131_072) {
        throw new BadGatewayException('OIDC token response does not contain an ID token.');
      }
      return body.id_token;
    } catch (error) {
      if (error instanceof BadGatewayException) throw error;
      throw new ServiceUnavailableException('OIDC token endpoint is unavailable.');
    } finally {
      clearTimeout(timeout);
    }
  }

  private async verifyIdToken(
    context: OidcAuthContextRow,
    idToken: string,
  ): Promise<{
    payload: JWTPayload;
    keyThumbprint: string;
    tokenHash: string;
    subjectHash: string;
    claimsHash: string;
    evidenceHash: string;
  }> {
    const jwks = await this.discovery.jwks(context.jwks_uri);
    const verifier = createLocalJWKSet({ keys: [...jwks.keys] });
    const result = await jwtVerify(idToken, verifier, {
      issuer: context.issuer,
      audience: context.client_id,
      clockTolerance: context.clock_skew_seconds,
      algorithms: [...OIDC_ALGORITHMS],
    });
    if (
      typeof result.payload.sub !== 'string' ||
      result.payload.sub.length === 0 ||
      result.payload.sub.length > 1024 ||
      typeof result.payload.nonce !== 'string'
    ) {
      throw new Error('OIDC ID token claims are incomplete.');
    }
    const actualNonceHash = this.hash('oidc-nonce', result.payload.nonce);
    if (!safeHexEqual(actualNonceHash, context.nonce_hash)) {
      throw new Error('OIDC nonce mismatch.');
    }
    const key = jwks.keys.find((candidate) => candidate.kid === result.protectedHeader.kid);
    if (key === undefined) throw new Error('OIDC signing key was not found.');
    const thumbprint = await calculateJwkThumbprint(key);
    const keyThumbprint = Buffer.from(thumbprint, 'base64url').toString('hex');
    const tokenHash = this.hash('oidc-id-token', idToken);
    const subjectHash = this.hash('oidc-subject', result.payload.sub);
    const claimsHash = this.hash('oidc-claims', stableJson(result.payload));
    const evidenceHash = this.hash(
      'oidc-verifier-evidence',
      stableJson({
        audience: context.client_id,
        claimsHash,
        issuer: context.issuer,
        jwksDocumentHash: jwks.documentHash,
        keyThumbprint,
        nonceHash: actualNonceHash,
        tokenHash,
      }),
    );
    return {
      payload: result.payload,
      keyThumbprint,
      tokenHash,
      subjectHash,
      claimsHash,
      evidenceHash,
    };
  }

  private async resolveAccount(
    transaction: Prisma.TransactionClient,
    context: OidcAuthContextRow,
    payload: JWTPayload,
    subjectHash: string,
    claimsHash: string,
    receiptId: string,
  ): Promise<string | null> {
    const bindings = await transaction.$queryRaw<Array<{ user_id: string }>>`
      SELECT "user_id"
      FROM public."oidc_account_bindings"
      WHERE "tenant_id" = ${context.tenant_id}::uuid
        AND "provider_id" = ${context.provider_id}::uuid
        AND "subject_hash" = ${subjectHash}
        AND "status" = 'ACTIVE'
      LIMIT 1
    `;
    if (bindings[0] !== undefined) return bindings[0].user_id;
    if (
      typeof payload.email !== 'string' ||
      payload.email_verified !== true ||
      payload.email.length > 320
    ) {
      return null;
    }
    const email = payload.email.trim().toLowerCase();
    const domain = email.split('@')[1];
    if (
      domain === undefined ||
      (context.allowed_email_domains.length > 0 && !context.allowed_email_domains.includes(domain))
    ) {
      return null;
    }
    let user = await transaction.user.findFirst({
      where: { tenantId: context.tenant_id, emailNormalized: email, status: 'ACTIVE' },
      select: { id: true },
    });
    if (user !== null && !context.allow_verified_email_linking) return null;
    if (user === null && context.jit_mode === 'CREATE_USERS') {
      user = await transaction.user.create({
        data: {
          tenantId: context.tenant_id,
          email,
          emailNormalized: email,
          displayName:
            typeof payload.name === 'string' && payload.name.trim()
              ? payload.name.trim().slice(0, 120)
              : email.split('@')[0]!.slice(0, 120),
          status: 'ACTIVE',
          role: 'MEMBER',
        },
        select: { id: true },
      });
    }
    if (user === null) return null;
    await transaction.$executeRaw`
      INSERT INTO public."oidc_account_bindings" (
        "tenant_id", "provider_id", "user_id", "created_from_receipt_id",
        "subject_hash", "claims_hash"
      ) VALUES (
        ${context.tenant_id}::uuid, ${context.provider_id}::uuid, ${user.id}::uuid,
        ${receiptId}::uuid, ${subjectHash}, ${claimsHash}
      )
    `;
    return user.id;
  }

  private async recordFailedToken(
    context: OidcAuthContextRow,
    idToken: string,
    failureCode: string,
  ): Promise<void> {
    await this.prisma.withAuth(async (transaction) => {
      await setTenant(transaction, context.tenant_id);
      const updated = await transaction.$executeRaw`
        UPDATE public."oidc_auth_transactions"
        SET "failed_at" = CURRENT_TIMESTAMP,
            "failure_code" = ${failureCode},
            "pkce_verifier_ciphertext" = NULL,
            "pkce_verifier_ref" = NULL,
            "pkce_key_id" = NULL
        WHERE "id" = ${context.id}::uuid
          AND "consumed_at" IS NULL
          AND "failed_at" IS NULL
      `;
      if (updated !== 1) return;
      await transaction.$executeRaw`
        INSERT INTO public."oidc_token_validation_receipts" (
          "tenant_id", "provider_id", "auth_transaction_id", "id_token_hash",
          "subject_hash", "claims_hash", "nonce_hash", "validation_status",
          "failure_code"
        ) VALUES (
          ${context.tenant_id}::uuid, ${context.provider_id}::uuid,
          ${context.id}::uuid, ${this.hash('oidc-id-token', idToken)},
          ${this.hash('oidc-subject', 'unavailable')},
          ${this.hash('oidc-claims', 'unavailable')}, ${context.nonce_hash},
          'FAILED', ${failureCode}
        )
      `;
    });
  }

  private async failTransaction(context: OidcAuthContextRow, failureCode: string): Promise<void> {
    await this.prisma.withAuth(async (transaction) => {
      await setTenant(transaction, context.tenant_id);
      await transaction.$executeRaw`
        UPDATE public."oidc_auth_transactions"
        SET "failed_at" = CURRENT_TIMESTAMP,
            "failure_code" = ${failureCode},
            "pkce_verifier_ciphertext" = NULL,
            "pkce_verifier_ref" = NULL,
            "pkce_key_id" = NULL
        WHERE "id" = ${context.id}::uuid
          AND "consumed_at" IS NULL
          AND "failed_at" IS NULL
      `;
    });
  }

  private validateRedirectUri(value: string): URL {
    const url = new URL(value);
    if (
      url.origin !== this.publicAppUrl.origin ||
      url.pathname !== '/oidc/callback' ||
      url.search !== '' ||
      url.hash !== ''
    ) {
      throw new BadRequestException('OIDC redirect URI is not registered for this application.');
    }
    return url;
  }

  private hash(namespace: string, value: string): string {
    return createHmac('sha256', this.pepper)
      .update(`enterprise-agent:${namespace}:v1\0`)
      .update(value)
      .digest('hex');
  }
}

interface OidcConfigurationRow {
  readonly provider_id: string;
  readonly tenant_id: string;
  readonly issuer: string;
  readonly authorization_endpoint: string;
  readonly token_endpoint: string;
  readonly jwks_uri: string;
  readonly client_id: string;
  readonly scopes: string[];
  readonly clock_skew_seconds: number;
}

interface OidcAuthContextRow {
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

async function setTenant(transaction: Prisma.TransactionClient, tenantId: string): Promise<void> {
  await transaction.$queryRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
}

function oidcUnavailable(): UnauthorizedException {
  return new UnauthorizedException('OIDC provider is unavailable.');
}

function addSeconds(value: Date, seconds: number): Date {
  return new Date(value.getTime() + seconds * 1000);
}

function safeHexEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'hex');
  const rightBytes = Buffer.from(right, 'hex');
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(',')}}`;
}
