import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { TenantRole } from '@enterprise/contracts';
import { describe, expect, it, vi } from 'vitest';

import type { AdminPrismaService } from '../../database/admin-prisma.service.js';
import type { PasswordHasher } from '../auth/application/password-hasher.js';
import type { AdminAccessService, AdminPrincipal } from './admin-access.service.js';
import { OrganizationAdminService } from './organization-admin.service.js';

const TENANT_ID = '00000000-0000-7000-8000-000000000001';
const ACTOR_ID = '00000000-0000-7000-8000-000000000101';
const MEMBER_ID = '00000000-0000-7000-8000-000000000102';
const ORGANIZATION_ID = '00000000-0000-7000-8000-000000000201';
const TEMPORARY_PASSWORD = 'TemporaryPassword!2026';

describe('OrganizationAdminService member password reset', () => {
  it('replaces the credential, requires a password change, revokes every session, and audits safely', async () => {
    const harness = createHarness();

    await expect(
      harness.service.resetMemberPassword(MEMBER_ID, {
        temporaryPassword: TEMPORARY_PASSWORD,
      }),
    ).resolves.toEqual({
      memberId: MEMBER_ID,
      passwordChangeRequired: true,
      revokedSessionCount: 2,
    });

    expect(harness.passwords.hash).toHaveBeenCalledWith(TEMPORARY_PASSWORD);
    expect(harness.transaction.passwordCredential.updateMany).toHaveBeenCalledWith({
      where: { tenantId: TENANT_ID, userId: MEMBER_ID },
      data: {
        passwordHash: 'scrypt$redacted-hash',
        mustChangePassword: true,
        passwordChangedAt: expect.any(Date),
      },
    });
    expect(harness.transaction.authSession.updateMany).toHaveBeenCalledWith({
      where: { tenantId: TENANT_ID, userId: MEMBER_ID, revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
    expect(harness.transaction.authActionToken.updateMany).toHaveBeenCalledWith({
      where: {
        tenantId: TENANT_ID,
        userId: MEMBER_ID,
        consumedAt: null,
        revokedAt: null,
      },
      data: { revokedAt: expect.any(Date) },
    });

    const audit = harness.transaction.auditEvent.create.mock.calls[0]?.[0];
    expect(audit).toEqual({
      data: {
        tenantId: TENANT_ID,
        actorType: 'USER',
        actorId: ACTOR_ID,
        action: 'admin.member.password_reset',
        resourceType: 'user',
        resourceId: MEMBER_ID,
        metadata: { passwordChangeRequired: true, revokedSessionCount: 2 },
      },
    });
    expect(JSON.stringify(audit)).not.toContain(TEMPORARY_PASSWORD);
    expect(JSON.stringify(audit)).not.toContain('redacted-hash');
  });

  it('prevents an administrator from resetting an owner credential', async () => {
    const harness = createHarness({ actorRole: 'ADMIN', targetRole: 'OWNER' });

    await expect(
      harness.service.resetMemberPassword(MEMBER_ID, {
        temporaryPassword: TEMPORARY_PASSWORD,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(harness.transaction.passwordCredential.updateMany).not.toHaveBeenCalled();
    expect(harness.transaction.authSession.updateMany).not.toHaveBeenCalled();
    expect(harness.transaction.auditEvent.create).not.toHaveBeenCalled();
  });

  it('does not expose or mutate a member outside the current tenant', async () => {
    const harness = createHarness({ targetRole: null });

    await expect(
      harness.service.resetMemberPassword(MEMBER_ID, {
        temporaryPassword: TEMPORARY_PASSWORD,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(harness.transaction.user.findFirst).toHaveBeenCalledWith({
      where: { id: MEMBER_ID, tenantId: TENANT_ID },
      select: { id: true, role: true },
    });
    expect(harness.transaction.passwordCredential.updateMany).not.toHaveBeenCalled();
  });

  it('requires the authenticated password-change flow for the current administrator', async () => {
    const harness = createHarness();

    await expect(
      harness.service.resetMemberPassword(ACTOR_ID, {
        temporaryPassword: TEMPORARY_PASSWORD,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(harness.passwords.hash).not.toHaveBeenCalled();
    expect(harness.prisma.withTenant).not.toHaveBeenCalled();
  });
});

function createHarness(
  options: {
    readonly actorRole?: TenantRole;
    readonly targetRole?: TenantRole | null;
  } = {},
) {
  const actorRole = options.actorRole ?? 'OWNER';
  const targetRole = options.targetRole === undefined ? 'MEMBER' : options.targetRole;
  const principal: AdminPrincipal = {
    tenantId: TENANT_ID,
    userId: ACTOR_ID,
    role: actorRole,
    authenticationSource: 'session',
  };
  const transaction = {
    organization: {
      findFirst: vi.fn().mockResolvedValue({ id: ORGANIZATION_ID }),
    },
    user: {
      findFirst: vi
        .fn()
        .mockResolvedValue(targetRole === null ? null : { id: MEMBER_ID, role: targetRole }),
    },
    passwordCredential: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    authSession: {
      updateMany: vi.fn().mockResolvedValue({ count: 2 }),
    },
    authActionToken: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    auditEvent: {
      create: vi.fn().mockResolvedValue({}),
    },
    $executeRaw: vi.fn().mockResolvedValue(undefined),
    $queryRaw: vi.fn().mockResolvedValue([{ locked: 1 }]),
  };
  const prisma = {
    withTenant: vi.fn(
      async (_tenantId: string, operation: (value: typeof transaction) => Promise<unknown>) =>
        operation(transaction),
    ),
  };
  const access = {
    requireDirectoryWrite: vi.fn().mockReturnValue(principal),
    assertCanManageMember: vi.fn((_actor: AdminPrincipal, role: TenantRole) => {
      if (role === 'OWNER' && actorRole !== 'OWNER') {
        throw new ForbiddenException('Only an owner can manage another owner.');
      }
    }),
  };
  const passwords = {
    hash: vi.fn().mockResolvedValue('scrypt$redacted-hash'),
  };
  return {
    transaction,
    prisma,
    passwords,
    service: new OrganizationAdminService(
      prisma as unknown as AdminPrismaService,
      access as unknown as AdminAccessService,
      passwords as unknown as PasswordHasher,
      {
        countOrgUnitBindings: vi.fn().mockResolvedValue(0),
      } as never,
    ),
  };
}
