import type { ConfigService } from '@nestjs/config';

import type { EnvironmentVariables } from '../../../config/environment.js';
import type { AuthPrismaService } from '../../../database/auth-prisma.service.js';
import {
  RecoveryRateLimitExceededException,
  RecoveryRequestLimiter,
} from './recovery-request-limiter.service.js';

describe('RecoveryRequestLimiter', () => {
  it('uses stable HMAC buckets without persisting identities or action tokens', () => {
    const limiter = createLimiter({ networkEnabled: true }).limiter;
    const first = limiter.createContext({
      namespace: 'password-request',
      tenantSlug: ' ACME ',
      accountValue: ' User@Example.test ',
      clientAddress: '203.0.113.5',
    });
    const second = limiter.createContext({
      namespace: 'password-request',
      tenantSlug: 'acme',
      accountValue: 'user@example.test',
      clientAddress: '203.0.113.5',
    });

    expect(first).toEqual(second);
    expect(first.accountKeyHash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.accountKeyHash).not.toContain('example');
    expect(first.networkKeyHash).toMatch(/^[a-f0-9]{64}$/);

    const otherTenant = limiter.createContext({
      namespace: 'password-request',
      tenantSlug: 'other-tenant',
      accountValue: 'other@example.test',
      clientAddress: '203.0.113.5',
    });
    expect(otherTenant.accountKeyHash).not.toBe(first.accountKeyHash);
    expect(otherTenant.networkKeyHash).toBe(first.networkKeyHash);
  });

  it('uses a fixed opaque fail-closed network bucket when the address is unavailable', () => {
    const limiter = createLimiter({ networkEnabled: true }).limiter;
    const missing = limiter.createContext({
      namespace: 'reset-token',
      tenantSlug: 'opaque-token',
      accountValue: `ea_reset_${'x'.repeat(43)}`,
    });
    const blank = limiter.createContext({
      namespace: 'reset-token',
      tenantSlug: 'different',
      accountValue: `ea_reset_${'y'.repeat(43)}`,
      clientAddress: ' ',
    });

    expect(missing.networkKeyHash).toMatch(/^[a-f0-9]{64}$/);
    expect(blank.networkKeyHash).toBe(missing.networkKeyHash);
  });

  it('atomically reserves account and network requests before identity lookup', async () => {
    const { limiter, query } = createLimiter({
      networkEnabled: true,
      queryRows: [[{ blocked: false }], [{ blocked: false }]],
    });
    const context = limiter.createContext({
      namespace: 'reset-token',
      tenantSlug: 'opaque-token',
      accountValue: `ea_reset_${'x'.repeat(43)}`,
      clientAddress: '203.0.113.5',
    });

    await expect(limiter.beginRequest(context)).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledTimes(2);
    const values = query.mock.calls.map(
      ([statement]) => (statement as { values: readonly unknown[] }).values,
    );
    expect(values[0]).toContain('RECOVERY_NETWORK');
    expect(values[1]).toContain('RECOVERY_ACCOUNT');
  });

  it('stops before the attacker-controlled account/token bucket once a network is blocked', async () => {
    const { limiter, query } = createLimiter({
      networkEnabled: true,
      queryRows: [{ blocked: true }],
    });
    const context = limiter.createContext({
      namespace: 'password-request',
      tenantSlug: 'unknown',
      accountValue: 'unknown@example.test',
      clientAddress: '203.0.113.10',
    });
    await expect(limiter.beginRequest(context)).rejects.toBeInstanceOf(
      RecoveryRateLimitExceededException,
    );
    expect(query).toHaveBeenCalledOnce();
    expect((query.mock.calls[0]![0] as { values: readonly unknown[] }).values).toContain(
      'RECOVERY_NETWORK',
    );
  });

  it('fails closed without inserting a random token when scope capacity is exhausted', async () => {
    const { limiter, query, execute } = createLimiter({ queryRows: [[], [], []] });
    const context = limiter.createContext({
      namespace: 'reset-token',
      tenantSlug: 'opaque-token',
      accountValue: `ea_reset_${'x'.repeat(43)}`,
    });

    await expect(limiter.beginRequest(context)).rejects.toBeInstanceOf(
      RecoveryRateLimitExceededException,
    );
    expect(query).toHaveBeenCalledTimes(3);
    expect(execute).toHaveBeenCalledOnce();
  });
});

function createLimiter(
  options: {
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
    AUTH_LOGIN_RATE_LIMIT_ENABLED: true,
    AUTH_LOGIN_RATE_LIMIT_NETWORK_ENABLED: options.networkEnabled ?? false,
    AUTH_TOKEN_PEPPER: 'test-only-recovery-pepper-with-more-than-32-characters',
    AUTH_RECOVERY_RATE_LIMIT_ACCOUNT_REQUESTS: 3,
    AUTH_RECOVERY_RATE_LIMIT_NETWORK_REQUESTS: 20,
    AUTH_RECOVERY_RATE_LIMIT_WINDOW_SECONDS: 3600,
    AUTH_RATE_LIMIT_BUCKET_CAPACITY_PER_SCOPE: 100_000,
  };
  const config = {
    get: (key: string) => values[key],
  } as unknown as ConfigService<EnvironmentVariables, true>;
  return { limiter: new RecoveryRequestLimiter(prisma, config), query, execute };
}
