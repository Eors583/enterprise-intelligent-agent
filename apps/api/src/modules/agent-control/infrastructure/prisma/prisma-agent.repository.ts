import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../../../../database/prisma.service.js';
import type { MemberAgent } from '../../domain/agent.models.js';
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
          version: { select: { status: true } },
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

      const result: MemberAgent[] = [];
      for (const agent of agents) {
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
