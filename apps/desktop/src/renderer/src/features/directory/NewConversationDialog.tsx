import type { MemberSummary } from '@enterprise/contracts';
import { useEffect, useId, useMemo, useState } from 'react';

import type { AgentCollaborationCandidate } from '../messaging/agent-collaboration';

interface NewConversationDialogProps {
  members: readonly MemberSummary[];
  agents: readonly AgentCollaborationCandidate[];
  currentUserId: string;
  initialKind?: 'all' | 'agent';
  pending: boolean;
  onClose: () => void;
  onSelectMember: (member: MemberSummary) => void;
  onSelectAgent: (member: MemberSummary) => void;
  onSelectStandaloneAgent: (agent: AgentCollaborationCandidate) => void;
  onCreateGroup: (
    title: string,
    memberUserIds: readonly string[],
    agentIds: readonly string[],
  ) => void;
}

export function NewConversationDialog({
  members,
  agents,
  currentUserId,
  initialKind = 'all',
  pending,
  onClose,
  onSelectMember,
  onSelectAgent,
  onSelectStandaloneAgent,
  onCreateGroup,
}: NewConversationDialogProps): React.JSX.Element {
  const titleId = useId();
  const [mode, setMode] = useState<'direct' | 'group'>('direct');
  const [query, setQuery] = useState('');
  const [groupTitle, setGroupTitle] = useState('');
  const [selectedMemberIds, setSelectedMemberIds] = useState<Set<string>>(() => new Set());
  const [selectedAgentIds, setSelectedAgentIds] = useState<Set<string>>(() => new Set());
  const normalized = query.normalize('NFKC').trim().toLocaleLowerCase('zh-CN');
  const agentByOwnerId = useMemo(
    () =>
      new Map(
        agents.flatMap((agent) =>
          agent.ownerUserId === undefined ? [] : [[agent.ownerUserId, agent] as const],
        ),
      ),
    [agents],
  );
  const memberCandidates = members.filter((member) => {
    if (member.status !== 'active' || member.id === currentUserId) return false;
    if (initialKind === 'agent' && !agentByOwnerId.has(member.id)) return false;
    if (!normalized) return true;
    return [member.name, member.title, member.agent?.name, member.agent?.summary].some((value) =>
      value?.normalize('NFKC').toLocaleLowerCase('zh-CN').includes(normalized),
    );
  });
  const standaloneAgents = agents.filter((agent) => {
    if (agent.kind !== 'department') return false;
    if (!normalized) return true;
    return [agent.name, agent.ownerName, agent.summary].some((value) =>
      value?.normalize('NFKC').toLocaleLowerCase('zh-CN').includes(normalized),
    );
  });

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !pending) onClose();
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [onClose, pending]);

  function toggle(setter: React.Dispatch<React.SetStateAction<Set<string>>>, id: string): void {
    setter((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAgent(agentId: string): void {
    setSelectedAgentIds((current) => {
      const next = new Set(current);
      if (next.has(agentId)) next.delete(agentId);
      else if (next.size < 2) next.add(agentId);
      return next;
    });
  }

  const selectedCount = selectedMemberIds.size + selectedAgentIds.size;

  return (
    <div
      className="new-conversation-backdrop"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target && !pending) onClose();
      }}
    >
      <section
        className="new-conversation-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <header>
          <div>
            <p className="eyebrow">NEW CONVERSATION</p>
            <h2 id={titleId}>{initialKind === 'agent' ? '询问智能体' : '新建会话'}</h2>
            <p>
              {mode === 'group'
                ? '选择员工和智能体。只选择多个智能体即可发起头脑风暴。'
                : '可联系员工本人、员工智能体或部门智能体。'}
            </p>
          </div>
          <button type="button" aria-label="关闭新建会话" disabled={pending} onClick={onClose}>
            ×
          </button>
        </header>

        {initialKind !== 'agent' ? (
          <div className="new-conversation-mode" role="tablist" aria-label="会话类型">
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'direct'}
              className={mode === 'direct' ? 'selected' : undefined}
              onClick={() => setMode('direct')}
            >
              单聊
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'group'}
              className={mode === 'group' ? 'selected' : undefined}
              onClick={() => setMode('group')}
            >
              群聊 / 头脑风暴
            </button>
          </div>
        ) : null}

        {mode === 'group' ? (
          <label className="new-conversation-group-title">
            <span>群名称</span>
            <input
              value={groupTitle}
              maxLength={200}
              placeholder="例如：新品发布头脑风暴"
              onChange={(event) => setGroupTitle(event.target.value)}
            />
          </label>
        ) : null}

        <label className="new-conversation-search">
          <span aria-hidden="true">⌕</span>
          <input
            autoFocus
            type="search"
            value={query}
            placeholder="搜索员工、员工智能体或部门智能体"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>

        <div className="new-conversation-list">
          {standaloneAgents.length > 0 ? (
            <div className="new-conversation-section-label">部门智能体</div>
          ) : null}
          {standaloneAgents.map((agent) => {
            const selected = selectedAgentIds.has(agent.id);
            return (
              <article
                key={agent.id}
                className={mode === 'group' && selected ? 'selected' : undefined}
              >
                <span className="new-conversation-avatar agent">AI</span>
                <div>
                  <strong>{agent.name}</strong>
                  <small>
                    {agent.ownerName} · {agent.summary ?? '部门共享知识智能体'}
                  </small>
                </div>
                {mode === 'group' ? (
                  <label className="new-conversation-member-check">
                    <input
                      type="checkbox"
                      checked={selected}
                      disabled={pending}
                      onChange={() => toggleAgent(agent.id)}
                    />
                    <span>{selected ? '已选择' : '加入群聊'}</span>
                  </label>
                ) : (
                  <button
                    type="button"
                    className="agent"
                    disabled={pending}
                    onClick={() => onSelectStandaloneAgent(agent)}
                  >
                    询问智能体
                  </button>
                )}
              </article>
            );
          })}

          {memberCandidates.length > 0 ? (
            <div className="new-conversation-section-label">员工与员工智能体</div>
          ) : null}
          {memberCandidates.map((member) => {
            const memberAgent = agentByOwnerId.get(member.id);
            const memberSelected = selectedMemberIds.has(member.id);
            const agentSelected = memberAgent !== undefined && selectedAgentIds.has(memberAgent.id);
            const canContactAgent = memberAgent !== undefined;
            return (
              <article
                key={member.id}
                className={
                  mode === 'group' && (memberSelected || agentSelected) ? 'selected' : undefined
                }
              >
                <span className="new-conversation-avatar">{initials(member.name)}</span>
                <div>
                  <strong>{member.name}</strong>
                  <small>{member.title}</small>
                </div>
                {mode === 'group' ? (
                  <div className="new-conversation-member-check group-targets">
                    <label>
                      <input
                        type="checkbox"
                        checked={memberSelected}
                        disabled={pending}
                        onChange={() => toggle(setSelectedMemberIds, member.id)}
                      />
                      <span>员工</span>
                    </label>
                    {memberAgent ? (
                      <label>
                        <input
                          type="checkbox"
                          checked={agentSelected}
                          disabled={pending}
                          onChange={() => toggleAgent(memberAgent.id)}
                        />
                        <span>智能体</span>
                      </label>
                    ) : null}
                  </div>
                ) : initialKind === 'agent' ? (
                  <button
                    type="button"
                    className="agent"
                    disabled={pending || !canContactAgent}
                    onClick={() => onSelectAgent(member)}
                  >
                    询问智能体
                  </button>
                ) : (
                  <div className="new-conversation-direct-actions">
                    <button type="button" disabled={pending} onClick={() => onSelectMember(member)}>
                      联系本人
                    </button>
                    <button
                      type="button"
                      className="agent"
                      disabled={pending || !canContactAgent}
                      onClick={() => onSelectAgent(member)}
                    >
                      询问智能体
                    </button>
                  </div>
                )}
              </article>
            );
          })}

          {standaloneAgents.length === 0 && memberCandidates.length === 0 ? (
            <div className="new-conversation-empty">
              <strong>没有可联系的对象</strong>
              <p>当前授权范围内没有匹配的员工或可用智能体。</p>
            </div>
          ) : null}
        </div>

        {mode === 'group' ? (
          <footer className="new-conversation-group-actions">
            <span>
              已选择 {selectedMemberIds.size} 名员工、{selectedAgentIds.size} 个智能体 （智能体最多
              2 个）
            </span>
            <button
              type="button"
              disabled={pending || groupTitle.trim().length === 0 || selectedCount === 0}
              onClick={() =>
                onCreateGroup(groupTitle.trim(), [...selectedMemberIds], [...selectedAgentIds])
              }
            >
              {pending ? '正在创建…' : selectedAgentIds.size >= 2 ? '开始头脑风暴' : '创建群聊'}
            </button>
          </footer>
        ) : null}
      </section>
    </div>
  );
}

function initials(value: string): string {
  return [...value.trim()].slice(-2).join('').toLocaleUpperCase('zh-CN') || '?';
}
