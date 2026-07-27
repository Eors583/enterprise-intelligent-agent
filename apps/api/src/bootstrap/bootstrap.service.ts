import { Inject, Injectable } from '@nestjs/common';
import type { BootstrapResponse } from '@enterprise/contracts';

import { TenantContext } from '../common/context/tenant-context.js';
import { AgentControlService } from '../modules/agent-control/application/agent-control.service.js';
import type { MemberAgent } from '../modules/agent-control/domain/agent.models.js';
import { AuthorizationService } from '../modules/authorization/authorization.service.js';
import { DirectoryService } from '../modules/directory/application/directory.service.js';
import { IdentityService } from '../modules/identity/application/identity.service.js';

const NAVIGATION: BootstrapResponse['navigation'] = [
  { id: 'home', label: '首页' },
  { id: 'messages', label: '消息' },
  { id: 'contacts', label: '通讯录' },
  { id: 'agents', label: '智能体' },
  { id: 'work', label: '工作台' },
];

@Injectable()
export class BootstrapService {
  constructor(
    @Inject(TenantContext) private readonly context: TenantContext,
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(DirectoryService) private readonly directory: DirectoryService,
    @Inject(AgentControlService) private readonly agents: AgentControlService,
    @Inject(AuthorizationService)
    private readonly authorization: AuthorizationService,
  ) {}

  async getBootstrap(): Promise<BootstrapResponse> {
    // Resolve and validate the request-scoped principal before starting parallel work.
    // Otherwise several services can reject concurrently for the same malformed header.
    const principal = this.context.current;
    const [{ tenant, user }, { departments, members }, agents] = await Promise.all([
      this.identity.getCurrentIdentity(),
      this.directory.getDirectory(),
      this.agents.listMemberAgents(),
    ]);
    this.authorization.assertTenantAccess(principal.tenantId);
    this.authorization.assertTenantAccess(tenant.id);

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
      navigation: NAVIGATION,
      departments: departments.map((department) => ({
        id: department.id,
        name: department.name,
        parentId: department.parentId,
        memberCount: department.memberCount,
      })),
      members: members.map((member) => {
        const agent = agentsByOwner.get(member.id);
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
                },
          capabilities: {
            canContactHuman: member.status === 'active' && member.id !== user.id,
            canContactAgent:
              agent !== undefined &&
              agent.status === 'online' &&
              agent.versionStatus === 'published',
          },
        };
      }),
    };
  }
}
