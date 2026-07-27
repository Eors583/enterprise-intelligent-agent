import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { EnvironmentVariables } from '../../../config/environment.js';
import {
  FeishuDirectoryError,
  type FeishuDirectoryDepartment,
  type FeishuDirectorySnapshot,
  type FeishuDirectoryUser,
} from './feishu-directory.models.js';

export { FeishuDirectoryError } from './feishu-directory.models.js';

const FEISHU_API_BASE_URL = 'https://open.feishu.cn';
const TOKEN_PATH = '/open-apis/auth/v3/tenant_access_token/internal';
const ROOT_DEPARTMENT_ID = '0';
const PAGE_SIZE = '50';
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_BASE_DELAY_MS = 250;
const DEFAULT_MAX_RETRY_DELAY_MS = 30_000;
const TOKEN_REFRESH_SKEW_MS = 5 * 60_000;
const TRANSIENT_PROVIDER_CODES = new Set([40003, 99991400]);
const EXPIRED_TOKEN_CODE = 99991663;

export type FeishuFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface FeishuDirectoryClientOptions {
  readonly enabled?: boolean;
  readonly tenantSlug?: string;
  readonly appId?: string;
  readonly appSecret?: string;
  readonly apiBaseUrl?: string;
  readonly fetchImpl?: FeishuFetch;
  readonly now?: () => number;
  readonly sleep?: (delayMs: number) => Promise<void>;
  readonly random?: () => number;
  readonly requestTimeoutMs?: number;
  /** Number of retries after the initial request. */
  readonly maxRetries?: number;
  readonly retryBaseDelayMs?: number;
  readonly maxRetryDelayMs?: number;
}

interface CachedToken {
  readonly value: string;
  readonly refreshAt: number;
}

interface HttpResult {
  readonly response: Response;
  readonly payload: unknown;
}

interface ProviderDepartment {
  readonly name: string;
  readonly openDepartmentId?: string;
  readonly parentDepartmentId?: string;
  readonly order?: string;
}

interface ProviderUserOrder {
  readonly departmentId: string;
  readonly departmentOrder: number;
  readonly primary: boolean;
}

interface ProviderUser {
  readonly externalId: string;
  readonly openId?: string;
  readonly unionId?: string;
  readonly name: string;
  readonly email?: string;
  readonly avatarUrl?: string;
  readonly active: boolean;
  readonly departmentIds: readonly string[];
  readonly orders: readonly ProviderUserOrder[];
  readonly employeeNumber?: string;
  readonly jobTitle?: string;
}

@Injectable()
export class FeishuDirectoryClient {
  private readonly enabled: boolean;
  private readonly tenantSlug: string | undefined;
  private readonly appId: string | undefined;
  private readonly appSecret: string | undefined;
  private readonly apiBaseUrl: string;
  private readonly fetchImpl: FeishuFetch;
  private readonly now: () => number;
  private readonly sleep: (delayMs: number) => Promise<void>;
  private readonly random: () => number;
  private readonly requestTimeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly maxRetryDelayMs: number;
  private cachedToken: CachedToken | undefined;
  private tokenRequest: Promise<CachedToken> | undefined;

  constructor(
    @Inject(ConfigService)
    configOrOptions: ConfigService<EnvironmentVariables, true> | FeishuDirectoryClientOptions,
  ) {
    const options = resolveOptions(configOrOptions);
    this.enabled = options.enabled ?? true;
    this.tenantSlug = nonEmpty(options.tenantSlug);
    this.appId = nonEmpty(options.appId);
    this.appSecret = nonEmpty(options.appSecret);
    this.apiBaseUrl = officialApiBaseUrl(options.apiBaseUrl);
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;
    this.requestTimeoutMs = boundedInteger(
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      1,
      120_000,
      'request timeout',
    );
    this.maxRetries = boundedInteger(
      options.maxRetries ?? DEFAULT_MAX_RETRIES,
      0,
      10,
      'maximum retries',
    );
    this.retryBaseDelayMs = boundedInteger(
      options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS,
      0,
      60_000,
      'retry base delay',
    );
    this.maxRetryDelayMs = boundedInteger(
      options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS,
      1,
      300_000,
      'maximum retry delay',
    );
  }

  isConfiguredForTenant(tenantSlug: string): boolean {
    return (
      this.isConfigured() &&
      tenantSlug.length > 0 &&
      tenantSlug === tenantSlug.trim() &&
      tenantSlug === this.tenantSlug
    );
  }

  async fetchSnapshot(): Promise<FeishuDirectorySnapshot> {
    this.requireConfigured();

    // Feishu's root-department detail endpoint can legitimately omit `name`
    // even when the application can read the complete directory. The root is
    // already represented by the tenant's local root org unit, so only use its
    // well-known ID when enumerating users and build the imported tree from the
    // descendant list (the same strategy used by Casdoor's Lark syncer).
    const departments = deduplicateDepartments(await this.fetchAllDepartments());
    const users = await this.fetchAllUsers([
      { externalId: ROOT_DEPARTMENT_ID, name: '', parentExternalId: null },
      ...departments,
    ]);
    return { departments, users };
  }

  async verifyConnection(): Promise<void> {
    this.requireConfigured();
    await this.tenantAccessToken(false);
  }

  private isConfigured(): boolean {
    return (
      this.enabled &&
      this.tenantSlug !== undefined &&
      this.appId !== undefined &&
      this.appSecret !== undefined
    );
  }

  private requireConfigured(): void {
    if (!this.isConfigured()) {
      throw new FeishuDirectoryError(
        'FEISHU_NOT_CONFIGURED',
        'Feishu directory synchronization is not configured.',
        false,
      );
    }
  }

  private async fetchAllDepartments(): Promise<readonly FeishuDirectoryDepartment[]> {
    try {
      return await this.fetchDepartmentPages(ROOT_DEPARTMENT_ID, true);
    } catch (error) {
      if (!(error instanceof FeishuDirectoryError) || error.providerCode !== 43010) throw error;
      return this.fetchDepartmentsBreadthFirst();
    }
  }

  private async fetchDepartmentsBreadthFirst(): Promise<readonly FeishuDirectoryDepartment[]> {
    const queue = [ROOT_DEPARTMENT_ID];
    const scheduled = new Set(queue);
    const departments = new Map<string, FeishuDirectoryDepartment>();

    while (queue.length > 0) {
      const parentId = queue.shift();
      if (parentId === undefined) break;
      const children = await this.fetchDepartmentPages(parentId, false);
      for (const child of children) {
        if (child.externalId === ROOT_DEPARTMENT_ID) continue;
        if (!departments.has(child.externalId)) departments.set(child.externalId, child);
        if (!scheduled.has(child.externalId)) {
          scheduled.add(child.externalId);
          queue.push(child.externalId);
        }
      }
    }

    return [...departments.values()];
  }

  private async fetchDepartmentPages(
    parentId: string,
    recursive: boolean,
  ): Promise<readonly FeishuDirectoryDepartment[]> {
    const departments: FeishuDirectoryDepartment[] = [];
    const pageTokens = new Set<string>();
    let pageToken: string | undefined;

    while (true) {
      const url = this.apiUrl(
        `/open-apis/contact/v3/departments/${encodeURIComponent(parentId)}/children`,
      );
      url.searchParams.set('department_id_type', 'open_department_id');
      url.searchParams.set('user_id_type', 'user_id');
      url.searchParams.set('fetch_child', String(recursive));
      url.searchParams.set('page_size', PAGE_SIZE);
      if (pageToken !== undefined) url.searchParams.set('page_token', pageToken);

      const payload = await this.authenticatedGet(url);
      const page = parsePage(payload.data, parseProviderDepartment);
      departments.push(...page.items.map(normalizeDepartment));
      pageToken = nextPageToken(page, pageTokens);
      if (pageToken === undefined) return departments;
    }
  }

  private async fetchAllUsers(
    departments: readonly FeishuDirectoryDepartment[],
  ): Promise<readonly FeishuDirectoryUser[]> {
    const users = new Map<string, FeishuDirectoryUser>();
    for (const departmentId of new Set(departments.map((department) => department.externalId))) {
      const departmentUsers = await this.fetchUserPages(departmentId);
      for (const providerUser of departmentUsers) {
        const user = normalizeUser(providerUser);
        const existing = users.get(user.externalId);
        users.set(user.externalId, existing === undefined ? user : mergeUser(existing, user));
      }
    }
    return [...users.values()];
  }

  private async fetchUserPages(departmentId: string): Promise<readonly ProviderUser[]> {
    const users: ProviderUser[] = [];
    const pageTokens = new Set<string>();
    let pageToken: string | undefined;

    while (true) {
      const url = this.apiUrl('/open-apis/contact/v3/users/find_by_department');
      url.searchParams.set('department_id', departmentId);
      url.searchParams.set('department_id_type', 'open_department_id');
      url.searchParams.set('user_id_type', 'user_id');
      url.searchParams.set('page_size', PAGE_SIZE);
      if (pageToken !== undefined) url.searchParams.set('page_token', pageToken);

      const payload = await this.authenticatedGet(url);
      const page = parsePage(payload.data, parseProviderUser);
      users.push(...page.items);
      pageToken = nextPageToken(page, pageTokens);
      if (pageToken === undefined) return users;
    }
  }

  private async authenticatedGet(url: URL): Promise<Record<string, unknown>> {
    let token = await this.tenantAccessToken(false);
    try {
      return await this.requestJson(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (error) {
      if (!(error instanceof FeishuDirectoryError) || error.providerCode !== EXPIRED_TOKEN_CODE) {
        throw error;
      }
    }

    this.invalidateToken(token);
    token = await this.tenantAccessToken(true);
    return this.requestJson(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
  }

  private async tenantAccessToken(forceRefresh: boolean): Promise<string> {
    if (forceRefresh) this.cachedToken = undefined;
    const cached = this.cachedToken;
    if (cached !== undefined && this.now() < cached.refreshAt) return cached.value;
    if (this.tokenRequest !== undefined) return (await this.tokenRequest).value;

    const request = this.requestTenantAccessToken();
    this.tokenRequest = request;
    try {
      const token = await request;
      this.cachedToken = token;
      return token.value;
    } finally {
      if (this.tokenRequest === request) this.tokenRequest = undefined;
    }
  }

  private async requestTenantAccessToken(): Promise<CachedToken> {
    const payload = await this.requestJson(this.apiUrl(TOKEN_PATH), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
    });
    const value = requiredNonEmptyString(payload.tenant_access_token);
    const expiresInSeconds = requiredPositiveInteger(payload.expire);
    const lifetimeMs = expiresInSeconds * 1_000;
    const refreshSkew = Math.min(TOKEN_REFRESH_SKEW_MS, Math.floor(lifetimeMs / 2));
    return { value, refreshAt: this.now() + lifetimeMs - refreshSkew };
  }

  private invalidateToken(expectedValue: string): void {
    if (this.cachedToken?.value === expectedValue) this.cachedToken = undefined;
  }

  private async requestJson(url: URL, init: RequestInit): Promise<Record<string, unknown>> {
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      let result: HttpResult;
      try {
        result = await this.fetchOnce(url, init);
      } catch (error) {
        const safeError =
          error instanceof FeishuDirectoryError
            ? error
            : new FeishuDirectoryError(
                'FEISHU_NETWORK_ERROR',
                'Feishu directory request failed.',
                true,
              );
        if (safeError.retryable && attempt < this.maxRetries) {
          await this.waitBeforeRetry(attempt);
          continue;
        }
        throw safeError;
      }

      const payload = isRecord(result.payload) ? result.payload : undefined;
      const providerCode = safeInteger(payload?.code);
      const retryable =
        result.response.status === 408 ||
        result.response.status === 429 ||
        result.response.status >= 500 ||
        (providerCode !== undefined && TRANSIENT_PROVIDER_CODES.has(providerCode));
      if (retryable && attempt < this.maxRetries) {
        await this.waitBeforeRetry(attempt, result.response);
        continue;
      }

      if (payload === undefined || providerCode === undefined) {
        if (!result.response.ok) throw httpError(result.response.status, retryable);
        throw invalidResponse();
      }
      if (!result.response.ok || providerCode !== 0) {
        if (providerCode !== 0)
          throw providerError(providerCode, result.response.status, retryable);
        throw httpError(result.response.status, retryable);
      }
      return payload;
    }

    throw new FeishuDirectoryError(
      'FEISHU_NETWORK_ERROR',
      'Feishu directory request failed.',
      true,
    );
  }

  private async fetchOnce(url: URL, init: RequestInit): Promise<HttpResult> {
    const controller = new AbortController();
    let timedOut = false;
    let rejectTimeout: ((error: FeishuDirectoryError) => void) | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      rejectTimeout = reject;
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      const error = timeoutError();
      controller.abort(error);
      rejectTimeout?.(error);
    }, this.requestTimeoutMs);
    timeout.unref();

    const operation = Promise.resolve()
      .then(() =>
        this.fetchImpl(url, {
          ...init,
          redirect: 'error',
          cache: 'no-store',
          signal: controller.signal,
          headers: {
            Accept: 'application/json',
            ...init.headers,
          },
        }),
      )
      .then(async (response): Promise<HttpResult> => {
        let payload: unknown;
        try {
          payload = await response.json();
        } catch {
          payload = undefined;
        }
        return { response, payload };
      })
      .catch((_error: unknown) => {
        if (timedOut) throw timeoutError();
        throw new FeishuDirectoryError(
          'FEISHU_NETWORK_ERROR',
          'Feishu directory request failed.',
          true,
        );
      });

    try {
      return await Promise.race([operation, timeoutPromise]);
    } finally {
      clearTimeout(timeout);
    }
  }

  private async waitBeforeRetry(attempt: number, response?: Response): Promise<void> {
    const resetSeconds = response === undefined ? undefined : retryResetSeconds(response);
    const exponential = this.retryBaseDelayMs * 2 ** attempt;
    const jitter = Math.floor(this.random() * Math.max(1, this.retryBaseDelayMs));
    const requestedDelay = resetSeconds === undefined ? exponential + jitter : resetSeconds * 1_000;
    await this.sleep(Math.min(this.maxRetryDelayMs, requestedDelay));
  }

  private apiUrl(path: string): URL {
    return new URL(path, this.apiBaseUrl);
  }
}

interface ParsedPage<T> {
  readonly items: readonly T[];
  readonly hasMore: boolean;
  readonly pageToken?: string;
}

function parsePage<T>(value: unknown, parseItem: (value: unknown) => T): ParsedPage<T> {
  const data = requiredRecord(value);
  if (typeof data.has_more !== 'boolean') throw invalidResponse();
  // Feishu omits `items` entirely for an empty terminal page. Treat that
  // representation as an empty list, but keep rejecting a missing list when
  // the provider claims another page exists.
  const items = data.items === undefined && !data.has_more ? [] : data.items;
  if (!Array.isArray(items)) throw invalidResponse();
  const pageToken = optionalNonEmptyString(data.page_token);
  return {
    items: items.map((item) => parseItem(item)),
    hasMore: data.has_more,
    ...(pageToken === undefined ? {} : { pageToken }),
  };
}

function nextPageToken<T>(page: ParsedPage<T>, seen: Set<string>): string | undefined {
  if (!page.hasMore) return undefined;
  if (page.pageToken === undefined || seen.has(page.pageToken)) {
    throw new FeishuDirectoryError(
      'FEISHU_PAGINATION_INVALID',
      'Feishu returned an invalid pagination cursor.',
      false,
    );
  }
  seen.add(page.pageToken);
  return page.pageToken;
}

function parseProviderDepartment(value: unknown): ProviderDepartment {
  const item = requiredRecord(value);
  const name = requiredNonEmptyString(item.name);
  const openDepartmentId = optionalNonEmptyString(item.open_department_id);
  const parentDepartmentId = optionalNonEmptyString(item.parent_department_id);
  const order = optionalNonEmptyString(item.order);
  return {
    name,
    ...(openDepartmentId === undefined ? {} : { openDepartmentId }),
    ...(parentDepartmentId === undefined ? {} : { parentDepartmentId }),
    ...(order === undefined ? {} : { order }),
  };
}

function normalizeDepartment(department: ProviderDepartment): FeishuDirectoryDepartment {
  const externalId = department.openDepartmentId;
  if (externalId === undefined) throw requiredFieldMissing();
  if (department.parentDepartmentId === undefined) throw requiredFieldMissing();
  return {
    externalId,
    name: department.name,
    parentExternalId: department.parentDepartmentId,
    ...(department.order === undefined ? {} : { sortOrder: parseSortOrder(department.order) }),
  };
}

function parseProviderUser(value: unknown): ProviderUser {
  const item = requiredRecord(value);
  const status = requiredRecord(item.status);
  const departments = item.department_ids;
  if (!Array.isArray(departments) || !departments.every(isNonEmptyString)) {
    throw requiredFieldMissing();
  }
  const orders = item.orders;
  if (orders !== undefined && !Array.isArray(orders)) throw invalidResponse();

  const avatar = isRecord(item.avatar) ? item.avatar : undefined;
  const parsedOrders = (orders ?? []).map(parseProviderUserOrder);
  const isActivated = requiredBoolean(status.is_activated);
  const active =
    isActivated &&
    status.is_frozen !== true &&
    status.is_resigned !== true &&
    status.is_exited !== true &&
    status.is_unjoin !== true;
  const openId = optionalNonEmptyString(item.open_id);
  const unionId = optionalNonEmptyString(item.union_id);
  const email = optionalNonEmptyString(item.email);
  const avatarUrl = firstString(
    avatar?.avatar_origin,
    avatar?.avatar_640,
    avatar?.avatar_240,
    avatar?.avatar_72,
  );
  const employeeNumber = optionalNonEmptyString(item.employee_no);
  const jobTitle = optionalNonEmptyString(item.job_title);
  return {
    externalId: requiredNonEmptyString(item.user_id),
    ...(openId === undefined ? {} : { openId }),
    ...(unionId === undefined ? {} : { unionId }),
    name: requiredNonEmptyString(item.name),
    ...(email === undefined ? {} : { email }),
    ...(avatarUrl === undefined ? {} : { avatarUrl }),
    active,
    departmentIds: uniqueStrings(departments),
    orders: parsedOrders,
    ...(employeeNumber === undefined ? {} : { employeeNumber }),
    ...(jobTitle === undefined ? {} : { jobTitle }),
  };
}

function parseProviderUserOrder(value: unknown): ProviderUserOrder {
  const order = requiredRecord(value);
  const departmentOrder = safeInteger(order.department_order) ?? 0;
  return {
    departmentId: requiredNonEmptyString(order.department_id),
    departmentOrder,
    primary: order.is_primary_dept === true,
  };
}

function normalizeUser(user: ProviderUser): FeishuDirectoryUser {
  const primaryDepartmentExternalId = choosePrimaryDepartment(user);
  return {
    externalId: user.externalId,
    ...(user.openId === undefined ? {} : { openId: user.openId }),
    ...(user.unionId === undefined ? {} : { unionId: user.unionId }),
    name: user.name,
    ...(user.email === undefined ? {} : { email: user.email }),
    ...(user.avatarUrl === undefined ? {} : { avatarUrl: user.avatarUrl }),
    active: user.active,
    departmentExternalIds: user.departmentIds,
    ...(primaryDepartmentExternalId === undefined ? {} : { primaryDepartmentExternalId }),
    ...(user.employeeNumber === undefined ? {} : { employeeNumber: user.employeeNumber }),
    ...(user.jobTitle === undefined ? {} : { jobTitle: user.jobTitle }),
  };
}

function choosePrimaryDepartment(user: ProviderUser): string | undefined {
  const explicit = user.orders.find((order) => order.primary);
  if (explicit !== undefined) return explicit.departmentId;
  const ordered = [...user.orders].sort(
    (left, right) => right.departmentOrder - left.departmentOrder,
  );
  if (ordered[0] !== undefined) return ordered[0].departmentId;
  return user.departmentIds.length === 1 ? user.departmentIds[0] : undefined;
}

function mergeUser(
  current: FeishuDirectoryUser,
  incoming: FeishuDirectoryUser,
): FeishuDirectoryUser {
  return {
    externalId: current.externalId,
    ...((current.openId ?? incoming.openId) === undefined
      ? {}
      : { openId: current.openId ?? incoming.openId }),
    ...((current.unionId ?? incoming.unionId) === undefined
      ? {}
      : { unionId: current.unionId ?? incoming.unionId }),
    name: current.name,
    ...((current.email ?? incoming.email) === undefined
      ? {}
      : { email: current.email ?? incoming.email }),
    ...((current.avatarUrl ?? incoming.avatarUrl) === undefined
      ? {}
      : { avatarUrl: current.avatarUrl ?? incoming.avatarUrl }),
    active: current.active && incoming.active,
    departmentExternalIds: uniqueStrings([
      ...current.departmentExternalIds,
      ...incoming.departmentExternalIds,
    ]),
    ...((current.primaryDepartmentExternalId ?? incoming.primaryDepartmentExternalId) === undefined
      ? {}
      : {
          primaryDepartmentExternalId:
            current.primaryDepartmentExternalId ?? incoming.primaryDepartmentExternalId,
        }),
    ...((current.employeeNumber ?? incoming.employeeNumber) === undefined
      ? {}
      : { employeeNumber: current.employeeNumber ?? incoming.employeeNumber }),
    ...((current.jobTitle ?? incoming.jobTitle) === undefined
      ? {}
      : { jobTitle: current.jobTitle ?? incoming.jobTitle }),
  };
}

function deduplicateDepartments(
  departments: readonly FeishuDirectoryDepartment[],
): readonly FeishuDirectoryDepartment[] {
  const unique = new Map<string, FeishuDirectoryDepartment>();
  for (const department of departments) {
    if (!unique.has(department.externalId)) unique.set(department.externalId, department);
  }
  return [...unique.values()];
}

function requiredRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw invalidResponse();
  return value;
}

function requiredNonEmptyString(value: unknown): string {
  if (!isNonEmptyString(value)) throw requiredFieldMissing();
  return value;
}

function optionalNonEmptyString(value: unknown): string | undefined {
  return isNonEmptyString(value) ? value : undefined;
}

function firstString(...values: readonly unknown[]): string | undefined {
  return values.find(isNonEmptyString) as string | undefined;
}

function requiredBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw requiredFieldMissing();
  return value;
}

function requiredPositiveInteger(value: unknown): number {
  const integer = safeInteger(value);
  if (integer === undefined || integer <= 0) throw invalidResponse();
  return integer;
}

function safeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function nonEmpty(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  return normalized.length === 0 ? undefined : normalized;
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function parseSortOrder(value: string | undefined): number {
  if (value === undefined || !/^\d+$/.test(value)) return 0;
  const parsed = BigInt(value);
  return parsed > 2_147_483_647n ? 2_147_483_647 : Number(parsed);
}

function retryResetSeconds(response: Response): number | undefined {
  const value = response.headers.get('x-ogw-ratelimit-reset');
  if (value === null || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`Feishu ${label} is invalid.`);
  }
  return value;
}

function resolveOptions(
  source: ConfigService<EnvironmentVariables, true> | FeishuDirectoryClientOptions,
): FeishuDirectoryClientOptions {
  if (!(source instanceof ConfigService)) return source;
  const tenantSlug = source.get('FEISHU_DIRECTORY_TARGET_TENANT_SLUG', { infer: true });
  const appId = source.get('FEISHU_APP_ID', { infer: true });
  const appSecret = source.get('FEISHU_APP_SECRET', { infer: true });
  return {
    enabled: source.get('FEISHU_DIRECTORY_SYNC_ENABLED', { infer: true }),
    ...(tenantSlug === undefined ? {} : { tenantSlug }),
    ...(appId === undefined ? {} : { appId }),
    ...(appSecret === undefined ? {} : { appSecret }),
    apiBaseUrl: source.get('FEISHU_API_BASE_URL', { infer: true }),
    requestTimeoutMs: source.get('FEISHU_HTTP_TIMEOUT_MS', { infer: true }),
  };
}

function officialApiBaseUrl(value: string | undefined): string {
  const configured = value ?? FEISHU_API_BASE_URL;
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new TypeError('Feishu API base URL is invalid.');
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'open.feishu.cn' ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== '' ||
    (url.pathname !== '' && url.pathname !== '/') ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new TypeError('Feishu API base URL must use the official HTTPS origin.');
  }
  return FEISHU_API_BASE_URL;
}

function providerError(
  providerCode: number,
  httpStatus: number,
  retryable: boolean,
): FeishuDirectoryError {
  return new FeishuDirectoryError(
    `FEISHU_API_${providerCode}`,
    'Feishu rejected the directory request.',
    retryable,
    providerCode,
    httpStatus,
  );
}

function httpError(status: number, retryable: boolean): FeishuDirectoryError {
  return new FeishuDirectoryError(
    `FEISHU_HTTP_${status}`,
    'Feishu rejected the directory request.',
    retryable,
    undefined,
    status,
  );
}

function invalidResponse(): FeishuDirectoryError {
  return new FeishuDirectoryError(
    'FEISHU_INVALID_RESPONSE',
    'Feishu returned an invalid directory response.',
    false,
  );
}

function requiredFieldMissing(): FeishuDirectoryError {
  return new FeishuDirectoryError(
    'FEISHU_REQUIRED_FIELD_MISSING',
    'Feishu did not return a required directory field.',
    false,
  );
}

function timeoutError(): FeishuDirectoryError {
  return new FeishuDirectoryError('FEISHU_TIMEOUT', 'Feishu directory request timed out.', true);
}

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, delayMs);
    timeout.unref();
  });
}
