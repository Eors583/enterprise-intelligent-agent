import type { ConfigService } from '@nestjs/config';

import type { EnvironmentVariables } from '../../../config/environment.js';
import type { AuthPrismaService } from '../../../database/auth-prisma.service.js';
import {
  LoginAttemptLimiter,
  LoginRateLimitExceededException,
} from './login-attempt-limiter.service.js';

describe('LoginAttemptLimiter', () => {
  it('uses opaque stable account/network buckets and never embeds the identity', () => {
    const limiter = createLimiter({ networkEnabled: true }).limiter;
    const first = limiter.createContext({
      tenantSlug: ' Example-Tenant ',
      email: ' User@Example.test ',
      clientAddress: '127.0.0.1',
    });
    const second = limiter.createContext({
      tenantSlug: 'example-tenant',
      email: 'user@example.test',
      clientAddress: '127.0.0.1',
    });

    expect(first).toEqual(second);
    expect(first.accountKeyHash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.accountKeyHash).not.toContain('example');
    expect(first.networkKeyHash).toMatch(/^[a-f0-9]{64}$/);

    const anotherTenant = limiter.createContext({
      tenantSlug: 'another-tenant',
      email: 'someone-else@example.test',
      clientAddress: '127.0.0.1',
    });
    expect(anotherTenant.accountKeyHash).not.toBe(first.accountKeyHash);
    expect(anotherTenant.networkKeyHash).toBe(first.networkKeyHash);
  });

  it('routes every missing client address into one opaque fail-closed network bucket', () => {
    const limiter = createLimiter({ networkEnabled: true }).limiter;
    const first = limiter.createContext({ tenantSlug: 'one', email: 'one@example.test' });
    const second = limiter.createContext({
      tenantSlug: 'two',
      email: 'two@example.test',
      clientAddress: '   ',
    });

    expect(first.networkKeyHash).toMatch(/^[a-f0-9]{64}$/);
    expect(second.networkKeyHash).toBe(first.networkKeyHash);
  });

  it('atomically reserves an account attempt before password verification', async () => {
    const { limiter, query } = createLimiter({ queryRows: [{ blocked: false }] });
    const context = limiter.createContext({
      tenantSlug: 'tenant',
      email: 'user@example.test',
      clientAddress: '10.0.0.8',
    });

    await expect(limiter.beginAttempt(context)).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledOnce();
  });

  it('checks the global network bucket before allocating an account bucket', async () => {
    const { limiter, query } = createLimiter({
      networkEnabled: true,
      queryRows: [{ blocked: true }],
    });
    const context = limiter.createContext({
      tenantSlug: 'tenant',
      email: 'user@example.test',
      clientAddress: '10.0.0.8',
    });

    await expect(limiter.beginAttempt(context)).rejects.toBeInstanceOf(
      LoginRateLimitExceededException,
    );
    expect(query).toHaveBeenCalledOnce();
    expect((query.mock.calls[0]![0] as { values: readonly unknown[] }).values).toContain('NETWORK');
  });

  it('reserves the network and account buckets in that order when the network is allowed', async () => {
    const { limiter, query } = createLimiter({
      networkEnabled: true,
      queryRows: [[{ blocked: false }], [{ blocked: false }]],
    });
    const context = limiter.createContext({
      tenantSlug: 'tenant',
      email: 'user@example.test',
      clientAddress: '10.0.0.8',
    });

    await expect(limiter.beginAttempt(context)).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledTimes(2);
    const values = query.mock.calls.map(
      ([statement]) => (statement as { values: readonly unknown[] }).values,
    );
    expect(values[0]).toContain('NETWORK');
    expect(values[1]).toContain('ACCOUNT');
  });

  it('fails closed without inserting a candidate when a scope capacity is exhausted', async () => {
    const { limiter, query, execute } = createLimiter({ queryRows: [[], [], []] });
    const context = limiter.createContext({ tenantSlug: 'tenant', email: 'random@example.test' });

    await expect(limiter.beginAttempt(context)).rejects.toBeInstanceOf(
      LoginRateLimitExceededException,
    );
    expect(query).toHaveBeenCalledTimes(3);
    expect(execute).toHaveBeenCalledOnce();
    const insertSql = (query.mock.calls[2]![0] as { strings: readonly string[] }).strings.join(' ');
    expect(insertSql).toContain('SELECT count(*) <');
  });

  it('clears the account bucket but only rolls back one shared network reservation', async () => {
    const { limiter, execute } = createLimiter({ networkEnabled: true });
    const context = limiter.createContext({
      tenantSlug: 'tenant',
      email: 'user@example.test',
      clientAddress: '10.0.0.8',
    });

    await limiter.clearSuccessfulAttempt(context);

    expect(execute).toHaveBeenCalledTimes(3);
    const statements = execute.mock.calls.map(([statement]) =>
      (statement as { strings: readonly string[] }).strings.join(' '),
    );
    expect(statements[0]).toContain('DELETE FROM public."auth_login_rate_limits"');
    expect(statements[1]).toContain('SET "failure_count" = GREATEST("failure_count" - 1, 0)');
    expect(statements[2]).toContain('AND "failure_count" = 0');
  });

  it('does not touch persistence when the development switch is disabled', async () => {
    const { limiter, query, execute } = createLimiter({ enabled: false });
    const context = limiter.createContext({ tenantSlug: 'tenant', email: 'user@example.test' });

    await limiter.beginAttempt(context);
    await limiter.clearSuccessfulAttempt(context);

    expect(query).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
});

function createLimiter(
  options: {
    enabled?: boolean;
    networkEnabled?: boolean;
    queryRows?: unknown | unknown[];
  } = {},
) {
  const query = vi.fn();
  if (
    Array.isArray(options.queryRows) &&
    options.queryRows.length > 0 &&
    Array.isArray(options.queryRows[0])
  ) {
    for (const rows of options.queryRows) query.mockResolvedValueOnce(rows);
  } else {
    query.mockResolvedValue(options.queryRows ?? []);
  }
  const execute = vi.fn().mockResolvedValue(1);
  const transaction = { $queryRaw: query, $executeRaw: execute };
  const prisma = {
    enabled: true,
    withAuth: <T>(operation: (value: typeof transaction) => Promise<T>) => operation(transaction),
  } as unknown as AuthPrismaService;
  const values: Record<string, unknown> = {
    AUTH_LOGIN_RATE_LIMIT_ENABLED: options.enabled ?? true,
    AUTH_LOGIN_RATE_LIMIT_NETWORK_ENABLED: options.networkEnabled ?? false,
    AUTH_TOKEN_PEPPER: 'test-only-pepper-with-more-than-32-characters',
    AUTH_LOGIN_RATE_LIMIT_ACCOUNT_FAILURES: 5,
    AUTH_LOGIN_RATE_LIMIT_NETWORK_FAILURES: 30,
    AUTH_LOGIN_RATE_LIMIT_WINDOW_SECONDS: 900,
    AUTH_LOGIN_RATE_LIMIT_BLOCK_SECONDS: 900,
    AUTH_RATE_LIMIT_BUCKET_CAPACITY_PER_SCOPE: 100_000,
  };
  const config = {
    get: (key: string) => values[key],
  } as unknown as ConfigService<EnvironmentVariables, true>;
  return { limiter: new LoginAttemptLimiter(prisma, config), query, execute };
}
