import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import {
  collaborationDisclosureScopeSchema,
  type UpdateWorkAvailabilityRequest,
  type WorkAvailability,
  type WorkAvailabilitySelfResponse,
  workAvailabilityStatusSchema,
} from '@enterprise/contracts';
import type { Prisma } from '@prisma/client';

import { TenantContext, type TenantPrincipal } from '../../common/context/tenant-context.js';
import { PrismaService } from '../../database/prisma.service.js';
import { recordPeopleMutation } from './people-organization.persistence.js';

@Injectable()
export class WorkAvailabilitySelfService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(TenantContext) private readonly context: TenantContext,
  ) {}

  async get(): Promise<WorkAvailabilitySelfResponse> {
    const principal = this.context.current;
    return this.prisma.withTenant(principal.tenantId, async (transaction) => ({
      availability: mapAvailability(
        await transaction.workAvailability.findFirst({
          where: { tenantId: principal.tenantId, userId: principal.userId },
          include: { emergencyContact: { select: { id: true, displayName: true } } },
        }),
      ),
    }));
  }

  async update(request: UpdateWorkAvailabilityRequest): Promise<WorkAvailabilitySelfResponse> {
    const principal = this.context.current;
    return this.prisma.withTenant(principal.tenantId, async (transaction) => {
      await transaction.$queryRaw`SELECT set_config('app.user_id', ${principal.userId}, true)`;
      if (request.emergencyContactUserId === principal.userId) {
        throw new BadRequestException('紧急联系人不能选择自己。');
      }
      if (request.emergencyContactUserId !== null) {
        const contact = await transaction.user.findFirst({
          where: {
            tenantId: principal.tenantId,
            id: request.emergencyContactUserId,
            status: 'ACTIVE',
            employments: { some: { status: 'ACTIVE' } },
          },
          select: { id: true },
        });
        if (contact === null) throw new BadRequestException('紧急联系人当前不可用。');
      }

      const existing = await transaction.workAvailability.findFirst({
        where: { tenantId: principal.tenantId, userId: principal.userId },
        select: { id: true, revision: true },
      });
      if ((existing?.revision ?? null) !== request.expectedRevision) {
        throw new ConflictException('工作可用状态已发生变化，请刷新后重新保存。');
      }
      const data = {
        status: request.status,
        startsAt: new Date(request.startsAt),
        endsAt: request.endsAt === null ? null : new Date(request.endsAt),
        summary: normalizeText(request.summary),
        expectedResponse: normalizeText(request.expectedResponse),
        emergencyContactUserId: request.emergencyContactUserId,
        disclosureScope: request.disclosureScope,
      };
      if (existing === null) {
        await transaction.workAvailability.create({
          data: {
            tenantId: principal.tenantId,
            userId: principal.userId,
            ...data,
          },
        });
      } else {
        const changed = await transaction.workAvailability.updateMany({
          where: {
            tenantId: principal.tenantId,
            userId: principal.userId,
            revision: existing.revision,
          },
          data: { ...data, revision: { increment: 1 } },
        });
        if (changed.count !== 1) {
          throw new ConflictException('工作可用状态已发生变化，请刷新后重新保存。');
        }
      }

      await recordPeopleMutation(
        transaction,
        principal,
        'employee.availability.changed.v1',
        'work_availability',
        principal.userId,
        {
          status: request.status,
          startsAt: request.startsAt,
          endsAt: request.endsAt,
          disclosureScope: request.disclosureScope,
          hasEmergencyContact: request.emergencyContactUserId !== null,
        },
      );
      return this.read(transaction, principal);
    });
  }

  private async read(
    transaction: Prisma.TransactionClient,
    principal: TenantPrincipal,
  ): Promise<WorkAvailabilitySelfResponse> {
    return {
      availability: mapAvailability(
        await transaction.workAvailability.findFirst({
          where: { tenantId: principal.tenantId, userId: principal.userId },
          include: { emergencyContact: { select: { id: true, displayName: true } } },
        }),
      ),
    };
  }
}

function mapAvailability(
  record: {
    readonly id: string;
    readonly status: string;
    readonly startsAt: Date;
    readonly endsAt: Date | null;
    readonly summary: string | null;
    readonly expectedResponse: string | null;
    readonly disclosureScope: string;
    readonly revision: number;
    readonly updatedAt: Date;
    readonly emergencyContact: { readonly id: string; readonly displayName: string } | null;
  } | null,
): WorkAvailability | null {
  if (record === null) return null;
  return {
    id: record.id,
    status: workAvailabilityStatusSchema.parse(record.status),
    startsAt: record.startsAt.toISOString(),
    endsAt: record.endsAt?.toISOString() ?? null,
    summary: record.summary,
    expectedResponse: record.expectedResponse,
    emergencyContact: record.emergencyContact,
    disclosureScope: collaborationDisclosureScopeSchema.parse(record.disclosureScope),
    revision: record.revision,
    updatedAt: record.updatedAt.toISOString(),
    expired: record.endsAt !== null && record.endsAt <= new Date(),
  };
}

function normalizeText(value: string | null): string | null {
  const normalized = value?.trim() ?? '';
  return normalized === '' ? null : normalized;
}
