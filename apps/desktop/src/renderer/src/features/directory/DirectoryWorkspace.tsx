import type { CreateConversationRequest } from '@enterprise/contracts';
import { useEffect, useMemo, useState } from 'react';
import type { DesktopRuntimeInfo } from '../../../../shared/desktop-api';
import { ApiClientError } from '../../shared/api/client';
import { ConversationWorkspace, MessagingSidebar } from '../messaging/MessagingWorkspace';
import { listAgentCollaborationCandidates } from '../messaging/agent-collaboration';
import { useConversations, useCreateDirectConversation } from '../messaging/hooks';
import type { BootstrapPayload, Department, Member } from './bootstrap';

interface DirectoryWorkspaceProps {
  payload: BootstrapPayload;
}

type ContactKind = 'human' | 'agent';

interface ContactOperation {
  kind: ContactKind;
  memberId: string;
  request: CreateConversationRequest;
  status: 'pending' | 'error';
  message?: string | undefined;
}

const DIRECTORY_IDS = new Set(['directory', 'contacts', 'organization', 'org']);
const MESSAGE_IDS = new Set(['messages', 'messaging', 'conversations', 'chat']);

export function DirectoryWorkspace({ payload }: DirectoryWorkspaceProps): React.JSX.Element {
  const directoryNavigation =
    payload.navigation.find((item) => DIRECTORY_IDS.has(item.id.toLowerCase())) ??
    payload.navigation[0];
  const messageNavigation = payload.navigation.find((item) =>
    MESSAGE_IDS.has(item.id.toLowerCase()),
  );

  const [activeNavigationId, setActiveNavigationId] = useState(directoryNavigation?.id ?? '');
  const [selectedMemberId, setSelectedMemberId] = useState<string | null>(
    payload.members.find((member) => member.status === 'active')?.id ??
      payload.members[0]?.id ??
      null,
  );
  const [contactOperation, setContactOperation] = useState<ContactOperation | null>(null);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const runtimeInfo = useRuntimeInfo();
  const isDirectoryActive = activeNavigationId === directoryNavigation?.id;
  const isMessagesActive = activeNavigationId === messageNavigation?.id;
  const conversations = useConversations(messageNavigation !== undefined);
  const createConversation = useCreateDirectConversation();

  const departmentById = useMemo(
    () => new Map(payload.departments.map((department) => [department.id, department])),
    [payload.departments],
  );
  const collaborationAgents = useMemo(
    () => listAgentCollaborationCandidates(payload.members),
    [payload.members],
  );
  const selectedMember =
    payload.members.find((member) => member.id === selectedMemberId) ?? payload.members[0] ?? null;
  const selectedConversation =
    conversations.data?.find((conversation) => conversation.id === selectedConversationId) ?? null;

  useEffect(() => {
    if (!isMessagesActive || !conversations.data) return;
    if (!conversations.data.some((conversation) => conversation.id === selectedConversationId)) {
      setSelectedConversationId(conversations.data[0]?.id ?? null);
    }
  }, [conversations.data, isMessagesActive, selectedConversationId]);

  function selectMember(memberId: string): void {
    setSelectedMemberId(memberId);
    setContactOperation(null);
    if (directoryNavigation) setActiveNavigationId(directoryNavigation.id);
  }

  function runContactOperation(operation: ContactOperation): void {
    if (!messageNavigation) {
      setContactOperation({
        ...operation,
        status: 'error',
        message: '当前账号未获得消息模块权限，无法进入会话。',
      });
      return;
    }

    setContactOperation({ ...operation, status: 'pending', message: undefined });
    createConversation.mutate(operation.request, {
      onSuccess: (conversation) => {
        setSelectedConversationId(conversation.id);
        setActiveNavigationId(messageNavigation.id);
        setContactOperation(null);
      },
      onError: (error) => {
        setContactOperation({
          ...operation,
          status: 'error',
          message: readableContactError(error),
        });
      },
    });
  }

  function contactMember(member: Member, kind: ContactKind): void {
    const target: CreateConversationRequest['target'] =
      kind === 'human'
        ? { type: 'human', userId: member.id }
        : { type: 'agent', agentId: member.agent!.id };
    runContactOperation({
      memberId: member.id,
      kind,
      request: { type: 'direct', target },
      status: 'pending',
    });
  }

  async function startAgentCollaboration(
    agentIds: [string, string],
    turnLimit: number,
  ): Promise<void> {
    if (!messageNavigation) {
      throw new Error('当前账号未获得消息模块权限，无法创建智能体协作。');
    }
    const conversation = await createConversation.mutateAsync({
      type: 'direct',
      target: { type: 'agent_pair', agentIds, turnLimit },
    });
    setSelectedConversationId(conversation.id);
    setActiveNavigationId(messageNavigation.id);
  }

  return (
    <div className="desktop-shell">
      <header className="design-titlebar">
        <div className="design-titlebar-brand">
          <span className="design-logo">E</span>
          <div>
            <strong>企业智能体</strong>
            <small>{payload.tenant.name}</small>
          </div>
        </div>
        <label className="design-global-search">
          <span aria-hidden="true">⌕</span>
          <input type="search" placeholder="搜索成员、智能体或会话" />
          <kbd>Ctrl K</kbd>
        </label>
        <div className="design-titlebar-actions">
          <span className="design-security-state">
            <i /> 安全连接
          </span>
          <button type="button" className="design-icon-button" aria-label="通知">
            ◌
          </button>
          <span className="design-current-user" title={payload.currentUser.name}>
            {initials(payload.currentUser.name)}
          </span>
        </div>
      </header>

      <div className="desktop-layout">
        <aside className="primary-rail" aria-label="主导航">
          <div className="rail-brand" aria-label="企业 AI 协同">
            E
          </div>
          <div className="tenant-chip" title={payload.tenant.name}>
            {initials(payload.tenant.name)}
          </div>
          <nav className="rail-navigation">
            {payload.navigation.map((item) => (
              <button
                type="button"
                key={item.id}
                className={item.id === activeNavigationId ? 'rail-item active' : 'rail-item'}
                aria-current={item.id === activeNavigationId ? 'page' : undefined}
                aria-label={item.label}
                title={item.label}
                onClick={() => setActiveNavigationId(item.id)}
              >
                <span className="rail-glyph" aria-hidden="true">
                  {navigationGlyph(item.id, item.label)}
                </span>
                <small>{item.label}</small>
              </button>
            ))}
          </nav>
          <div
            className="rail-user"
            title={`${payload.currentUser.name} · ${payload.currentUser.title ?? '成员'}`}
          >
            {initials(payload.currentUser.name)}
            <span className="presence-dot" aria-label="在线" />
          </div>
        </aside>

        {isDirectoryActive || isMessagesActive ? (
          <MessagingSidebar
            organizationPanel={
              <OrganizationTreePanel
                payload={payload}
                selectedMemberId={isDirectoryActive ? (selectedMember?.id ?? null) : null}
                onSelectMember={selectMember}
                onContactAgent={(member) => contactMember(member, 'agent')}
              />
            }
            conversations={conversations.data}
            agents={collaborationAgents}
            selectedConversationId={selectedConversationId}
            isLoading={conversations.isPending}
            isError={conversations.isError}
            error={conversations.error}
            currentUserId={payload.currentUser.id}
            onSelect={(conversationId) => {
              setSelectedConversationId(conversationId);
              if (messageNavigation) setActiveNavigationId(messageNavigation.id);
            }}
            onRetry={() => conversations.refetch()}
            onCreateAgentPair={startAgentCollaboration}
          />
        ) : (
          <aside className="directory-sidebar module-sidebar">
            <p className="eyebrow">企业工作台</p>
            <h2>{payload.navigation.find((item) => item.id === activeNavigationId)?.label}</h2>
            <p>该模块尚未接入当前桌面里程碑。</p>
          </aside>
        )}

        <main className={isMessagesActive ? 'workspace messaging-active' : 'workspace'}>
          <section className="assistant-launcher" aria-label="智能体快捷入口">
            <div className="assistant-launcher-heading">
              <span>✣</span>
              <strong>智能体</strong>
              <small>选择助手开始对话</small>
            </div>
            <div className="assistant-launcher-list">
              {collaborationAgents.map((agent, index) => (
                <button
                  type="button"
                  className="assistant-launcher-card"
                  key={agent.id}
                  disabled={createConversation.isPending}
                  onClick={() =>
                    runContactOperation({
                      memberId: agent.ownerUserId,
                      kind: 'agent',
                      request: { type: 'direct', target: { type: 'agent', agentId: agent.id } },
                      status: 'pending',
                    })
                  }
                >
                  <span className={`assistant-launcher-icon ${agentTone(index)}`}>AI</span>
                  <span>
                    <strong>{agent.name}</strong>
                    <small>{agent.summary ?? `${agent.ownerName} 的个人智能体`}</small>
                  </span>
                </button>
              ))}
              {!collaborationAgents.length && (
                <p className="assistant-launcher-empty">暂无可联系的智能体</p>
              )}
            </div>
          </section>
          <header className="workspace-topbar">
            <div>
              <strong>{payload.tenant.name}</strong>
              <span className="topbar-divider" />
              <span>{isDirectoryActive ? '企业通讯录' : isMessagesActive ? '消息' : '工作台'}</span>
            </div>
            <div className="runtime-info" title="客户端运行信息">
              <span className="secure-dot" />
              桌面安全模式
              {runtimeInfo &&
                ` · v${runtimeInfo.appVersion} · ${platformLabel(runtimeInfo.platform)}`}
            </div>
          </header>

          {isDirectoryActive ? (
            selectedMember ? (
              <MemberWorkspace
                member={selectedMember}
                currentUserId={payload.currentUser.id}
                departments={selectedMember.departmentIds
                  .map((departmentId) => departmentById.get(departmentId))
                  .filter((department): department is Department => department !== undefined)}
                contactOperation={
                  contactOperation?.memberId === selectedMember.id ? contactOperation : null
                }
                onContact={(kind) => contactMember(selectedMember, kind)}
                onRetryContact={() => {
                  if (contactOperation) runContactOperation(contactOperation);
                }}
              />
            ) : (
              <EmptyWorkspace title="没有可显示的成员" description="组织中尚未返回成员数据。" />
            )
          ) : isMessagesActive ? (
            conversations.isPending ? (
              <EmptyWorkspace title="正在加载会话" description="正在从企业服务读取可访问的会话…" />
            ) : conversations.isError && conversations.data === undefined ? (
              <EmptyWorkspace
                title="会话列表加载失败"
                description={readableContactError(conversations.error)}
              />
            ) : (
              <ConversationWorkspace
                conversation={selectedConversation}
                currentUserId={payload.currentUser.id}
              />
            )
          ) : (
            <EmptyWorkspace title="模块正在建设" description="该模块尚未接入当前桌面里程碑。" />
          )}
        </main>
      </div>
    </div>
  );
}

interface OrganizationTreePanelProps {
  payload: BootstrapPayload;
  selectedMemberId: string | null;
  onSelectMember: (memberId: string) => void;
  onContactAgent: (member: Member) => void;
}

function OrganizationTreePanel({
  payload,
  selectedMemberId,
  onSelectMember,
  onContactAgent,
}: OrganizationTreePanelProps): React.JSX.Element {
  const rootDepartments = payload.departments.filter((department) => department.parentId === null);
  const [expandedDepartmentIds, setExpandedDepartmentIds] = useState<Set<string>>(
    () => new Set(rootDepartments.map((department) => department.id)),
  );

  function toggleDepartment(departmentId: string): void {
    setExpandedDepartmentIds((current) => {
      const next = new Set(current);
      if (next.has(departmentId)) next.delete(departmentId);
      else next.add(departmentId);
      return next;
    });
  }

  function renderDepartment(department: Department, depth: number): React.JSX.Element {
    const isExpanded = expandedDepartmentIds.has(department.id);
    const children = payload.departments.filter((item) => item.parentId === department.id);
    const members = payload.members.filter((member) =>
      member.departmentIds.includes(department.id),
    );
    return (
      <div
        className="organization-node"
        key={department.id}
        role="treeitem"
        aria-expanded={isExpanded}
      >
        <button
          type="button"
          className="organization-node-toggle"
          style={{ '--tree-depth': depth } as React.CSSProperties}
          onClick={() => toggleDepartment(department.id)}
        >
          <span
            className={isExpanded ? 'tree-chevron expanded' : 'tree-chevron'}
            aria-hidden="true"
          >
            ›
          </span>
          <span className="department-icon" aria-hidden="true">
            ▦
          </span>
          <strong>{department.name}</strong>
          <small>{department.memberCount}</small>
        </button>
        {isExpanded && (
          <div className="organization-node-content" role="group">
            {members.map((member) => (
              <button
                type="button"
                key={member.id}
                className={
                  member.id === selectedMemberId ? 'tree-member-row selected' : 'tree-member-row'
                }
                style={{ '--tree-depth': depth } as React.CSSProperties}
                aria-current={member.id === selectedMemberId ? 'true' : undefined}
                onClick={(event) => {
                  if ((event.target as HTMLElement).closest('[data-agent-action="true"]')) {
                    onContactAgent(member);
                    return;
                  }
                  onSelectMember(member.id);
                }}
              >
                <Avatar name={member.name} status={member.status} size="small" />
                <span className="member-row-copy">
                  <strong>{member.name}</strong>
                  <small>{member.title || '未设置职位'}</small>
                </span>
                {member.agent && member.agent.status !== 'disabled' ? (
                  <span
                    className="tree-member-ai"
                    title={`与 ${member.agent.name} 对话`}
                    aria-label={`与 ${member.agent.name} 对话`}
                    data-agent-action="true"
                  >
                    AI
                  </span>
                ) : (
                  <span className="tree-member-ai placeholder" aria-hidden="true" />
                )}
              </button>
            ))}
            {children.map((child) => renderDepartment(child, depth + 1))}
            {!members.length && !children.length && (
              <p className="organization-node-empty">暂无成员</p>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <section className="organization-tree-panel" aria-labelledby="organization-tree-title">
      <header className="unified-section-header">
        <div>
          <strong id="organization-tree-title">组织架构</strong>
          <small>
            {payload.departments.length} 个部门 · {payload.members.length} 人
          </small>
        </div>
        <span className="organization-mark" aria-hidden="true">
          ⌘
        </span>
      </header>
      <div className="organization-tree" role="tree" aria-label="组织架构">
        {rootDepartments.map((department) => renderDepartment(department, 0))}
        {!rootDepartments.length && <p className="list-empty">暂无组织数据</p>}
      </div>
    </section>
  );
}

interface MemberWorkspaceProps {
  member: Member;
  currentUserId: string;
  departments: Department[];
  contactOperation: ContactOperation | null;
  onContact: (kind: ContactKind) => void;
  onRetryContact: () => void;
}

function MemberWorkspace({
  member,
  currentUserId,
  departments,
  contactOperation,
  onContact,
  onRetryContact,
}: MemberWorkspaceProps): React.JSX.Element {
  const canContactHuman =
    member.id !== currentUserId &&
    member.status === 'active' &&
    member.capabilities.canContactHuman;
  const canContactAgent =
    member.capabilities.canContactAgent &&
    member.agent !== null &&
    member.agent.status !== 'disabled';
  const contactPending = contactOperation?.status === 'pending';

  return (
    <div className="member-workspace">
      <section className="member-hero">
        <div className="hero-pattern" aria-hidden="true" />
        <div className="member-identity">
          <Avatar name={member.name} status={member.status} size="large" />
          <div>
            <div className="identity-title-row">
              <h1>{member.name}</h1>
              <StatusPill active={member.status === 'active'} />
            </div>
            <p>{member.title || '未设置职位'}</p>
            <div className="department-breadcrumbs">
              {departments.length
                ? departments.map((department) => (
                    <span key={department.id}>{department.name}</span>
                  ))
                : '未归属部门'}
            </div>
          </div>
        </div>
        <div className="contact-actions" aria-label="联系入口">
          <button
            type="button"
            className={
              contactOperation?.kind === 'human' ? 'secondary-button selected' : 'secondary-button'
            }
            disabled={!canContactHuman || contactPending}
            onClick={() => onContact('human')}
          >
            <span className="button-icon" aria-hidden="true">
              人
            </span>
            {contactPending && contactOperation.kind === 'human' ? '正在进入…' : '联系本人'}
          </button>
          <button
            type="button"
            className={
              contactOperation?.kind === 'agent' ? 'primary-button selected' : 'primary-button'
            }
            disabled={!canContactAgent || contactPending}
            onClick={() => onContact('agent')}
          >
            <span className="button-icon ai" aria-hidden="true">
              AI
            </span>
            {contactPending && contactOperation.kind === 'agent' ? '正在进入…' : '联系智能体'}
          </button>
        </div>
      </section>

      <div className="workspace-body">
        <div className="profile-column">
          <section className="content-card info-card">
            <header>
              <div>
                <p className="eyebrow">Profile</p>
                <h2>成员信息</h2>
              </div>
            </header>
            <dl className="profile-grid">
              <div>
                <dt>姓名</dt>
                <dd>{member.name}</dd>
              </div>
              <div>
                <dt>职位</dt>
                <dd>{member.title || '未设置'}</dd>
              </div>
              <div>
                <dt>所属部门</dt>
                <dd>{departments.map((department) => department.name).join('、') || '未设置'}</dd>
              </div>
              <div>
                <dt>成员状态</dt>
                <dd>{member.status === 'active' ? '在职' : '已停用'}</dd>
              </div>
            </dl>
          </section>

          {contactOperation ? (
            <ContactOperationCard
              member={member}
              operation={contactOperation}
              onRetry={onRetryContact}
            />
          ) : (
            <section className="content-card prompt-card">
              <div className="prompt-illustration" aria-hidden="true">
                <span>人</span>
                <i />
                <span className="ai">AI</span>
              </div>
              <div>
                <h2>选择你的协作方式</h2>
                <p>直接联系成员本人，或与其已授权的个人智能体协作。两个身份始终明确区分。</p>
              </div>
            </section>
          )}
        </div>

        <aside className="agent-column">
          <section className="content-card agent-card">
            <header className="agent-card-heading">
              <div className="agent-avatar" aria-hidden="true">
                AI
              </div>
              <div>
                <p className="eyebrow">Personal Agent</p>
                <h2>{member.agent?.name ?? '未配置个人智能体'}</h2>
              </div>
            </header>
            {member.agent ? (
              <>
                <div className={`agent-status ${member.agent.status}`}>
                  <span />
                  {agentStatusLabel(member.agent.status)}
                </div>
                <p className="agent-summary">
                  {member.agent.summary || '该成员尚未公开智能体能力说明。'}
                </p>
                <div className="identity-warning">
                  <strong>AI 身份提示</strong>
                  <p>它代表已授权的知识与能力，但不是成员本人。重要决定请向本人确认。</p>
                </div>
              </>
            ) : (
              <p className="agent-summary">该成员暂未提供可联系的个人智能体。</p>
            )}
          </section>

          <section className="privacy-note">
            <span aria-hidden="true">◇</span>
            <div>
              <strong>可见范围受企业权限控制</strong>
              <p>页面只展示当前账号经后端授权返回的字段和能力。</p>
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}

function ContactOperationCard({
  member,
  operation,
  onRetry,
}: {
  member: Member;
  operation: ContactOperation;
  onRetry: () => void;
}): React.JSX.Element {
  const isAgent = operation.kind === 'agent';
  const isPending = operation.status === 'pending';
  return (
    <section
      className={
        isAgent
          ? 'content-card contact-operation-card agent'
          : 'content-card contact-operation-card'
      }
      aria-live="polite"
    >
      <div className="contact-operation-heading">
        <div className={isAgent ? 'contact-avatar ai' : 'contact-avatar'} aria-hidden="true">
          {isAgent ? 'AI' : initials(member.name)}
        </div>
        <div>
          <p className="eyebrow">{isAgent ? 'AI CONVERSATION' : 'HUMAN CONVERSATION'}</p>
          <h2>
            {isAgent ? `与 ${member.agent?.name ?? '个人智能体'} 协作` : `联系 ${member.name} 本人`}
          </h2>
        </div>
      </div>
      {isAgent && (
        <div className="ai-disclosure">联系对象是 AI 智能体，不是 {member.name} 本人。</div>
      )}
      {isPending ? (
        <div className="contact-progress" role="status">
          <span className="progress-spinner" aria-hidden="true" />
          <div>
            <strong>正在创建或复用会话</strong>
            <p>服务端确认后将自动进入消息工作区。</p>
          </div>
        </div>
      ) : (
        <div className="contact-operation-error" role="alert">
          <div>
            <strong>无法进入会话</strong>
            <p>{operation.message ?? '创建会话失败，请重试。'}</p>
          </div>
          <button type="button" onClick={onRetry}>
            重试
          </button>
        </div>
      )}
    </section>
  );
}

function EmptyWorkspace({
  title,
  description,
}: {
  title: string;
  description: string;
}): React.JSX.Element {
  return (
    <div className="empty-workspace">
      <div className="empty-symbol" aria-hidden="true">
        ◇
      </div>
      <h1>{title}</h1>
      <p>{description}</p>
    </div>
  );
}

function Avatar({
  name,
  status,
  size,
}: {
  name: string;
  status: Member['status'];
  size: 'small' | 'large';
}): React.JSX.Element {
  return (
    <span
      className={`avatar ${size}`}
      aria-label={`${name}，${status === 'active' ? '在职' : '已停用'}`}
    >
      {initials(name)}
      <i className={status === 'active' ? 'online' : 'inactive'} />
    </span>
  );
}

function StatusPill({ active }: { active: boolean }): React.JSX.Element {
  return (
    <span className={active ? 'status-pill active' : 'status-pill'}>
      {active ? '在职' : '停用'}
    </span>
  );
}

function initials(value: string): string {
  const normalized = value.trim();
  if (!normalized) return '?';
  const chunks = normalized.split(/\s+/);
  if (chunks.length > 1) {
    return chunks
      .slice(0, 2)
      .map((chunk) => chunk[0])
      .join('')
      .toLocaleUpperCase('zh-CN');
  }
  return [...normalized].slice(-2).join('').toLocaleUpperCase('zh-CN');
}

function navigationGlyph(id: string, label: string): string {
  const glyphs: Record<string, string> = {
    messages: '讯',
    messaging: '讯',
    directory: '录',
    contacts: '录',
    workbench: '工',
    projects: '项',
    knowledge: '知',
    automation: '自',
    admin: '管',
  };
  return glyphs[id.toLowerCase()] ?? [...label][0] ?? '·';
}

function agentTone(index: number): string {
  return ['violet', 'cyan', 'green', 'purple', 'orange', 'red', 'pink', 'amber', 'blue'][
    index % 9
  ]!;
}

function agentStatusLabel(status: NonNullable<Member['agent']>['status']): string {
  return { online: '智能体在线', offline: '智能体离线', disabled: '智能体已停用' }[status];
}

function readableContactError(error: unknown): string {
  if (error instanceof ApiClientError) {
    return `${error.message}${error.requestId ? `（请求 ID：${error.requestId}）` : ''}`;
  }
  return error instanceof Error ? error.message : '发生未知错误，请重试。';
}

function platformLabel(platform: DesktopRuntimeInfo['platform']): string {
  return { win32: 'Windows', darwin: 'macOS', linux: 'Linux', other: 'Desktop' }[platform];
}

function useRuntimeInfo(): DesktopRuntimeInfo | null {
  const [runtimeInfo, setRuntimeInfo] = useState<DesktopRuntimeInfo | null>(null);

  useEffect(() => {
    let disposed = false;
    void window.enterpriseDesktop
      .getRuntimeInfo()
      .then((info) => {
        if (!disposed) setRuntimeInfo(info);
      })
      .catch(() => {
        // Runtime metadata is decorative and must not block business bootstrap.
      });
    return () => {
      disposed = true;
    };
  }, []);

  return runtimeInfo;
}
