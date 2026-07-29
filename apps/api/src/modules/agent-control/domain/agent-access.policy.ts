import type { MemberAgent } from './agent.models.js';

export interface AgentAccessPrincipal {
  readonly tenantId: string;
  readonly userId: string;
}

/** Pure agent-domain visibility policy with no dependency on transport/request context. */
export function canContactMemberAgent(
  principal: AgentAccessPrincipal,
  agent: MemberAgent,
): boolean {
  if (
    agent.tenantId !== principal.tenantId ||
    agent.status === 'disabled' ||
    (agent.requiresActiveAssignment && !agent.assignedToPrincipal)
  ) {
    return false;
  }
  return (
    agent.requiresActiveAssignment ||
    agent.visibility === 'tenant' ||
    agent.ownerUserId === principal.userId ||
    agent.assignedToPrincipal
  );
}
