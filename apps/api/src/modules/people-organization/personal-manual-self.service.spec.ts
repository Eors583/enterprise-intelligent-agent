import { ConflictException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TenantContext } from '../../common/context/tenant-context.js';
import type { PrismaService } from '../../database/prisma.service.js';
import { PersonalManualSelfService } from './personal-manual-self.service.js';

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const USER_ID = '00000000-0000-4000-8000-000000000002';
const PROFILE_ID = '00000000-0000-4000-8000-000000000003';
const UPDATED_AT = new Date('2026-08-11T01:00:00.000Z');

describe('PersonalManualSelfService', () => {
  const transaction = {
    $queryRaw: vi.fn(),
    user: { findFirst: vi.fn() },
    memberProfile: {
      findFirst: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(),
    },
    auditEvent: { create: vi.fn() },
    outboxEvent: { create: vi.fn() },
  };
  const prisma = {
    withTenant: vi.fn(async (_tenantId: string, operation: (tx: typeof transaction) => unknown) =>
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
  const service = new PersonalManualSelfService(
    prisma as unknown as PrismaService,
    context as unknown as TenantContext,
  );

  beforeEach(() => {
    vi.clearAllMocks();
    transaction.user.findFirst.mockResolvedValue(profileRecord());
    transaction.memberProfile.create.mockResolvedValue({ id: PROFILE_ID });
    transaction.memberProfile.updateMany.mockResolvedValue({ count: 1 });
    transaction.auditEvent.create.mockResolvedValue({ id: 'audit' });
    transaction.outboxEvent.create.mockResolvedValue({ id: 'outbox' });
  });

  it('returns only the current user identity, employment and collaboration manual', async () => {
    const result = await service.get();

    expect(prisma.withTenant).toHaveBeenCalledWith(TENANT_ID, expect.any(Function));
    expect(transaction.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: TENANT_ID, id: USER_ID } }),
    );
    expect(result.user.displayName).toBe('林晓');
    expect(result.employment?.departmentName).toBe('产品中心');
    expect(result.manual.personalSummary).toBe('负责企业协作产品。');
    expect(result.updatedAt).toBe(UPDATED_AT.toISOString());
  });

  it('creates the first manual for the authenticated user and emits metadata-only audit', async () => {
    transaction.memberProfile.findFirst.mockResolvedValue(null);

    const result = await service.update({
      expectedUpdatedAt: null,
      manual: {
        ...emptyManual(),
        personalSummary: ' 我负责企业协作产品。 ',
        coreSkills: '产品设计',
        faqs: [{ question: '什么事情可以找我？', answer: '产品优先级。' }],
      },
    });

    expect(transaction.$queryRaw).toHaveBeenCalledOnce();
    expect(transaction.memberProfile.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: TENANT_ID,
        userId: USER_ID,
        personalSummary: '我负责企业协作产品。',
        coreSkills: '产品设计',
      }),
    });
    expect(transaction.auditEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: USER_ID,
        action: 'people.personal_manual.updated',
        metadata: { completedFieldCount: 3, faqCount: 1 },
      }),
    });
    expect(result.user.id).toBe(USER_ID);
  });

  it('rejects a stale edit before updating the profile', async () => {
    transaction.memberProfile.findFirst.mockResolvedValue({
      id: PROFILE_ID,
      updatedAt: UPDATED_AT,
    });

    await expect(
      service.update({
        expectedUpdatedAt: '2026-08-11T00:00:00.000Z',
        manual: emptyManual(),
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(transaction.memberProfile.updateMany).not.toHaveBeenCalled();
  });
});

function profileRecord() {
  return {
    id: USER_ID,
    displayName: '林晓',
    email: 'lin.xiao@example.com',
    phone: null,
    avatarUrl: null,
    employments: [
      {
        orgUnit: { name: '产品中心' },
        position: { name: '产品负责人' },
        employeeNumber: 'P-001',
        employmentType: 'REGULAR',
      },
    ],
    memberProfile: {
      id: PROFILE_ID,
      ...emptyManual(),
      personalSummary: '负责企业协作产品。',
      updatedAt: UPDATED_AT,
    },
  };
}

function emptyManual() {
  return {
    personalSummary: null,
    educationBackground: null,
    careerOverview: null,
    jobResponsibilities: null,
    communicationPreference: null,
    collaborationHabits: null,
    routineSchedule: null,
    contactInformation: null,
    coreSkills: null,
    availableResources: null,
    hobbies: null,
    clubs: null,
    faqs: [],
  };
}
