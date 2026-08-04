import type { DepartmentAgent, MemberSummary } from '@enterprise/contracts';

export interface AgentCollaborationCandidate {
  id: string;
  name: string;
  kind: 'member' | 'department';
  ownerUserId?: string;
  ownerName: string;
  departmentId?: string;
  summary?: string;
}

export function listAgentCollaborationCandidates(
  members: MemberSummary[],
  departmentAgents: DepartmentAgent[] = [],
): AgentCollaborationCandidate[] {
  const seen = new Set<string>();
  const candidates: AgentCollaborationCandidate[] = [];
  for (const member of members) {
    const agent = member.agent;
    if (
      member.status !== 'active' ||
      !member.capabilities.canContactAgent ||
      agent?.status !== 'online' ||
      agent.operationalAvailability.status !== 'AVAILABLE' ||
      seen.has(agent.id)
    ) {
      continue;
    }

    seen.add(agent.id);
    candidates.push({
      id: agent.id,
      name: agent.name,
      kind: 'member',
      ownerUserId: member.id,
      ownerName: member.name,
      ...(agent.summary ? { summary: agent.summary } : {}),
    });
  }
  for (const agent of departmentAgents) {
    if (
      agent.status !== 'online' ||
      agent.operationalAvailability.status !== 'AVAILABLE' ||
      seen.has(agent.id)
    ) {
      continue;
    }
    seen.add(agent.id);
    candidates.push({
      id: agent.id,
      name: agent.name,
      kind: 'department',
      ownerName: agent.departmentName,
      departmentId: agent.departmentId,
      ...(agent.summary ? { summary: agent.summary } : {}),
    });
  }
  return candidates;
}
