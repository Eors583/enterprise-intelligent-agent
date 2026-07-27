import { vi } from 'vitest';

import { FeishuDirectoryClient, type FeishuFetch } from './feishu-directory.client.js';
import { FeishuDirectoryError } from './feishu-directory.models.js';

describe('FeishuDirectoryClient', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('paginates departments and every direct-user list, then normalizes and deduplicates users', async () => {
    const requestedUrls: URL[] = [];
    const fetchImpl = vi.fn<FeishuFetch>(async (input) => {
      const url = toUrl(input);
      requestedUrls.push(url);
      if (url.pathname === TOKEN_PATH) return tokenResponse('t-cached');
      if (url.pathname.endsWith('/children')) {
        if (url.searchParams.get('page_token') === null) {
          return pageResponse(
            [department('od-product', '产品部', '0', '10')],
            true,
            'department+/cursor',
          );
        }
        expect(url.searchParams.get('page_token')).toBe('department+/cursor');
        return pageResponse([department('od-engineering', '研发部', '0', '20')]);
      }
      if (url.pathname === USERS_PATH) {
        const departmentId = url.searchParams.get('department_id');
        if (departmentId === '0') return pageResponse([activeUser('u-1')]);
        if (departmentId === 'od-product' && url.searchParams.get('page_token') === null) {
          return pageResponse([activeUser('u-1')], true, 'users/cursor');
        }
        if (departmentId === 'od-product') {
          return pageResponse([
            user({
              id: 'u-2',
              name: '李四',
              departments: ['od-product', 'od-engineering'],
              activated: true,
              frozen: true,
              primary: 'od-engineering',
            }),
          ]);
        }
        if (departmentId === 'od-engineering') {
          return pageResponse([
            user({
              id: 'u-2',
              name: '李四',
              departments: ['od-product', 'od-engineering'],
              activated: true,
              frozen: true,
              primary: 'od-engineering',
            }),
          ]);
        }
      }
      throw new Error(`Unexpected route: ${url.pathname}`);
    });
    const client = createClient(fetchImpl);

    const snapshot = await client.fetchSnapshot();

    expect(snapshot.departments).toEqual([
      {
        externalId: 'od-product',
        name: '产品部',
        parentExternalId: '0',
        sortOrder: 10,
      },
      {
        externalId: 'od-engineering',
        name: '研发部',
        parentExternalId: '0',
        sortOrder: 20,
      },
    ]);
    expect(snapshot.users).toHaveLength(2);
    expect(snapshot.users[0]).toEqual({
      externalId: 'u-1',
      openId: 'ou-u-1',
      unionId: 'on-u-1',
      name: '张三',
      email: 'zhangsan@example.com',
      avatarUrl: 'https://images.example/avatar.png',
      active: true,
      departmentExternalIds: ['0', 'od-product'],
      primaryDepartmentExternalId: 'od-product',
      employeeNumber: 'E-001',
      jobTitle: '产品经理',
    });
    expect(snapshot.users[1]).toMatchObject({
      externalId: 'u-2',
      active: false,
      departmentExternalIds: ['od-product', 'od-engineering'],
      primaryDepartmentExternalId: 'od-engineering',
    });
    expect(
      requestedUrls
        .filter((url) => url.pathname.endsWith('/children'))
        .map((url) => ({
          recursive: url.searchParams.get('fetch_child'),
          size: url.searchParams.get('page_size'),
          userIdType: url.searchParams.get('user_id_type'),
        })),
    ).toEqual([
      { recursive: 'true', size: '50', userIdType: 'user_id' },
      { recursive: 'true', size: '50', userIdType: 'user_id' },
    ]);
    expect(
      requestedUrls
        .filter((url) => url.pathname === USERS_PATH)
        .map((url) => url.searchParams.get('department_id')),
    ).toEqual(['0', 'od-product', 'od-product', 'od-engineering']);
  });

  it('caches the tenant token and exposes tenant-scoped configuration state', async () => {
    let now = 1_000;
    let tokenRequests = 0;
    const fetchImpl = vi.fn<FeishuFetch>(async (input) => {
      const url = toUrl(input);
      if (url.pathname === TOKEN_PATH) {
        tokenRequests += 1;
        return tokenResponse(`t-${tokenRequests}`);
      }
      return pageResponse([]);
    });
    const client = createClient(fetchImpl, { now: () => now });

    expect(client.isConfiguredForTenant('future-collaboration')).toBe(true);
    expect(client.isConfiguredForTenant('different-tenant')).toBe(false);
    await client.fetchSnapshot();
    await client.fetchSnapshot();
    expect(tokenRequests).toBe(1);

    now += 7_000_000;
    await client.fetchSnapshot();
    expect(tokenRequests).toBe(2);
  });

  it('accepts Feishu empty terminal pages that omit the items field', async () => {
    const fetchImpl = vi.fn<FeishuFetch>(async (input) => {
      const url = toUrl(input);
      if (url.pathname === TOKEN_PATH) return tokenResponse('t-one');
      if (url.pathname.endsWith('/children')) {
        return pageResponse([department('od-empty', '空部门', '0')]);
      }
      if (url.pathname === USERS_PATH) {
        return jsonResponse({ code: 0, msg: 'success', data: { has_more: false } });
      }
      throw new Error(`Unexpected route: ${url.pathname}`);
    });

    await expect(createClient(fetchImpl).fetchSnapshot()).resolves.toEqual({
      departments: [
        { externalId: 'od-empty', name: '空部门', parentExternalId: '0', sortOrder: 0 },
      ],
      users: [],
    });
  });

  it('rejects a missing items field when Feishu claims another page exists', async () => {
    const fetchImpl = vi.fn<FeishuFetch>(async (input) => {
      const url = toUrl(input);
      if (url.pathname === TOKEN_PATH) return tokenResponse('t-one');
      return jsonResponse({
        code: 0,
        msg: 'success',
        data: { has_more: true, page_token: 'next' },
      });
    });

    await expect(createClient(fetchImpl).fetchSnapshot()).rejects.toMatchObject({
      code: 'FEISHU_INVALID_RESPONSE',
    });
  });

  it('falls back from recursive code 43010 to fully paginated breadth-first traversal', async () => {
    const breadthFirstParents: string[] = [];
    const fetchImpl = vi.fn<FeishuFetch>(async (input) => {
      const url = toUrl(input);
      if (url.pathname === TOKEN_PATH) return tokenResponse('t-one');
      if (url.pathname === USERS_PATH) return pageResponse([]);
      if (url.pathname.endsWith('/children')) {
        const parent = decodeURIComponent(url.pathname.split('/').at(-2) ?? '');
        const recursive = url.searchParams.get('fetch_child') === 'true';
        if (recursive) return jsonResponse({ code: 43010, msg: 'big dept forbid recursion' });
        breadthFirstParents.push(parent);
        if (parent === '0' && url.searchParams.get('page_token') === null) {
          return pageResponse([department('od-a', 'A', '0')], true, 'next-root-page');
        }
        if (parent === '0') return pageResponse([department('od-b', 'B', '0')]);
        if (parent === 'od-a') return pageResponse([department('od-c', 'C', 'od-a')]);
        return pageResponse([]);
      }
      throw new Error('Unexpected route');
    });

    const snapshot = await createClient(fetchImpl).fetchSnapshot();

    expect(snapshot.departments.map((department) => department.externalId)).toEqual([
      'od-a',
      'od-b',
      'od-c',
    ]);
    expect(breadthFirstParents).toEqual(['0', '0', 'od-a', 'od-b', 'od-c']);
  });

  it('refreshes an expired tenant token exactly once and replays with the new token', async () => {
    let tokenRequests = 0;
    const departmentAuthorization: string[] = [];
    const fetchImpl = vi.fn<FeishuFetch>(async (input, init) => {
      const url = toUrl(input);
      if (url.pathname === TOKEN_PATH) {
        tokenRequests += 1;
        return tokenResponse(tokenRequests === 1 ? 't-old' : 't-new');
      }
      if (url.pathname.endsWith('/children')) {
        const authorization = new Headers(init?.headers).get('Authorization') ?? '';
        departmentAuthorization.push(authorization);
        if (authorization === 'Bearer t-old') {
          return jsonResponse(
            { code: 99991663, msg: 'expired credential value must not be retained' },
            401,
          );
        }
        return pageResponse([]);
      }
      return pageResponse([]);
    });

    await expect(createClient(fetchImpl).fetchSnapshot()).resolves.toMatchObject({ users: [] });
    expect(tokenRequests).toBe(2);
    expect(departmentAuthorization).toEqual(['Bearer t-old', 'Bearer t-new']);
  });

  it('retries HTTP 5xx and 429 with the official reset delay', async () => {
    const delays: number[] = [];
    let departmentAttempts = 0;
    let userAttempts = 0;
    const fetchImpl = vi.fn<FeishuFetch>(async (input) => {
      const url = toUrl(input);
      if (url.pathname === TOKEN_PATH) return tokenResponse('t-one');
      if (url.pathname.endsWith('/children')) {
        departmentAttempts += 1;
        return departmentAttempts === 1
          ? jsonResponse({ code: 5000, msg: 'internal' }, 500)
          : pageResponse([]);
      }
      if (url.pathname === USERS_PATH) {
        userAttempts += 1;
        return userAttempts === 1
          ? jsonResponse({ code: 99991400, msg: 'limited' }, 429, {
              'x-ogw-ratelimit-reset': '2',
            })
          : pageResponse([]);
      }
      return pageResponse([]);
    });

    await createClient(fetchImpl, {
      sleep: async (delay) => {
        delays.push(delay);
      },
      random: () => 0,
    }).fetchSnapshot();

    expect(departmentAttempts).toBe(2);
    expect(userAttempts).toBe(2);
    expect(delays).toEqual([250, 2_000]);
  });

  it('bounds timeout retries and never exposes credentials or provider messages', async () => {
    vi.useFakeTimers();
    const appSecret = 'super-secret-value';
    let departmentAttempts = 0;
    const fetchImpl = vi.fn<FeishuFetch>(async (input) => {
      const url = toUrl(input);
      if (url.pathname === TOKEN_PATH) return tokenResponse('t-sensitive-token');
      if (url.pathname.endsWith('/children')) {
        departmentAttempts += 1;
        return new Promise<Response>(() => undefined);
      }
      throw new Error(`must not expose ${appSecret}`);
    });
    const client = createClient(fetchImpl, {
      appSecret,
      requestTimeoutMs: 100,
      maxRetries: 2,
      sleep: async () => undefined,
    });
    const pending = client.fetchSnapshot();
    const rejection = expect(pending).rejects.toMatchObject({
      code: 'FEISHU_TIMEOUT',
      retryable: true,
    });

    await vi.runAllTimersAsync();
    await rejection;
    expect(departmentAttempts).toBe(3);
    await pending.catch((error: unknown) => {
      expect(String(error)).not.toContain(appSecret);
      expect(String(error)).not.toContain('t-sensitive-token');
    });
  });

  it('checks a non-zero business code even on HTTP 200 and exposes only a safe code', async () => {
    const appSecret = 'never-print-this-secret';
    const fetchImpl = vi.fn<FeishuFetch>(async (input) => {
      const url = toUrl(input);
      if (url.pathname === TOKEN_PATH) return tokenResponse('t-secret-token');
      return jsonResponse({
        code: 40004,
        msg: `no authority ${appSecret} t-secret-token`,
      });
    });

    const error = await createClient(fetchImpl, { appSecret })
      .fetchSnapshot()
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(FeishuDirectoryError);
    expect(error).toMatchObject({
      code: 'FEISHU_API_40004',
      providerCode: 40004,
      retryable: false,
    });
    expect(String(error)).not.toContain(appSecret);
    expect(String(error)).not.toContain('t-secret-token');
    expect(JSON.stringify(error)).not.toContain(appSecret);
  });

  it('fails closed when a required field scope is missing', async () => {
    const fetchImpl = vi.fn<FeishuFetch>(async (input) => {
      const url = toUrl(input);
      if (url.pathname === TOKEN_PATH) return tokenResponse('t-one');
      if (url.pathname.endsWith('/children')) return pageResponse([]);
      return pageResponse([
        {
          user_id: 'u-1',
          name: '没有组织权限字段的用户',
          status: { is_activated: true },
        },
      ]);
    });

    await expect(createClient(fetchImpl).fetchSnapshot()).rejects.toMatchObject({
      code: 'FEISHU_REQUIRED_FIELD_MISSING',
    });
  });

  it('fails closed instead of flattening a department whose parent field is missing', async () => {
    const fetchImpl = vi.fn<FeishuFetch>(async (input) => {
      const url = toUrl(input);
      if (url.pathname === TOKEN_PATH) return tokenResponse('t-one');
      if (url.pathname.endsWith('/children')) {
        return pageResponse([{ name: '缺少父部门', open_department_id: 'od-orphan' }]);
      }
      return pageResponse([]);
    });

    await expect(createClient(fetchImpl).fetchSnapshot()).rejects.toMatchObject({
      code: 'FEISHU_REQUIRED_FIELD_MISSING',
    });
  });

  it('clamps provider sort order to the PostgreSQL integer range', async () => {
    const fetchImpl = vi.fn<FeishuFetch>(async (input) => {
      const url = toUrl(input);
      if (url.pathname === TOKEN_PATH) return tokenResponse('t-one');
      if (url.pathname.endsWith('/children')) {
        return pageResponse([department('od-large-order', '大序号部门', '0', '999999999999999')]);
      }
      return pageResponse([]);
    });

    const snapshot = await createClient(fetchImpl).fetchSnapshot();
    expect(snapshot.departments[0]?.sortOrder).toBe(2_147_483_647);
  });
});

const TOKEN_PATH = '/open-apis/auth/v3/tenant_access_token/internal';
const USERS_PATH = '/open-apis/contact/v3/users/find_by_department';

function createClient(
  fetchImpl: FeishuFetch,
  overrides: Partial<{
    tenantSlug: string;
    appId: string;
    appSecret: string;
    now: () => number;
    sleep: (delayMs: number) => Promise<void>;
    random: () => number;
    requestTimeoutMs: number;
    maxRetries: number;
  }> = {},
): FeishuDirectoryClient {
  return new FeishuDirectoryClient({
    tenantSlug: overrides.tenantSlug ?? 'future-collaboration',
    appId: overrides.appId ?? 'cli_test_app',
    appSecret: overrides.appSecret ?? 'test-secret',
    fetchImpl,
    ...(overrides.now === undefined ? {} : { now: overrides.now }),
    ...(overrides.sleep === undefined ? {} : { sleep: overrides.sleep }),
    ...(overrides.random === undefined ? {} : { random: overrides.random }),
    ...(overrides.requestTimeoutMs === undefined
      ? {}
      : { requestTimeoutMs: overrides.requestTimeoutMs }),
    ...(overrides.maxRetries === undefined ? {} : { maxRetries: overrides.maxRetries }),
  });
}

function toUrl(input: string | URL | Request): URL {
  if (input instanceof Request) return new URL(input.url);
  return new URL(String(input));
}

function tokenResponse(token: string): Response {
  return jsonResponse({ code: 0, msg: 'ok', tenant_access_token: token, expire: 7200 });
}

function pageResponse(items: readonly unknown[], hasMore = false, pageToken?: string): Response {
  return jsonResponse({
    code: 0,
    msg: 'success',
    data: {
      items,
      has_more: hasMore,
      ...(pageToken === undefined ? {} : { page_token: pageToken }),
    },
  });
}

function department(id: string, name: string, parentId: string, order = '0'): unknown {
  return {
    open_department_id: id,
    name,
    parent_department_id: parentId,
    order,
  };
}

function activeUser(id: string): unknown {
  return user({
    id,
    name: '张三',
    departments: ['0', 'od-product'],
    activated: true,
    primary: 'od-product',
    includeDetails: true,
  });
}

function user(options: {
  readonly id: string;
  readonly name: string;
  readonly departments: readonly string[];
  readonly activated: boolean;
  readonly frozen?: boolean;
  readonly primary?: string;
  readonly includeDetails?: boolean;
}): unknown {
  return {
    user_id: options.id,
    open_id: `ou-${options.id}`,
    union_id: `on-${options.id}`,
    name: options.name,
    status: {
      is_activated: options.activated,
      is_frozen: options.frozen ?? false,
      is_resigned: false,
      is_exited: false,
      is_unjoin: false,
    },
    department_ids: options.departments,
    orders:
      options.primary === undefined
        ? []
        : options.departments.map((departmentId, index) => ({
            department_id: departmentId,
            department_order: index + 1,
            is_primary_dept: departmentId === options.primary,
          })),
    ...(options.includeDetails === true
      ? {
          email: 'zhangsan@example.com',
          avatar: { avatar_origin: 'https://images.example/avatar.png' },
          employee_no: 'E-001',
          job_title: '产品经理',
        }
      : {}),
  };
}

function jsonResponse(
  value: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}
