import type { Conversation, MemberSummary } from '@enterprise/contracts';
import { describe, expect, it } from 'vitest';

import { unifiedSearchResults } from './DirectoryWorkspace';

const member: MemberSummary = {
  id: 'member-1',
  name: '林晓',
  title: '产品经理',
  departmentIds: ['department-1'],
  status: 'active',
  agent: {
    id: 'agent-1',
    name: '产品决策智能体',
    status: 'online',
    summary: '协助梳理产品决策',
    operationalAvailability: {
      status: 'AVAILABLE',
      evidenceStatus: 'VERIFIED',
      reasonCodes: [],
      checkedAt: '2026-07-28T01:00:00.000Z',
    },
  },
  capabilities: {
    canContactHuman: true,
    canContactAgent: true,
  },
};

const conversation: Conversation = {
  id: 'conversation-1',
  type: 'direct',
  title: '需求评审',
  participants: [
    { type: 'user', id: 'member-current', name: '我' },
    { type: 'user', id: member.id, name: member.name },
  ],
  lastMessageAt: null,
  createdAt: '2026-07-28T00:00:00.000Z',
  updatedAt: '2026-07-28T00:00:00.000Z',
};

describe('unifiedSearchResults', () => {
  it('searches authorized members, online agents, and accessible conversations', () => {
    expect(unifiedSearchResults('林晓', [member], [conversation])).toEqual([
      expect.objectContaining({ kind: 'member', id: member.id }),
      expect.objectContaining({ kind: 'agent', id: member.agent?.id }),
      expect.objectContaining({ kind: 'conversation', id: conversation.id }),
    ]);
    expect(unifiedSearchResults('产品决策', [member], [conversation])).toEqual([
      expect.objectContaining({ kind: 'agent', id: member.agent?.id }),
    ]);
    expect(unifiedSearchResults('需求评审', [member], [conversation])).toEqual([
      expect.objectContaining({ kind: 'conversation', id: conversation.id }),
    ]);
  });

  it('does not expose disabled, offline, or unauthorized agents', () => {
    const restrictedMember: MemberSummary = {
      ...member,
      agent: { ...member.agent!, status: 'offline' },
      capabilities: { ...member.capabilities, canContactAgent: false },
    };

    expect(unifiedSearchResults('智能体', [restrictedMember], [])).toEqual([]);
  });

  it('keeps an enabled agent searchable when provider evidence is not ready', () => {
    const unavailableMember: MemberSummary = {
      ...member,
      agent: {
        ...member.agent!,
        operationalAvailability: {
          status: 'NOT_READY',
          evidenceStatus: 'INSUFFICIENT_EVIDENCE',
          reasonCodes: ['RUNTIME_PROVIDER_NOT_READY'],
          checkedAt: '2026-07-28T01:00:00.000Z',
        },
      },
    };

    expect(unifiedSearchResults('产品决策智能体', [unavailableMember], [])).toEqual([
      expect.objectContaining({ kind: 'agent', id: unavailableMember.agent?.id }),
    ]);
  });

  it('normalizes full-width input and gives untitled conversations an honest label', () => {
    const untitledConversation: Conversation = {
      ...conversation,
      title: null,
      participants: [
        { type: 'user', id: 'member-current', name: '我' },
        { type: 'agent', id: 'agent-2', name: '财务ＡＩ' },
      ],
    };

    expect(unifiedSearchResults('ai', [], [untitledConversation])).toEqual([
      expect.objectContaining({
        kind: 'conversation',
        label: '未命名会话',
      }),
    ]);
  });
});
