import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  personalManualFaqSchema,
  type PersonalManualContent,
  type PersonalManualSelfProfile,
  type UpdatePersonalManualRequest,
} from '@enterprise/contracts';
import { Prisma } from '@prisma/client';

import { TenantContext, type TenantPrincipal } from '../../common/context/tenant-context.js';
import { PrismaService } from '../../database/prisma.service.js';
import { recordPeopleMutation } from './people-organization.persistence.js';

@Injectable()
export class PersonalManualSelfService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(TenantContext) private readonly context: TenantContext,
  ) {}

  async get(): Promise<PersonalManualSelfProfile> {
    const principal = this.context.current;
    return this.prisma.withTenant(principal.tenantId, async (transaction) =>
      this.readProfile(transaction, principal),
    );
  }

  async update(request: UpdatePersonalManualRequest): Promise<PersonalManualSelfProfile> {
    const principal = this.context.current;
    return this.prisma.withTenant(principal.tenantId, async (transaction) => {
      await transaction.$queryRaw`SELECT set_config('app.user_id', ${principal.userId}, true)`;
      const existing = await transaction.memberProfile.findFirst({
        where: { tenantId: principal.tenantId, userId: principal.userId },
        select: { id: true, updatedAt: true },
      });

      this.assertCurrentVersion(existing?.updatedAt ?? null, request.expectedUpdatedAt);
      const manual = normalizeManual(request.manual);
      const data = {
        ...manualTextFields(manual),
        faqs: manual.faqs as Prisma.InputJsonValue,
      };

      if (existing === null) {
        try {
          await transaction.memberProfile.create({
            data: {
              tenantId: principal.tenantId,
              userId: principal.userId,
              ...data,
            },
          });
        } catch (error) {
          if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
            throw new ConflictException('个人使用说明书已被创建，请刷新后重新保存。');
          }
          throw error;
        }
      } else {
        const changed = await transaction.memberProfile.updateMany({
          where: {
            tenantId: principal.tenantId,
            userId: principal.userId,
            updatedAt: existing.updatedAt,
          },
          data,
        });
        if (changed.count !== 1) {
          throw new ConflictException('个人使用说明书已发生变化，请刷新后重新保存。');
        }
      }

      await recordPeopleMutation(
        transaction,
        principal,
        'people.personal_manual.updated',
        'member_profile',
        principal.userId,
        {
          completedFieldCount: completedFieldCount(manual),
          faqCount: manual.faqs.length,
        },
      );
      return this.readProfile(transaction, principal);
    });
  }

  private assertCurrentVersion(current: Date | null, expected: string | null): void {
    if (current === null && expected === null) return;
    if (current === null || expected === null || current.toISOString() !== expected) {
      throw new ConflictException('个人使用说明书已发生变化，请刷新后重新保存。');
    }
  }

  private async readProfile(
    transaction: Prisma.TransactionClient,
    principal: TenantPrincipal,
  ): Promise<PersonalManualSelfProfile> {
    const user = await transaction.user.findFirst({
      where: { tenantId: principal.tenantId, id: principal.userId },
      include: {
        memberProfile: true,
        employments: {
          where: { status: { in: ['ACTIVE', 'PENDING'] } },
          orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
          take: 1,
          include: { orgUnit: true, position: true },
        },
      },
    });
    if (user === null) throw new NotFoundException('当前成员档案不存在。');

    const employment = user.employments[0] ?? null;
    return {
      user: {
        id: user.id,
        displayName: user.displayName,
        email: user.email,
        phone: user.phone,
        avatarUrl: user.avatarUrl,
      },
      employment:
        employment === null
          ? null
          : {
              departmentName: employment.orgUnit.name,
              title: employment.position?.name ?? null,
              employeeNumber: employment.employeeNumber,
              employmentType: readEmploymentType(employment.employmentType),
            },
      manual:
        user.memberProfile === null
          ? emptyManual()
          : {
              personalSummary: user.memberProfile.personalSummary,
              educationBackground: user.memberProfile.educationBackground,
              careerOverview: user.memberProfile.careerOverview,
              jobResponsibilities: user.memberProfile.jobResponsibilities,
              communicationPreference: user.memberProfile.communicationPreference,
              collaborationHabits: user.memberProfile.collaborationHabits,
              routineSchedule: user.memberProfile.routineSchedule,
              contactInformation: user.memberProfile.contactInformation,
              coreSkills: user.memberProfile.coreSkills,
              availableResources: user.memberProfile.availableResources,
              hobbies: user.memberProfile.hobbies,
              clubs: user.memberProfile.clubs,
              faqs: readFaqs(user.memberProfile.faqs),
            },
      updatedAt: user.memberProfile?.updatedAt.toISOString() ?? null,
    };
  }
}

function normalizeManual(manual: PersonalManualContent): PersonalManualContent {
  return {
    personalSummary: normalizeText(manual.personalSummary),
    educationBackground: normalizeText(manual.educationBackground),
    careerOverview: normalizeText(manual.careerOverview),
    jobResponsibilities: normalizeText(manual.jobResponsibilities),
    communicationPreference: normalizeText(manual.communicationPreference),
    collaborationHabits: normalizeText(manual.collaborationHabits),
    routineSchedule: normalizeText(manual.routineSchedule),
    contactInformation: normalizeText(manual.contactInformation),
    coreSkills: normalizeText(manual.coreSkills),
    availableResources: normalizeText(manual.availableResources),
    hobbies: normalizeText(manual.hobbies),
    clubs: normalizeText(manual.clubs),
    faqs: manual.faqs,
  };
}

function normalizeText(value: string | null): string | null {
  const normalized = value?.trim() ?? '';
  return normalized === '' ? null : normalized;
}

function manualTextFields(manual: PersonalManualContent) {
  return {
    personalSummary: manual.personalSummary,
    educationBackground: manual.educationBackground,
    careerOverview: manual.careerOverview,
    jobResponsibilities: manual.jobResponsibilities,
    communicationPreference: manual.communicationPreference,
    collaborationHabits: manual.collaborationHabits,
    routineSchedule: manual.routineSchedule,
    contactInformation: manual.contactInformation,
    coreSkills: manual.coreSkills,
    availableResources: manual.availableResources,
    hobbies: manual.hobbies,
    clubs: manual.clubs,
  };
}

function readFaqs(value: Prisma.JsonValue): PersonalManualContent['faqs'] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const parsed = personalManualFaqSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

function emptyManual(): PersonalManualContent {
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

function readEmploymentType(
  value: string | null,
): NonNullable<PersonalManualSelfProfile['employment']>['employmentType'] {
  return ['REGULAR', 'INTERN', 'OUTSOURCED', 'LABOR', 'CONSULTANT'].includes(value ?? '')
    ? (value as NonNullable<PersonalManualSelfProfile['employment']>['employmentType'])
    : null;
}

function completedFieldCount(manual: PersonalManualContent): number {
  return Object.entries(manual).filter(([key, value]) =>
    key === 'faqs' ? manual.faqs.length > 0 : value !== null,
  ).length;
}
