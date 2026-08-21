import { UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { AuthSessionResponse, LoginResult } from '@enterprise/contracts';

import type { EnvironmentVariables } from '../../../config/environment.js';
import type { AuthPrismaService } from '../../../database/auth-prisma.service.js';
import type { AuthenticatedPrincipal } from '../domain/authenticated-principal.js';
import { AuthService } from './auth.service.js';
import type { MfaService } from './mfa.service.js';
import type { PasswordHasher } from './password-hasher.js';
import { TokenService } from './token.service.js';

describe('AuthService refresh rotation', () => {
  it('atomically replaces both opaque token hashes while retaining the 30-day boundary', async () => {
    const config = authConfig();
    const tokens = new TokenService(config);
    const oldPair = tokens.issuePair();
    const refreshExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    let updateData: Record<string, unknown> | undefined;
    const transaction = {
      authSession: {
        findUnique: vi.fn().mockResolvedValue({
          id: '00000000-0000-7000-8000-000000000010',
          tenantId: '00000000-0000-7000-8000-000000000001',
          userId: '00000000-0000-7000-8000-000000000101',
          accessTokenHash: oldPair.access.hash,
          refreshTokenHash: oldPair.refresh.hash,
          accessExpiresAt: new Date(Date.now() + 10_000),
          refreshExpiresAt,
          lastUsedAt: new Date(),
          revokedAt: null,
          createdAt: new Date(),
          tenant: {
            id: '00000000-0000-7000-8000-000000000001',
            slug: 'test-workspace',
            name: 'Test workspace',
            status: 'ACTIVE',
          },
          user: {
            id: '00000000-0000-7000-8000-000000000101',
            email: 'owner@example.test',
            displayName: 'Owner',
            role: 'OWNER',
            status: 'ACTIVE',
          },
        }),
        updateMany: vi.fn().mockImplementation((input: { data: Record<string, unknown> }) => {
          updateData = input.data;
          return { count: 1 };
        }),
      },
    };
    const prisma = {
      enabled: true,
      withAuth: <T>(operation: (value: typeof transaction) => Promise<T>) => operation(transaction),
    } as unknown as AuthPrismaService;
    const service = new AuthService(prisma, {} as PasswordHasher, tokens, config);

    const result = await service.refresh({ refreshToken: oldPair.refresh.value });

    expect(result.accessToken).not.toBe(oldPair.access.value);
    expect(result.refreshToken).not.toBe(oldPair.refresh.value);
    expect(updateData?.accessTokenHash).toBe(tokens.hash(result.accessToken));
    expect(updateData?.refreshTokenHash).toBe(tokens.hash(result.refreshToken));
    expect(updateData?.accessTokenHash).not.toBe(result.accessToken);
    expect(result.account.refreshExpiresAt).toBe(refreshExpiresAt.toISOString());
    expect(new Date(result.account.accessExpiresAt).getTime()).toBeLessThanOrEqual(
      Date.now() + 15 * 60 * 1000,
    );
  });

  it('rejects a raced refresh token when its conditional rotation loses', async () => {
    const config = authConfig();
    const tokens = new TokenService(config);
    const pair = tokens.issuePair();
    const transaction = {
      authSession: {
        findUnique: vi.fn().mockResolvedValue({
          id: '00000000-0000-7000-8000-000000000010',
          tenantId: '00000000-0000-7000-8000-000000000001',
          userId: '00000000-0000-7000-8000-000000000101',
          refreshExpiresAt: new Date(Date.now() + 60_000),
          revokedAt: null,
          tenant: { slug: 'test', name: 'Test', status: 'ACTIVE' },
          user: {
            email: 'user@example.test',
            displayName: 'User',
            role: 'MEMBER',
            status: 'ACTIVE',
          },
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    };
    const prisma = {
      enabled: true,
      withAuth: <T>(operation: (value: typeof transaction) => Promise<T>) => operation(transaction),
    } as unknown as AuthPrismaService;
    const service = new AuthService(prisma, {} as PasswordHasher, tokens, config);

    await expect(service.refresh({ refreshToken: pair.refresh.value })).rejects.toThrow(
      UnauthorizedException,
    );
  });
});

describe('AuthService password changes', () => {
  it('replaces the credential, clears the temporary flag, and revokes only other sessions', async () => {
    const config = authConfig();
    const tokens = new TokenService(config);
    const oldHash = 'scrypt$old';
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([{ set_config: principal.tenantId }]),
      passwordCredential: {
        findUnique: vi.fn().mockResolvedValue({ passwordHash: oldHash }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      authSession: { updateMany: vi.fn().mockResolvedValue({ count: 3 }) },
      authActionToken: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      auditEvent: { create: vi.fn().mockResolvedValue({}) },
    };
    const prisma = {
      enabled: true,
      withAuth: <T>(operation: (value: typeof transaction) => Promise<T>) => operation(transaction),
    } as unknown as AuthPrismaService;
    const passwords = {
      verify: vi.fn().mockResolvedValue(true),
      hash: vi.fn().mockResolvedValue('scrypt$new'),
    } as unknown as PasswordHasher;
    const service = new AuthService(prisma, passwords, tokens, config);

    const result = await service.changePassword(
      { currentPassword: '1234567890', newPassword: 'a-new-password' },
      principal,
    );

    expect(result).toEqual({
      account: {
        sessionId: principal.sessionId,
        tenantId: principal.tenantId,
        tenantSlug: principal.tenantSlug,
        tenantName: principal.tenantName,
        userId: principal.userId,
        email: principal.email,
        displayName: principal.displayName,
        role: principal.role,
        passwordChangeRequired: false,
        accessExpiresAt: principal.accessExpiresAt,
        refreshExpiresAt: principal.refreshExpiresAt,
      },
      revokedSessionCount: 3,
    });
    expect(transaction.passwordCredential.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ passwordHash: oldHash }),
        data: expect.objectContaining({
          passwordHash: 'scrypt$new',
          mustChangePassword: false,
        }),
      }),
    );
    expect(transaction.authSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: { not: principal.sessionId },
          revokedAt: null,
        }),
      }),
    );
    expect(transaction.authActionToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: principal.tenantId,
          userId: principal.userId,
          consumedAt: null,
          revokedAt: null,
        }),
      }),
    );
  });

  it('does not update anything when the current password is incorrect', async () => {
    const config = authConfig();
    const transaction = {
      passwordCredential: {
        findUnique: vi.fn().mockResolvedValue({ passwordHash: 'scrypt$old' }),
      },
    };
    const prisma = {
      enabled: true,
      withAuth: <T>(operation: (value: typeof transaction) => Promise<T>) => operation(transaction),
    } as unknown as AuthPrismaService;
    const passwords = {
      verify: vi.fn().mockResolvedValue(false),
      hash: vi.fn(),
    } as unknown as PasswordHasher;
    const service = new AuthService(prisma, passwords, new TokenService(config), config);

    await expect(
      service.changePassword(
        { currentPassword: 'wrong-password', newPassword: 'a-new-password' },
        principal,
      ),
    ).rejects.toThrow(UnauthorizedException);
    expect(passwords.hash).not.toHaveBeenCalled();
  });
});

describe('AuthService work-email login', () => {
  it('uses one active employment when no local email identity exists', async () => {
    const { service, transaction } = loginSetup({
      localUser: null,
      candidateUserIds: ['external'],
    });

    const result = requireAuthenticatedLogin(
      await service.login({
        tenantSlug: 'test-workspace',
        email: 'employee@example.test',
        password: '1234567890',
      }),
    );

    expect(result.account.userId).toBe('external');
    expect(result.account.email).toBe('external@external.invalid');
    expect(result.account.passwordChangeRequired).toBe(true);
    expect(transaction.employment.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          workEmail: { equals: 'employee@example.test', mode: 'insensitive' },
          status: 'ACTIVE',
        }),
        take: 2,
      }),
    );
  });

  it('always prefers a direct local email identity over employment email matches', async () => {
    const localUser = loginUser('local', 'employee@example.test', false);
    const { service, transaction } = loginSetup({
      localUser,
      candidateUserIds: ['external'],
    });

    const result = requireAuthenticatedLogin(
      await service.login({
        tenantSlug: 'test-workspace',
        email: 'employee@example.test',
        password: '1234567890',
      }),
    );

    expect(result.account.userId).toBe('local');
    expect(transaction.employment.groupBy).not.toHaveBeenCalled();
  });

  it('rejects a credentialless Feishu identity found by work email even when the submitted password matches a former shared default', async () => {
    const { service, transaction, passwords } = loginSetup({
      localUser: null,
      candidateUserIds: ['external'],
      externalHasCredential: false,
    });

    await expect(
      service.login({
        tenantSlug: 'test-workspace',
        email: 'employee@example.test',
        password: '1234567890',
      }),
    ).rejects.toThrow(UnauthorizedException);
    expect(passwords.verify).toHaveBeenCalledOnce();
    expect(transaction.authSession.create).not.toHaveBeenCalled();
  });

  it('does not create a session when the password changed after verification', async () => {
    const { service, transaction } = loginSetup({
      localUser: loginUser('local', 'employee@example.test', true),
      candidateUserIds: [],
      lockedPasswordHash: 'scrypt$changed-concurrently',
    });

    await expect(
      service.login({
        tenantSlug: 'test-workspace',
        email: 'employee@example.test',
        password: '1234567890',
      }),
    ).rejects.toThrow(UnauthorizedException);
    expect(transaction.authSession.create).not.toHaveBeenCalled();
  });

  it('does not create a session when the work-email alias changed while password verification waited', async () => {
    const { service, transaction } = loginSetup({
      localUser: null,
      candidateUserIds: ['external'],
    });
    transaction.employment.groupBy
      .mockResolvedValueOnce([{ userId: 'external' }])
      .mockResolvedValueOnce([]);

    await expect(
      service.login({
        tenantSlug: 'test-workspace',
        email: 'employee@example.test',
        password: '1234567890',
      }),
    ).rejects.toThrow(UnauthorizedException);
    expect(transaction.authSession.create).not.toHaveBeenCalled();
  });

  it('does not create a session when the account was disabled while password verification waited', async () => {
    const localUser = loginUser('local', 'employee@example.test', true);
    const { service, transaction } = loginSetup({
      localUser,
      candidateUserIds: [],
    });
    transaction.user.findFirst.mockImplementation(({ where }: { where: { id?: string } }) =>
      Promise.resolve(where.id === undefined ? localUser : null),
    );

    await expect(
      service.login({
        tenantSlug: 'test-workspace',
        email: 'employee@example.test',
        password: '1234567890',
      }),
    ).rejects.toThrow(UnauthorizedException);
    expect(transaction.authSession.create).not.toHaveBeenCalled();
  });

  it('never accepts an internal external.invalid placeholder as a login identifier', async () => {
    const { service, transaction, passwords } = loginSetup({
      localUser: loginUser('external', 'external@external.invalid', true),
      candidateUserIds: ['external'],
    });

    await expect(
      service.login({
        tenantSlug: 'test-workspace',
        email: 'external@external.invalid',
        password: '1234567890',
      }),
    ).rejects.toThrow(UnauthorizedException);
    expect(passwords.verify).toHaveBeenCalledOnce();
    expect(transaction.user.findFirst).not.toHaveBeenCalled();
    expect(transaction.employment.groupBy).not.toHaveBeenCalled();
    expect(transaction.authSession.create).not.toHaveBeenCalled();
  });

  it('rejects an MFA challenge bound to an email that is no longer an active alias', async () => {
    const config = authConfig();
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([{ locked: 1 }]),
      tenant: {
        findUnique: vi.fn().mockResolvedValue({
          id: principal.tenantId,
          slug: principal.tenantSlug,
          name: principal.tenantName,
          status: 'ACTIVE',
        }),
      },
      user: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'external',
          email: 'new@example.test',
          displayName: 'External member',
          role: 'MEMBER',
          status: 'ACTIVE',
          passwordCredential: {
            passwordHash: 'scrypt$encoded',
            mustChangePassword: false,
          },
        }),
        findFirst: vi.fn(),
      },
      employment: {
        findMany: vi.fn().mockResolvedValue([{ workEmail: 'new@example.test' }]),
        groupBy: vi.fn(),
      },
      authSession: { create: vi.fn() },
    };
    const mfa = {
      completeLogin: vi
        .fn()
        .mockImplementation(
          async (
            _request: unknown,
            createSession: (
              value: typeof transaction,
              verified: Record<string, unknown>,
            ) => unknown,
          ) =>
            createSession(transaction, {
              tenantId: principal.tenantId,
              userId: 'external',
              factorId: '00000000-0000-7000-8000-000000000301',
              method: 'TOTP',
              verifiedAt: new Date(),
              credentialBinding: 'credential:scrypt$encoded',
              loginIdentifierBinding: 'identifier:old@example.test',
            }),
        ),
      credentialBinding: vi.fn((hash: string) => `credential:${hash}`),
      loginIdentifierBinding: vi.fn((email: string) => `identifier:${email}`),
    } as unknown as MfaService;
    const prisma = {
      enabled: true,
      withAuth: <T>(operation: (value: typeof transaction) => Promise<T>) => operation(transaction),
    } as unknown as AuthPrismaService;
    const service = new AuthService(
      prisma,
      {} as PasswordHasher,
      new TokenService(config),
      config,
      mfa,
    );

    await expect(
      service.completeMfaLogin({
        challenge: `ea_mfa_${'x'.repeat(43)}`,
        code: '123456',
        method: 'TOTP',
      }),
    ).rejects.toThrow(UnauthorizedException);
    expect(transaction.authSession.create).not.toHaveBeenCalled();
  });
});

function requireAuthenticatedLogin(result: LoginResult): AuthSessionResponse {
  if ('kind' in result) {
    throw new Error('Expected an authenticated session, received an MFA challenge.');
  }
  return result;
}

const principal: AuthenticatedPrincipal = {
  sessionId: '00000000-0000-7000-8000-000000000010',
  tenantId: '00000000-0000-7000-8000-000000000001',
  tenantSlug: 'test-workspace',
  tenantName: 'Test workspace',
  userId: '00000000-0000-7000-8000-000000000101',
  email: 'user@example.test',
  displayName: 'Test user',
  role: 'MEMBER',
  passwordChangeRequired: true,
  accessExpiresAt: '2030-01-01T00:15:00.000Z',
  refreshExpiresAt: '2030-01-31T00:00:00.000Z',
  authenticationSource: 'session',
};

function loginSetup(options: {
  readonly localUser: ReturnType<typeof loginUser> | null;
  readonly candidateUserIds: readonly string[];
  readonly lockedPasswordHash?: string;
  readonly externalHasCredential?: boolean;
}) {
  const config = authConfig();
  const transaction = {
    $queryRaw: vi.fn().mockResolvedValue([{ set_config: principal.tenantId }]),
    tenant: {
      findUnique: vi.fn().mockResolvedValue({
        id: principal.tenantId,
        slug: principal.tenantSlug,
        name: principal.tenantName,
        status: 'ACTIVE',
      }),
    },
    user: {
      findFirst: vi
        .fn()
        .mockImplementation(({ where }: { where: { id?: string } }) =>
          Promise.resolve(
            where.id === undefined
              ? options.localUser
              : loginUser(
                  where.id,
                  options.localUser?.email ?? 'external@external.invalid',
                  true,
                  options.externalHasCredential ?? true,
                ),
          ),
        ),
      findUnique: vi
        .fn()
        .mockImplementation(({ where }: { where: { tenantId_id: { id: string } } }) =>
          Promise.resolve(
            loginUser(
              where.tenantId_id.id,
              'external@external.invalid',
              true,
              options.externalHasCredential ?? true,
            ),
          ),
        ),
    },
    employment: {
      groupBy: vi.fn().mockResolvedValue(options.candidateUserIds.map((userId) => ({ userId }))),
    },
    passwordCredential: {
      findUnique: vi.fn().mockResolvedValue({
        passwordHash: options.lockedPasswordHash ?? 'scrypt$encoded',
        mustChangePassword: options.localUser?.passwordCredential?.mustChangePassword ?? true,
      }),
    },
    authSession: {
      create: vi.fn().mockResolvedValue({ id: principal.sessionId }),
    },
  };
  const prisma = {
    enabled: true,
    withAuth: <T>(operation: (value: typeof transaction) => Promise<T>) => operation(transaction),
  } as unknown as AuthPrismaService;
  const passwords = {
    verify: vi.fn().mockResolvedValue(true),
    hash: vi.fn(),
  } as unknown as PasswordHasher;
  return {
    service: new AuthService(prisma, passwords, new TokenService(config), config),
    transaction,
    passwords,
  };
}

function loginUser(id: string, email: string, mustChangePassword: boolean, hasCredential = true) {
  return {
    id,
    email,
    displayName: id,
    role: 'MEMBER' as const,
    status: 'ACTIVE' as const,
    passwordCredential: hasCredential
      ? { passwordHash: 'scrypt$encoded', mustChangePassword }
      : null,
  };
}

function authConfig(): ConfigService<EnvironmentVariables, true> {
  const values = {
    AUTH_TOKEN_PEPPER: 'unit-test-pepper',
    AUTH_ACCESS_TTL_SECONDS: 900,
    AUTH_REFRESH_TTL_SECONDS: 2_592_000,
  } as const;
  return {
    get: (key: keyof EnvironmentVariables) => values[key as keyof typeof values],
  } as unknown as ConfigService<EnvironmentVariables, true>;
}
