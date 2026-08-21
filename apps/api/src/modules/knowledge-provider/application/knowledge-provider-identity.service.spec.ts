import { ConflictException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { AdminPrismaService } from '../../../database/admin-prisma.service.js';
import { KnowledgeProviderIdentityService } from './knowledge-provider-identity.service.js';

const TENANT_ID = '00000000-0000-7000-8000-000000000001';
const USER_ID = '00000000-0000-7000-8000-000000000101';
const ACTOR_ID = '00000000-0000-7000-8000-000000000102';

describe('KnowledgeProviderIdentityService', () => {
  it('binds one active employee to one active Lexiang connection and audits it', async () => {
    const transaction = transactionMock();
    const service = createService(transaction);

    const result = await service.bind(TENANT_ID, ACTOR_ID, {
      userId: USER_ID,
      externalStaffId: 'staff-101',
    });

    expect(transaction.knowledgeProviderUserBinding.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          tenantId: TENANT_ID,
          userId: USER_ID,
          externalStaffId: 'staff-101',
          status: 'ACTIVE',
        }),
      }),
    );
    expect(transaction.auditEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: ACTOR_ID,
        action: 'knowledge.provider.user_binding.updated',
        resourceId: USER_ID,
        metadata: { provider: 'LEXIANG' },
      }),
    });
    expect(result.bindings[0]).toMatchObject({ userId: USER_ID, status: 'ACTIVE' });
  });

  it('rejects an unmapped inactive employee and a conflicting external identity', async () => {
    const inactive = transactionMock();
    inactive.user.findFirst.mockResolvedValue(null);
    await expect(
      createService(inactive).bind(TENANT_ID, ACTOR_ID, {
        userId: USER_ID,
        externalStaffId: 'staff-101',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);

    const conflict = transactionMock();
    conflict.knowledgeProviderUserBinding.findFirst.mockResolvedValue({ id: 'conflict' });
    await expect(
      createService(conflict).bind(TENANT_ID, ACTOR_ID, {
        userId: USER_ID,
        externalStaffId: 'staff-101',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

function createService(transaction: ReturnType<typeof transactionMock>) {
  return new KnowledgeProviderIdentityService({
    withTenant: vi.fn(
      (_tenantId: string, operation: (value: typeof transaction) => Promise<unknown>) =>
        operation(transaction),
    ),
  } as unknown as AdminPrismaService);
}

function transactionMock() {
  return {
    knowledgeProviderConnection: {
      findFirst: vi.fn().mockResolvedValue({ id: 'connection-1' }),
    },
    user: { findFirst: vi.fn().mockResolvedValue({ id: USER_ID }) },
    knowledgeProviderUserBinding: {
      findFirst: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findMany: vi.fn().mockResolvedValue([
        {
          userId: USER_ID,
          externalStaffId: 'staff-101',
          status: 'ACTIVE',
          updatedAt: new Date('2026-08-13T03:00:00.000Z'),
          user: { displayName: '测试成员' },
        },
      ]),
    },
    auditEvent: { create: vi.fn().mockResolvedValue({}) },
  };
}
