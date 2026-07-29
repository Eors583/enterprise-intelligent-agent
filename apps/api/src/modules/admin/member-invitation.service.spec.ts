import { ConflictException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';

import type { EnvironmentVariables } from '../../config/environment.js';
import type { AdminPrismaService } from '../../database/admin-prisma.service.js';
import type { AuthRecoveryNotificationService } from '../auth/application/auth-recovery-notification.service.js';
import type { PasswordHasher } from '../auth/application/password-hasher.js';
import type { TokenService } from '../auth/application/token.service.js';
import type { AdminAccessService } from './admin-access.service.js';
import { MemberInvitationService } from './member-invitation.service.js';

const tenantId = '00000000-0000-7000-8000-000000000001';
const administratorId = '00000000-0000-7000-8000-000000000101';
const memberId = '00000000-0000-7000-8000-000000000102';
const invitationId = '00000000-0000-7000-8000-000000000201';

describe('MemberInvitationService directory activation', () => {
  it('sends a one-time invitation to the unique work email without creating a shared credential', async () => {
    const now = new Date();
    const invitation = {
      id: invitationId,
      tenantId,
      userId: memberId,
      purpose: 'MEMBER_INVITATION',
      tokenHash: 'a'.repeat(64),
      deliveryStatus: 'PENDING',
      deliveryAttempts: 0,
      lastDeliveryAt: null,
      expiresAt: new Date(now.getTime() + 60_000),
      consumedAt: null,
      revokedAt: null,
      createdById: administratorId,
      createdAt: now,
      updatedAt: now,
      user: {
        id: memberId,
        tenantId,
        email: 'feishu-external@external.invalid',
        emailNormalized: 'feishu-external@external.invalid',
        displayName: 'Directory member',
        status: 'ACTIVE',
        role: 'MEMBER',
      },
    };
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      user: {
        findFirst: vi.fn().mockResolvedValue({
          ...invitation.user,
          passwordCredential: null,
          employments: [{ workEmail: 'Member@Example.test' }, { workEmail: 'member@example.test' }],
        }),
      },
      authActionToken: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        create: vi.fn().mockResolvedValue(invitation),
        update: vi
          .fn()
          .mockImplementation(({ data }: { data: { deliveryStatus: string; expiresAt?: Date } }) =>
            Promise.resolve({
              ...invitation,
              deliveryStatus: data.deliveryStatus,
              expiresAt: data.expiresAt ?? invitation.expiresAt,
            }),
          ),
      },
      auditEvent: { create: vi.fn().mockResolvedValue({}) },
      tenant: { findUniqueOrThrow: vi.fn().mockResolvedValue({ name: 'Test tenant' }) },
    };
    const prisma = {
      withTenant: <T>(
        _tenantId: string,
        operation: (value: typeof transaction) => Promise<T>,
      ): Promise<T> => operation(transaction),
    } as unknown as AdminPrismaService;
    const access = {
      requireDirectoryWrite: vi.fn().mockReturnValue({
        tenantId,
        userId: administratorId,
        role: 'ADMIN',
        authenticationSource: 'session',
      }),
      assertCanManageMember: vi.fn(),
    } as unknown as AdminAccessService;
    const notifications = {
      sendMemberInvitation: vi
        .fn()
        .mockResolvedValueOnce('NOT_CONFIGURED')
        .mockResolvedValueOnce('SENT'),
      actionUrl: vi.fn().mockReturnValue('https://admin.example.test/accept-invitation'),
    } as unknown as AuthRecoveryNotificationService;
    const tokens = {
      issueAction: vi.fn().mockReturnValue({
        value: `ea_invite_${'x'.repeat(43)}`,
        hash: 'a'.repeat(64),
      }),
    } as unknown as TokenService;
    const service = new MemberInvitationService(
      prisma,
      access,
      {} as PasswordHasher,
      tokens,
      notifications,
      invitationConfig(),
    );

    const fallback = await service.issueForDirectoryMember(memberId);
    expect(fallback).toMatchObject({
      memberId,
      email: 'member@example.test',
      deliveryStatus: 'NOT_CONFIGURED',
      deliveryKind: 'MANUAL_FALLBACK',
      fallback: { kind: 'MANUAL_FALLBACK' },
    });
    expect(Date.parse(fallback.fallback!.expiresAt) - Date.now()).toBeLessThanOrEqual(900_000);
    const delivered = await service.issueForDirectoryMember(memberId);
    expect(delivered).toMatchObject({
      deliveryStatus: 'SENT',
      deliveryKind: 'EMAIL_SENT',
      fallback: null,
    });
    expect(delivered).not.toHaveProperty('acceptanceToken');
    expect(delivered).not.toHaveProperty('acceptanceUrl');
    expect(notifications.sendMemberInvitation).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'member@example.test' }),
    );
    expect(transaction.authActionToken.create).toHaveBeenCalledTimes(2);
    expect(transaction.auditEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'admin.member.invitation_manual_fallback_issued',
        }),
      }),
    );
    expect(JSON.stringify(transaction)).not.toContain('passwordCredential');
  });

  it('refuses to issue an activation invitation after a local password credential exists', async () => {
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      user: {
        findFirst: vi.fn().mockResolvedValue({
          id: memberId,
          role: 'MEMBER',
          passwordCredential: { passwordHash: 'scrypt$existing' },
          employments: [{ workEmail: 'member@example.test' }],
        }),
      },
      authActionToken: { create: vi.fn() },
    };
    const prisma = {
      withTenant: <T>(
        _tenantId: string,
        operation: (value: typeof transaction) => Promise<T>,
      ): Promise<T> => operation(transaction),
    } as unknown as AdminPrismaService;
    const service = new MemberInvitationService(
      prisma,
      {
        requireDirectoryWrite: () => ({
          tenantId,
          userId: administratorId,
          role: 'ADMIN',
          authenticationSource: 'session',
        }),
        assertCanManageMember: vi.fn(),
      } as unknown as AdminAccessService,
      {} as PasswordHasher,
      {
        issueAction: () => ({
          value: `ea_invite_${'x'.repeat(43)}`,
          hash: 'a'.repeat(64),
        }),
      } as unknown as TokenService,
      {} as AuthRecoveryNotificationService,
      invitationConfig(),
    );

    await expect(service.issueForDirectoryMember(memberId)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(transaction.authActionToken.create).not.toHaveBeenCalled();
  });
});

function invitationConfig(): ConfigService<EnvironmentVariables, true> {
  return {
    get: (key: keyof EnvironmentVariables) =>
      key === 'AUTH_MEMBER_INVITATION_FALLBACK_TTL_SECONDS' ? 900 : 604_800,
  } as unknown as ConfigService<EnvironmentVariables, true>;
}
