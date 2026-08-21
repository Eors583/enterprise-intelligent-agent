import {
  DEFAULT_PERSONAL_MANUAL_DISCLOSURE_POLICY,
  employeeCollaborationContextSnapshotSchema,
} from '@enterprise/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../database/prisma.service.js';
import { EmployeeCollaborationContextService } from './employee-collaboration-context.service.js';

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const REQUESTER_ID = '00000000-0000-4000-8000-000000000002';
const OWNER_ID = '00000000-0000-4000-8000-000000000003';
const CONTACT_ID = '00000000-0000-4000-8000-000000000004';
const OBJECTIVE_ID = '00000000-0000-4000-8000-000000000005';
const AVAILABILITY_ID = '00000000-0000-4000-8000-000000000006';
const NOW = new Date('2026-08-13T03:00:00.000Z');

describe('EmployeeCollaborationContextService', () => {
  const transaction = {
    user: { findMany: vi.fn() },
    memberProfile: { findFirst: vi.fn() },
    workAvailability: { findFirst: vi.fn() },
    task: { findMany: vi.fn(), findFirst: vi.fn() },
  };
  const prisma = {
    withTenant: vi.fn((_tenantId: string, operation: (tx: typeof transaction) => unknown) =>
      operation(transaction),
    ),
  };
  const service = new EmployeeCollaborationContextService(prisma as unknown as PrismaService);

  beforeEach(() => {
    vi.clearAllMocks();
    transaction.user.findMany.mockResolvedValue(activePeople('same-department'));
    transaction.task.findMany.mockResolvedValue([]);
    transaction.task.findFirst.mockResolvedValue(null);
    transaction.memberProfile.findFirst.mockResolvedValue(profileRecord());
    transaction.workAvailability.findFirst.mockResolvedValue(null);
  });

  it('keeps historical manuals private even for an active colleague in the same department', async () => {
    const snapshot = await service.resolve(input('COLLABORATION_GUIDANCE'));

    expect(snapshot.relationship).toBe('DEPARTMENT');
    expect(snapshot.sources).toEqual([]);
    expect(employeeCollaborationContextSnapshotSchema.parse(snapshot)).toEqual(snapshot);
  });

  it('keeps a private manual available to its owner without enabling external sharing', async () => {
    const snapshot = await service.resolve({
      ...input('COLLABORATION_GUIDANCE'),
      requesterUserId: OWNER_ID,
    });

    expect(snapshot.relationship).toBe('SELF');
    expect(snapshot.sources.map(({ sourceType }) => sourceType)).toContain('PERSONAL_MANUAL');
    expect(snapshot.sources.some(({ content }) => content.includes('会议请提前一天预约'))).toBe(
      true,
    );
  });

  it('exposes only the allowed manual partition to a colleague with shared work', async () => {
    transaction.task.findMany.mockResolvedValue([{ objectiveId: OBJECTIVE_ID }]);
    transaction.task.findFirst.mockResolvedValue({ id: 'shared-task' });
    transaction.memberProfile.findFirst.mockResolvedValue(
      profileRecord({
        manualSharingEnabled: true,
        disclosurePolicy: {
          ...DEFAULT_PERSONAL_MANUAL_DISCLOSURE_POLICY,
          COLLABORATION: 'SHARED_WORK',
        },
      }),
    );

    const snapshot = await service.resolve(input('COLLABORATION_GUIDANCE'));

    expect(snapshot.relationship).toBe('SHARED_WORK');
    expect(snapshot.sources).toHaveLength(1);
    expect(snapshot.sources[0]).toMatchObject({
      sourceType: 'PERSONAL_MANUAL',
      title: '林晓本人填写的协作方式',
    });
    expect(snapshot.sources[0]?.content).toContain('会议请提前一天预约');
    expect(snapshot.sources[0]?.content).not.toContain('负责保密战略');
  });

  it('does not load an expired availability and never asks for raw calendar data', async () => {
    transaction.memberProfile.findFirst.mockResolvedValue(
      profileRecord({ availabilitySharingEnabled: true }),
    );

    const snapshot = await service.resolve(input('AVAILABILITY_QUERY'));

    expect(transaction.workAvailability.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          startsAt: { lte: NOW },
          OR: [{ endsAt: null }, { endsAt: { gt: NOW } }],
        }),
      }),
    );
    expect(snapshot.sources).toEqual([]);
  });

  it('returns a minimal availability summary and strips itinerary details', async () => {
    transaction.memberProfile.findFirst.mockResolvedValue(
      profileRecord({ availabilitySharingEnabled: true }),
    );
    transaction.workAvailability.findFirst.mockResolvedValue({
      id: AVAILABILITY_ID,
      status: 'TRAVELING',
      startsAt: NOW,
      endsAt: new Date('2026-08-14T07:00:00.000Z'),
      summary: '航班 CA123，入住某酒店 801 房间',
      expectedResponse: '明天下午回复',
      disclosureScope: 'DEPARTMENT',
      revision: 2,
      updatedAt: NOW,
      emergencyContact: {
        id: CONTACT_ID,
        displayName: '陈晨',
        status: 'ACTIVE',
        employments: [{ id: 'active-employment' }],
      },
    });

    const snapshot = await service.resolve(input('AVAILABILITY_QUERY'));

    expect(snapshot.sources).toHaveLength(1);
    expect(snapshot.sources[0]?.content).toContain('状态：出差中');
    expect(snapshot.sources[0]?.content).toContain('预计响应：明天下午回复');
    expect(snapshot.sources[0]?.content).toContain('紧急联系人：陈晨');
    expect(snapshot.sources[0]?.content).not.toMatch(/CA123|酒店|801/u);
  });
});

function input(purpose: 'COLLABORATION_GUIDANCE' | 'AVAILABILITY_QUERY') {
  return {
    tenantId: TENANT_ID,
    requesterUserId: REQUESTER_ID,
    representedEmployeeId: OWNER_ID,
    purpose,
    query: purpose === 'AVAILABILITY_QUERY' ? '林晓今天方便吗？' : '怎样和林晓协作？',
    now: NOW,
  } as const;
}

function activePeople(mode: 'same-department' | 'different-department') {
  return [
    {
      id: REQUESTER_ID,
      displayName: '提问者',
      employments: [{ orgUnitId: '00000000-0000-4000-8000-000000000010' }],
    },
    {
      id: OWNER_ID,
      displayName: '林晓',
      employments: [
        {
          orgUnitId:
            mode === 'same-department'
              ? '00000000-0000-4000-8000-000000000010'
              : '00000000-0000-4000-8000-000000000011',
        },
      ],
    },
  ];
}

function profileRecord(overrides: Record<string, unknown> = {}) {
  return {
    personalSummary: '产品负责人',
    educationBackground: null,
    careerOverview: null,
    jobResponsibilities: '负责保密战略',
    communicationPreference: '紧急事项用即时消息',
    collaborationHabits: '会议请提前一天预约',
    routineSchedule: null,
    contactInformation: null,
    coreSkills: '产品设计',
    availableResources: null,
    hobbies: null,
    clubs: null,
    faqs: [],
    disclosurePolicy: DEFAULT_PERSONAL_MANUAL_DISCLOSURE_POLICY,
    manualSharingEnabled: false,
    availabilitySharingEnabled: false,
    privateRiskRemindersEnabled: true,
    policyRevision: 1,
    updatedAt: NOW,
    ...overrides,
  };
}
