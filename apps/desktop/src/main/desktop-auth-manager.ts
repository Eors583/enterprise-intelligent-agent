import {
  authSessionResponseSchema,
  changePasswordRequestSchema,
  changePasswordResponseSchema,
  loginRequestSchema,
  registerTenantRequestSchema,
  type AuthAccount,
  type ChangePasswordRequest,
  type LoginRequest,
  type RegisterTenantRequest,
} from '@enterprise/contracts';
import type {
  DesktopApiRequest,
  DesktopApiResponse,
  DesktopAuthState,
  DesktopPasswordChangeResult,
} from '../shared/desktop-api';
import { AccountStore } from './account-store';

const MAX_REQUEST_BYTES = 2_100_000;
const REQUEST_TIMEOUT_MS = 20_000;
const UUID =
  '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}';
const BUSINESS_ROUTES: ReadonlyArray<{
  pattern: RegExp;
  methods: ReadonlySet<DesktopApiRequest['method']>;
}> = [
  { pattern: /^\/api\/v1\/bootstrap$/, methods: new Set(['GET']) },
  { pattern: /^\/api\/v1\/conversations$/, methods: new Set(['GET', 'POST']) },
  {
    pattern: new RegExp(`^/api/v1/conversations/${UUID}/messages$`),
    methods: new Set(['GET', 'POST']),
  },
  {
    pattern: new RegExp(`^/api/v1/conversations/${UUID}/runs/${UUID}/(?:cancel|retry)$`),
    methods: new Set(['POST']),
  },
  {
    pattern: new RegExp(`^/api/v1/messages/${UUID}/feedback$`),
    methods: new Set(['GET', 'PUT']),
  },
  {
    pattern: new RegExp(`^/api/v1/knowledge-citations/${UUID}/chunks/${UUID}$`),
    methods: new Set(['GET']),
  },
];

interface AccessTokenState {
  token: string;
  expiresAt: number;
}

class AuthHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class DesktopAuthManager {
  private readonly accessTokens = new Map<string, AccessTokenState>();
  private readonly refreshes = new Map<string, Promise<void>>();
  private generation = 0;

  constructor(
    private readonly store: AccountStore,
    private readonly baseUrl: string,
    private readonly onStateChanged: (state: DesktopAuthState) => void = () => undefined,
  ) {}

  async initialize(): Promise<void> {
    validateBaseUrl(this.baseUrl);
    await this.store.load();
  }

  state(): DesktopAuthState {
    return {
      accounts: this.store.list(),
      activeSessionId: this.store.activeId,
      persistentStorageAvailable: this.store.persistentStorageAvailable,
    };
  }

  async login(input: LoginRequest): Promise<DesktopAuthState> {
    const request = loginRequestSchema.parse(input);
    const response = await this.authRequest('/api/v1/auth/login', request);
    await this.acceptBundle(response);
    return this.state();
  }

  async registerTenant(input: RegisterTenantRequest): Promise<DesktopAuthState> {
    const request = registerTenantRequestSchema.parse(input);
    const response = await this.authRequest('/api/v1/auth/register-tenant', request);
    await this.acceptBundle(response);
    return this.state();
  }

  async changePassword(input: ChangePasswordRequest): Promise<DesktopPasswordChangeResult> {
    const request = changePasswordRequestSchema.parse(input);
    const activeSessionId = this.store.activeId;
    if (!activeSessionId) throw new AuthHttpError(401, 'Please sign in first.');
    const requestGeneration = this.generation;

    let token = await this.accessToken(activeSessionId);
    this.requireExpectedSession(activeSessionId);
    let response = await this.rawRequest('/api/v1/auth/change-password', {
      method: 'POST',
      body: request,
      authorization: token,
    });
    if (response.status === 401) {
      this.requireExpectedSession(activeSessionId);
      token = await this.accessTokenAfterUnauthorized(activeSessionId, token);
      this.requireExpectedSession(activeSessionId);
      response = await this.rawRequest('/api/v1/auth/change-password', {
        method: 'POST',
        body: request,
        authorization: token,
      });
    }
    this.requireExpectedSession(activeSessionId);
    if (requestGeneration !== this.generation) throw staleAccountError();
    if (response.status < 200 || response.status >= 300) {
      throw new AuthHttpError(response.status, responseMessage(response.body));
    }

    const parsed = changePasswordResponseSchema.safeParse(response.body);
    if (!parsed.success) throw new Error('Password change response failed contract validation.');
    const stored = this.store.get(activeSessionId);
    if (
      !stored ||
      parsed.data.account.sessionId !== activeSessionId ||
      parsed.data.account.tenantId !== stored.account.tenantId ||
      parsed.data.account.userId !== stored.account.userId
    ) {
      throw new Error('The password change response identity changed unexpectedly.');
    }

    await this.store.updateCredentials(parsed.data.account, stored.refreshToken);
    this.emitState();
    return {
      state: this.state(),
      revokedSessionCount: parsed.data.revokedSessionCount,
    };
  }

  async switchAccount(sessionId: string): Promise<DesktopAuthState> {
    if (!this.store.get(sessionId)) throw new Error('Account is not available on this device.');
    await this.refresh(sessionId);
    await this.store.activate(sessionId);
    this.generation += 1;
    this.emitState();
    return this.state();
  }

  async logout(sessionId = this.store.activeId ?? undefined): Promise<DesktopAuthState> {
    if (!sessionId) return this.state();
    const stored = this.store.get(sessionId);
    if (!stored) return this.state();

    try {
      const accessToken = await this.accessToken(sessionId);
      await this.rawRequest('/api/v1/auth/logout', {
        method: 'POST',
        authorization: accessToken,
      });
    } catch {
      // Local logout remains available while offline. The remote session still
      // has a short access lifetime and a bounded refresh lifetime.
    }
    this.accessTokens.delete(sessionId);
    await this.store.remove(sessionId);
    this.generation += 1;
    this.emitState();
    return this.state();
  }

  async apiRequest(request: DesktopApiRequest): Promise<DesktopApiResponse> {
    assertBusinessRequest(request);
    const activeSessionId = this.requireExpectedSession(request.expectedSessionId);
    const requestGeneration = this.generation;

    let token = await this.accessToken(activeSessionId);
    this.requireExpectedSession(request.expectedSessionId);
    let response = await this.rawRequest(request.path, {
      method: request.method,
      ...(request.body === undefined ? {} : { body: request.body }),
      authorization: token,
    });
    if (response.status === 401) {
      this.requireExpectedSession(request.expectedSessionId);
      token = await this.accessTokenAfterUnauthorized(activeSessionId, token);
      this.requireExpectedSession(request.expectedSessionId);
      response = await this.rawRequest(request.path, {
        method: request.method,
        ...(request.body === undefined ? {} : { body: request.body }),
        authorization: token,
      });
    }
    this.requireExpectedSession(request.expectedSessionId);
    if (requestGeneration !== this.generation) {
      throw staleAccountError();
    }
    return response;
  }

  private async accessToken(sessionId: string): Promise<string> {
    const cached = this.accessTokens.get(sessionId);
    if (cached && cached.expiresAt > Date.now() + 30_000) return cached.token;
    await this.refresh(sessionId);
    const refreshed = this.accessTokens.get(sessionId);
    if (!refreshed) throw new AuthHttpError(401, 'The account session has expired.');
    return refreshed.token;
  }

  private async accessTokenAfterUnauthorized(
    sessionId: string,
    failedToken: string,
  ): Promise<string> {
    const current = this.accessTokens.get(sessionId);
    if (current && current.token !== failedToken) return current.token;
    if (current?.token === failedToken) this.accessTokens.delete(sessionId);
    return this.accessToken(sessionId);
  }

  private async refresh(sessionId: string): Promise<void> {
    const inFlight = this.refreshes.get(sessionId);
    if (inFlight) return inFlight;

    const refresh = (async () => {
      const stored = this.store.get(sessionId);
      if (!stored) throw new AuthHttpError(401, 'The account session is not stored.');
      try {
        const bundle = await this.authRequest('/api/v1/auth/refresh', {
          refreshToken: stored.refreshToken,
        });
        if (bundle.account.sessionId !== sessionId) {
          throw new AuthHttpError(401, 'The refreshed session identity changed unexpectedly.');
        }
        await this.acceptBundle(bundle, false);
      } catch (error) {
        if (error instanceof AuthHttpError && (error.status === 401 || error.status === 403)) {
          this.accessTokens.delete(sessionId);
          await this.store.remove(sessionId);
          this.generation += 1;
          this.emitState();
        }
        throw error;
      }
    })().finally(() => this.refreshes.delete(sessionId));

    this.refreshes.set(sessionId, refresh);
    return refresh;
  }

  private async acceptBundle(
    bundle: ReturnType<typeof authSessionResponseSchema.parse>,
    activate = true,
  ): Promise<void> {
    if (activate) await this.store.put(bundle.account, bundle.refreshToken);
    else await this.store.updateCredentials(bundle.account, bundle.refreshToken);
    this.accessTokens.set(bundle.account.sessionId, {
      token: bundle.accessToken,
      expiresAt: Date.parse(bundle.account.accessExpiresAt),
    });
    if (activate) {
      this.generation += 1;
      this.emitState();
    }
  }

  private requireExpectedSession(expectedSessionId: string): string {
    const activeSessionId = this.store.activeId;
    if (activeSessionId === null) throw new AuthHttpError(401, 'Please sign in first.');
    if (activeSessionId !== expectedSessionId) throw staleAccountError();
    return activeSessionId;
  }

  private emitState(): void {
    this.onStateChanged(this.state());
  }

  private async authRequest(path: string, body: unknown) {
    const response = await this.rawRequest(path, { method: 'POST', body });
    if (response.status < 200 || response.status >= 300) {
      throw new AuthHttpError(response.status, responseMessage(response.body));
    }
    const parsed = authSessionResponseSchema.safeParse(response.body);
    if (!parsed.success) throw new Error('Authentication response failed contract validation.');
    return parsed.data;
  }

  private async rawRequest(
    path: string,
    options: {
      method: DesktopApiRequest['method'];
      body?: unknown;
      authorization?: string;
    },
  ): Promise<DesktopApiResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`${this.baseUrl.replace(/\/+$/, '')}${path}`, {
        method: options.method,
        cache: 'no-store',
        redirect: 'error',
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(options.authorization === undefined
            ? {}
            : { Authorization: `Bearer ${options.authorization}` }),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
      const text = await response.text();
      let body: unknown = null;
      if (text) {
        try {
          body = JSON.parse(text) as unknown;
        } catch {
          body = { message: 'The server returned a non-JSON response.' };
        }
      }
      const requestId = response.headers.get('x-request-id') ?? undefined;
      return {
        status: response.status,
        ...(requestId === undefined ? {} : { requestId }),
        body,
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

function validateBaseUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('VITE_API_BASE_URL must be a valid URL.');
  }
  const local =
    url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error('The desktop API must use HTTPS, except for a local development server.');
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('VITE_API_BASE_URL must contain only an origin.');
  }
}

function assertBusinessRequest(request: DesktopApiRequest): void {
  if (!UUID_PATTERN.test(request.expectedSessionId)) {
    throw new Error('expectedSessionId must be a UUID.');
  }
  const match = BUSINESS_ROUTES.find(({ pattern }) => pattern.test(request.path));
  if (!match || !match.methods.has(request.method)) {
    throw new Error('The requested desktop API operation is not allowed.');
  }
  if (
    request.body !== undefined &&
    Buffer.byteLength(JSON.stringify(request.body), 'utf8') > MAX_REQUEST_BYTES
  ) {
    throw new Error('The desktop API request is too large.');
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function staleAccountError(): Error {
  const error = new Error(
    'STALE_ACCOUNT: The desktop account changed before the request completed.',
  );
  error.name = 'StaleAccountError';
  return error;
}

function responseMessage(value: unknown): string {
  if (value && typeof value === 'object') {
    const message = Reflect.get(value, 'message');
    if (typeof message === 'string' && message.trim()) return message.slice(0, 500);
  }
  return 'Authentication request failed.';
}
