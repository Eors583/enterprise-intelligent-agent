import { BadRequestException, Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';

import type { EnvironmentVariables } from '../../../config/environment.js';
import type { AuthPrismaService } from '../../../database/auth-prisma.service.js';
import type { AuthRecoveryNotificationService } from './auth-recovery-notification.service.js';
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
    const service = new AuthRecoveryService(
      prisma,
      passwords,
      tokens,
      {} as AuthRecoveryNotificationService,
      config,
    );

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
    const service = new AuthRecoveryService(
      prisma,
      passwords,
      tokens,
      {} as AuthRecoveryNotificationService,
      config,
    );

    await expect(
      service.completePasswordReset({
        token: `ea_invite_${'x'.repeat(43)}`,
        newPassword: 'ReplacementPassword!2026',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.withAuth).not.toHaveBeenCalled();
    expect(passwords.hash).not.toHaveBeenCalled();
  });

  it('catches an asynchronous delivery rejection, records FAILED, and does not emit unhandledRejection', async () => {
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
    const notifications = {
      sendPasswordReset: vi.fn().mockRejectedValue(new Error('provider transport failed')),
    } as unknown as AuthRecoveryNotificationService;
    const service = new AuthRecoveryService(
      prisma,
      {} as PasswordHasher,
      tokens,
      notifications,
      config,
    );
    const warned = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const unhandled: unknown[] = [];
    const captureUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', captureUnhandled);

    try {
      await expect(
        service.requestPasswordReset({
          tenantSlug: 'tenant',
          email: 'member@example.test',
        }),
      ).resolves.toMatchObject({ accepted: true });
      await flushImmediate();
      await flushImmediate();

      expect(notifications.sendPasswordReset).toHaveBeenCalledOnce();
      expect(updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ deliveryStatus: 'FAILED' }),
        }),
      );
      expect(warned).toHaveBeenCalledWith(expect.stringContaining('status recorded as FAILED'));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', captureUnhandled);
      warned.mockRestore();
    }
  });
});

function flushImmediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
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
