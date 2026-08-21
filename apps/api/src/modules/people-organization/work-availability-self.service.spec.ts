import { BadRequestException, ConflictException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TenantContext } from '../../common/context/tenant-context.js';
import type { PrismaService } from '../../database/prisma.service.js';
import { WorkAvailabilitySelfService } from './work-availability-self.service.js';

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const USER_ID = '00000000-0000-4000-8000-000000000002';
const CONTACT_ID = '00000000-0000-4000-8000-000000000003';
const AVAILABILITY_ID = '00000000-0000-4000-8000-000000000004';

describe('WorkAvailabilitySelfService', () => {
  const transaction = {
    $queryRaw: vi.fn(),
    user: { findFirst: vi.fn() },
    workAvailability: {
      findFirst: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(),
    },
    auditEvent: { create: vi.fn() },
    outboxEvent: { create: vi.fn() },
  };
  const prisma = {
    withTenant: vi.fn((_tenantId: string, operation: (tx: typeof transaction) => unknown) =>
      operation(transaction),
    ),
  };
  const context = {
    current: {
      tenantId: TENANT_ID,
      userId: USER_ID,
      role: 'MEMBER',
      authenticationSource: 'session',
    },
  };
  const service = new WorkAvailabilitySelfService(
    prisma as unknown as PrismaService,
    context as unknown as TenantContext,
  );

  beforeEach(() => {
    vi.clearAllMocks();
    transaction.user.findFirst.mockResolvedValue({ id: CONTACT_ID });
    transaction.workAvailability.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(availabilityRecord());
    transaction.workAvailability.create.mockResolvedValue({ id: AVAILABILITY_ID });
    transaction.workAvailability.updateMany.mockResolvedValue({ count: 1 });
    transaction.auditEvent.create.mockResolvedValue({ id: 'audit' });
    transaction.outboxEvent.create.mockResolvedValue({ id: 'outbox' });
  });

  it('creates only the current user status and emits metadata without the private summary', async () => {
    const result = await service.update(request());

    expect(transaction.$queryRaw).toHaveBeenCalledOnce();
    expect(transaction.workAvailability.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: TENANT_ID,
        userId: USER_ID,
        status: 'TRAVELING',
        emergencyContactUserId: CONTACT_ID,
      }),
    });
    expect(transaction.auditEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'employee.availability.changed.v1',
        metadata: expect.not.objectContaining({ summary: expect.anything() }),
      }),
    });
    expect(result.availability?.status).toBe('TRAVELING');
  });

  it('rejects selecting the owner as their own emergency contact', async () => {
    await expect(
      service.update({ ...request(), emergencyContactUserId: USER_ID }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(transaction.workAvailability.create).not.toHaveBeenCalled();
  });

  it('rejects a stale revision before updating', async () => {
    transaction.workAvailability.findFirst.mockReset();
    transaction.workAvailability.findFirst.mockResolvedValue({ id: AVAILABILITY_ID, revision: 3 });

    await expect(service.update({ ...request(), expectedRevision: 2 })).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(transaction.workAvailability.updateMany).not.toHaveBeenCalled();
  });
});

function request() {
  return {
    status: 'TRAVELING' as const,
    startsAt: '2026-08-13T02:00:00.000Z',
    endsAt: '2026-08-14T07:00:00.000Z',
    summary: '外出拜访客户',
    expectedResponse: '明天下午回复',
    emergencyContactUserId: CONTACT_ID,
    disclosureScope: 'DEPARTMENT' as const,
    expectedRevision: null,
  };
}

function availabilityRecord() {
  return {
    id: AVAILABILITY_ID,
    status: 'TRAVELING',
    startsAt: new Date('2026-08-13T02:00:00.000Z'),
    endsAt: new Date('2026-08-14T07:00:00.000Z'),
    summary: '外出拜访客户',
    expectedResponse: '明天下午回复',
    disclosureScope: 'DEPARTMENT',
    revision: 1,
    updatedAt: new Date('2026-08-13T02:00:00.000Z'),
    emergencyContact: { id: CONTACT_ID, displayName: '陈晨' },
  };
}
