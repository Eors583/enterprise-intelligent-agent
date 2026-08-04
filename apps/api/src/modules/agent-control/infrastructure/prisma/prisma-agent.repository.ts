import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../../../../database/prisma.service.js';
import type { DepartmentAgent, MemberAgent } from '../../domain/agent.models.js';
import { AgentRepository } from '../../domain/agent.repository.js';
import { hasRoleAgentAssignmentMarker } from '../../domain/role-agent-assignment.policy.js';

@Injectable()
export class PrismaAgentRepository extends AgentRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {
    super();
  }

  listMemberAgents(tenantId: string, principalUserId: string): Promise<readonly MemberAgent[]> {
    return this.prisma.withTenant(tenantId, async (transaction) => {
      const now = new Date();
      const agents = await transaction.agentInstance.findMany({
        where: { tenantId, ownerUserId: { not: null } },
        include: {
          version: { select: { status: true, knowledgeScope: true } },
          _count: { select: { roleAssignments: true } },
          roleAssignments: {
            where: {
              tenantId,
              userId: principalUserId,
              status: 'ACTIVE',
              effectiveFrom: { lte: now },
              AND: [
                { OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }] },
                { employment: { is: { userId: principalUserId, status: 'ACTIVE' } } },
              ],
            },
            select: { id: true },
            take: 1,
          },
        },
        orderBy: { name: 'asc' },
      });

      const preferredByOwner = new Map<string, (typeof agents)[number]>();
      for (const agent of agents) {
        if (agent.ownerUserId === null) continue;
        const current = preferredByOwner.get(agent.ownerUserId);
        if (
          current === undefined ||
          memberAgentPreference(agent) > memberAgentPreference(current)
        ) {
          preferredByOwner.set(agent.ownerUserId, agent);
        }
      }

      const result: MemberAgent[] = [];
      for (const agent of preferredByOwner.values()) {
        if (agent.ownerUserId === null) continue;
        result.push({
          id: agent.id,
          tenantId: agent.tenantId,
          ownerUserId: agent.ownerUserId,
          name: agent.name,
          status: agent.status.toLowerCase() as MemberAgent['status'],
          versionStatus: agent.version.status.toLowerCase() as MemberAgent['versionStatus'],
          visibility: readVisibility(agent.settings),
          assignedToPrincipal: agent.roleAssignments.length > 0,
          requiresActiveAssignment:
            hasRoleAgentAssignmentMarker(agent.settings) || agent._count.roleAssignments > 0,
          ...(agent.summary === null ? {} : { summary: agent.summary }),
        });
      }
      return result;
    });
  }

  listDepartmentAgents(
    tenantId: string,
    principalUserId: string,
  ): Promise<readonly DepartmentAgent[]> {
    return this.prisma.withTenant(tenantId, async (transaction) => {
      const employments = await transaction.employment.findMany({
        where: { tenantId, userId: principalUserId, status: 'ACTIVE' },
        select: { orgUnitId: true },
      });
      const orgUnitIds = [...new Set(employments.map((item) => item.orgUnitId))];
      if (orgUnitIds.length === 0) return [];
      const agents = await transaction.agentInstance.findMany({
        where: {
          tenantId,
          kind: 'DEPARTMENT',
          orgUnitId: { in: orgUnitIds },
        },
        include: {
          version: { select: { status: true } },
          orgUnit: { select: { id: true, name: true, status: true } },
        },
        orderBy: [{ orgUnit: { name: 'asc' } }, { name: 'asc' }],
      });
      return agents.flatMap((agent): DepartmentAgent[] => {
        if (agent.orgUnit === null || agent.orgUnit.status !== 'ACTIVE') return [];
        return [
          {
            id: agent.id,
            tenantId: agent.tenantId,
            orgUnitId: agent.orgUnit.id,
            departmentName: agent.orgUnit.name,
            name: agent.name,
            status: agent.status.toLowerCase() as DepartmentAgent['status'],
            versionStatus: agent.version.status.toLowerCase() as DepartmentAgent['versionStatus'],
            visibility: 'tenant',
            assignedToPrincipal: false,
            requiresActiveAssignment: false,
            ...(agent.summary === null ? {} : { summary: agent.summary }),
          },
        ];
      });
    });
  }
}

function memberAgentPreference(agent: {
  readonly status: string;
  readonly settings: Prisma.JsonValue;
  readonly version: { readonly status: string; readonly knowledgeScope: Prisma.JsonValue };
}): number {
  return (
    (agent.status === 'ONLINE' ? 1_000 : agent.status === 'OFFLINE' ? 100 : 0) +
    (agent.version.status === 'PUBLISHED' ? 500 : 0) +
    effectiveKnowledgeBaseCount(agent.settings, agent.version.knowledgeScope) * 10
  );
}

function effectiveKnowledgeBaseCount(
  settings: Prisma.JsonValue,
  versionScope: Prisma.JsonValue,
): number {
  for (const value of [settings, versionScope]) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
    const candidate = value === settings ? value.knowledgeBaseIdsOverride : value.knowledgeBaseIds;
    if (Array.isArray(candidate)) {
      return new Set(candidate.filter((id): id is string => typeof id === 'string')).size;
    }
  }
  return 0;
}

function readVisibility(settings: Prisma.JsonValue): MemberAgent['visibility'] {
  if (
    typeof settings === 'object' &&
    settings !== null &&
    !Array.isArray(settings) &&
    settings.visibility === 'tenant'
  ) {
    return 'tenant';
  }
  // Missing or malformed policy is private-by-default.
  return 'owner';
}
