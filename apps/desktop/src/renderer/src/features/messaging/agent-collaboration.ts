import type { MemberSummary } from '@enterprise/contracts';

export interface AgentCollaborationCandidate {
  id: string;
  name: string;
  ownerUserId: string;
  ownerName: string;
  summary?: string;
}

export function listAgentCollaborationCandidates(
  members: MemberSummary[],
): AgentCollaborationCandidate[] {
  const seen = new Set<string>();
  return members.flatMap((member) => {
    const agent = member.agent;
    if (
      member.status !== 'active' ||
      !member.capabilities.canContactAgent ||
      agent?.status !== 'online' ||
      agent.operationalAvailability.status !== 'AVAILABLE' ||
      seen.has(agent.id)
    ) {
      return [];
    }

    seen.add(agent.id);
    return [
      {
        id: agent.id,
        name: agent.name,
        ownerUserId: member.id,
        ownerName: member.name,
        ...(agent.summary ? { summary: agent.summary } : {}),
      },
    ];
  });
}
