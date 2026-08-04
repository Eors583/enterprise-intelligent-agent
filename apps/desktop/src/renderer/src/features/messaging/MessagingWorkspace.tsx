import type {
  AnswerFeedbackReason,
  Conversation,
  ConversationAgentRun,
  CreateMessageRequest,
  KnowledgeCitationDetail,
  Message,
  MessageResponseTarget,
  TextMessageContent,
} from '@enterprise/contracts';
import {
  useEffect,
  useId,
  useReducer,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { ApiClientError } from '../../shared/api/client';
import type { AgentCollaborationCandidate } from './agent-collaboration';
import { getKnowledgeCitationOriginal } from './api';
import { composerReducer, createClientMessageId, initialComposerState } from './composer-state';
import {
  useAgentRunActions,
  useAgentRunStream,
  useAnswerFeedback,
  useConversationSearch,
  useConversationMessages,
  useConversationStateActions,
  useImRealtimeSync,
  useLoadOlderMessages,
  useSendTextMessage,
  useUpsertAnswerFeedback,
} from './hooks';
import { RunActionGate } from './run-action-gate';

interface MessagingSidebarProps {
  organizationPanel?: ReactNode;
  conversations: Conversation[] | undefined;
  agents: AgentCollaborationCandidate[];
  selectedConversationId: string | null;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  currentUserId: string;
  onSelect: (conversationId: string) => void;
  onRetry: () => Promise<unknown>;
  onStartConversation?: (() => void) | undefined;
  enableAgentPairCollaboration?: boolean | undefined;
  onCreateAgentPair?: (agentIds: [string, string], turnLimit: number) => Promise<void>;
}

export function MessagingSidebar({
  organizationPanel,
  conversations,
  agents,
  selectedConversationId,
  isLoading,
  isError,
  error,
  currentUserId,
  onSelect,
  onRetry,
  onStartConversation,
  enableAgentPairCollaboration = false,
  onCreateAgentPair,
}: MessagingSidebarProps): React.JSX.Element {
  const [isManualRefreshing, setIsManualRefreshing] = useState(false);
  const [isAgentPairDialogOpen, setIsAgentPairDialogOpen] = useState(false);
  const [conversationFilter, setConversationFilter] = useState('');
  const hasCachedConversations = conversations !== undefined;
  const normalizedConversationFilter = conversationFilter.trim().toLocaleLowerCase('zh-CN');
  const visibleConversations = conversations?.filter(
    (conversation) =>
      normalizedConversationFilter.length === 0 ||
      conversationTitle(conversation, currentUserId)
        .toLocaleLowerCase('zh-CN')
        .includes(normalizedConversationFilter) ||
      conversation.participants.some((participant) =>
        participant.name.toLocaleLowerCase('zh-CN').includes(normalizedConversationFilter),
      ),
  );

  async function refreshConversations(): Promise<void> {
    if (isManualRefreshing) return;
    setIsManualRefreshing(true);
    try {
      await onRetry();
    } finally {
      setIsManualRefreshing(false);
    }
  }

  return (
    <>
      <aside
        className={
          organizationPanel
            ? 'directory-sidebar messaging-sidebar unified-sidebar'
            : 'directory-sidebar messaging-sidebar'
        }
        aria-label={organizationPanel ? '组织架构与聊天' : '消息会话'}
      >
        {organizationPanel && <div className="unified-organization-pane">{organizationPanel}</div>}

        <section className={organizationPanel ? 'unified-chat-pane' : undefined}>
          <header
            className={
              organizationPanel ? 'unified-chat-header' : 'sidebar-header messaging-sidebar-header'
            }
          >
            <div>
              {!organizationPanel && <p className="eyebrow">Conversations</p>}
              {organizationPanel ? <strong>聊天</strong> : <h1>消息</h1>}
            </div>
            {organizationPanel && <small>{conversations?.length ?? 0} 个会话</small>}
            <button
              type="button"
              className="icon-action"
              onClick={() => void refreshConversations()}
              disabled={isManualRefreshing}
              aria-label="刷新会话列表"
              title="刷新会话列表"
            >
              {isManualRefreshing ? '…' : '↻'}
            </button>
            {onStartConversation && (
              <button
                type="button"
                className="new-conversation-button"
                onClick={onStartConversation}
              >
                ＋ 新建
              </button>
            )}
          </header>

          <label className="conversation-filter">
            <span aria-hidden="true">⌕</span>
            <input
              type="search"
              value={conversationFilter}
              placeholder="搜索会话或成员"
              onChange={(event) => setConversationFilter(event.target.value)}
            />
          </label>

          {enableAgentPairCollaboration && onCreateAgentPair && (
            <div className="agent-collaboration-launch">
              <button
                type="button"
                disabled={agents.length < 2}
                title={
                  agents.length < 2
                    ? '至少需要两个已通过运行就绪检查的智能体'
                    : '创建智能体协作会话'
                }
                onClick={() => setIsAgentPairDialogOpen(true)}
              >
                <span className="agent-pair-mark" aria-hidden="true">
                  AI
                </span>
                <span>
                  <strong>智能体协作</strong>
                  <small>
                    {agents.length < 2 ? '运行可用智能体不足 2 个' : '选择两个智能体受控协作'}
                  </small>
                </span>
                <i aria-hidden="true">＋</i>
              </button>
            </div>
          )}

          <div className="conversation-list" aria-live="polite">
            {isLoading && <ConversationListSkeleton />}
            {isError && !hasCachedConversations && (
              <InlineFailure
                title="会话列表加载失败"
                message={readableError(error)}
                onRetry={() => void refreshConversations()}
              />
            )}
            {isError && hasCachedConversations && (
              <SyncWarning error={error} onRetry={() => void refreshConversations()} />
            )}
            {!isLoading && hasCachedConversations && visibleConversations?.length === 0 && (
              <div className="conversation-list-empty">
                <span aria-hidden="true">◇</span>
                <strong>还没有会话</strong>
                <p>从通讯录选择成员，进入本人和其智能体共用的会话。</p>
              </div>
            )}
            {!isLoading &&
              hasCachedConversations &&
              visibleConversations?.map((conversation) => {
                const isAgent = conversationHasAgent(conversation);
                const isAgentPair = conversationHasAgentPair(conversation);
                const isShared = conversationHasSharedMemberAgent(conversation, currentUserId);
                return (
                  <button
                    type="button"
                    key={conversation.id}
                    className={
                      conversation.id === selectedConversationId
                        ? 'conversation-row selected'
                        : 'conversation-row'
                    }
                    aria-current={conversation.id === selectedConversationId ? 'true' : undefined}
                    onClick={() => onSelect(conversation.id)}
                  >
                    <ConversationAvatar conversation={conversation} currentUserId={currentUserId} />
                    <span className="conversation-row-copy">
                      <span className="conversation-title-line">
                        <strong>{conversationTitle(conversation, currentUserId)}</strong>
                        {isAgent && (
                          <i className="conversation-ai-badge">{isAgentPair ? 'AI × 2' : 'AI'}</i>
                        )}
                        {conversation.pinnedAt ? <i className="conversation-pin">置顶</i> : null}
                      </span>
                      <small>
                        {conversation.type === 'group'
                          ? `群聊 · ${conversation.participants.filter((participant) => participant.type === 'user').length} 位成员`
                          : isAgentPair
                            ? '智能体协作 · 受控轮次'
                            : isShared
                              ? '成员与智能体共享'
                              : isAgent
                                ? '智能体会话'
                                : '真人会话'}
                      </small>
                    </span>
                    <time dateTime={conversation.lastMessageAt ?? conversation.updatedAt}>
                      {compactTime(conversation.lastMessageAt ?? conversation.updatedAt)}
                    </time>
                    {(conversation.unreadCount ?? 0) > 0 ? (
                      <span
                        className="conversation-unread"
                        aria-label={`${conversation.unreadCount} 条未读`}
                      >
                        {Math.min(conversation.unreadCount ?? 0, 99)}
                      </span>
                    ) : null}
                  </button>
                );
              })}
          </div>
        </section>
      </aside>
      {enableAgentPairCollaboration && onCreateAgentPair && isAgentPairDialogOpen && (
        <AgentPairDialog
          agents={agents}
          onClose={() => setIsAgentPairDialogOpen(false)}
          onCreate={onCreateAgentPair}
        />
      )}
    </>
  );
}

function AgentPairDialog({
  agents,
  onClose,
  onCreate,
}: {
  agents: AgentCollaborationCandidate[];
  onClose: () => void;
  onCreate: (agentIds: [string, string], turnLimit: number) => Promise<void>;
}): React.JSX.Element {
  const titleId = useId();
  const [firstAgentId, setFirstAgentId] = useState(agents[0]?.id ?? '');
  const [secondAgentId, setSecondAgentId] = useState(
    agents.find((agent) => agent.id !== agents[0]?.id)?.id ?? '',
  );
  const [turnLimit, setTurnLimit] = useState(4);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canSubmit =
    firstAgentId !== '' && secondAgentId !== '' && firstAgentId !== secondAgentId && !isSubmitting;

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !isSubmitting) onClose();
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isSubmitting, onClose]);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!canSubmit) return;
    setError(null);
    setIsSubmitting(true);
    try {
      await onCreate([firstAgentId, secondAgentId], turnLimit);
      onClose();
    } catch (caught) {
      setError(readableError(caught));
      setIsSubmitting(false);
    }
  }

  return (
    <div
      className="agent-pair-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target && !isSubmitting) onClose();
      }}
    >
      <section
        className="agent-pair-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <header>
          <div className="agent-pair-dialog-icon" aria-hidden="true">
            AI↔AI
          </div>
          <div>
            <p className="eyebrow">Controlled collaboration</p>
            <h2 id={titleId}>创建智能体协作</h2>
          </div>
          <button
            type="button"
            className="agent-pair-close"
            aria-label="关闭智能体协作窗口"
            disabled={isSubmitting}
            onClick={onClose}
          >
            ×
          </button>
        </header>

        <p className="agent-pair-dialog-intro">
          选择两个已通过运行就绪检查的智能体。你将作为观察者发送协作主题，服务端按设定轮次组织它们交替讨论。
        </p>

        <form onSubmit={(event) => void submit(event)}>
          <div className="agent-pair-selectors">
            <label>
              <span>智能体 A</span>
              <select
                autoFocus
                value={firstAgentId}
                disabled={isSubmitting}
                onChange={(event) => setFirstAgentId(event.target.value)}
              >
                {agents
                  .filter((agent) => agent.id !== secondAgentId)
                  .map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agent.name} · {agent.ownerName}
                    </option>
                  ))}
              </select>
              <AgentSummary agent={agents.find((agent) => agent.id === firstAgentId)} />
            </label>
            <span className="agent-pair-connector" aria-hidden="true">
              ↔
            </span>
            <label>
              <span>智能体 B</span>
              <select
                value={secondAgentId}
                disabled={isSubmitting}
                onChange={(event) => setSecondAgentId(event.target.value)}
              >
                {agents
                  .filter((agent) => agent.id !== firstAgentId)
                  .map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agent.name} · {agent.ownerName}
                    </option>
                  ))}
              </select>
              <AgentSummary agent={agents.find((agent) => agent.id === secondAgentId)} />
            </label>
          </div>

          <label className="agent-pair-turn-limit">
            <span>
              <strong>受控轮次</strong>
              <small>到达上限后自动停止，避免智能体无限对话。</small>
            </span>
            <select
              value={turnLimit}
              disabled={isSubmitting}
              onChange={(event) => setTurnLimit(Number(event.target.value))}
            >
              {[2, 3, 4, 5, 6, 7, 8].map((turns) => (
                <option key={turns} value={turns}>
                  {turns} 轮{turns === 4 ? '（推荐）' : ''}
                </option>
              ))}
            </select>
          </label>

          {error && (
            <div className="agent-pair-error" role="alert">
              {error}
            </div>
          )}

          <footer>
            <button
              type="button"
              className="secondary-button"
              disabled={isSubmitting}
              onClick={onClose}
            >
              取消
            </button>
            <button type="submit" className="primary-button" disabled={!canSubmit}>
              {isSubmitting ? '正在创建…' : '进入协作会话'}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}

function AgentSummary({
  agent,
}: {
  agent: AgentCollaborationCandidate | undefined;
}): React.JSX.Element {
  return <small>{agent?.summary ?? `${agent?.ownerName ?? '成员'}的已授权个人智能体`}</small>;
}

interface ConversationWorkspaceProps {
  conversation: Conversation | null;
  currentUserId: string;
  preferredResponseTargetKind?: 'human' | 'agent' | null;
}

export function ConversationWorkspace({
  conversation,
  currentUserId,
  preferredResponseTargetKind = null,
}: ConversationWorkspaceProps): React.JSX.Element {
  useImRealtimeSync();
  const conversationId = conversation?.id ?? null;
  const messages = useConversationMessages(conversationId, conversation !== null);
  const loadOlder = useLoadOlderMessages(conversationId);
  const searchMessages = useConversationSearch(conversationId);
  const stateActions = useConversationStateActions();
  const sendMessage = useSendTextMessage(conversationId);
  const runActions = useAgentRunActions(conversationId);
  const [composer, dispatch] = useReducer(composerReducer, initialComposerState);
  const [isManualRefreshing, setIsManualRefreshing] = useState(false);
  const [retryingRunId, setRetryingRunId] = useState<string | null>(null);
  const [responseTargetKind, setResponseTargetKind] = useState<'human' | 'agent'>('human');
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [messageSearchQuery, setMessageSearchQuery] = useState('');
  const retryGateRef = useRef(new RunActionGate());
  const listEndRef = useRef<HTMLDivElement | null>(null);
  const activeRun = [...(messages.data?.runs ?? [])]
    .reverse()
    .find((run) => ['QUEUED', 'DISPATCHING', 'RUNNING', 'UNKNOWN'].includes(run.status));
  const runStream = useAgentRunStream(conversationId, activeRun);

  useEffect(() => {
    dispatch({ type: 'reset' });
    sendMessage.reset();
    retryGateRef.current.reset();
    setRetryingRunId(null);
    runActions.retry.reset();
  }, [conversationId]);

  useEffect(() => {
    if (conversation === null || conversationHasAgentPair(conversation)) return;
    const targets = conversationResponseTargets(conversation, currentUserId);
    if (preferredResponseTargetKind === 'agent' && targets.agent !== undefined) {
      setResponseTargetKind('agent');
      return;
    }
    if (preferredResponseTargetKind === 'human' && targets.human !== undefined) {
      setResponseTargetKind('human');
      return;
    }
    setResponseTargetKind(
      targets.human === undefined && targets.agent !== undefined ? 'agent' : 'human',
    );
  }, [conversation, currentUserId, preferredResponseTargetKind]);

  useEffect(() => {
    listEndRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.data?.items.length, runStream.content.length]);

  if (!conversation) {
    return (
      <div className="empty-workspace conversation-empty-workspace">
        <div className="empty-symbol" aria-hidden="true">
          讯
        </div>
        <h1>选择一个会话</h1>
        <p>左侧只显示服务端返回且当前账号有权访问的会话。</p>
      </div>
    );
  }

  const activeConversation = conversation;

  const isAgentConversation = conversationHasAgent(activeConversation);
  const isAgentPair = conversationHasAgentPair(activeConversation);
  const isGroup = activeConversation.type === 'group';
  const responseTargets = conversationResponseTargets(activeConversation, currentUserId);
  const isSharedMemberAgentConversation =
    !isAgentPair && responseTargets.human !== undefined && responseTargets.agent !== undefined;
  const latestMessage = messages.data?.items.at(-1);
  const latestRun = messages.data?.runs.at(-1);
  const failedRun =
    latestRun &&
    latestMessage?.id === latestRun.inputMessageId &&
    ['FAILED', 'UNKNOWN', 'CANCELLED'].includes(latestRun.status)
      ? latestRun
      : undefined;
  const awaitingAgentReply =
    isAgentConversation && activeRun !== undefined && !sendMessage.isPending;

  function runSend(request: CreateMessageRequest): void {
    dispatch({ type: 'sendStarted' });
    sendMessage.mutate(request, {
      onSuccess: () => dispatch({ type: 'sendSucceeded', request }),
      onError: () => dispatch({ type: 'sendFailed', request }),
    });
  }

  function submitDraft(): void {
    const text = composer.draft.trim();
    if (!text || sendMessage.isPending) return;
    runSend({
      clientMessageId: createClientMessageId(),
      content: { type: 'text', text },
      ...(isAgentPair || (isGroup && responseTargetKind === 'human')
        ? {}
        : {
            responseTarget: selectedResponseTarget(responseTargetKind, responseTargets),
          }),
    });
  }

  async function refreshMessages(): Promise<void> {
    if (isManualRefreshing) return;
    setIsManualRefreshing(true);
    try {
      await messages.refetch();
    } finally {
      setIsManualRefreshing(false);
    }
  }

  function togglePinned(): void {
    stateActions.mutate({
      conversationId: activeConversation.id,
      request: { pinned: activeConversation.pinnedAt == null },
    });
  }

  function toggleMuted(): void {
    const isMuted =
      activeConversation.mutedUntil != null &&
      new Date(activeConversation.mutedUntil).getTime() > Date.now();
    stateActions.mutate({
      conversationId: activeConversation.id,
      request: {
        mutedUntil: isMuted
          ? null
          : new Date(Date.now() + 365 * 24 * 60 * 60 * 1_000).toISOString(),
      },
    });
  }

  function archiveConversation(): void {
    stateActions.mutate({ conversationId: activeConversation.id, request: { archived: true } });
  }

  function runMessageSearch(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const query = messageSearchQuery.trim();
    if (query.length > 0) searchMessages.mutate(query);
  }

  function retryFailedRun(runId: string): void {
    const token = `${conversationId ?? 'none'}:${runId}`;
    if (!retryGateRef.current.tryStart(token)) return;

    runActions.retry.reset();
    setRetryingRunId(runId);
    runActions.retry.mutate(runId, {
      onSettled: () => {
        retryGateRef.current.finish(token);
        setRetryingRunId((current) => (current === runId ? null : current));
      },
    });
  }

  return (
    <section
      className="conversation-workspace"
      aria-label={conversationTitle(activeConversation, currentUserId)}
    >
      <header className="conversation-header">
        <ConversationAvatar conversation={conversation} currentUserId={currentUserId} large />
        <div className="conversation-header-copy">
          <div>
            <h1>{conversationTitle(conversation, currentUserId)}</h1>
            <span className={isAgentConversation ? 'identity-badge agent' : 'identity-badge human'}>
              {isGroup
                ? '群聊'
                : isAgentPair
                  ? '智能体协作'
                  : isSharedMemberAgentConversation
                    ? '成员与智能体共享'
                    : isAgentConversation
                      ? (responseTargets.agent?.name ?? 'AI 智能体')
                      : '真人'}
            </span>
          </div>
          <p>{participantDescription(conversation, currentUserId)}</p>
        </div>
        <div className="conversation-header-actions">
          <button type="button" onClick={() => setIsSearchOpen((current) => !current)}>
            搜索
          </button>
          <button type="button" disabled={stateActions.isPending} onClick={togglePinned}>
            {conversation.pinnedAt == null ? '置顶' : '取消置顶'}
          </button>
          <button type="button" disabled={stateActions.isPending} onClick={toggleMuted}>
            {conversation.mutedUntil != null &&
            new Date(conversation.mutedUntil).getTime() > Date.now()
              ? '取消免打扰'
              : '免打扰'}
          </button>
          <button type="button" disabled={stateActions.isPending} onClick={archiveConversation}>
            归档
          </button>
        </div>
        <button
          type="button"
          className="text-action"
          disabled={isManualRefreshing}
          onClick={() => void refreshMessages()}
        >
          {isManualRefreshing ? '刷新中…' : '刷新消息'}
        </button>
      </header>

      {isSearchOpen ? (
        <section className="conversation-message-search" aria-label="搜索当前会话">
          <form onSubmit={runMessageSearch}>
            <input
              type="search"
              value={messageSearchQuery}
              maxLength={200}
              placeholder="搜索消息内容"
              onChange={(event) => setMessageSearchQuery(event.target.value)}
            />
            <button type="submit" disabled={searchMessages.isPending || !messageSearchQuery.trim()}>
              {searchMessages.isPending ? '搜索中…' : '搜索'}
            </button>
          </form>
          {searchMessages.isError ? (
            <p role="alert">{readableError(searchMessages.error)}</p>
          ) : null}
          {searchMessages.data ? (
            <div className="conversation-message-search-results">
              {searchMessages.data.items.length === 0 ? (
                <p>没有找到相关消息。</p>
              ) : (
                searchMessages.data.items.map((message) => (
                  <article key={message.id}>
                    <strong>{message.sender.name}</strong>
                    <p>{message.content.text}</p>
                    <time dateTime={message.createdAt}>{fullTime(message.createdAt)}</time>
                  </article>
                ))
              )}
            </div>
          ) : null}
        </section>
      ) : null}

      {isAgentConversation && (
        <div className="conversation-ai-disclosure" role="note">
          <strong>{isAgentPair ? '受控轮次' : '共享会话'}</strong>
          {isAgentPair
            ? '你是当前协作的观察者。发送主题后，两个智能体会由服务端按设定轮次交替讨论；桌面端只展示服务端实际返回的内容。'
            : `${responseTargets.agent?.name ?? '该成员的智能体'}和成员本人共用此窗口。你可以选择由谁回应；无论选择哪一方，成员本人都能收到并查看消息，也可以随时接管回复。`}
        </div>
      )}

      <div className="message-timeline" aria-live="polite" aria-busy={messages.isPending}>
        {messages.isPending && <MessageTimelineSkeleton />}
        {messages.data?.hasMore && messages.data.nextCursor ? (
          <button
            type="button"
            className="load-older-messages"
            disabled={loadOlder.isPending}
            onClick={() => loadOlder.mutate(messages.data!.nextCursor!)}
          >
            {loadOlder.isPending ? '正在加载…' : '加载更早消息'}
          </button>
        ) : null}
        {loadOlder.isError ? <p role="alert">{readableError(loadOlder.error)}</p> : null}
        {messages.isError && messages.data === undefined && (
          <InlineFailure
            title="消息加载失败"
            message={readableError(messages.error)}
            onRetry={() => void refreshMessages()}
          />
        )}
        {messages.isError && messages.data !== undefined && (
          <SyncWarning error={messages.error} onRetry={() => void refreshMessages()} />
        )}
        {!messages.isPending && messages.data?.items.length === 0 && (
          <div className="timeline-empty">
            <span aria-hidden="true">◇</span>
            <strong>暂无消息</strong>
            <p>
              {isAgentPair
                ? '发送一个协作主题，服务端将启动两个智能体的受控讨论。'
                : '发送第一条消息后，服务端确认的内容会显示在这里。'}
            </p>
          </div>
        )}
        {!messages.isPending &&
          messages.data?.items.map((message) => (
            <MessageBubble
              key={message.id}
              message={message}
              isCurrentUser={message.sender.type === 'user' && message.sender.id === currentUserId}
              senderDisplayName={messageSenderDisplayName(message, conversation)}
              responseTargetName={messageResponseTargetName(message.responseTarget, conversation)}
            />
          ))}
        {sendMessage.isPending && (
          <div className="sending-indicator" role="status">
            <span /> 正在等待服务端确认发送…
          </div>
        )}
        {awaitingAgentReply && runStream.content.length > 0 ? (
          <AgentRunStreamingBubble
            agentName={
              conversationAgentDisplayName(conversation, activeRun?.agentId) ??
              activeRun?.agentName ??
              'AI'
            }
            content={runStream.content}
            phase={runStream.phase}
          />
        ) : null}
        {awaitingAgentReply && runStream.content.length === 0 && (
          <div
            className="sending-indicator agent-thinking"
            role="status"
            data-stream-mode={activeRun.streamMode ?? 'unknown'}
          >
            <span /> {agentRunWaitingMessage(activeRun)}
          </div>
        )}
        {awaitingAgentReply ? (
          <div className="agent-run-status-detail">
            <span>
              {conversationAgentDisplayName(conversation, activeRun?.agentId) ??
                activeRun?.agentName}{' '}
              · {activeRun?.status}
            </span>
            <span className="agent-run-stream-state" data-stream-state={runStream.phase}>
              {activeRun.streamMode === 'terminal_only' && runStream.content.length === 0
                ? '等待供应商终态'
                : agentRunStreamPhaseLabel(runStream.phase)}
            </span>
            <button
              type="button"
              disabled={runActions.cancel.isPending}
              onClick={() => activeRun && runActions.cancel.mutate(activeRun.id)}
            >
              {runActions.cancel.isPending ? '正在停止…' : '停止生成'}
            </button>
          </div>
        ) : null}
        {failedRun && latestMessage?.sender.type === 'user' ? (
          <AgentRunFailureNotice
            run={failedRun}
            isRetrying={retryingRunId === failedRun.id || runActions.retry.isPending}
            retryError={runActions.retry.isError ? runActions.retry.error : null}
            onRetry={() => retryFailedRun(failedRun.id)}
          />
        ) : null}
        <div ref={listEndRef} />
      </div>

      <footer className="message-composer">
        {sendMessage.isError && composer.failedRequest && (
          <div className="send-error" role="alert">
            <span>{readableError(sendMessage.error)}</span>
            <button
              type="button"
              disabled={sendMessage.isPending}
              onClick={() => runSend(composer.failedRequest!)}
            >
              使用同一消息 ID 重试
            </button>
          </div>
        )}
        {!isAgentPair &&
        (responseTargets.human !== undefined || responseTargets.agent !== undefined) ? (
          <div className="response-target-switch" role="group" aria-label="选择回应方">
            {responseTargets.human !== undefined ? (
              <button
                type="button"
                className={responseTargetKind === 'human' ? 'selected' : undefined}
                aria-pressed={responseTargetKind === 'human'}
                disabled={sendMessage.isPending}
                onClick={() => setResponseTargetKind('human')}
              >
                <span aria-hidden="true">人</span>
                {isGroup ? '发送到群聊' : `发给 ${responseTargets.human.name}`}
              </button>
            ) : null}
            {responseTargets.agent !== undefined ? (
              <button
                type="button"
                className={responseTargetKind === 'agent' ? 'selected agent' : 'agent'}
                aria-pressed={responseTargetKind === 'agent'}
                disabled={sendMessage.isPending}
                onClick={() => setResponseTargetKind('agent')}
              >
                <span aria-hidden="true">AI</span>
                询问 {responseTargets.agent.name}
              </button>
            ) : null}
            {isSharedMemberAgentConversation ? <small>消息对成员本人始终可见</small> : null}
          </div>
        ) : null}
        <textarea
          value={composer.draft}
          maxLength={20_000}
          rows={3}
          disabled={sendMessage.isPending}
          aria-label={
            isAgentPair
              ? '发起智能体协作主题'
              : isAgentConversation
                ? `向${responseTargetKind === 'agent' ? (responseTargets.agent?.name ?? '智能体') : (responseTargets.human?.name ?? '成员')}发送消息`
                : '向成员发送消息'
          }
          placeholder={
            isAgentPair
              ? '输入希望两个智能体协作讨论的主题…'
              : isAgentConversation
                ? responseTargetKind === 'agent'
                  ? `询问 ${responseTargets.agent?.name ?? '智能体'}…`
                  : `给 ${responseTargets.human?.name ?? '成员'} 发消息…`
                : '输入消息…'
          }
          onChange={(event) => dispatch({ type: 'draftChanged', value: event.target.value })}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              submitDraft();
            }
          }}
        />
        <div className="composer-toolbar">
          <small>Enter 发送 · Shift + Enter 换行</small>
          <span>{composer.draft.length.toLocaleString('zh-CN')} / 20,000</span>
          <button
            type="button"
            className="primary-button"
            disabled={!composer.draft.trim() || sendMessage.isPending}
            onClick={submitDraft}
          >
            {sendMessage.isPending ? '发送中…' : '发送'}
          </button>
        </div>
      </footer>
    </section>
  );
}

export function agentRunStreamPhaseLabel(
  phase: 'idle' | 'replaying' | 'live' | 'offline' | 'terminal' | 'terminal_only',
): string {
  return {
    idle: '等待生成',
    replaying: '正在恢复实时事件',
    live: '正在实时生成',
    offline: '连接中断，正在续传',
    terminal: '生成完成',
    terminal_only: '供应商仅返回终态',
  }[phase];
}

export function agentRunWaitingMessage(run: Pick<ConversationAgentRun, 'streamMode'>): string {
  return run.streamMode === 'terminal_only'
    ? '等待供应商终态；当前供应商不提供增量输出，完成后会自动显示回复。'
    : '智能体正在处理，通常需要 10–30 秒；回复生成后会自动显示。';
}

export function AgentRunStreamingBubble({
  agentName,
  content,
  phase,
}: {
  readonly agentName: string;
  readonly content: string;
  readonly phase: 'idle' | 'replaying' | 'live' | 'offline' | 'terminal' | 'terminal_only';
}): React.JSX.Element {
  return (
    <article
      className="message-entry from-agent agent-run-streaming"
      data-stream-state={phase}
      aria-label={`${agentName} streaming reply`}
    >
      <div className="message-sender-avatar agent">AI</div>
      <div className="message-entry-body">
        <div className="message-meta">
          <strong>{agentName}</strong>
          <span className="sender-type agent">{agentRunStreamPhaseLabel(phase)}</span>
        </div>
        <p>{content}</p>
      </div>
    </article>
  );
}

function MessageBubble({
  message,
  isCurrentUser,
  senderDisplayName,
  responseTargetName,
}: {
  message: Message;
  isCurrentUser: boolean;
  senderDisplayName: string;
  responseTargetName: string | null;
}): React.JSX.Element {
  const isAgent = message.sender.type === 'agent';
  return (
    <article
      className={`message-entry ${isCurrentUser ? 'mine' : ''} ${isAgent ? 'from-agent' : ''}`}
    >
      {!isCurrentUser && (
        <div className={isAgent ? 'message-sender-avatar agent' : 'message-sender-avatar'}>
          {isAgent ? 'AI' : initials(message.sender.name)}
        </div>
      )}
      <div className="message-entry-body">
        <div className="message-meta">
          <strong>{isCurrentUser ? '我' : senderDisplayName}</strong>
          <span className={isAgent ? 'sender-type agent' : 'sender-type human'}>
            {isAgent ? 'AI 智能体' : '真人'}
          </span>
          <time dateTime={message.createdAt}>{fullTime(message.createdAt)}</time>
          {responseTargetName !== null ? (
            <span className="message-response-target">发给 {responseTargetName}</span>
          ) : null}
        </div>
        <p>{message.content.text}</p>
        {message.content.citations && message.content.citations.length > 0 ? (
          <div className="message-citations" aria-label="知识来源">
            <strong>知识来源</strong>
            {message.content.citations.map((citation, index) => (
              <MessageCitationCard
                key={citation.chunkId ?? `legacy:${citation.documentId}:${index}`}
                messageId={message.id}
                citation={citation}
                index={index}
              />
            ))}
          </div>
        ) : null}
        {isAgent ? <AnswerFeedbackControls messageId={message.id} /> : null}
      </div>
    </article>
  );
}

interface ConversationResponseTargets {
  readonly human: Conversation['participants'][number] | undefined;
  readonly agent: Conversation['participants'][number] | undefined;
}

function conversationResponseTargets(
  conversation: Conversation,
  currentUserId: string,
): ConversationResponseTargets {
  return {
    human: conversation.participants.find(
      (participant) => participant.type === 'user' && participant.id !== currentUserId,
    ),
    agent: conversation.participants.find((participant) => participant.type === 'agent'),
  };
}

function selectedResponseTarget(
  kind: 'human' | 'agent',
  targets: ConversationResponseTargets,
): MessageResponseTarget {
  if (kind === 'agent' && targets.agent !== undefined) {
    return { type: 'agent', agentId: targets.agent.id };
  }
  if (targets.human !== undefined) return { type: 'human', userId: targets.human.id };
  if (targets.agent !== undefined) return { type: 'agent', agentId: targets.agent.id };
  throw new Error('当前会话没有可回应的成员或智能体。');
}

function messageResponseTargetName(
  target: MessageResponseTarget | null | undefined,
  conversation: Conversation,
): string | null {
  if (target === null || target === undefined) return null;
  const id = target.type === 'human' ? target.userId : target.agentId;
  return (
    conversation.participants.find(
      (participant) => participant.type === target.type && participant.id === id,
    )?.name ?? null
  );
}

function messageSenderDisplayName(message: Message, conversation: Conversation): string {
  if (message.sender.type !== 'agent') return message.sender.name;
  return conversationAgentDisplayName(conversation, message.sender.id) ?? message.sender.name;
}

function conversationAgentDisplayName(
  conversation: Conversation,
  agentId: string | undefined,
): string | null {
  if (agentId === undefined) return null;
  return (
    conversation.participants.find(
      (participant) => participant.type === 'agent' && participant.id === agentId,
    )?.name ?? null
  );
}

function AnswerFeedbackControls({ messageId }: { messageId: string }): React.JSX.Element {
  const feedbackQuery = useAnswerFeedback(messageId);
  const updateFeedback = useUpsertAnswerFeedback(messageId);
  const current = feedbackQuery.data?.feedback ?? null;
  const [isReasonDialogOpen, setIsReasonDialogOpen] = useState(false);
  const [reason, setReason] = useState<AnswerFeedbackReason>('INCORRECT');
  const [comment, setComment] = useState('');

  function openNegativeFeedback(): void {
    setReason(current?.reason ?? 'INCORRECT');
    setComment(current?.comment ?? '');
    setIsReasonDialogOpen(true);
  }

  async function submitHelpful(): Promise<void> {
    try {
      await updateFeedback.mutateAsync({ rating: 'HELPFUL', reason: null, comment: null });
    } catch {
      // The mutation exposes a stable visible error below the controls.
    }
  }

  async function submitNotHelpful(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    try {
      await updateFeedback.mutateAsync({ rating: 'NOT_HELPFUL', reason, comment });
      setIsReasonDialogOpen(false);
    } catch {
      // Keep the dialog open so the user's explanation is not lost.
    }
  }

  return (
    <div className="answer-feedback" aria-label="评价智能体回答">
      <span>这个回答有帮助吗？</span>
      <div>
        <button
          type="button"
          className={current?.rating === 'HELPFUL' ? 'selected' : undefined}
          aria-pressed={current?.rating === 'HELPFUL'}
          disabled={feedbackQuery.isLoading || updateFeedback.isPending}
          onClick={() => void submitHelpful()}
        >
          有帮助
        </button>
        <button
          type="button"
          className={current?.rating === 'NOT_HELPFUL' ? 'selected' : undefined}
          aria-pressed={current?.rating === 'NOT_HELPFUL'}
          disabled={feedbackQuery.isLoading || updateFeedback.isPending}
          onClick={openNegativeFeedback}
        >
          没帮助
        </button>
      </div>
      {current !== null ? <small>已记录，可随时修改</small> : null}
      {feedbackQuery.error !== null ? (
        <p className="answer-feedback-error" role="alert">
          反馈状态加载失败：{readableError(feedbackQuery.error)}
        </p>
      ) : null}
      {updateFeedback.error !== null && !isReasonDialogOpen ? (
        <p className="answer-feedback-error" role="alert">
          反馈保存失败：{readableError(updateFeedback.error)}
        </p>
      ) : null}

      {isReasonDialogOpen ? (
        <div
          className="answer-feedback-dialog-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setIsReasonDialogOpen(false);
          }}
        >
          <form
            className="answer-feedback-dialog"
            aria-label="没帮助的原因"
            onSubmit={(event) => void submitNotHelpful(event)}
          >
            <header>
              <div>
                <small>帮助我们改进</small>
                <h2>哪里没有帮助？</h2>
              </div>
              <button
                type="button"
                className="icon-action"
                aria-label="关闭反馈"
                onClick={() => setIsReasonDialogOpen(false)}
              >
                ×
              </button>
            </header>
            <fieldset>
              <legend>请选择主要原因</legend>
              {ANSWER_FEEDBACK_REASONS.map((item) => (
                <label key={item}>
                  <input
                    type="radio"
                    name={`feedback-reason-${messageId}`}
                    value={item}
                    checked={reason === item}
                    onChange={() => setReason(item)}
                  />
                  <span>{answerFeedbackReasonLabel(item)}</span>
                </label>
              ))}
            </fieldset>
            <label className="answer-feedback-comment">
              <span>补充说明（可选）</span>
              <textarea
                maxLength={500}
                value={comment}
                placeholder="例如：哪条信息不准确，或缺少哪项知识"
                onChange={(event) => setComment(event.target.value)}
              />
              <small>{comment.length}/500</small>
            </label>
            {updateFeedback.error !== null ? (
              <p className="answer-feedback-error" role="alert">
                保存失败：{readableError(updateFeedback.error)}
              </p>
            ) : null}
            <footer>
              <button type="button" onClick={() => setIsReasonDialogOpen(false)}>
                取消
              </button>
              <button type="submit" disabled={updateFeedback.isPending}>
                {updateFeedback.isPending ? '保存中…' : '提交反馈'}
              </button>
            </footer>
          </form>
        </div>
      ) : null}
    </div>
  );
}

const ANSWER_FEEDBACK_REASONS: readonly AnswerFeedbackReason[] = [
  'INCORRECT',
  'IRRELEVANT_CITATION',
  'OUTDATED',
  'MISSING_KNOWLEDGE',
  'OTHER',
];

export function answerFeedbackReasonLabel(reason: AnswerFeedbackReason): string {
  return {
    INCORRECT: '内容不正确',
    IRRELEVANT_CITATION: '引用与回答无关',
    OUTDATED: '信息已过期',
    MISSING_KNOWLEDGE: '缺少关键知识',
    OTHER: '其他原因',
  }[reason];
}

export function MessageCitationCard({
  messageId,
  citation,
  index,
}: {
  messageId: string;
  citation: MessageCitation;
  index: number;
}): React.JSX.Element {
  const metadata = citationDisplayMetadata(citation);
  const [isOriginalOpen, setIsOriginalOpen] = useState(false);
  const [original, setOriginal] = useState<KnowledgeCitationDetail | null>(null);
  const [isLoadingOriginal, setIsLoadingOriginal] = useState(false);
  const [originalError, setOriginalError] = useState<unknown>(null);
  const requestRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!isOriginalOpen) return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setIsOriginalOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [isOriginalOpen]);

  useEffect(
    () => () => {
      requestRef.current?.abort();
    },
    [],
  );

  async function openOriginal(forceReload = false): Promise<void> {
    if (citation.verificationStatus === 'LEGACY') return;
    setIsOriginalOpen(true);
    if (original !== null && !forceReload) return;

    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setIsLoadingOriginal(true);
    setOriginalError(null);
    try {
      const detail = await getKnowledgeCitationOriginal(
        messageId,
        citation.documentVersionId,
        citation.chunkId,
        controller.signal,
      );
      setOriginal(detail);
    } catch (error) {
      if (!controller.signal.aborted) setOriginalError(error);
    } finally {
      if (requestRef.current === controller) {
        requestRef.current = null;
        setIsLoadingOriginal(false);
      }
    }
  }

  return (
    <>
      <details className="message-citation-card">
        <summary>
          <span className="message-citation-index">[来源{index + 1}]</span>
          <span>{citation.title}</span>
        </summary>
        <div className="message-citation-context">
          {citation.verificationStatus === 'LEGACY' ? (
            <span>旧引用 · 不可完整核验</span>
          ) : (
            <>
              <span>来源链路已核验（非内容真实性判定）</span>
              <span>知识库：{citation.knowledgeBaseName}</span>
              <span>文档：v{citation.documentVersion}</span>
              <span>章节：{metadata.heading}</span>
              <span>类型：{metadata.sourceType}</span>
              <time dateTime={citation.updatedAt}>更新：{metadata.updatedAt}</time>
            </>
          )}
        </div>
        <p>{citation.excerpt}</p>
        {citation.verificationStatus === 'LINEAGE_VERIFIED' ? (
          <button
            type="button"
            className="message-citation-original-action"
            onClick={() => void openOriginal()}
          >
            查看原文
          </button>
        ) : (
          <button
            type="button"
            className="message-citation-original-action"
            disabled
            title="旧引用未保存文档版本与切片信息，无法完整核验原文"
          >
            无法查看原文
          </button>
        )}
      </details>

      {isOriginalOpen && citation.verificationStatus === 'LINEAGE_VERIFIED' ? (
        <div
          className="citation-original-dialog-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setIsOriginalOpen(false);
          }}
        >
          <section
            className="citation-original-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={`${citation.title}引用原文`}
          >
            <header>
              <div>
                <small>引用原文</small>
                <h2>{original?.documentTitle ?? citation.title}</h2>
              </div>
              <button
                type="button"
                className="icon-action"
                aria-label="关闭引用原文"
                onClick={() => setIsOriginalOpen(false)}
              >
                ×
              </button>
            </header>

            {isLoadingOriginal ? (
              <div className="citation-original-state" role="status">
                正在核验当前访问权限并加载原文…
              </div>
            ) : null}
            {originalError !== null ? (
              <div className="citation-original-state error" role="alert">
                <strong>原文暂时无法打开</strong>
                <p>{readableError(originalError)}</p>
                <button type="button" onClick={() => void openOriginal(true)}>
                  重试
                </button>
              </div>
            ) : null}
            {original !== null && !isLoadingOriginal ? (
              <>
                <div className="citation-original-metadata">
                  <span>知识库：{original.knowledgeBaseName}</span>
                  <span>版本：v{original.documentVersion}</span>
                  <span>章节：{original.headingPath.join(' / ') || '未标注章节'}</span>
                  <span>类型：{knowledgeSourceTypeLabel(original.sourceType)}</span>
                  <time dateTime={original.updatedAt}>
                    更新时间：{fullDateTime(original.updatedAt)}
                  </time>
                </div>
                <pre>{original.content}</pre>
              </>
            ) : null}
          </section>
        </div>
      ) : null}
    </>
  );
}

interface AgentRunFailureNoticeProps {
  run: ConversationAgentRun;
  isRetrying: boolean;
  retryError: unknown;
  onRetry: () => void;
}

export function AgentRunFailureNotice({
  run,
  isRetrying,
  retryError,
  onRetry,
}: AgentRunFailureNoticeProps): React.JSX.Element {
  const isResultPendingConfirmation = run.status === 'UNKNOWN';
  const canRetry = run.retryable && !isResultPendingConfirmation;

  return (
    <div className="agent-run-failure" role="alert">
      <strong>
        {run.agentName} {isResultPendingConfirmation ? '的回复状态待确认' : '未能完成回复'}
      </strong>
      <span>
        {isResultPendingConfirmation
          ? '系统尚未确认远端生成结果。请稍后刷新消息或联系管理员，避免重复执行。'
          : run.errorCode
            ? agentRunFailureMessage(run.errorCode, run.retryable)
            : (run.errorMessage ?? '生成失败，请稍后重试。')}
      </span>
      {retryError !== null && canRetry ? (
        <div className="agent-run-retry-error">
          <strong>重新生成请求失败</strong>
          <span>{readableError(retryError)}</span>
        </div>
      ) : null}
      {canRetry ? (
        <button type="button" disabled={isRetrying} onClick={onRetry}>
          {isRetrying ? '正在重新生成…' : '重新生成'}
        </button>
      ) : null}
    </div>
  );
}

export function agentRunFailureMessage(errorCode: string | null, retryable = true): string {
  if (errorCode === 'PROVIDER_INVALID_RESPONSE') {
    return retryable
      ? '模型服务返回的结果暂时无法解析，本次回答未完成。请点击“重新生成”再次尝试；若持续失败，请联系管理员检查模型服务。'
      : '模型服务返回的结果无法解析，本次回答未完成。请联系管理员检查模型服务。';
  }

  const messages: Record<string, string> = {
    AI_RUNTIME_UNAVAILABLE: 'AI Runtime 当前不可用，请确认模型服务已启动。',
    AI_RUNTIME_TIMEOUT: '模型响应超时，请稍后重试。',
    AI_RUNTIME_HTTP_401: '模型服务认证失败，请联系管理员检查密钥。',
    AI_RUNTIME_HTTP_429: '模型服务请求过于频繁，请稍后重试。',
    PROVIDER_UNAVAILABLE: '当前模型提供方不可用，请稍后重试或联系管理员检查模型配置。',
    PROVIDER_TIMEOUT: '模型提供方响应超时，请稍后重试。',
    PROVIDER_AUTHENTICATION_FAILED: '模型提供方认证失败，请联系管理员检查模型密钥。',
    AGENT_NOT_ONLINE: '智能体当前未上线。',
    AGENT_VERSION_NOT_PUBLISHED: '智能体尚无已发布版本。',
  };
  return errorCode ? (messages[errorCode] ?? `生成失败（${errorCode}）`) : '生成失败，请稍后重试。';
}

function ConversationAvatar({
  conversation,
  currentUserId,
  large = false,
}: {
  conversation: Conversation;
  currentUserId: string;
  large?: boolean;
}): React.JSX.Element {
  const isAgent = conversationHasAgent(conversation);
  const isAgentPair = conversationHasAgentPair(conversation);
  return (
    <span className={`conversation-avatar ${isAgent ? 'agent' : ''} ${large ? 'large' : ''}`}>
      {isAgentPair
        ? 'AI²'
        : isAgent
          ? 'AI'
          : initials(conversationTitle(conversation, currentUserId))}
    </span>
  );
}

function ConversationListSkeleton(): React.JSX.Element {
  return (
    <div className="conversation-skeleton" aria-label="正在加载会话">
      {[0, 1, 2, 3].map((item) => (
        <div key={item}>
          <i />
          <span />
        </div>
      ))}
    </div>
  );
}

function MessageTimelineSkeleton(): React.JSX.Element {
  return (
    <div className="timeline-skeleton" aria-label="正在加载消息">
      <span />
      <span />
      <span />
    </div>
  );
}

function InlineFailure({
  title,
  message,
  onRetry,
}: {
  title: string;
  message: string;
  onRetry: () => void;
}): React.JSX.Element {
  return (
    <div className="inline-failure" role="alert">
      <span aria-hidden="true">!</span>
      <strong>{title}</strong>
      <p>{message}</p>
      <button type="button" onClick={onRetry}>
        重试
      </button>
    </div>
  );
}

function SyncWarning({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry: () => void;
}): React.JSX.Element {
  return (
    <div className="sync-warning" role="status">
      <span>自动同步暂时中断，已保留现有内容。</span>
      <button type="button" onClick={onRetry} title={readableError(error)}>
        立即重试
      </button>
    </div>
  );
}

export function conversationHasAgent(conversation: Conversation): boolean {
  return conversation.participants.some((participant) => participant.type === 'agent');
}

export function conversationHasAgentPair(conversation: Conversation): boolean {
  return (
    conversation.participants.filter((participant) => participant.type === 'agent').length >= 2
  );
}

export function conversationHasSharedMemberAgent(
  conversation: Conversation,
  currentUserId: string,
): boolean {
  return (
    conversation.participants.some((participant) => participant.type === 'agent') &&
    conversation.participants.some(
      (participant) => participant.type === 'user' && participant.id !== currentUserId,
    )
  );
}

export function conversationTitle(conversation: Conversation, currentUserId?: string): string {
  if (conversation.title) return conversation.title;
  const visibleParticipants = currentUserId
    ? conversation.participants.filter(
        (participant) => !(participant.type === 'user' && participant.id === currentUserId),
      )
    : conversation.participants;
  return visibleParticipants.map((participant) => participant.name).join('、') || '未命名会话';
}

function participantDescription(conversation: Conversation, currentUserId: string): string {
  const others = conversation.participants.filter(
    (participant) => !(participant.type === 'user' && participant.id === currentUserId),
  );
  return others
    .map((participant) => `${participant.name}（${participant.type === 'agent' ? 'AI' : '真人'}）`)
    .join('、');
}

function readableError(error: unknown): string {
  if (error instanceof ApiClientError) {
    return `${error.message}${error.requestId ? `（请求 ID：${error.requestId}）` : ''}`;
  }
  return error instanceof Error ? error.message : '发生未知错误，请重试。';
}

function initials(value: string): string {
  const normalized = value.trim();
  if (!normalized) return '?';
  return [...normalized].slice(-2).join('').toLocaleUpperCase('zh-CN');
}

function compactTime(value: string): string {
  const date = new Date(value);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(date);
  }
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' }).format(date);
}

function fullTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

type MessageCitation = NonNullable<TextMessageContent['citations']>[number];

export function citationDisplayMetadata(citation: MessageCitation): {
  readonly heading: string;
  readonly sourceType: string;
  readonly updatedAt: string;
} {
  if (citation.verificationStatus === 'LEGACY') {
    return {
      heading: '历史记录未保存章节',
      sourceType: '旧引用',
      updatedAt: '不可完整核验',
    };
  }
  return {
    heading: citation.headingPath.join(' / ') || '未标注章节',
    sourceType: knowledgeSourceTypeLabel(citation.sourceType),
    updatedAt: new Intl.DateTimeFormat('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(citation.updatedAt)),
  };
}

function knowledgeSourceTypeLabel(sourceType: 'TEXT' | 'MARKDOWN' | 'FILE' | 'WEB'): string {
  return { TEXT: '文本', MARKDOWN: 'Markdown', FILE: '文件', WEB: 'HTTPS 网页' }[sourceType];
}

function fullDateTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}
