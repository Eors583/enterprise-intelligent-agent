import { Inject, Injectable } from '@nestjs/common';
import {
  roleDefinitionSnapshotSchema,
  roleAssignmentListResponseSchema,
  type RoleAssignment,
  type RoleAssignmentListResponse,
} from '@enterprise/contracts';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../database/prisma.service.js';
import { IdentityService } from '../identity/application/identity.service.js';

const roleAssignmentInclude = {
  user: { select: { id: true, tenantId: true, displayName: true, status: true } },
  employment: {
    select: {
      id: true,
      tenantId: true,
      organizationId: true,
      orgUnitId: true,
      positionId: true,
      status: true,
    },
  },
  agentInstance: {
    select: {
      id: true,
      tenantId: true,
      name: true,
      status: true,
      versionId: true,
      version: {
        select: {
          tenantId: true,
          version: true,
          status: true,
          roleDefinitionSnapshot: true,
          blueprintRevision: true,
          template: { select: { id: true, key: true, name: true } },
        },
      },
    },
  },
  createdBy: { select: { id: true, displayName: true } },
  revokedBy: { select: { id: true, displayName: true } },
} satisfies Prisma.RoleAssignmentInclude;

type RoleAssignmentRecord = Prisma.RoleAssignmentGetPayload<{
  include: typeof roleAssignmentInclude;
}>;

@Injectable()
export class MyRoleAssignmentService {
  constructor(
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  async listMine(): Promise<RoleAssignmentListResponse> {
    const { tenant, user } = await this.identity.getCurrentIdentity();

    return this.prisma.withTenant(tenant.id, async (transaction) => {
      const assignments = await transaction.roleAssignment.findMany({
        where: {
          tenantId: tenant.id,
          userId: user.id,
        },
        include: roleAssignmentInclude,
        orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }, { id: 'asc' }],
        take: 200,
      });

      // RLS and the compound predicate are both required. The final relation check
      // is defense in depth against an accidentally broadened include/query later.
      const items = assignments
        .filter(
          (assignment) =>
            assignment.tenantId === tenant.id &&
            assignment.userId === user.id &&
            assignment.user.id === user.id &&
            assignment.user.tenantId === tenant.id &&
            assignment.employment.tenantId === tenant.id &&
            assignment.agentInstance.tenantId === tenant.id &&
            assignment.agentInstance.version.tenantId === tenant.id,
        )
        .map(mapRoleAssignment);

      return roleAssignmentListResponseSchema.parse({ items });
    });
  }
}

function mapRoleAssignment(record: RoleAssignmentRecord): RoleAssignment {
  return {
    id: record.id,
    key: record.key,
    status: record.status,
    source: record.source,
    effectiveFrom: record.effectiveFrom.toISOString(),
    effectiveTo: record.effectiveTo?.toISOString() ?? null,
    organizationScope: jsonRecord(record.organizationScope),
    permissionScope: jsonRecord(record.permissionScope),
    memoryPolicy: jsonRecord(record.memoryPolicy),
    delegatedFromAssignmentId: record.delegatedFromAssignmentId,
    roleDefinitionSnapshot: parseRoleDefinitionSnapshot(
      record.agentInstance.version.roleDefinitionSnapshot,
    ),
    blueprintRevision: record.agentInstance.version.blueprintRevision,
    assignee: {
      id: record.user.id,
      displayName: record.user.displayName,
      status: record.user.status,
    },
    employment: {
      id: record.employment.id,
      organizationId: record.employment.organizationId,
      orgUnitId: record.employment.orgUnitId,
      positionId: record.employment.positionId,
      status: record.employment.status,
    },
    agent: {
      id: record.agentInstance.id,
      name: record.agentInstance.name,
      status: record.agentInstance.status,
      versionId: record.agentInstance.versionId,
      version: record.agentInstance.version.version,
      versionStatus: record.agentInstance.version.status,
      template: record.agentInstance.version.template,
    },
    createdBy: record.createdBy,
    revokedAt: record.revokedAt?.toISOString() ?? null,
    revokedBy: record.revokedBy,
    revokeReason: record.revokeReason,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

function jsonRecord(value: Prisma.JsonValue): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function parseRoleDefinitionSnapshot(
  value: Prisma.JsonValue,
): RoleAssignment['roleDefinitionSnapshot'] {
  const parsed = roleDefinitionSnapshotSchema.safeParse(jsonRecord(value));
  return parsed.success ? parsed.data : null;
}
