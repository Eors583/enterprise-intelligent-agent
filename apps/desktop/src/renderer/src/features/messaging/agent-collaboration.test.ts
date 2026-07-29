import type { MemberSummary } from '@enterprise/contracts';
import { describe, expect, it } from 'vitest';
import { listAgentCollaborationCandidates } from './agent-collaboration';

function member(
  id: string,
  overrides: Partial<MemberSummary> & Pick<MemberSummary, 'agent'>,
): MemberSummary {
  return {
    id,
    name: `成员 ${id}`,
    title: '工程师',
    departmentIds: [],
    status: 'active',
    capabilities: { canContactHuman: true, canContactAgent: true },
    ...overrides,
  };
}

describe('listAgentCollaborationCandidates', () => {
  it('只返回当前用户可联系且在线的在职成员智能体，并去重', () => {
    const onlineAgent = {
      id: '00000000-0000-7000-8000-000000000201',
      name: '研发智能体',
      status: 'online' as const,
      summary: '负责研发方案',
      operationalAvailability: {
        status: 'AVAILABLE' as const,
        evidenceStatus: 'VERIFIED' as const,
        reasonCodes: [],
        checkedAt: '2026-07-28T01:00:00.000Z',
      },
    };
    const result = listAgentCollaborationCandidates([
      member('user-1', { name: '林晓', agent: onlineAgent }),
      member('user-2', { name: '重复归属', agent: onlineAgent }),
      member('user-3', {
        agent: {
          id: '00000000-0000-7000-8000-000000000202',
          name: '离线智能体',
          status: 'offline',
          operationalAvailability: {
            status: 'NOT_READY',
            evidenceStatus: 'INSUFFICIENT_EVIDENCE',
            reasonCodes: ['AGENT_CONFIGURATION_NOT_ONLINE'],
            checkedAt: null,
          },
        },
      }),
      member('user-4', {
        capabilities: { canContactHuman: true, canContactAgent: false },
        agent: {
          id: '00000000-0000-7000-8000-000000000203',
          name: '不可联系智能体',
          status: 'online',
          operationalAvailability: {
            status: 'AVAILABLE',
            evidenceStatus: 'VERIFIED',
            reasonCodes: [],
            checkedAt: '2026-07-28T01:00:00.000Z',
          },
        },
      }),
      member('user-5', {
        status: 'inactive',
        agent: {
          id: '00000000-0000-7000-8000-000000000204',
          name: '离职成员智能体',
          status: 'online',
          operationalAvailability: {
            status: 'AVAILABLE',
            evidenceStatus: 'VERIFIED',
            reasonCodes: [],
            checkedAt: '2026-07-28T01:00:00.000Z',
          },
        },
      }),
    ]);

    expect(result).toEqual([
      {
        id: onlineAgent.id,
        name: onlineAgent.name,
        ownerUserId: 'user-1',
        ownerName: '林晓',
        summary: onlineAgent.summary,
      },
    ]);
  });
});
