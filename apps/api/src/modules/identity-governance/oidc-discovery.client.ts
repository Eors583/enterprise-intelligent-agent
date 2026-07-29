import { createHash } from 'node:crypto';
import { isIP } from 'node:net';

import {
  BadRequestException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { JWK } from 'jose';

import type { EnvironmentVariables } from '../../config/environment.js';

const MAX_DOCUMENT_BYTES = 1_048_576;

export interface OidcDiscoveryDocument {
  readonly issuer: string;
  readonly authorization_endpoint: string;
  readonly token_endpoint: string;
  readonly jwks_uri: string;
  readonly response_types_supported: readonly string[];
  readonly id_token_signing_alg_values_supported?: readonly string[];
}

@Injectable()
export class OidcDiscoveryClient {
  private readonly timeoutMs: number;
  private readonly environment: EnvironmentVariables['NODE_ENV'];

  constructor(
    @Inject(ConfigService)
    config: ConfigService<EnvironmentVariables, true>,
  ) {
    this.timeoutMs = config.get('IDENTITY_OIDC_HTTP_TIMEOUT_MS', { infer: true });
    this.environment = config.get('NODE_ENV', { infer: true });
  }

  async discover(
    discoveryUrl: string,
    expectedIssuer: string,
  ): Promise<{ document: OidcDiscoveryDocument; documentHash: string }> {
    this.assertSafeProviderUrl(discoveryUrl);
    this.assertSafeProviderUrl(expectedIssuer);
    const value = await this.getJson(discoveryUrl);
    if (!isRecord(value)) throw invalidDiscovery();
    const issuer = requiredString(value, 'issuer');
    const authorizationEndpoint = requiredString(value, 'authorization_endpoint');
    const tokenEndpoint = requiredString(value, 'token_endpoint');
    const jwksUri = requiredString(value, 'jwks_uri');
    if (canonicalIssuer(issuer) !== canonicalIssuer(expectedIssuer)) {
      throw new BadRequestException('OIDC discovery issuer does not match the configured issuer.');
    }
    for (const url of [issuer, authorizationEndpoint, tokenEndpoint, jwksUri]) {
      this.assertSafeProviderUrl(url);
    }
    const responseTypes = stringArray(value.response_types_supported);
    if (!responseTypes.includes('code')) {
      throw new BadRequestException('OIDC provider does not support authorization code flow.');
    }
    const algorithms = stringArray(value.id_token_signing_alg_values_supported);
    if (algorithms.some((algorithm) => algorithm === 'none' || algorithm.startsWith('HS'))) {
      throw new BadRequestException('OIDC provider advertises an unsafe ID-token algorithm.');
    }
    const document: OidcDiscoveryDocument = {
      issuer,
      authorization_endpoint: authorizationEndpoint,
      token_endpoint: tokenEndpoint,
      jwks_uri: jwksUri,
      response_types_supported: responseTypes,
      ...(algorithms.length === 0 ? {} : { id_token_signing_alg_values_supported: algorithms }),
    };
    return { document, documentHash: hashJson(document) };
  }

  async jwks(jwksUri: string): Promise<{ keys: readonly JWK[]; documentHash: string }> {
    this.assertSafeProviderUrl(jwksUri);
    const value = await this.getJson(jwksUri);
    if (!isRecord(value) || !Array.isArray(value.keys) || value.keys.length === 0) {
      throw new BadRequestException('OIDC JWKS document does not contain signing keys.');
    }
    const keys = value.keys.filter(isRecord) as JWK[];
    if (
      keys.length === 0 ||
      keys.some(
        (key) =>
          typeof key.kty !== 'string' ||
          key.kty === 'oct' ||
          key.use === 'enc' ||
          key.alg === 'none' ||
          (typeof key.alg === 'string' && key.alg.startsWith('HS')),
      )
    ) {
      throw new BadRequestException('OIDC JWKS contains an unsupported signing key.');
    }
    return { keys, documentHash: hashJson({ keys }) };
  }

  assertSafeProviderUrl(value: string): URL {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new BadRequestException('OIDC provider URL is invalid.');
    }
    const localDevelopment =
      this.environment !== 'production' &&
      (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1');
    if (
      (url.protocol !== 'https:' && !(localDevelopment && url.protocol === 'http:')) ||
      url.username !== '' ||
      url.password !== '' ||
      url.hash !== ''
    ) {
      throw new BadRequestException('OIDC provider URLs must be credential-free HTTPS URLs.');
    }
    if (!localDevelopment && isPrivateLiteral(url.hostname)) {
      throw new BadRequestException('OIDC provider URLs must not target a private network.');
    }
    return url;
  }

  private async getJson(url: string): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        cache: 'no-store',
        redirect: 'error',
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new ServiceUnavailableException('OIDC provider metadata is unavailable.');
      }
      const contentLength = Number(response.headers.get('content-length') ?? 0);
      if (contentLength > MAX_DOCUMENT_BYTES) {
        throw new BadRequestException('OIDC provider metadata exceeds the size limit.');
      }
      const text = await response.text();
      if (Buffer.byteLength(text, 'utf8') > MAX_DOCUMENT_BYTES) {
        throw new BadRequestException('OIDC provider metadata exceeds the size limit.');
      }
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw invalidDiscovery();
      }
    } catch (error) {
      if (error instanceof BadRequestException || error instanceof ServiceUnavailableException) {
        throw error;
      }
      throw new ServiceUnavailableException('OIDC provider metadata is unavailable.');
    } finally {
      clearTimeout(timeout);
    }
  }
}

function canonicalIssuer(value: string): string {
  return value.replace(/\/+$/, '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const result = value[key];
  if (typeof result !== 'string' || result.length === 0 || result.length > 1000) {
    throw invalidDiscovery();
  }
  return result;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is string => typeof item === 'string' && item.length > 0 && item.length <= 100,
  );
}

function hashJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function isPrivateLiteral(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (normalized === 'localhost' || normalized.endsWith('.localhost')) return true;
  const version = isIP(normalized);
  if (version === 4) {
    const [a = 0, b = 0] = normalized.split('.').map(Number);
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  if (version === 6) {
    return (
      normalized === '::1' ||
      normalized === '::' ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      normalized.startsWith('fe8') ||
      normalized.startsWith('fe9') ||
      normalized.startsWith('fea') ||
      normalized.startsWith('feb')
    );
  }
  return false;
}

function invalidDiscovery(): BadRequestException {
  return new BadRequestException('OIDC discovery document is invalid.');
}
