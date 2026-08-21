import { parseLexiangTokenResponse } from './lexiang-response.schemas.js';

const LEXIANG_TOKEN_TIMEOUT_MS = 20_000;

export interface LexiangCredential {
  readonly appKey: string;
  readonly appSecret: string;
}

interface CachedToken {
  readonly value: string;
  readonly refreshAt: number;
}

export class LexiangTokenProvider {
  private readonly cache = new Map<string, CachedToken>();
  private readonly pending = new Map<string, Promise<string>>();

  constructor(
    private readonly fetchImplementation: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  get(connectionId: string, credential: LexiangCredential, forceRefresh = false): Promise<string> {
    const cached = this.cache.get(connectionId);
    if (!forceRefresh && cached !== undefined && cached.refreshAt > this.now()) {
      return Promise.resolve(cached.value);
    }
    const existing = this.pending.get(connectionId);
    if (existing !== undefined) return existing;
    const request = this.fetchToken(connectionId, credential).finally(() =>
      this.pending.delete(connectionId),
    );
    this.pending.set(connectionId, request);
    return request;
  }

  invalidate(connectionId: string): void {
    this.cache.delete(connectionId);
  }

  private async fetchToken(connectionId: string, credential: LexiangCredential): Promise<string> {
    const response = await this.fetchImplementation('https://lxapi.lexiangla.com/cgi-bin/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        app_key: credential.appKey,
        app_secret: credential.appSecret,
        grant_type: 'client_credentials',
      }),
      signal: AbortSignal.timeout(LEXIANG_TOKEN_TIMEOUT_MS),
    });
    if (!response.ok) throw new LexiangProviderError('LEXIANG_TOKEN_UNAVAILABLE', response.status);
    const parsed = parseLexiangTokenResponse(await response.json());
    if (parsed === null) throw new LexiangProviderError('LEXIANG_TOKEN_INVALID_RESPONSE');
    const lifetimeMs = parsed.expires_in * 1_000;
    this.cache.set(connectionId, {
      value: parsed.access_token,
      refreshAt: this.now() + Math.max(1_000, lifetimeMs - 300_000),
    });
    return parsed.access_token;
  }
}

export class LexiangProviderError extends Error {
  constructor(
    readonly code: string,
    readonly status?: number,
  ) {
    super(code);
    this.name = 'LexiangProviderError';
  }
}
