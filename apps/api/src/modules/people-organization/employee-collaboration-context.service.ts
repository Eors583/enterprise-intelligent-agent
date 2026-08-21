import { Inject, Injectable } from '@nestjs/common';
import {
  DEFAULT_PERSONAL_MANUAL_DISCLOSURE_POLICY,
  personalManualDisclosurePolicySchema,
  personalManualFaqSchema,
  type CollaborationDisclosureScope,
  type EmployeeCollaborationContextSnapshot,
  type EmployeeCollaborationPurpose,
  type EmployeeCollaborationRelationship,
  type EmployeeCollaborationSource,
  type PersonalManualSection,
} from '@enterprise/contracts';
import type { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';

import { PrismaService } from '../../database/prisma.service.js';
import {
  EmployeeCollaborationContextPort,
  type ResolveEmployeeCollaborationContextInput,
} from './employee-collaboration-context.port.js';

const TERMINAL_TASK_STATUSES = ['ACCEPTED', 'CANCELLED'] as const;
const DENIED_CAPABILITIES = [
  'SEND_MESSAGE',
  'CHANGE_TASK',
  'MAKE_COMMITMENT',
  'ACCEPT',
  'APPROVE',
  'ESCALATE',
] as const;

type Transaction = Prisma.TransactionClient;

@Injectable()
export class EmployeeCollaborationContextService extends EmployeeCollaborationContextPort {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {
    super();
  }

  async resolve(
    input: ResolveEmployeeCollaborationContextInput,
  ): Promise<EmployeeCollaborationContextSnapshot> {
    const now = input.now ?? new Date();
    return this.prisma.withTenant(input.tenantId, async (transaction) => {
      const people = await transaction.user.findMany({
        where: {
          tenantId: input.tenantId,
          id: { in: [...new Set([input.requesterUserId, input.representedEmployeeId])] },
          status: 'ACTIVE',
        },
        select: {
          id: true,
          displayName: true,
          employments: {
            where: { status: 'ACTIVE' },
            select: { orgUnitId: true },
          },
        },
      });
      const requester = people.find(({ id }) => id === input.requesterUserId);
      const represented = people.find(({ id }) => id === input.representedEmployeeId);
      if (
        requester === undefined ||
        represented === undefined ||
        requester.employments.length === 0 ||
        represented.employments.length === 0
      ) {
        return emptySnapshot(input, now);
      }

      const relationship = await resolveRelationship(transaction, input, requester, represented);
      const profile = await transaction.memberProfile.findFirst({
        where: { tenantId: input.tenantId, userId: input.representedEmployeeId },
      });
      const policy = readPolicy(profile?.disclosurePolicy);
      const sources: EmployeeCollaborationSource[] = [];
      if (profile !== null && (relationship === 'SELF' || profile.manualSharingEnabled)) {
        for (const section of sectionsForPurpose(input.purpose)) {
          if (!scopeAllows(policy[section], relationship)) continue;
          const content = manualSectionContent(section, profile);
          if (content === null) continue;
          sources.push(
            sourceFrom({
              tenantId: input.tenantId,
              representedEmployeeId: input.representedEmployeeId,
              type: 'PERSONAL_MANUAL',
              key: section,
              version: profile.policyRevision,
              title: `${represented.displayName}本人填写的${sectionTitle(section)}`,
              content,
              updatedAt: profile.updatedAt,
            }),
          );
        }
      }

      if (
        input.purpose === 'AVAILABILITY_QUERY' &&
        (relationship === 'SELF' || profile?.availabilitySharingEnabled === true)
      ) {
        const availability = await transaction.workAvailability.findFirst({
          where: {
            tenantId: input.tenantId,
            userId: input.representedEmployeeId,
            startsAt: { lte: now },
            OR: [{ endsAt: null }, { endsAt: { gt: now } }],
          },
          include: {
            emergencyContact: {
              select: {
                id: true,
                displayName: true,
                status: true,
                employments: { where: { status: 'ACTIVE' }, take: 1, select: { id: true } },
              },
            },
          },
        });
        if (
          availability !== null &&
          scopeAllows(readScope(availability.disclosureScope), relationship)
        ) {
          sources.push(
            sourceFrom({
              tenantId: input.tenantId,
              representedEmployeeId: input.representedEmployeeId,
              type: 'WORK_AVAILABILITY',
              key: availability.id,
              version: availability.revision,
              title: `${represented.displayName}的工作可用状态`,
              content: availabilityContent(availability),
              updatedAt: availability.updatedAt,
            }),
          );
        }
      }

      return createSnapshot(
        input,
        now,
        relationship,
        profile?.policyRevision ?? 1,
        policy,
        sources,
      );
    });
  }
}

async function resolveRelationship(
  transaction: Transaction,
  input: ResolveEmployeeCollaborationContextInput,
  requester: { readonly employments: readonly { readonly orgUnitId: string }[] },
  represented: { readonly employments: readonly { readonly orgUnitId: string }[] },
): Promise<EmployeeCollaborationRelationship> {
  if (input.requesterUserId === input.representedEmployeeId) return 'SELF';
  const requesterWork = await transaction.task.findMany({
    where: {
      tenantId: input.tenantId,
      ownerUserId: input.requesterUserId,
      status: { notIn: [...TERMINAL_TASK_STATUSES] },
    },
    select: { objectiveId: true },
    distinct: ['objectiveId'],
    take: 100,
  });
  if (
    requesterWork.length > 0 &&
    (await transaction.task.findFirst({
      where: {
        tenantId: input.tenantId,
        ownerUserId: input.representedEmployeeId,
        objectiveId: { in: requesterWork.map(({ objectiveId }) => objectiveId) },
        status: { notIn: [...TERMINAL_TASK_STATUSES] },
      },
      select: { id: true },
    })) !== null
  ) {
    return 'SHARED_WORK';
  }
  const requesterOrgUnits = new Set(requester.employments.map(({ orgUnitId }) => orgUnitId));
  return represented.employments.some(({ orgUnitId }) => requesterOrgUnits.has(orgUnitId))
    ? 'DEPARTMENT'
    : 'TENANT_MEMBER';
}

function sectionsForPurpose(
  purpose: EmployeeCollaborationPurpose,
): readonly PersonalManualSection[] {
  switch (purpose) {
    case 'SELF_ASSISTANCE':
      return ['IDENTITY', 'RESPONSIBILITIES', 'COLLABORATION', 'RESOURCES', 'INTERESTS', 'FAQ'];
    case 'COLLABORATION_GUIDANCE':
      return ['IDENTITY', 'RESPONSIBILITIES', 'COLLABORATION', 'RESOURCES', 'FAQ'];
    case 'WORK_PROGRESS_QUERY':
      return ['RESPONSIBILITIES'];
    case 'AVAILABILITY_QUERY':
      return ['COLLABORATION'];
  }
}

function scopeAllows(
  scope: CollaborationDisclosureScope,
  relationship: EmployeeCollaborationRelationship,
): boolean {
  if (relationship === 'SELF') return true;
  if (scope === 'SELF_ONLY') return false;
  if (scope === 'TENANT') return true;
  if (scope === 'DEPARTMENT')
    return relationship === 'DEPARTMENT' || relationship === 'SHARED_WORK';
  return relationship === 'SHARED_WORK';
}

function readPolicy(value: Prisma.JsonValue | undefined) {
  const parsed = personalManualDisclosurePolicySchema.safeParse(value);
  return parsed.success ? parsed.data : DEFAULT_PERSONAL_MANUAL_DISCLOSURE_POLICY;
}

function readScope(value: string): CollaborationDisclosureScope {
  return value === 'SHARED_WORK' || value === 'DEPARTMENT' || value === 'TENANT'
    ? value
    : 'SELF_ONLY';
}

function manualSectionContent(
  section: PersonalManualSection,
  profile: {
    readonly personalSummary: string | null;
    readonly educationBackground: string | null;
    readonly careerOverview: string | null;
    readonly jobResponsibilities: string | null;
    readonly communicationPreference: string | null;
    readonly collaborationHabits: string | null;
    readonly routineSchedule: string | null;
    readonly contactInformation: string | null;
    readonly coreSkills: string | null;
    readonly availableResources: string | null;
    readonly hobbies: string | null;
    readonly clubs: string | null;
    readonly faqs: Prisma.JsonValue;
  },
): string | null {
  const fields =
    section === 'IDENTITY'
      ? [profile.personalSummary, profile.educationBackground, profile.careerOverview]
      : section === 'RESPONSIBILITIES'
        ? [profile.jobResponsibilities]
        : section === 'COLLABORATION'
          ? [
              profile.communicationPreference,
              profile.collaborationHabits,
              profile.routineSchedule,
              profile.contactInformation,
            ]
          : section === 'RESOURCES'
            ? [profile.coreSkills, profile.availableResources]
            : section === 'INTERESTS'
              ? [profile.hobbies, profile.clubs]
              : readFaqs(profile.faqs).map(
                  ({ question, answer }) => `问：${question}\n答：${answer}`,
                );
  const content = fields
    .map((value) => value?.trim() ?? '')
    .filter((value) => value.length > 0)
    .join('\n');
  return content.length === 0 ? null : content.slice(0, 10_000);
}

function readFaqs(value: Prisma.JsonValue) {
  const parsed = personalManualFaqSchema.array().safeParse(value);
  return parsed.success ? parsed.data : [];
}

function availabilityContent(availability: {
  readonly status: string;
  readonly startsAt: Date;
  readonly endsAt: Date | null;
  readonly summary: string | null;
  readonly expectedResponse: string | null;
  readonly emergencyContact: {
    readonly displayName: string;
    readonly status: string;
    readonly employments: readonly unknown[];
  } | null;
}): string {
  const parts = [
    `状态：${availabilityLabel(availability.status)}`,
    `开始时间：${availability.startsAt.toISOString()}`,
    availability.endsAt === null ? null : `有效至：${availability.endsAt.toISOString()}`,
    safeAvailabilitySummary(availability.summary),
    availability.expectedResponse === null ? null : `预计响应：${availability.expectedResponse}`,
    availability.emergencyContact?.status === 'ACTIVE' &&
    availability.emergencyContact.employments.length > 0
      ? `紧急联系人：${availability.emergencyContact.displayName}`
      : null,
  ];
  return parts.filter((value): value is string => value !== null).join('\n');
}

function safeAvailabilitySummary(value: string | null): string | null {
  if (value === null) return null;
  const normalized = value.replace(/\s+/gu, ' ').trim();
  if (normalized.length === 0) return null;
  if (/(航班|班次|登机|酒店|房间|车次|经纬度|定位|身份证|护照)/u.test(normalized)) {
    return null;
  }
  return `本人摘要：${normalized}`;
}

function availabilityLabel(status: string): string {
  return (
    {
      AVAILABLE: '可联系',
      FOCUSING: '专注工作中',
      IN_MEETING: '会议中',
      TRAVELING: '出差中',
      ON_LEAVE: '休假中',
      UNAVAILABLE: '暂时无法联系',
    }[status] ?? '状态未确认'
  );
}

function sectionTitle(section: PersonalManualSection): string {
  return {
    IDENTITY: '个人简介',
    RESPONSIBILITIES: '岗位职责',
    COLLABORATION: '协作方式',
    RESOURCES: '技能与资源',
    INTERESTS: '兴趣与社团',
    FAQ: '常见问题',
  }[section];
}

function sourceFrom(input: {
  readonly tenantId: string;
  readonly representedEmployeeId: string;
  readonly type: 'PERSONAL_MANUAL' | 'WORK_AVAILABILITY';
  readonly key: string;
  readonly version: number;
  readonly title: string;
  readonly content: string;
  readonly updatedAt: Date;
}): EmployeeCollaborationSource {
  return {
    sourceId: stableUuid(
      `${input.tenantId}:${input.representedEmployeeId}:${input.type}:${input.key}`,
    ),
    sourceType: input.type,
    sourceVersion: input.version,
    title: input.title,
    content: input.content,
    updatedAt: input.updatedAt.toISOString(),
    contentHash: sha256(input.content),
  };
}

function emptySnapshot(
  input: ResolveEmployeeCollaborationContextInput,
  now: Date,
): EmployeeCollaborationContextSnapshot {
  return createSnapshot(
    input,
    now,
    input.requesterUserId === input.representedEmployeeId ? 'SELF' : 'TENANT_MEMBER',
    1,
    DEFAULT_PERSONAL_MANUAL_DISCLOSURE_POLICY,
    [],
  );
}

function createSnapshot(
  input: ResolveEmployeeCollaborationContextInput,
  now: Date,
  relationship: EmployeeCollaborationRelationship,
  policyRevision: number,
  policy: Readonly<Record<PersonalManualSection, CollaborationDisclosureScope>>,
  sources: readonly EmployeeCollaborationSource[],
): EmployeeCollaborationContextSnapshot {
  const policyHash = sha256(stableJson(policy));
  const snapshotBase = {
    schemaVersion: 1 as const,
    requesterUserId: input.requesterUserId,
    representedEmployeeId: input.representedEmployeeId,
    purpose: input.purpose,
    relationship,
    policyRevision,
    policyHash,
    resolvedAt: now.toISOString(),
    sources: sources.slice(0, 12),
    allowedCapabilities: ['ANSWER_FACTS', 'GIVE_ADVICE', 'DRAFT_ACTION'] as Array<
      'ANSWER_FACTS' | 'GIVE_ADVICE' | 'DRAFT_ACTION'
    >,
    deniedCapabilities: [...DENIED_CAPABILITIES],
  };
  const stableSnapshot = {
    ...snapshotBase,
    resolvedAt: undefined,
  };
  return { ...snapshotBase, snapshotHash: sha256(stableJson(stableSnapshot)) };
}

function stableUuid(value: string): string {
  const hex = sha256(value).slice(0, 32).split('');
  hex[12] = '5';
  hex[16] = ((Number.parseInt(hex[16] ?? '0', 16) & 0x3) | 0x8).toString(16);
  const joined = hex.join('');
  return `${joined.slice(0, 8)}-${joined.slice(8, 12)}-${joined.slice(12, 16)}-${joined.slice(16, 20)}-${joined.slice(20)}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function stableJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(',')}}`;
}
