import type { MemberAgent } from './agent.models.js';

export abstract class AgentRepository {
  abstract listMemberAgents(tenantId: string): Promise<readonly MemberAgent[]>;
}
