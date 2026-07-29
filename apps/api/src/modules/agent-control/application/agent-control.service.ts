import { Inject, Injectable } from '@nestjs/common';

import { TenantContext } from '../../../common/context/tenant-context.js';
import { AuthorizationService } from '../../authorization/authorization.service.js';
import { canContactMemberAgent } from '../domain/agent-access.policy.js';
import type { MemberAgent } from '../domain/agent.models.js';
import { AgentRepository } from '../domain/agent.repository.js';

@Injectable()
export class AgentControlService {
  constructor(
    @Inject(TenantContext) private readonly context: TenantContext,
    @Inject(AgentRepository) private readonly repository: AgentRepository,
    @Inject(AuthorizationService) private readonly authorization: AuthorizationService,
  ) {}

  async listMemberAgents(): Promise<readonly MemberAgent[]> {
    const principal = this.context.current;
    this.authorization.requireCurrent({
      action: 'agent.list',
      resourceTenantId: principal.tenantId,
      risk: 'LOW',
    });
    const agents = await this.repository.listMemberAgents(principal.tenantId, principal.userId);
    return agents.filter((agent) => {
      if (!canContactMemberAgent(principal, agent)) return false;
      return this.authorization.decideCurrent({
        action: 'agent.use',
        resourceTenantId: agent.tenantId,
        assignment: agent.assignedToPrincipal
          ? {
              tenantId: agent.tenantId,
              userId: principal.userId,
              agentInstanceId: agent.id,
              status: 'ACTIVE',
              employmentActive: true,
            }
          : null,
        taskContext: {
          assignmentRequired: agent.requiresActiveAssignment,
          resourceAgentId: agent.id,
          resourceOwnerUserId: agent.ownerUserId,
          resourceVisibility: agent.visibility,
        },
        risk: 'LOW',
      }).allowed;
    });
  }
}
