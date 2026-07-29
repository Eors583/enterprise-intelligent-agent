import type {
  Conversation,
  CreateMemoryCandidateRequest,
  MemoryRecord,
  MemoryScope,
  MemoryTransitionRequest,
  RoleAssignment,
  Task,
} from '@enterprise/contracts';
import { useMemo, useState, type FormEvent } from 'react';

import { useCreateMemoryCandidate, useMemories, useTransitionMemory } from './hooks';
import {
  AGENT_RUN_MEMORY_PURPOSE,
  MEMORY_SCOPES,
  availableMemoryActions,
  formatMemoryDate,
  memoryActionLabel,
  memoryContentHash,
  memoryErrorMessage,
  memoryExpiryIso,
  memoryIdentity,
  memoryScopeLabel,
  memoryStatusLabel,
  shortMemoryId,
  splitMemoryLabels,
} from './memory-view';
import './memory.css';

interface MemoryWorkspaceProps {
  readonly assignments: readonly RoleAssignment[];
  readonly tasks: readonly Task[];
  readonly conversations: readonly Conversation[];
}

export function MemoryWorkspace({
  assignments,
  tasks,
  conversations,
}: MemoryWorkspaceProps): React.JSX.Element {
  const [scope, setScope] = useState<MemoryScope>('ENTERPRISE');
  const [purpose, setPurpose] = useState('');
  const memories = useMemories(scope, purpose);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [transition, setTransition] = useState<{
    readonly memory: MemoryRecord;
    readonly action: MemoryTransitionRequest['action'];
  } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const selected =
    memories.data?.items.find((memory) => memory.id === selectedId) ??
    memories.data?.items[0] ??
    null;

  return (
    <div className="memory-module">
      <MemorySidebar
        scope={scope}
        purpose={purpose}
        items={memories.data?.items}
        selectedId={selected?.id ?? null}
        isLoading={memories.isPending}
        error={memories.error}
        onScopeChange={(nextScope) => {
          setScope(nextScope);
          if (nextScope === 'EMPLOYEE_PRIVATE' && !purpose.trim()) {
            setPurpose(AGENT_RUN_MEMORY_PURPOSE);
          }
          setSelectedId(null);
          setNotice(null);
        }}
        onPurposeChange={(nextPurpose) => {
          setPurpose(nextPurpose);
          setSelectedId(null);
        }}
        onSelect={setSelectedId}
        onRefresh={() => void memories.refetch()}
        onCreate={() => setCreateOpen(true)}
      />

      <main className="memory-workspace">
        <header className="memory-topbar">
          <div>
            <strong>我的记忆</strong>
            <span />
            <small>{memoryScopeLabel(scope)}</small>
          </div>
          <div className="memory-security-state">
            <i /> 权限过滤已启用
          </div>
        </header>

        {notice ? (
          <div className="memory-notice" role="status">
            <span>{notice}</span>
            <button type="button" onClick={() => setNotice(null)} aria-label="关闭提示">
              ×
            </button>
          </div>
        ) : null}

        {scope === 'EMPLOYEE_PRIVATE' && !purpose.trim() ? (
          <MemoryState
            title="需要填写使用目的"
            description="员工私有记忆采用用途绑定同意。只有与记录同意用途完全一致时，服务端才会返回内容。"
          />
        ) : memories.isPending ? (
          <MemoryState
            title="正在加载记忆"
            description="正在校验任命、任务、会话和权限标签…"
            busy
          />
        ) : memories.isError ? (
          <MemoryState
            title="记忆加载失败"
            description={memoryErrorMessage(memories.error)}
            error
            action={
              <button type="button" onClick={() => void memories.refetch()}>
                重新加载
              </button>
            }
          />
        ) : selected ? (
          <MemoryDetail
            memory={selected}
            onTransition={(action) => setTransition({ memory: selected, action })}
          />
        ) : (
          <MemoryState
            title="当前范围暂无记忆"
            description="服务端已成功响应；这里不会生成示例记忆或跨范围拼接内容。"
            action={
              <button type="button" onClick={() => setCreateOpen(true)}>
                创建候选记忆
              </button>
            }
          />
        )}
      </main>

      {createOpen ? (
        <CreateMemoryDialog
          scope={scope}
          purpose={purpose}
          assignments={assignments}
          tasks={tasks}
          conversations={conversations}
          onClose={() => setCreateOpen(false)}
          onSaved={(created) => {
            setCreateOpen(false);
            setSelectedId(created.id);
            setNotice('候选记忆已登记，仍需显式确认后才能生效。');
            void memories.refetch();
          }}
        />
      ) : null}

      {transition ? (
        <MemoryTransitionDialog
          scope={scope}
          purpose={purpose}
          memory={transition.memory}
          action={transition.action}
          onClose={() => setTransition(null)}
          onSaved={(updated) => {
            setTransition(null);
            setSelectedId(updated.id);
            setNotice('记忆状态已由服务端确认并写入审计。');
            void memories.refetch();
          }}
        />
      ) : null}
    </div>
  );
}

function MemorySidebar({
  scope,
  purpose,
  items,
  selectedId,
  isLoading,
  error,
  onScopeChange,
  onPurposeChange,
  onSelect,
  onRefresh,
  onCreate,
}: {
  readonly scope: MemoryScope;
  readonly purpose: string;
  readonly items: readonly MemoryRecord[] | undefined;
  readonly selectedId: string | null;
  readonly isLoading: boolean;
  readonly error: unknown;
  readonly onScopeChange: (scope: MemoryScope) => void;
  readonly onPurposeChange: (purpose: string) => void;
  readonly onSelect: (id: string) => void;
  readonly onRefresh: () => void;
  readonly onCreate: () => void;
}): React.JSX.Element {
  return (
    <aside className="memory-sidebar" aria-label="五层记忆">
      <header>
        <div>
          <span>MEMORY</span>
          <h1>五层记忆</h1>
        </div>
        <button type="button" aria-label="刷新记忆" onClick={onRefresh}>
          ↻
        </button>
      </header>
      <p>企业、角色、员工、任务和会话记忆严格隔离，不跨范围合并授权。</p>
      <div className="memory-scope-tabs" role="tablist" aria-label="记忆范围">
        {MEMORY_SCOPES.map((candidate) => (
          <button
            key={candidate}
            type="button"
            role="tab"
            aria-selected={scope === candidate}
            className={scope === candidate ? 'active' : ''}
            onClick={() => onScopeChange(candidate)}
          >
            <span>{memoryScopeGlyph(candidate)}</span>
            <small>{memoryScopeLabel(candidate)}</small>
          </button>
        ))}
      </div>
      {scope === 'EMPLOYEE_PRIVATE' ? (
        <label className="memory-purpose">
          <span>本次使用目的</span>
          <input
            value={purpose}
            onChange={(event) => onPurposeChange(event.target.value)}
            placeholder="必须与授权用途完全一致"
          />
          <button
            type="button"
            onClick={() => onPurposeChange(AGENT_RUN_MEMORY_PURPOSE)}
            disabled={purpose === AGENT_RUN_MEMORY_PURPOSE}
          >
            用于智能体对话
          </button>
          <small>默认用途 {AGENT_RUN_MEMORY_PURPOSE} 会在每次 Agent Run 调度前重新校验。</small>
        </label>
      ) : null}
      <div className="memory-sidebar-toolbar">
        <strong>{memoryScopeLabel(scope)}</strong>
        <button type="button" onClick={onCreate}>
          + 候选
        </button>
      </div>
      <div className="memory-record-list">
        {isLoading ? (
          <p role="status">正在读取…</p>
        ) : error ? (
          <p role="alert">加载失败</p>
        ) : !items?.length ? (
          <p>暂无可见记录</p>
        ) : (
          items.map((memory) => (
            <button
              key={memory.id}
              type="button"
              className={memory.id === selectedId ? 'selected' : ''}
              onClick={() => onSelect(memory.id)}
            >
              <span className={`memory-record-glyph status-${memory.status.toLowerCase()}`}>
                {memoryScopeGlyph(memory.scope)}
              </span>
              <span>
                <strong>{memory.title}</strong>
                <small>
                  {memoryStatusLabel(memory.status)} · v{memory.version}
                </small>
                <time>{formatMemoryDate(memory.updatedAt)}</time>
              </span>
            </button>
          ))
        )}
      </div>
    </aside>
  );
}

function MemoryDetail({
  memory,
  onTransition,
}: {
  readonly memory: MemoryRecord;
  readonly onTransition: (action: MemoryTransitionRequest['action']) => void;
}): React.JSX.Element {
  const actions = availableMemoryActions(memory.status);
  return (
    <section className="memory-detail-card">
      <header>
        <div className="memory-detail-mark">{memoryScopeGlyph(memory.scope)}</div>
        <div>
          <span>{memoryScopeLabel(memory.scope)}</span>
          <h2>{memory.title}</h2>
          <p>{memoryIdentity(memory)}</p>
        </div>
        <span className={`memory-status status-${memory.status.toLowerCase()}`}>
          {memoryStatusLabel(memory.status)}
        </span>
      </header>

      <div className="memory-summary">
        <span>受控摘要</span>
        <p>{memory.summary}</p>
      </div>

      <dl className="memory-metadata">
        <div>
          <dt>来源</dt>
          <dd>
            {memory.sourceType} · {shortMemoryId(memory.sourceId)} · v{memory.sourceVersion}
          </dd>
        </div>
        <div>
          <dt>敏感级别</dt>
          <dd>{memory.sensitivity}</dd>
        </div>
        <div>
          <dt>证据</dt>
          <dd>{memory.sourceEvidenceIds.length} 条</dd>
        </div>
        <div>
          <dt>权限标签</dt>
          <dd>{memory.permissionLabels.join('、') || '无附加标签'}</dd>
        </div>
        <div>
          <dt>生效</dt>
          <dd>{formatMemoryDate(memory.effectiveFrom)}</dd>
        </div>
        <div>
          <dt>到期</dt>
          <dd>{formatMemoryDate(memory.expiresAt ?? memory.effectiveTo)}</dd>
        </div>
        <div>
          <dt>保留动作</dt>
          <dd>{memory.retentionAction}</dd>
        </div>
        <div>
          <dt>内容指纹</dt>
          <dd>{memory.contentHash.slice(0, 16)}…</dd>
        </div>
      </dl>

      {memory.scope === 'EMPLOYEE_PRIVATE' ? (
        <div className="memory-consent" role="note">
          <strong>用途绑定同意</strong>
          <span>{memory.consent.purpose}</span>
          <small>授权于 {formatMemoryDate(memory.consent.grantedAt)}</small>
        </div>
      ) : null}

      <footer>
        <small>
          r{memory.revision} · 更新于 {formatMemoryDate(memory.updatedAt)}
        </small>
        <div>
          {actions.map((action) => (
            <button
              key={action}
              type="button"
              className={action === 'DELETE' ? 'danger' : ''}
              onClick={() => onTransition(action)}
            >
              {memoryActionLabel(action)}
            </button>
          ))}
        </div>
      </footer>
    </section>
  );
}

function CreateMemoryDialog({
  scope,
  purpose,
  assignments,
  tasks,
  conversations,
  onClose,
  onSaved,
}: {
  readonly scope: MemoryScope;
  readonly purpose: string;
  readonly assignments: readonly RoleAssignment[];
  readonly tasks: readonly Task[];
  readonly conversations: readonly Conversation[];
  readonly onClose: () => void;
  readonly onSaved: (memory: MemoryRecord) => void;
}): React.JSX.Element {
  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');
  const [labels, setLabels] = useState('');
  const [sensitivity, setSensitivity] =
    useState<CreateMemoryCandidateRequest['sensitivity']>('INTERNAL');
  const [selectedAssignmentId, setSelectedAssignmentId] = useState(assignments[0]?.id ?? '');
  const [selectedTaskId, setSelectedTaskId] = useState(tasks[0]?.id ?? '');
  const [selectedConversationId, setSelectedConversationId] = useState(conversations[0]?.id ?? '');
  const [expiresAt, setExpiresAt] = useState('');
  const [error, setError] = useState<string | null>(null);
  const create = useCreateMemoryCandidate(scope, purpose);
  const assignment = assignments.find((item) => item.id === selectedAssignmentId) ?? null;

  const sourceId = useMemo(() => {
    if (scope === 'ROLE' || scope === 'EMPLOYEE_PRIVATE') return assignment?.id ?? '';
    if (scope === 'TASK') return selectedTaskId;
    if (scope === 'CONVERSATION') return selectedConversationId;
    return crypto.randomUUID();
  }, [assignment?.id, scope, selectedConversationId, selectedTaskId]);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setError(null);
    try {
      const input: CreateMemoryCandidateRequest = {
        scope,
        title,
        summary,
        contentHash: await memoryContentHash(summary),
        sourceType: 'USER_CONFIRMED',
        sourceId,
        sourceVersion: 1,
        sourceEvidenceIds: [],
        ...(scope === 'ROLE' || scope === 'EMPLOYEE_PRIVATE'
          ? {
              roleTemplateId: assignment?.roleTemplateId ?? assignment?.agent.template.id ?? '',
              roleVersionId: assignment?.roleVersionId ?? assignment?.agent.versionId ?? '',
            }
          : {}),
        ...(scope === 'EMPLOYEE_PRIVATE'
          ? {
              roleAssignmentId: assignment?.id ?? '',
              consentPurpose: purpose.trim(),
            }
          : {}),
        ...(scope === 'TASK' ? { taskId: selectedTaskId } : {}),
        ...(scope === 'CONVERSATION'
          ? {
              conversationId: selectedConversationId,
              expiresAt: memoryExpiryIso(expiresAt),
            }
          : {}),
        permissionLabels: splitMemoryLabels(labels),
        sensitivity,
        retentionAction:
          scope === 'EMPLOYEE_PRIVATE' ? 'SEAL' : scope === 'CONVERSATION' ? 'DELETE' : 'ARCHIVE',
        idempotencyKey: crypto.randomUUID(),
      };
      onSaved(await create.mutateAsync(input));
    } catch (caught: unknown) {
      setError(memoryErrorMessage(caught));
    }
  };

  return (
    <MemoryDialog title={`创建${memoryScopeLabel(scope)}候选`} onClose={onClose}>
      <form onSubmit={(event) => void submit(event)}>
        <label>
          <span>标题</span>
          <input
            required
            maxLength={300}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <label>
          <span>受控摘要</span>
          <textarea
            required
            rows={5}
            maxLength={20_000}
            value={summary}
            onChange={(event) => setSummary(event.target.value)}
          />
        </label>
        {scope === 'ROLE' || scope === 'EMPLOYEE_PRIVATE' ? (
          <label>
            <span>角色任命</span>
            <select
              required
              value={selectedAssignmentId}
              onChange={(event) => setSelectedAssignmentId(event.target.value)}
            >
              {assignments.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.agent.template.name} · v{item.agent.version}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {scope === 'TASK' ? (
          <label>
            <span>任务</span>
            <select
              required
              value={selectedTaskId}
              onChange={(event) => setSelectedTaskId(event.target.value)}
            >
              {tasks.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {scope === 'CONVERSATION' ? (
          <div className="memory-dialog-grid">
            <label>
              <span>会话</span>
              <select
                required
                value={selectedConversationId}
                onChange={(event) => setSelectedConversationId(event.target.value)}
              >
                {conversations.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.title ?? shortMemoryId(item.id)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>到期时间</span>
              <input
                required
                type="datetime-local"
                value={expiresAt}
                onChange={(event) => setExpiresAt(event.target.value)}
              />
            </label>
          </div>
        ) : null}
        {scope === 'EMPLOYEE_PRIVATE' ? (
          <div className="memory-dialog-consent">
            <strong>使用目的</strong>
            <span>{purpose.trim() || '请先在左侧输入明确用途'}</span>
            <small>
              确认后仅本人在相同用途下可访问；使用 AGENT_RUN_CONTEXT 时可作为受控对话上下文，
              管理员默认不可读取。
            </small>
          </div>
        ) : null}
        <div className="memory-dialog-grid">
          <label>
            <span>权限标签</span>
            <input value={labels} onChange={(event) => setLabels(event.target.value)} />
          </label>
          <label>
            <span>敏感级别</span>
            <select
              value={sensitivity}
              onChange={(event) => setSensitivity(event.target.value as typeof sensitivity)}
            >
              <option value="PUBLIC">PUBLIC</option>
              <option value="INTERNAL">INTERNAL</option>
              <option value="CONFIDENTIAL">CONFIDENTIAL</option>
              <option value="RESTRICTED">RESTRICTED</option>
            </select>
          </label>
        </div>
        {error ? (
          <p className="memory-dialog-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="memory-dialog-actions">
          <button type="button" onClick={onClose} disabled={create.isPending}>
            取消
          </button>
          <button
            type="submit"
            disabled={create.isPending || (scope === 'EMPLOYEE_PRIVATE' && !purpose.trim())}
          >
            {create.isPending ? '正在登记…' : '登记候选'}
          </button>
        </div>
      </form>
    </MemoryDialog>
  );
}

function MemoryTransitionDialog({
  scope,
  purpose,
  memory,
  action,
  onClose,
  onSaved,
}: {
  readonly scope: MemoryScope;
  readonly purpose: string;
  readonly memory: MemoryRecord;
  readonly action: MemoryTransitionRequest['action'];
  readonly onClose: () => void;
  readonly onSaved: (memory: MemoryRecord) => void;
}): React.JSX.Element {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const transition = useTransitionMemory(scope, purpose);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setError(null);
    try {
      onSaved(
        await transition.mutateAsync({
          memoryId: memory.id,
          input: {
            expectedRevision: memory.revision,
            action,
            reason,
            idempotencyKey: crypto.randomUUID(),
          },
        }),
      );
    } catch (caught: unknown) {
      setError(memoryErrorMessage(caught));
    }
  };

  return (
    <MemoryDialog title={memoryActionLabel(action)} onClose={onClose}>
      <form onSubmit={(event) => void submit(event)}>
        <div className="memory-transition-warning">
          <strong>{memory.title}</strong>
          <span>
            当前 {memoryStatusLabel(memory.status)} · r{memory.revision}
          </span>
        </div>
        <label>
          <span>操作理由</span>
          <textarea
            required
            maxLength={500}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </label>
        {action === 'DELETE' ? (
          <p className="memory-delete-note">
            删除后不会再进入检索，但审计和法定留存记录仍按策略保存。
          </p>
        ) : null}
        {error ? (
          <p className="memory-dialog-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="memory-dialog-actions">
          <button type="button" onClick={onClose} disabled={transition.isPending}>
            取消
          </button>
          <button
            className={action === 'DELETE' ? 'danger' : ''}
            type="submit"
            disabled={transition.isPending}
          >
            {transition.isPending ? '正在提交…' : memoryActionLabel(action)}
          </button>
        </div>
      </form>
    </MemoryDialog>
  );
}

function MemoryDialog({
  title,
  onClose,
  children,
}: {
  readonly title: string;
  readonly onClose: () => void;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="memory-dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="memory-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <span>GOVERNED MEMORY</span>
            <h2>{title}</h2>
          </div>
          <button type="button" aria-label="关闭" onClick={onClose}>
            ×
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}

function MemoryState({
  title,
  description,
  busy = false,
  error = false,
  action,
}: {
  readonly title: string;
  readonly description: string;
  readonly busy?: boolean;
  readonly error?: boolean;
  readonly action?: React.ReactNode;
}): React.JSX.Element {
  return (
    <section
      className={`memory-state ${error ? 'error' : ''}`}
      role={error ? 'alert' : busy ? 'status' : undefined}
    >
      <span>{busy ? '···' : error ? '!' : '◇'}</span>
      <h2>{title}</h2>
      <p>{description}</p>
      {action}
    </section>
  );
}

function memoryScopeGlyph(scope: MemoryScope): string {
  return {
    ENTERPRISE: '企',
    ROLE: '角',
    EMPLOYEE_PRIVATE: '私',
    TASK: '任',
    CONVERSATION: '聊',
  }[scope];
}
