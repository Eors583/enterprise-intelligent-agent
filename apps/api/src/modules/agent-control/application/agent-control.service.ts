import { Inject, Injectable } from '@nestjs/common';

import { TenantContext } from '../../../common/context/tenant-context.js';
import { canContactMemberAgent } from '../domain/agent-access.policy.js';
import type { MemberAgent } from '../domain/agent.models.js';
import { AgentRepository } from '../domain/agent.repository.js';

@Injectable()
export class AgentControlService {
  constructor(
    @Inject(TenantContext) private readonly context: TenantContext,
    @Inject(AgentRepository) private readonly repository: AgentRepository,
  ) {}

  async listMemberAgents(): Promise<readonly MemberAgent[]> {
    const principal = this.context.current;
    const agents = await this.repository.listMemberAgents(principal.tenantId);
    return agents.filter((agent) => canContactMemberAgent(principal, agent));
  }
}
