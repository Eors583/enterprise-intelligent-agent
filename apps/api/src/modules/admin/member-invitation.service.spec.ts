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
  it('uses the passwordless invitation flow and generates an unknowable placeholder credential', async () => {
    const now = new Date();
    const user = {
      id: memberId,
      tenantId,
      email: 'member@example.test',
      emailNormalized: 'member@example.test',
      displayName: 'Invited member',
      status: 'INACTIVE',
      role: 'MEMBER',
    };
    const invitation = {
      id: invitationId,
      tenantId,
      userId: memberId,
      purpose: 'MEMBER_INVITATION',
      tokenHash: 'a'.repeat(64),
      deliveryTargetEmail: 'member@example.test',
      deliveryTargetEvidence: 'ISSUED',
      deliveryStatus: 'PENDING',
      deliveryAttempts: 0,
      lastDeliveryAt: null,
      expiresAt: new Date(now.getTime() + 60_000),
      consumedAt: null,
      revokedAt: null,
      createdById: administratorId,
      createdAt: now,
      updatedAt: now,
      user,
    };
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([{ locked: 1 }]),
      $executeRaw: vi.fn().mockResolvedValue(1),
      organization: { findFirst: vi.fn().mockResolvedValue({ id: invitationId }) },
      orgUnit: { findFirst: vi.fn().mockResolvedValue({ id: invitationId }) },
      user: { create: vi.fn().mockResolvedValue(user) },
      passwordCredential: { create: vi.fn().mockResolvedValue({}) },
      employment: { create: vi.fn().mockResolvedValue({}) },
      authActionToken: {
        create: vi.fn().mockResolvedValue(invitation),
        update: vi.fn().mockResolvedValue({ ...invitation, deliveryStatus: 'SENT' }),
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
    const passwords = {
      hash: vi.fn().mockResolvedValue('scrypt$server-generated-placeholder'),
    };
    const service = new MemberInvitationService(
      prisma,
      {
        requireDirectoryWrite: () => ({
          tenantId,
          userId: administratorId,
          role: 'ADMIN',
          authenticationSource: 'session',
        }),
        assertCanAssignRole: vi.fn(),
      } as unknown as AdminAccessService,
      passwords as unknown as PasswordHasher,
      {
        issueAction: () => ({
          value: `ea_invite_${'x'.repeat(43)}`,
          hash: 'a'.repeat(64),
        }),
      } as unknown as TokenService,
      {
        sendMemberInvitation: vi.fn().mockResolvedValue('SENT'),
      } as unknown as AuthRecoveryNotificationService,
      invitationConfig(),
    );

    await expect(
      service.invite({
        email: 'member@example.test',
        displayName: 'Invited member',
        role: 'MEMBER',
        orgUnitId: invitationId,
        employmentType: 'REGULAR',
      }),
    ).resolves.toMatchObject({
      memberId,
      email: 'member@example.test',
      deliveryKind: 'EMAIL_SENT',
    });

    const generatedSecret = passwords.hash.mock.calls[0]?.[0];
    expect(generatedSecret).toEqual(expect.any(String));
    expect(generatedSecret).toHaveLength(43);
    expect(transaction.user.create).toHaveBeenCalledWith({
      data: expect.not.objectContaining({ password: expect.anything() }),
    });
    expect(transaction.passwordCredential.create).toHaveBeenCalledWith({
      data: {
        tenantId,
        userId: memberId,
        passwordHash: 'scrypt$server-generated-placeholder',
        mustChangePassword: true,
      },
    });
  });

  it('sends a one-time invitation to the unique work email without creating a shared credential', async () => {
    const now = new Date();
    const invitation = {
      id: invitationId,
      tenantId,
      userId: memberId,
      purpose: 'MEMBER_INVITATION',
      tokenHash: 'a'.repeat(64),
      deliveryTargetEmail: 'member@example.test',
      deliveryTargetEvidence: 'ISSUED',
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

  it('requires an administrator-provided real email instead of a Feishu placeholder', async () => {
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([{ locked: 1 }]),
      user: {
        findFirst: vi.fn().mockResolvedValue({
          id: memberId,
          role: 'MEMBER',
          passwordCredential: null,
          employments: [{ workEmail: 'feishu-placeholder@external.invalid' }],
        }),
      },
      authActionToken: { create: vi.fn(), updateMany: vi.fn() },
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

    await expect(service.issueForDirectoryMember(memberId)).rejects.toThrow(
      'Set a real login email',
    );
    expect(transaction.authActionToken.updateMany).not.toHaveBeenCalled();
    expect(transaction.authActionToken.create).not.toHaveBeenCalled();
  });

  it('lists the immutable delivery target instead of the synthetic directory identity', async () => {
    const now = new Date();
    const transaction = {
      authActionToken: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: invitationId,
            tenantId,
            userId: memberId,
            purpose: 'MEMBER_INVITATION',
            tokenHash: 'a'.repeat(64),
            deliveryTargetEmail: 'member@example.test',
            deliveryTargetEvidence: 'ISSUED',
            deliveryStatus: 'SENT',
            deliveryAttempts: 1,
            lastDeliveryAt: now,
            expiresAt: new Date(now.getTime() + 60_000),
            consumedAt: null,
            revokedAt: null,
            createdById: administratorId,
            createdAt: now,
            updatedAt: now,
            user: {
              email: 'feishu-placeholder@external.invalid',
              displayName: 'Directory member',
            },
          },
        ]),
      },
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
        requireDirectoryRead: () => ({
          tenantId,
          userId: administratorId,
          role: 'ADMIN',
          authenticationSource: 'session',
        }),
      } as unknown as AdminAccessService,
      {} as PasswordHasher,
      {} as TokenService,
      {} as AuthRecoveryNotificationService,
      invitationConfig(),
    );

    await expect(service.list()).resolves.toEqual([
      expect.objectContaining({
        email: 'member@example.test',
        deliveryTargetEvidence: 'ISSUED',
      }),
    ]);
  });
});

function invitationConfig(): ConfigService<EnvironmentVariables, true> {
  return {
    get: (key: keyof EnvironmentVariables) =>
      key === 'AUTH_MEMBER_INVITATION_FALLBACK_TTL_SECONDS' ? 900 : 604_800,
  } as unknown as ConfigService<EnvironmentVariables, true>;
}
