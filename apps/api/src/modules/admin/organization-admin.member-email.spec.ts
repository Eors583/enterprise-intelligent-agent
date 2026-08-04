import { BadRequestException, ConflictException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { AdminPrismaService } from '../../database/admin-prisma.service.js';
import type { PasswordHasher } from '../auth/application/password-hasher.js';
import type { AdminAccessService, AdminPrincipal } from './admin-access.service.js';
import { OrganizationAdminService } from './organization-admin.service.js';

const TENANT_ID = '00000000-0000-7000-8000-000000000001';
const ADMIN_ID = '00000000-0000-7000-8000-000000000101';
const MEMBER_ID = '00000000-0000-7000-8000-000000000102';
const ORGANIZATION_ID = '00000000-0000-7000-8000-000000000201';
const EMPLOYMENT_ID = '00000000-0000-7000-8000-000000000301';

describe('OrganizationAdminService member login email', () => {
  it('stores a Feishu email as a protected alias across every active employment', async () => {
    const harness = createEmailHarness({ directoryManaged: true });

    await expect(
      harness.service.updateMember(MEMBER_ID, { email: 'Login@Example.test' }),
    ).resolves.toMatchObject({ email: 'login@example.test', source: 'FEISHU' });

    expect(harness.transaction.user.update).toHaveBeenCalledWith({
      where: { id: MEMBER_ID },
      data: {
        email: 'login@example.test',
        emailNormalized: 'login@example.test',
      },
    });
    expect(harness.transaction.employment.updateMany).toHaveBeenCalledWith({
      where: {
        tenantId: TENANT_ID,
        userId: MEMBER_ID,
        status: { not: 'TERMINATED' },
      },
      data: {
        workEmail: 'login@example.test',
        workEmailOverridden: true,
      },
    });
    expect(harness.transaction.$queryRaw).toHaveBeenCalledTimes(1);
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
      data: expect.objectContaining({
        action: 'admin.member.updated',
        metadata: expect.objectContaining({
          previousEmail: 'remote@example.test',
          email: 'login@example.test',
          emailSource: 'LOCAL_OVERRIDE',
        }),
      }),
    });
    expect(JSON.stringify(audit)).not.toMatch(/password|tokenHash|session/i);
  });

  it('changes the canonical identity and all employments for a local member', async () => {
    const harness = createEmailHarness({ directoryManaged: false });

    await harness.service.updateMember(MEMBER_ID, { email: 'local-login@example.test' });

    expect(harness.transaction.user.update).toHaveBeenCalledWith({
      where: { id: MEMBER_ID },
      data: {
        email: 'local-login@example.test',
        emailNormalized: 'local-login@example.test',
      },
    });
    expect(harness.transaction.employment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { workEmail: 'local-login@example.test' },
      }),
    );
  });

  it.each([
    ['canonical user identity', 1, 0],
    ['active employment alias', 0, 1],
  ])('rejects an email used by another %s', async (_source, userCount, employmentCount) => {
    const harness = createEmailHarness({ directoryManaged: true, userCount, employmentCount });

    await expect(
      harness.service.updateMember(MEMBER_ID, { email: 'collision@example.test' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(harness.transaction.user.update).not.toHaveBeenCalled();
    expect(harness.transaction.employment.updateMany).not.toHaveBeenCalled();
    expect(harness.transaction.auditEvent.create).not.toHaveBeenCalled();
  });

  it('rejects a synthetic external.invalid address as a login email', async () => {
    const harness = createEmailHarness({ directoryManaged: true });

    await expect(
      harness.service.updateMember(MEMBER_ID, { email: 'feishu-new@external.invalid' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(harness.transaction.user.count).not.toHaveBeenCalled();
    expect(harness.transaction.user.update).not.toHaveBeenCalled();
  });
});

function createEmailHarness(options: {
  readonly directoryManaged: boolean;
  readonly userCount?: number;
  readonly employmentCount?: number;
}) {
  const principal: AdminPrincipal = {
    tenantId: TENANT_ID,
    userId: ADMIN_ID,
    role: 'ADMIN',
    authenticationSource: 'session',
  };
  const current = memberRecord({
    email: options.directoryManaged ? 'feishu-placeholder@external.invalid' : 'remote@example.test',
    workEmail: 'remote@example.test',
    directoryManaged: options.directoryManaged,
  });
  const updated = memberRecord({
    email: options.directoryManaged
      ? 'feishu-placeholder@external.invalid'
      : 'local-login@example.test',
    workEmail:
      options.userCount || options.employmentCount
        ? 'remote@example.test'
        : options.directoryManaged
          ? 'login@example.test'
          : 'local-login@example.test',
    directoryManaged: options.directoryManaged,
  });
  const transaction = {
    $executeRaw: vi.fn().mockResolvedValue(1),
    $queryRaw: vi.fn().mockResolvedValue([{ locked: 1 }]),
    organization: {
      findFirst: vi.fn().mockResolvedValue({ id: ORGANIZATION_ID }),
    },
    user: {
      findFirst: vi.fn().mockResolvedValueOnce(current).mockResolvedValue(updated),
      count: vi.fn().mockResolvedValue(options.userCount ?? 0),
      update: vi.fn().mockResolvedValue({}),
    },
    employment: {
      count: vi.fn().mockResolvedValue(options.employmentCount ?? 0),
      findMany: vi
        .fn()
        .mockResolvedValue([{ workEmail: 'remote@example.test' }, { workEmail: 'other@old.test' }]),
      updateMany: vi.fn().mockResolvedValue({ count: 2 }),
      update: vi.fn().mockResolvedValue({}),
    },
    authSession: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    authActionToken: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    auditEvent: { create: vi.fn().mockResolvedValue({}) },
  };
  const prisma = {
    withTenant: <T>(
      _tenantId: string,
      operation: (value: typeof transaction) => Promise<T>,
    ): Promise<T> => operation(transaction),
  } as unknown as AdminPrismaService;
  const access = {
    requireDirectoryWrite: vi.fn().mockReturnValue(principal),
    assertCanManageMember: vi.fn(),
    assertCanAssignRole: vi.fn(),
  } as unknown as AdminAccessService;
  return {
    transaction,
    service: new OrganizationAdminService(prisma, access, {} as PasswordHasher),
  };
}

function memberRecord(input: {
  readonly email: string;
  readonly workEmail: string;
  readonly directoryManaged: boolean;
}) {
  return {
    id: MEMBER_ID,
    tenantId: TENANT_ID,
    email: input.email,
    emailNormalized: input.email.toLowerCase(),
    phone: null,
    displayName: 'Member',
    avatarUrl: null,
    status: 'ACTIVE',
    role: 'MEMBER',
    createdAt: new Date(),
    updatedAt: new Date(),
    directoryBindings: input.directoryManaged ? [{ id: 'binding-1' }] : [],
    employments: [
      {
        id: EMPLOYMENT_ID,
        tenantId: TENANT_ID,
        userId: MEMBER_ID,
        organizationId: ORGANIZATION_ID,
        orgUnitId: '00000000-0000-7000-8000-000000000401',
        positionId: null,
        employeeNumber: null,
        workEmail: input.workEmail,
        workEmailOverridden: input.directoryManaged,
        employmentType: null,
        hireDate: null,
        city: null,
        status: 'ACTIVE',
        isPrimary: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        position: null,
      },
    ],
  };
}
