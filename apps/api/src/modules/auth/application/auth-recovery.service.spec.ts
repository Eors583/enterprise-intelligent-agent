import { BadRequestException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';

import type { EnvironmentVariables } from '../../../config/environment.js';
import type { AuthPrismaService } from '../../../database/auth-prisma.service.js';
import type { IdentitySecretVault } from '../../identity-governance/identity-secret-vault.js';
import { AuthRecoveryService } from './auth-recovery.service.js';
import type { PasswordHasher } from './password-hasher.js';
import { TokenService } from './token.service.js';

describe('AuthRecoveryService token preflight', () => {
  it('does not run scrypt for an unknown random token', async () => {
    const config = recoveryConfig();
    const tokens = new TokenService(config);
    const transaction = {
      authActionToken: { findUnique: vi.fn().mockResolvedValue(null) },
    };
    const prisma = {
      enabled: true,
      withAuth: <T>(operation: (value: typeof transaction) => Promise<T>) => operation(transaction),
    } as unknown as AuthPrismaService;
    const passwords = { hash: vi.fn() } as unknown as PasswordHasher;
    const service = new AuthRecoveryService(prisma, passwords, tokens, secretVault(), config);

    await expect(
      service.completePasswordReset({
        token: `ea_reset_${'x'.repeat(43)}`,
        newPassword: 'ReplacementPassword!2026',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(passwords.hash).not.toHaveBeenCalled();
  });

  it('rejects a purpose-confused token before persistence', async () => {
    const config = recoveryConfig();
    const tokens = new TokenService(config);
    const prisma = {
      enabled: true,
      withAuth: vi.fn(),
    } as unknown as AuthPrismaService;
    const passwords = { hash: vi.fn() } as unknown as PasswordHasher;
    const service = new AuthRecoveryService(prisma, passwords, tokens, secretVault(), config);

    await expect(
      service.completePasswordReset({
        token: `ea_invite_${'x'.repeat(43)}`,
        newPassword: 'ReplacementPassword!2026',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.withAuth).not.toHaveBeenCalled();
    expect(passwords.hash).not.toHaveBeenCalled();
  });

  it('creates the first local credential only after a credentialless directory member consumes an invitation', async () => {
    const config = recoveryConfig();
    const tokens = new TokenService(config);
    const invitation = tokens.issueAction('invite');
    const passwordCreate = vi.fn().mockResolvedValue({});
    const passwordUpdate = vi.fn();
    const candidate = {
      id: '00000000-0000-7000-8000-000000000201',
      tenantId: '00000000-0000-7000-8000-000000000001',
      userId: '00000000-0000-7000-8000-000000000101',
      purpose: 'MEMBER_INVITATION',
      expiresAt: new Date(Date.now() + 60_000),
      consumedAt: null,
      revokedAt: null,
      tenant: { status: 'ACTIVE' },
      user: { status: 'ACTIVE' },
    };
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      authActionToken: {
        findUnique: vi.fn().mockResolvedValue(candidate),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      passwordCredential: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: passwordCreate,
        updateMany: passwordUpdate,
      },
      user: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      employment: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      authSession: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      auditEvent: { create: vi.fn().mockResolvedValue({}) },
    };
    const prisma = {
      enabled: true,
      withAuth: <T>(operation: (value: typeof transaction) => Promise<T>) => operation(transaction),
    } as unknown as AuthPrismaService;
    const passwords = {
      hash: vi.fn().mockResolvedValue('scrypt$activated'),
    } as unknown as PasswordHasher;
    const service = new AuthRecoveryService(prisma, passwords, tokens, secretVault(), config);

    await expect(
      service.acceptMemberInvitation({
        token: invitation.value,
        newPassword: 'ActivatedPassword!2026',
      }),
    ).resolves.toEqual({ accepted: true, revokedSessionCount: 0 });
    expect(passwordCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: candidate.tenantId,
        userId: candidate.userId,
        passwordHash: 'scrypt$activated',
        mustChangePassword: false,
      }),
    });
    expect(passwordUpdate).not.toHaveBeenCalled();
  });

  it('persists an encrypted delivery before returning the enumeration-safe response', async () => {
    const config = recoveryConfig();
    const tokens = new TokenService(config);
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const findFirst = vi
      .fn()
      .mockResolvedValueOnce({
        id: '00000000-0000-7000-8000-000000000101',
        email: 'member@example.test',
        displayName: 'Member',
      })
      .mockResolvedValueOnce({ id: '00000000-0000-7000-8000-000000000101' });
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      $executeRaw: vi.fn().mockResolvedValue(1),
      tenant: {
        findUnique: vi.fn().mockResolvedValue({
          id: '00000000-0000-7000-8000-000000000001',
          name: 'Tenant',
          status: 'ACTIVE',
        }),
      },
      user: { findFirst },
      authActionToken: {
        updateMany,
        create: vi.fn().mockResolvedValue({ id: '00000000-0000-7000-8000-000000000201' }),
      },
      auditEvent: { create: vi.fn().mockResolvedValue({}) },
    };
    const prisma = {
      enabled: true,
      withAuth: <T>(operation: (value: typeof transaction) => Promise<T>) => operation(transaction),
    } as unknown as AuthPrismaService;
    const vault = secretVault();
    const service = new AuthRecoveryService(prisma, {} as PasswordHasher, tokens, vault, config);

    await expect(
      service.requestPasswordReset({
        tenantSlug: 'tenant',
        email: 'member@example.test',
      }),
    ).resolves.toMatchObject({ accepted: true });

    expect(vault.encrypt).toHaveBeenCalledWith(
      expect.not.stringContaining('payloadCiphertext'),
      expect.objectContaining({ purpose: 'AUTH_RECOVERY_DELIVERY' }),
    );
    expect(transaction.$executeRaw).toHaveBeenCalledOnce();
    expect(updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ deliveryStatus: 'FAILED' }),
      }),
    );
  });

  it('does not issue a reset token when the submitted email changed while waiting for the identity lock', async () => {
    const config = recoveryConfig();
    const tokens = new TokenService(config);
    const create = vi.fn();
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      tenant: {
        findUnique: vi.fn().mockResolvedValue({
          id: '00000000-0000-7000-8000-000000000001',
          name: 'Tenant',
          status: 'ACTIVE',
        }),
      },
      user: {
        findFirst: vi
          .fn()
          .mockResolvedValueOnce({
            id: '00000000-0000-7000-8000-000000000101',
            email: 'old@example.test',
            displayName: 'Member',
          })
          .mockResolvedValueOnce(null),
      },
      employment: { groupBy: vi.fn().mockResolvedValue([]) },
      authActionToken: { create, updateMany: vi.fn() },
    };
    const prisma = {
      enabled: true,
      withAuth: <T>(operation: (value: typeof transaction) => Promise<T>) => operation(transaction),
    } as unknown as AuthPrismaService;
    const vault = secretVault();
    const service = new AuthRecoveryService(prisma, {} as PasswordHasher, tokens, vault, config);

    await expect(
      service.requestPasswordReset({ tenantSlug: 'tenant', email: 'old@example.test' }),
    ).resolves.toMatchObject({ accepted: true });
    expect(create).not.toHaveBeenCalled();
    expect(vault.encrypt).not.toHaveBeenCalled();
  });

  it('treats an external.invalid placeholder as an ineligible reset identity', async () => {
    const config = recoveryConfig();
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      tenant: {
        findUnique: vi.fn().mockResolvedValue({
          id: '00000000-0000-7000-8000-000000000001',
          name: 'Tenant',
          status: 'ACTIVE',
        }),
      },
      user: { findFirst: vi.fn() },
      employment: { groupBy: vi.fn() },
      authActionToken: { create: vi.fn() },
    };
    const prisma = {
      enabled: true,
      withAuth: <T>(operation: (value: typeof transaction) => Promise<T>) => operation(transaction),
    } as unknown as AuthPrismaService;
    const service = new AuthRecoveryService(
      prisma,
      {} as PasswordHasher,
      new TokenService(config),
      secretVault(),
      config,
    );

    await expect(
      service.requestPasswordReset({
        tenantSlug: 'tenant',
        email: 'feishu-placeholder@external.invalid',
      }),
    ).resolves.toMatchObject({ accepted: true });
    expect(transaction.user.findFirst).not.toHaveBeenCalled();
    expect(transaction.employment.groupBy).not.toHaveBeenCalled();
    expect(transaction.authActionToken.create).not.toHaveBeenCalled();
  });
});

function secretVault(): IdentitySecretVault {
  return {
    encrypt: vi.fn().mockReturnValue({
      ciphertext: Buffer.from('encrypted-capability'),
      keyId: 'unit-test-v1',
      formatVersion: 1,
    }),
  } as unknown as IdentitySecretVault;
}

function recoveryConfig(): ConfigService<EnvironmentVariables, true> {
  const values: Record<string, unknown> = {
    AUTH_TOKEN_PEPPER: 'unit-test-recovery-pepper',
    AUTH_PASSWORD_RESET_TTL_SECONDS: 1800,
  };
  return {
    get: (key: string) => values[key],
  } as unknown as ConfigService<EnvironmentVariables, true>;
}
