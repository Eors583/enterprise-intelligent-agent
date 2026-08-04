import { Inject, Injectable } from '@nestjs/common';
import type { AgentOperationalAvailability, BootstrapResponse } from '@enterprise/contracts';

import { TenantContext } from '../common/context/tenant-context.js';
import { AgentControlService } from '../modules/agent-control/application/agent-control.service.js';
import type { MemberAgent } from '../modules/agent-control/domain/agent.models.js';
import { AgentOperationalReadinessService } from '../modules/ai-safety-model-routing/agent-operational-readiness.service.js';
import { AuthorizationService } from '../modules/authorization/authorization.service.js';
import { DirectoryService } from '../modules/directory/application/directory.service.js';
import { IdentityService } from '../modules/identity/application/identity.service.js';

const NAVIGATION = [
  { id: 'workbench', label: '工作台' },
  { id: 'messages', label: '消息' },
  { id: 'contacts', label: '通讯录' },
  { id: 'profile', label: '我的' },
] as const satisfies BootstrapResponse['navigation'];

@Injectable()
export class BootstrapService {
  constructor(
    @Inject(TenantContext) private readonly context: TenantContext,
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(DirectoryService) private readonly directory: DirectoryService,
    @Inject(AgentControlService) private readonly agents: AgentControlService,
    @Inject(AuthorizationService)
    private readonly authorization: AuthorizationService,
    @Inject(AgentOperationalReadinessService)
    private readonly operationalReadiness: AgentOperationalReadinessService,
  ) {}

  async getBootstrap(): Promise<BootstrapResponse> {
    // Resolve and validate the request-scoped principal before starting parallel work.
    // Otherwise several services can reject concurrently for the same malformed header.
    const principal = this.context.current;
    const [{ tenant, user }, { departments, members }, agents, departmentAgents] =
      await Promise.all([
        this.identity.getCurrentIdentity(),
        this.directory.getDirectory(),
        this.agents.listMemberAgents(),
        this.agents.listDepartmentAgents(),
      ]);
    this.authorization.assertTenantAccess(principal.tenantId);
    this.authorization.assertTenantAccess(tenant.id);
    const operationalAvailabilityByAgentId = await this.operationalReadiness.inspectAgents(
      tenant.id,
      [...agents, ...departmentAgents].map(({ id }) => id),
    );

    const agentsByOwner = new Map<string, MemberAgent>(
      agents.map((agent) => [agent.ownerUserId, agent]),
    );

    return {
      tenant: { id: tenant.id, name: tenant.name },
      currentUser: {
        id: user.id,
        name: user.name,
        ...(user.title === undefined ? {} : { title: user.title }),
        ...(user.avatarUrl === undefined ? {} : { avatarUrl: user.avatarUrl }),
      },
      navigation: [...NAVIGATION],
      departments: departments.map((department) => ({
        id: department.id,
        name: department.name,
        parentId: department.parentId,
        memberCount: department.memberCount,
      })),
      members: members.map((member) => {
        const agent = agentsByOwner.get(member.id);
        const operationalAvailability =
          agent === undefined
            ? undefined
            : (operationalAvailabilityByAgentId.get(agent.id) ?? unknownAvailability());
        return {
          id: member.id,
          name: member.name,
          title: member.title,
          departmentIds: [...member.departmentIds],
          ...(member.avatarUrl === undefined ? {} : { avatarUrl: member.avatarUrl }),
          status: member.status,
          agent:
            agent === undefined
              ? null
              : {
                  id: agent.id,
                  name: agent.name,
                  status: agent.status,
                  ...(agent.summary === undefined ? {} : { summary: agent.summary }),
                  operationalAvailability: operationalAvailability ?? unknownAvailability(),
                },
          capabilities: {
            canContactHuman: member.status === 'active' && member.id !== user.id,
            canContactAgent: operationalAvailability?.status === 'AVAILABLE',
          },
        };
      }),
      departmentAgents: departmentAgents.map((agent) => ({
        id: agent.id,
        name: agent.name,
        ...(agent.summary === undefined ? {} : { summary: agent.summary }),
        departmentId: agent.orgUnitId,
        departmentName: agent.departmentName,
        status: agent.status,
        operationalAvailability:
          operationalAvailabilityByAgentId.get(agent.id) ?? unknownAvailability(),
      })),
    };
  }
}

function unknownAvailability(): AgentOperationalAvailability {
  return {
    status: 'UNKNOWN',
    evidenceStatus: 'INSUFFICIENT_EVIDENCE',
    reasonCodes: ['READINESS_RESULT_MISSING'],
    checkedAt: null,
  };
}
