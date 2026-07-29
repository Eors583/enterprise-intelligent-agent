import type { MemberAgent } from './agent.models.js';

export abstract class AgentRepository {
  abstract listMemberAgents(
    tenantId: string,
    principalUserId: string,
  ): Promise<readonly MemberAgent[]>;
}
