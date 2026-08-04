import type {
  Conversation,
  CreateConversationRequest,
  RoleAssignment,
} from '@enterprise/contracts';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { DesktopRuntimeInfo } from '../../../../shared/desktop-api';
import { ApiClientError } from '../../shared/api/client';
import type { AccountMenuDestination } from '../auth/AccountSwitcher';
import { ConversationWorkspace, MessagingSidebar } from '../messaging/MessagingWorkspace';
import {
  listAgentCollaborationCandidates,
  type AgentCollaborationCandidate,
} from '../messaging/agent-collaboration';
import { useConversations, useCreateDirectConversation } from '../messaging/hooks';
import { RoleWorkspace } from '../roles/RoleWorkspace';
import { useMyRoleAssignments } from '../roles/hooks';
import { defaultRoleAssignmentId, roleAgentAvailability } from '../roles/role-assignment-view';
import { WorkbenchTaskWorkspace } from '../workbench/WorkbenchWorkspace';
import { useWorkbenchObjectives, useWorkbenchTasks } from '../workbench/hooks';
import type { BootstrapPayload, Department, Member } from './bootstrap';
import { EmployeeWorkbenchOverview } from './EmployeeWorkbenchOverview';
import {
  buildEmployeeNavigation,
  employeeSectionForLegacyId,
  initialEmployeeSection,
  type EmployeeSection,
} from './employee-navigation';
import {
  AboutWorkspace,
  AccountSecurityWorkspace,
  MyOverviewWorkspace,
  type MySection,
} from './MyWorkspace';
import { NewConversationDialog } from './NewConversationDialog';

interface DirectoryWorkspaceProps {
  payload: BootstrapPayload;
  navigationRequest?: { destination: AccountMenuDestination; requestId: number } | null | undefined;
  onOpenAccountMenu?: (() => void) | undefined;
  onChangePassword?: (() => void) | undefined;
}

type ContactKind = 'human' | 'agent';

interface ContactOperation {
  kind: ContactKind;
  memberId: string;
  assignmentId?: string | undefined;
  request: CreateConversationRequest;
  status: 'pending' | 'error';
  message?: string | undefined;
}

type UnifiedSearchResult =
  | {
      readonly kind: 'member';
      readonly id: string;
      readonly label: string;
      readonly detail: string;
      readonly member: Member;
    }
  | {
      readonly kind: 'agent';
      readonly id: string;
      readonly label: string;
      readonly detail: string;
      readonly agentId: string;
      readonly ownerUserId: string;
    }
  | {
      readonly kind: 'conversation';
      readonly id: string;
      readonly label: string;
      readonly detail: string;
      readonly conversationId: string;
    };

export function DirectoryWorkspace({
  payload,
  navigationRequest,
  onOpenAccountMenu = () => undefined,
  onChangePassword = () => undefined,
}: DirectoryWorkspaceProps): React.JSX.Element {
  const employeeNavigation = useMemo(
    () => buildEmployeeNavigation(payload.navigation),
    [payload.navigation],
  );
  const [activeNavigationId, setActiveNavigationId] = useState<EmployeeSection>(() =>
    initialEmployeeSection(globalThis.location?.hash ?? '', employeeNavigation),
  );
  const [selectedMemberId, setSelectedMemberId] = useState<string | null>(
    payload.members.find((member) => member.status === 'active')?.id ??
      payload.members[0]?.id ??
      null,
  );
  const [contactOperation, setContactOperation] = useState<ContactOperation | null>(null);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [preferredResponseTarget, setPreferredResponseTarget] = useState<{
    conversationId: string;
    kind: ContactKind;
  } | null>(null);
  const [selectedRoleAssignmentId, setSelectedRoleAssignmentId] = useState<string | null>(null);
  const [selectedObjectiveId, setSelectedObjectiveId] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [mySection, setMySection] = useState<MySection>('overview');
  const [newConversationKind, setNewConversationKind] = useState<'all' | 'agent' | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchFocused, setSearchFocused] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const runtimeInfo = useRuntimeInfo();
  const isDirectoryActive = activeNavigationId === 'directory';
  const isMessagesActive = activeNavigationId === 'messages';
  const isWorkbenchActive = activeNavigationId === 'workbench';
  const isMyActive = activeNavigationId === 'my';
  const canUseMessages = employeeNavigation.some((item) => item.id === 'messages');
  const conversations = useConversations(canUseMessages);
  const roleAssignments = useMyRoleAssignments(isMyActive);
  const workbenchObjectives = useWorkbenchObjectives(isWorkbenchActive);
  const workbenchTasks = useWorkbenchTasks(isWorkbenchActive);
  const createConversation = useCreateDirectConversation();

  useEffect(() => {
    if (!navigationRequest) return;
    if (!employeeNavigation.some((item) => item.id === navigationRequest.destination)) return;
    setActiveNavigationId(navigationRequest.destination);
    if (navigationRequest.destination === 'my') setMySection('overview');
  }, [employeeNavigation, navigationRequest]);

  const departmentById = useMemo(
    () => new Map(payload.departments.map((department) => [department.id, department])),
    [payload.departments],
  );
  const collaborationAgents = useMemo(
    () => listAgentCollaborationCandidates(payload.members, payload.departmentAgents),
    [payload.departmentAgents, payload.members],
  );
  const selectedMember =
    payload.members.find((member) => member.id === selectedMemberId) ?? payload.members[0] ?? null;
  const selectedConversation =
    conversations.data?.find((conversation) => conversation.id === selectedConversationId) ?? null;
  const selectedRoleAssignment =
    roleAssignments.data?.find((assignment) => assignment.id === selectedRoleAssignmentId) ?? null;
  const selectedObjective =
    workbenchObjectives.data?.find((objective) => objective.id === selectedObjectiveId) ?? null;
  const selectedTask = workbenchTasks.data?.find((task) => task.id === selectedTaskId) ?? null;
  const searchResults = useMemo(
    () => unifiedSearchResults(searchQuery, payload.members, conversations.data ?? []),
    [conversations.data, payload.members, searchQuery],
  );

  useEffect(() => {
    const focusSearch = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        searchInputRef.current?.focus();
        setSearchFocused(true);
      }
      if (event.key === 'Escape' && document.activeElement === searchInputRef.current) {
        setSearchQuery('');
        setSearchFocused(false);
        searchInputRef.current?.blur();
      }
    };
    window.addEventListener('keydown', focusSearch);
    return () => window.removeEventListener('keydown', focusSearch);
  }, []);

  useEffect(() => {
    const followCompatibleHash = (): void => {
      const section = employeeSectionForLegacyId(window.location?.hash ?? '');
      if (section && employeeNavigation.some((item) => item.id === section)) {
        setActiveNavigationId(section);
      }
    };
    window.addEventListener('hashchange', followCompatibleHash);
    return () => window.removeEventListener('hashchange', followCompatibleHash);
  }, [employeeNavigation]);

  useEffect(() => {
    if (!employeeNavigation.some((item) => item.id === activeNavigationId)) {
      setActiveNavigationId(initialEmployeeSection('', employeeNavigation));
      return;
    }
    if (!window.location || !window.history) return;
    const nextHash = `#${activeNavigationId}`;
    if (window.location.hash !== nextHash) {
      window.history.replaceState(null, '', nextHash);
    }
  }, [activeNavigationId, employeeNavigation]);

  useEffect(() => {
    if (!isMessagesActive || !conversations.data) return;
    if (!conversations.data.some((conversation) => conversation.id === selectedConversationId)) {
      setSelectedConversationId(conversations.data[0]?.id ?? null);
    }
  }, [conversations.data, isMessagesActive, selectedConversationId]);

  useEffect(() => {
    if (!roleAssignments.data) return;
    if (
      selectedRoleAssignmentId === null ||
      !roleAssignments.data.some((assignment) => assignment.id === selectedRoleAssignmentId)
    ) {
      setSelectedRoleAssignmentId(defaultRoleAssignmentId(roleAssignments.data));
    }
  }, [roleAssignments.data, selectedRoleAssignmentId]);

  useEffect(() => {
    if (!workbenchObjectives.data) return;
    if (
      selectedObjectiveId === null ||
      !workbenchObjectives.data.some((objective) => objective.id === selectedObjectiveId)
    ) {
      setSelectedObjectiveId(
        workbenchObjectives.data.find((objective) => objective.parentObjectiveId === null)?.id ??
          workbenchObjectives.data[0]?.id ??
          null,
      );
    }
  }, [selectedObjectiveId, workbenchObjectives.data]);

  useEffect(() => {
    if (!workbenchTasks.data) return;
    if (selectedTaskId === null) return;
    if (workbenchTasks.data.some((task) => task.id === selectedTaskId)) return;
    setSelectedTaskId(null);
  }, [selectedTaskId, workbenchTasks.data]);

  function selectMember(memberId: string): void {
    setSelectedMemberId(memberId);
    setContactOperation(null);
    setActiveNavigationId('directory');
  }

  function runContactOperation(operation: ContactOperation): void {
    if (!canUseMessages) {
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
        setPreferredResponseTarget({ conversationId: conversation.id, kind: operation.kind });
        setActiveNavigationId('messages');
        setContactOperation(null);
        setNewConversationKind(null);
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
    if (
      kind === 'agent' &&
      (member.agent === null ||
        !member.capabilities.canContactAgent ||
        member.agent.operationalAvailability.status !== 'AVAILABLE')
    ) {
      return;
    }
    const target: Extract<CreateConversationRequest, { type: 'direct' }>['target'] =
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

  function contactStandaloneAgent(agent: AgentCollaborationCandidate): void {
    runContactOperation({
      memberId: agent.ownerUserId ?? agent.departmentId ?? agent.id,
      kind: 'agent',
      request: { type: 'direct', target: { type: 'agent', agentId: agent.id } },
      status: 'pending',
    });
  }

  function createGroupConversation(
    title: string,
    memberUserIds: readonly string[],
    agentIds: readonly string[],
  ): void {
    createConversation.mutate(
      { type: 'group', title, memberUserIds: [...memberUserIds], agentIds: [...agentIds] },
      {
        onSuccess: (conversation) => {
          setSelectedConversationId(conversation.id);
          setPreferredResponseTarget(null);
          setActiveNavigationId('messages');
          setContactOperation(null);
          setNewConversationKind(null);
        },
        onError: (error) => {
          setContactOperation({
            kind: 'human',
            memberId: memberUserIds[0] ?? payload.currentUser.id,
            request: {
              type: 'group',
              title,
              memberUserIds: [...memberUserIds],
              agentIds: [...agentIds],
            },
            status: 'error',
            message: readableContactError(error),
          });
        },
      },
    );
  }

  function openRoleAgent(assignment: RoleAssignment): void {
    if (!roleAgentAvailability(assignment).available) return;
    runContactOperation({
      assignmentId: assignment.id,
      memberId: assignment.assignee.id,
      kind: 'agent',
      request: { type: 'direct', target: { type: 'agent', agentId: assignment.agent.id } },
      status: 'pending',
    });
  }

  function selectSearchResult(result: UnifiedSearchResult): void {
    setSearchQuery('');
    setSearchFocused(false);
    searchInputRef.current?.blur();
    if (result.kind === 'member') {
      selectMember(result.member.id);
      return;
    }
    if (result.kind === 'conversation') {
      setSelectedConversationId(result.conversationId);
      if (canUseMessages) setActiveNavigationId('messages');
      return;
    }
    runContactOperation({
      memberId: result.ownerUserId,
      kind: 'agent',
      request: { type: 'direct', target: { type: 'agent', agentId: result.agentId } },
      status: 'pending',
    });
  }

  async function startAgentCollaboration(
    agentIds: [string, string],
    turnLimit: number,
  ): Promise<void> {
    if (!canUseMessages) {
      throw new Error('当前账号未获得消息模块权限，无法创建智能体协作。');
    }
    const conversation = await createConversation.mutateAsync({
      type: 'direct',
      target: { type: 'agent_pair', agentIds, turnLimit },
    });
    setSelectedConversationId(conversation.id);
    setActiveNavigationId('messages');
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
        <span />
        <div className="design-titlebar-actions" />
      </header>

      <div className="desktop-layout">
        <div className="desktop-search-dock">
          <label className="design-global-search">
            <span aria-hidden="true">⌕</span>
            <input
              ref={searchInputRef}
              type="search"
              value={searchQuery}
              placeholder="搜索成员、智能体或会话"
              aria-label="统一搜索"
              aria-expanded={searchFocused && searchQuery.trim().length > 0}
              aria-controls="desktop-unified-search-results"
              onFocus={() => setSearchFocused(true)}
              onBlur={() => setSearchFocused(false)}
              onChange={(event) => setSearchQuery(event.target.value)}
            />
            <kbd>Ctrl K</kbd>
            {searchFocused && searchQuery.trim().length > 0 ? (
              <div
                id="desktop-unified-search-results"
                className="desktop-unified-search-results"
                role="listbox"
                aria-label="搜索结果"
                onMouseDown={(event) => event.preventDefault()}
              >
                {searchResults.length === 0 ? (
                  <p>没有找到可访问的成员、智能体或会话。</p>
                ) : (
                  searchResults.map((result) => (
                    <button
                      type="button"
                      role="option"
                      aria-selected="false"
                      key={`${result.kind}:${result.id}`}
                      onClick={() => selectSearchResult(result)}
                    >
                      <span className={`unified-search-kind ${result.kind}`}>
                        {result.kind === 'member' ? '人' : result.kind === 'agent' ? 'AI' : '聊'}
                      </span>
                      <span>
                        <strong>{result.label}</strong>
                        <small>{result.detail}</small>
                      </span>
                    </button>
                  ))
                )}
              </div>
            ) : null}
          </label>
        </div>
        <>
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
              setPreferredResponseTarget(null);
              setActiveNavigationId('messages');
            }}
            onRetry={() => conversations.refetch()}
            onStartConversation={() => setNewConversationKind('all')}
            enableAgentPairCollaboration={false}
            onCreateAgentPair={startAgentCollaboration}
          />

          <main
            className={
              isMessagesActive
                ? 'workspace messaging-active'
                : isWorkbenchActive
                  ? 'workspace workbench-active'
                  : isMyActive
                    ? 'workspace my-active'
                    : 'workspace'
            }
          >
            <header className="workspace-topbar">
              <div>
                <strong>{payload.tenant.name}</strong>
                <span className="topbar-divider" />
                <span>
                  {isWorkbenchActive
                    ? '工作台'
                    : isDirectoryActive
                      ? '企业通讯录'
                      : isMessagesActive
                        ? '消息'
                        : '我的'}
                </span>
              </div>
            </header>

            {isWorkbenchActive ? (
              selectedTask ? (
                <WorkbenchTaskWorkspace
                  task={selectedTask}
                  objective={
                    workbenchObjectives.data?.find(
                      (objective) => objective.id === selectedTask.objectiveId,
                    ) ?? selectedObjective
                  }
                  isLoading={workbenchObjectives.isPending || workbenchTasks.isPending}
                />
              ) : (
                <EmployeeWorkbenchOverview
                  userName={payload.currentUser.name}
                  objectives={workbenchObjectives.data ?? []}
                  tasks={workbenchTasks.data ?? []}
                  loading={workbenchObjectives.isPending || workbenchTasks.isPending}
                  onSelectTask={setSelectedTaskId}
                  onAskAgent={() => setNewConversationKind('agent')}
                />
              )
            ) : isDirectoryActive ? (
              selectedMember ? (
                <MemberWorkspace
                  member={selectedMember}
                  currentUserId={payload.currentUser.id}
                  departments={selectedMember.departmentIds
                    .map((departmentId) => departmentById.get(departmentId))
                    .filter((department): department is Department => department !== undefined)}
                  contactOperation={
                    contactOperation?.assignmentId === undefined &&
                    contactOperation?.memberId === selectedMember.id
                      ? contactOperation
                      : null
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
                <EmptyWorkspace
                  title="正在加载会话"
                  description="正在从企业服务读取可访问的会话…"
                />
              ) : conversations.isError && conversations.data === undefined ? (
                <EmptyWorkspace
                  title="会话列表加载失败"
                  description={readableContactError(conversations.error)}
                />
              ) : (
                <ConversationWorkspace
                  conversation={selectedConversation}
                  currentUserId={payload.currentUser.id}
                  preferredResponseTargetKind={
                    preferredResponseTarget !== null &&
                    preferredResponseTarget.conversationId === selectedConversation?.id
                      ? preferredResponseTarget.kind
                      : null
                  }
                />
              )
            ) : isMyActive ? (
              mySection === 'roles' ? (
                <RoleWorkspace
                  assignment={selectedRoleAssignment}
                  isLoading={roleAssignments.isPending}
                  operation={
                    contactOperation?.assignmentId
                      ? {
                          assignmentId: contactOperation.assignmentId,
                          status: contactOperation.status,
                          ...(contactOperation.message === undefined
                            ? {}
                            : { message: contactOperation.message }),
                        }
                      : null
                  }
                  onOpenAgent={openRoleAgent}
                  onRetryAgent={() => {
                    if (contactOperation?.assignmentId) runContactOperation(contactOperation);
                  }}
                />
              ) : mySection === 'security' ? (
                <AccountSecurityWorkspace
                  onOpenAccountMenu={onOpenAccountMenu}
                  onChangePassword={onChangePassword}
                />
              ) : mySection === 'about' ? (
                <AboutWorkspace runtimeInfo={runtimeInfo} />
              ) : (
                <MyOverviewWorkspace
                  user={payload.currentUser}
                  assignments={roleAssignments.data ?? []}
                  onOpenRoles={() => setMySection('roles')}
                  onOpenAccountMenu={onOpenAccountMenu}
                  onChangePassword={onChangePassword}
                  onOpenSecurity={() => setMySection('security')}
                  onOpenAbout={() => setMySection('about')}
                />
              )
            ) : (
              <EmptyWorkspace title="模块正在建设" description="该模块尚未接入当前桌面里程碑。" />
            )}
          </main>
        </>
      </div>
      {newConversationKind && (
        <NewConversationDialog
          members={payload.members}
          agents={collaborationAgents}
          currentUserId={payload.currentUser.id}
          initialKind={newConversationKind}
          pending={createConversation.isPending}
          onClose={() => setNewConversationKind(null)}
          onSelectMember={(member) => contactMember(member, 'human')}
          onSelectAgent={(member) => contactMember(member, 'agent')}
          onSelectStandaloneAgent={contactStandaloneAgent}
          onCreateGroup={createGroupConversation}
        />
      )}
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
                    className={
                      member.capabilities.canContactAgent
                        ? 'tree-member-ai'
                        : 'tree-member-ai unavailable'
                    }
                    title={
                      member.capabilities.canContactAgent
                        ? `与 ${member.agent.name} 对话`
                        : agentOperationalDescription(member.agent)
                    }
                    aria-label={
                      member.capabilities.canContactAgent
                        ? `与 ${member.agent.name} 对话`
                        : `${member.agent.name}：${agentOperationalDescription(member.agent)}`
                    }
                    {...(member.capabilities.canContactAgent
                      ? { 'data-agent-action': 'true' }
                      : {})}
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
    member.agent.status === 'online' &&
    member.agent.operationalAvailability.status === 'AVAILABLE';
  const contactPending = contactOperation?.status === 'pending';
  const canOpenSharedConversation = canContactHuman || canContactAgent;
  const defaultContactKind: ContactKind = canContactHuman ? 'human' : 'agent';

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
            className="primary-button"
            disabled={!canOpenSharedConversation || contactPending}
            title={
              member.agent !== null && !canContactAgent && canContactHuman
                ? `可联系本人；${agentOperationalDescription(member.agent)}`
                : '成员本人和其智能体共用同一个会话窗口'
            }
            onClick={() => onContact(defaultContactKind)}
          >
            <span className="button-icon" aria-hidden="true">
              讯
            </span>
            {contactPending ? '正在进入…' : '打开共享会话'}
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
                <div
                  className={`agent-operational-status ${member.agent.operationalAvailability.status.toLocaleLowerCase().replace('_', '-')}`}
                >
                  <strong>{agentOperationalLabel(member.agent)}</strong>
                  <small>{agentOperationalReason(member.agent)}</small>
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

export function unifiedSearchResults(
  query: string,
  members: Member[],
  conversations: Conversation[],
): UnifiedSearchResult[] {
  const normalized = query.normalize('NFKC').trim().toLocaleLowerCase('zh-CN');
  if (normalized.length === 0) return [];
  const includes = (...values: Array<string | null | undefined>): boolean =>
    values.some((value) =>
      value?.normalize('NFKC').toLocaleLowerCase('zh-CN').includes(normalized),
    );
  const results: UnifiedSearchResult[] = [];
  for (const member of members) {
    if (includes(member.name, member.title)) {
      results.push({
        kind: 'member',
        id: member.id,
        label: member.name,
        detail: `${member.title || '成员'} · ${member.status === 'active' ? '在职' : '已停用'}`,
        member,
      });
    }
    if (
      member.agent &&
      member.capabilities.canContactAgent &&
      member.agent.status === 'online' &&
      member.agent.operationalAvailability.status === 'AVAILABLE' &&
      includes(member.agent.name, member.agent.summary, member.name)
    ) {
      results.push({
        kind: 'agent',
        id: member.agent.id,
        label: member.agent.name,
        detail: `${member.name} 的智能体 · 已授权`,
        agentId: member.agent.id,
        ownerUserId: member.id,
      });
    }
  }
  for (const conversation of conversations) {
    if (includes(conversation.title, ...conversation.participants.map(({ name }) => name))) {
      results.push({
        kind: 'conversation',
        id: conversation.id,
        label: conversation.title ?? '未命名会话',
        detail: `${conversation.participants.length} 位参与者 · 历史会话`,
        conversationId: conversation.id,
      });
    }
  }
  return results.slice(0, 12);
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

function agentStatusLabel(status: NonNullable<Member['agent']>['status']): string {
  return { online: '配置已启用', offline: '配置已离线', disabled: '配置已停用' }[status];
}

function agentOperationalLabel(agent: NonNullable<Member['agent']>): string {
  if (agent.status === 'offline') return '配置已离线，运行不可用';
  if (agent.status === 'disabled') return '配置已停用，运行不可用';
  return {
    AVAILABLE: '模型运行可用',
    NOT_READY: '配置已启用，但模型未就绪',
    DEGRADED: '模型服务处于降级状态',
    UNKNOWN: '模型可用性证据不足',
  }[agent.operationalAvailability.status];
}

function agentOperationalReason(agent: NonNullable<Member['agent']>): string {
  if (agent.status === 'offline') return '管理员尚未启用该智能体配置';
  if (agent.status === 'disabled') return '该智能体配置已被管理员停用';
  const reason = agent.operationalAvailability.reasonCodes[0];
  if (reason === undefined && agent.operationalAvailability.status === 'AVAILABLE') {
    return 'Runtime 路由与近期真实成功凭据均已验证';
  }
  return (
    {
      RUNTIME_READINESS_UNAVAILABLE: '模型运行服务探针暂不可达',
      RUNTIME_READINESS_STALE: '模型运行证据已经过期',
      RUNTIME_ALLOWLIST_MISMATCH: '模型路由尚未进入 Runtime 精确允许列表',
      RUNTIME_PROVIDER_NOT_READY: '模型供应商尚未就绪',
      RUNTIME_TRUSTED_ROUTE_NOT_READY: '可信模型路由尚未就绪',
      NO_RECENT_SUCCESSFUL_PROVIDER_EVIDENCE: '缺少近期真实成功调用凭据',
      MODEL_CIRCUIT_OPEN: '模型路由熔断器当前已打开',
      NO_PUBLISHED_ROUTE_POLICY: '尚未发布匹配的模型路由策略',
      NO_PUBLISHED_ROUTE_CANDIDATE: '模型路由策略没有可执行候选',
      ROUTE_POLICY_INCOMPATIBLE: '智能体模型策略与已发布路由不兼容',
      AGENT_CONFIGURATION_NOT_ONLINE: '智能体配置当前未启用',
      AGENT_CONFIGURATION_DISABLED: '智能体配置已停用',
      AGENT_VERSION_NOT_PUBLISHED: '智能体版本尚未发布',
      READINESS_DATA_UNAVAILABLE: '模型就绪度数据暂不可用',
    }[reason ?? ''] ?? '模型运行证据未通过完整校验'
  );
}

function agentOperationalDescription(agent: NonNullable<Member['agent']>): string {
  return `${agentOperationalLabel(agent)}：${agentOperationalReason(agent)}`;
}

function readableContactError(error: unknown): string {
  if (error instanceof ApiClientError) {
    return `${error.message}${error.requestId ? `（请求 ID：${error.requestId}）` : ''}`;
  }
  return error instanceof Error ? error.message : '发生未知错误，请重试。';
}

function useRuntimeInfo(): DesktopRuntimeInfo | null {
  const [runtimeInfo, setRuntimeInfo] = useState<DesktopRuntimeInfo | null>(null);

  useEffect(() => {
    let disposed = false;
    const desktopBridge = window.enterpriseDesktop;
    if (!desktopBridge) return;
    void desktopBridge
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
