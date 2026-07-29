import type {
  Collaboration,
  CollaborationCommandRequest,
  CorrectionCase,
  CorrectionFeedbackRequest,
  CreateCollaborationRequest,
} from '@enterprise/contracts';
import { useEffect, useId, useState, type FormEvent } from 'react';

import {
  useCreateTaskCollaboration,
  useSubmitTaskCollaborationCommand,
  useSubmitTaskCorrectionFeedback,
  useTaskCollaborationCandidates,
  useTaskCollaborationDetail,
  useTaskCollaborations,
  useTaskCorrections,
} from './hooks';
import {
  collaborationActionsFor,
  collaborationCommandLabel,
  collaborationMessageLabel,
  collaborationStatusLabel,
  correctionActionLabel,
  correctionActionRequiresEvidence,
  correctionActionsFor,
  correctionStatusLabel,
  isCollaborationTerminal,
  isWorkbenchCapabilityUnavailable,
  workbenchInteractionError,
  type CollaborationCommandAction,
  type CorrectionFeedbackAction,
} from './interaction-view';
import { formatWorkbenchDate, shortBusinessId } from './workbench-view';

export type WorkbenchTaskMode = 'overview' | 'execution' | 'collaboration' | 'correction' | 'tools';

export function WorkbenchTaskModeTabs({
  active,
  onChange,
}: {
  active: WorkbenchTaskMode;
  onChange: (mode: WorkbenchTaskMode) => void;
}): React.JSX.Element {
  const tabs: ReadonlyArray<{ id: WorkbenchTaskMode; label: string; description: string }> = [
    { id: 'overview', label: '任务总览', description: '经营语义与 trace' },
    { id: 'execution', label: '任务执行', description: '状态、证据与验收' },
    { id: 'collaboration', label: '协同', description: '结构化协议消息' },
    { id: 'correction', label: '纠偏', description: '依据、影响与反馈' },
    { id: 'tools', label: '工具', description: '受控查询与执行' },
  ];
  return (
    <div className="workbench-task-mode-tabs" role="tablist" aria-label="任务工作区视图">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          id={`task-mode-tab-${tab.id}`}
          type="button"
          role="tab"
          aria-selected={active === tab.id}
          aria-controls={`task-mode-panel-${tab.id}`}
          tabIndex={active === tab.id ? 0 : -1}
          className={active === tab.id ? 'active' : ''}
          onClick={() => onChange(tab.id)}
        >
          <strong>{tab.label}</strong>
          <small>{tab.description}</small>
        </button>
      ))}
    </div>
  );
}

export function TaskCollaborationPanel({ taskId }: { taskId: string }): React.JSX.Element {
  const list = useTaskCollaborations(taskId);
  const collaborations = list.data?.items;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [commandAction, setCommandAction] = useState<CollaborationCommandAction | null>(null);

  useEffect(() => {
    if (!collaborations) return;
    setSelectedId((current) =>
      current && collaborations.some((item) => item.id === current)
        ? current
        : (collaborations[0]?.id ?? null),
    );
  }, [collaborations]);

  const selected = collaborations?.find((collaboration) => collaboration.id === selectedId) ?? null;
  const detail = useTaskCollaborationDetail(taskId, selectedId, selectedId !== null);

  if (list.isPending && list.data === undefined) {
    return (
      <InteractionState
        title="正在读取协同"
        description="等待服务端返回当前任务可见的结构化协同…"
        busy
      />
    );
  }
  if (list.isError) {
    return (
      <InteractionErrorState
        title={isWorkbenchCapabilityUnavailable(list.error) ? '协同能力未接通' : '协同加载失败'}
        error={list.error}
        onRetry={() => void list.refetch()}
      />
    );
  }
  return (
    <section
      id="task-mode-panel-collaboration"
      role="tabpanel"
      aria-labelledby="task-mode-tab-collaboration"
      className="task-interaction-panel"
    >
      <header className="interaction-panel-header">
        <div>
          <p className="eyebrow">Structured collaboration</p>
          <h2>协同协议</h2>
          <p>Request / Commit / Deliver / Accept / Reject / Escalate / Cancel</p>
        </div>
        <div className="interaction-header-actions">
          <button type="button" onClick={() => setCreating(true)}>
            发起协同
          </button>
          <button type="button" disabled={list.isFetching} onClick={() => void list.refetch()}>
            {list.isFetching ? '刷新中…' : '刷新'}
          </button>
        </div>
      </header>

      {!collaborations?.length ? (
        <InteractionState
          title="暂无协同"
          description="服务端已成功响应，但当前任务没有可见协同；这里不会创建示例记录，可通过“发起协同”创建真实协议。"
          compact
        />
      ) : (
        <div className="interaction-layout">
          <div className="interaction-record-list" role="list" aria-label="任务协同列表">
            {collaborations.map((collaboration) => (
              <button
                key={collaboration.id}
                type="button"
                role="listitem"
                className={collaboration.id === selectedId ? 'selected' : ''}
                aria-current={collaboration.id === selectedId ? 'true' : undefined}
                onClick={() => setSelectedId(collaboration.id)}
              >
                <span>{collaboration.status.slice(0, 1)}</span>
                <span>
                  <strong>{collaboration.commonGoal}</strong>
                  <small>
                    {collaborationStatusLabel(collaboration.status)} · r{collaboration.revision}
                  </small>
                  <code>{shortBusinessId(collaboration.correlationId)}</code>
                </span>
              </button>
            ))}
            {list.data.pageInfo.hasMore ? (
              <p className="interaction-page-hint">
                服务端还有更多协同记录；已保留分页游标，不会伪造本地记录。
              </p>
            ) : null}
          </div>

          {selected ? (
            <CollaborationDetail
              collaboration={selected}
              pending={detail.isPending}
              error={detail.error}
              response={detail.data}
              onRetry={() => void detail.refetch()}
              onAction={setCommandAction}
            />
          ) : null}
        </div>
      )}

      {creating ? (
        <CreateCollaborationDialog
          taskId={taskId}
          onClose={() => setCreating(false)}
          onCreated={(collaborationId) => {
            setSelectedId(collaborationId);
            setCreating(false);
          }}
        />
      ) : null}
      {selected && commandAction ? (
        <CollaborationCommandDialog
          taskId={taskId}
          collaboration={detail.data?.collaboration ?? selected}
          action={commandAction}
          onClose={() => setCommandAction(null)}
        />
      ) : null}
    </section>
  );
}

function CollaborationDetail({
  collaboration,
  pending,
  error,
  response,
  onRetry,
  onAction,
}: {
  collaboration: Collaboration;
  pending: boolean;
  error: unknown;
  response: ReturnType<typeof useTaskCollaborationDetail>['data'];
  onRetry: () => void;
  onAction: (action: CollaborationCommandAction) => void;
}): React.JSX.Element {
  if (pending && response === undefined) {
    return (
      <InteractionState
        title="正在读取协同 trace"
        description="正在校验消息的 Collaboration、Tenant 与 Correlation 归属…"
        busy
        compact
      />
    );
  }
  if (error) {
    return (
      <InteractionErrorState
        title={
          isWorkbenchCapabilityUnavailable(error) ? '协同详情能力未接通' : '协同 trace 加载失败'
        }
        error={error}
        onRetry={onRetry}
        compact
      />
    );
  }
  if (!response) {
    return (
      <InteractionState
        title="暂无协同 trace"
        description="服务端未返回可展示的协同详情。"
        compact
      />
    );
  }
  if (collaboration.id !== response.collaboration.id) {
    return (
      <InteractionState
        title="协同详情身份不一致"
        description="服务端返回了其他协同的详情，当前内容已拒绝展示。"
        compact
        alert
      />
    );
  }

  return (
    <article className="interaction-detail-card">
      <header>
        <div>
          <p className="eyebrow">Correlation trace</p>
          <h3>{response.collaboration.commonGoal}</h3>
          <p>{response.collaboration.requestedInput}</p>
        </div>
        <div>
          <span className={`interaction-status ${response.collaboration.status.toLowerCase()}`}>
            {collaborationStatusLabel(response.collaboration.status)}
          </span>
          {isCollaborationTerminal(response.collaboration.status) ? (
            <button type="button" disabled>
              协同已终态
            </button>
          ) : (
            <div className="interaction-action-row">
              {collaborationActionsFor(response.collaboration.status).map((action) => (
                <button key={action} type="button" onClick={() => onAction(action)}>
                  {collaborationCommandLabel(action)}
                </button>
              ))}
            </div>
          )}
        </div>
      </header>
      <IdentityTrace
        entries={[
          ['Correlation ID', response.collaboration.correlationId],
          ['Collaboration ID', response.collaboration.id],
          ['Objective', response.collaboration.objectiveId],
          ['Task', response.collaboration.taskId],
          ['Requester role', response.collaboration.requesterRoleAssignmentId],
          ['Revision', `r${response.collaboration.revision}`],
        ]}
      />
      <div className="collaboration-message-list">
        {response.messages.length > 0 ? (
          response.messages.map((message) => (
            <article key={message.id}>
              <header>
                <span>{collaborationMessageLabel(message.type)}</span>
                <strong>{formatWorkbenchDate(message.occurredAt)}</strong>
                <code>r{message.revision}</code>
              </header>
              <IdentityTrace
                entries={[
                  ['Message ID', message.id],
                  ['Correlation ID', message.correlationId],
                  ['Causation ID', message.causationId],
                  ['Sender role', message.senderRoleAssignmentId],
                ]}
                compact
              />
              <pre>{JSON.stringify(message.payload, null, 2)}</pre>
            </article>
          ))
        ) : (
          <p className="interaction-empty-copy">该协同详情没有服务端返回的协议消息。</p>
        )}
      </div>
    </article>
  );
}

function CreateCollaborationDialog({
  taskId,
  onClose,
  onCreated,
}: {
  taskId: string;
  onClose: () => void;
  onCreated: (collaborationId: string) => void;
}): React.JSX.Element {
  const titleId = useId();
  const candidates = useTaskCollaborationCandidates(taskId);
  const mutation = useCreateTaskCollaboration(taskId);
  const [actingRoleAssignmentId, setActingRoleAssignmentId] = useState('');
  const [recipientRoleAssignmentIds, setRecipientRoleAssignmentIds] = useState<string[]>([]);
  const [background, setBackground] = useState('');
  const [commonGoal, setCommonGoal] = useState('');
  const [requestedInput, setRequestedInput] = useState('');
  const [dueAt, setDueAt] = useState('');
  const [expectedOutputSchema, setExpectedOutputSchema] = useState(
    JSON.stringify(
      {
        type: 'object',
        properties: { summary: { type: 'string' } },
        required: ['summary'],
      },
      null,
      2,
    ),
  );
  const [error, setError] = useState<string | null>(null);
  const [idempotencyKey] = useState(() => `desktop-collaboration:create:${crypto.randomUUID()}`);

  useEffect(() => {
    const first = candidates.data?.items.find((candidate) => candidate.canActAsRequester);
    if (first && !actingRoleAssignmentId) setActingRoleAssignmentId(first.roleAssignmentId);
  }, [actingRoleAssignmentId, candidates.data?.items]);

  const parsedSchema = parseJsonObject(expectedOutputSchema);
  const dueAtDate = dueAt ? new Date(dueAt) : null;
  const canSubmit =
    !mutation.isPending &&
    actingRoleAssignmentId.length > 0 &&
    recipientRoleAssignmentIds.length > 0 &&
    background.trim().length > 0 &&
    commonGoal.trim().length > 0 &&
    requestedInput.trim().length > 0 &&
    parsedSchema !== null &&
    dueAtDate !== null &&
    !Number.isNaN(dueAtDate.getTime()) &&
    dueAtDate.getTime() > Date.now();

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!canSubmit || dueAtDate === null || parsedSchema === null) return;
    setError(null);
    const input: CreateCollaborationRequest = {
      actingRoleAssignmentId,
      recipientRoleAssignmentIds,
      background,
      commonGoal,
      requestedInput,
      expectedOutputSchema: parsedSchema,
      dueAt: dueAtDate.toISOString(),
      contextRefs: [],
      idempotencyKey,
    };
    try {
      const response = await mutation.mutateAsync(input);
      onCreated(response.collaboration.id);
    } catch (caught) {
      setError(workbenchInteractionError(caught));
    }
  };

  return (
    <div
      className="correction-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target && !mutation.isPending) onClose();
      }}
    >
      <section
        className="correction-dialog collaboration-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <header>
          <div>
            <p className="eyebrow">Request collaboration</p>
            <h2 id={titleId}>发起结构化协同</h2>
          </div>
          <button
            type="button"
            aria-label="关闭协同创建窗口"
            disabled={mutation.isPending}
            onClick={onClose}
          >
            ×
          </button>
        </header>
        <form onSubmit={(event) => void submit(event)}>
          {candidates.isPending ? <p>正在读取当前任务可用角色…</p> : null}
          {candidates.isError ? (
            <div className="interaction-operation-error" role="alert">
              {workbenchInteractionError(candidates.error)}
            </div>
          ) : null}
          <label>
            <span>以哪个角色发起</span>
            <select
              value={actingRoleAssignmentId}
              disabled={mutation.isPending || candidates.isPending}
              onChange={(event) => {
                setActingRoleAssignmentId(event.target.value);
                setRecipientRoleAssignmentIds((current) =>
                  current.filter((id) => id !== event.target.value),
                );
              }}
            >
              <option value="">选择可发起角色</option>
              {candidates.data?.items
                .filter((candidate) => candidate.canActAsRequester)
                .map((candidate) => (
                  <option key={candidate.roleAssignmentId} value={candidate.roleAssignmentId}>
                    {candidate.roleName} · {candidate.userName} · {candidate.orgUnitName}
                  </option>
                ))}
            </select>
          </label>
          <fieldset>
            <legend>接收角色</legend>
            <div className="collaboration-recipient-options">
              {candidates.data?.items
                .filter((candidate) => candidate.roleAssignmentId !== actingRoleAssignmentId)
                .map((candidate) => (
                  <label key={candidate.roleAssignmentId}>
                    <input
                      type="checkbox"
                      checked={recipientRoleAssignmentIds.includes(candidate.roleAssignmentId)}
                      disabled={mutation.isPending}
                      onChange={(event) =>
                        setRecipientRoleAssignmentIds((current) =>
                          event.target.checked
                            ? [...new Set([...current, candidate.roleAssignmentId])]
                            : current.filter((id) => id !== candidate.roleAssignmentId),
                        )
                      }
                    />
                    <span>
                      {candidate.roleName} · {candidate.userName} · {candidate.orgUnitName}
                    </span>
                  </label>
                ))}
            </div>
          </fieldset>
          <label>
            <span>背景</span>
            <textarea
              rows={3}
              value={background}
              disabled={mutation.isPending}
              onChange={(event) => setBackground(event.target.value)}
            />
          </label>
          <label>
            <span>共同目标</span>
            <textarea
              rows={2}
              value={commonGoal}
              disabled={mutation.isPending}
              onChange={(event) => setCommonGoal(event.target.value)}
            />
          </label>
          <label>
            <span>需要对方提供</span>
            <textarea
              rows={3}
              value={requestedInput}
              disabled={mutation.isPending}
              onChange={(event) => setRequestedInput(event.target.value)}
            />
          </label>
          <label>
            <span>截止时间</span>
            <input
              type="datetime-local"
              value={dueAt}
              disabled={mutation.isPending}
              onChange={(event) => setDueAt(event.target.value)}
            />
          </label>
          <label>
            <span>期望输出 JSON Schema</span>
            <textarea
              rows={7}
              spellCheck={false}
              value={expectedOutputSchema}
              disabled={mutation.isPending}
              onChange={(event) => setExpectedOutputSchema(event.target.value)}
            />
          </label>
          {expectedOutputSchema && parsedSchema === null ? (
            <div className="interaction-operation-error" role="alert">
              期望输出必须是有效且非空的 JSON 对象。
            </div>
          ) : null}
          {error ? (
            <div className="interaction-operation-error" role="alert">
              {error}
            </div>
          ) : null}
          <footer>
            <button type="button" disabled={mutation.isPending} onClick={onClose}>
              取消
            </button>
            <button type="submit" disabled={!canSubmit}>
              {mutation.isPending ? '等待服务端确认…' : '发送 Request'}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}

function CollaborationCommandDialog({
  taskId,
  collaboration,
  action,
  onClose,
}: {
  taskId: string;
  collaboration: Collaboration;
  action: CollaborationCommandAction;
  onClose: () => void;
}): React.JSX.Element {
  const titleId = useId();
  const mutation = useSubmitTaskCollaborationCommand(taskId, collaboration.id);
  const [payloadSource, setPayloadSource] = useState(() =>
    JSON.stringify(defaultCollaborationPayload(action, collaboration), null, 2),
  );
  const [error, setError] = useState<string | null>(null);
  const [idempotencyKey] = useState(
    () => `desktop-collaboration:${action.toLowerCase()}:${crypto.randomUUID()}`,
  );
  const payload = parseJsonObject(payloadSource);
  const canSubmit = !mutation.isPending && payload !== null;

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!canSubmit || payload === null) return;
    setError(null);
    const input = {
      type: action,
      expectedRevision: collaboration.revision,
      idempotencyKey,
      payload,
    } as CollaborationCommandRequest;
    try {
      await mutation.mutateAsync(input);
      onClose();
    } catch (caught) {
      setError(workbenchInteractionError(caught));
    }
  };

  return (
    <div
      className="correction-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target && !mutation.isPending) onClose();
      }}
    >
      <section
        className="correction-dialog collaboration-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <header>
          <div>
            <p className="eyebrow">Revision-bound command</p>
            <h2 id={titleId}>{collaborationCommandLabel(action)}</h2>
          </div>
          <button
            type="button"
            aria-label="关闭协同命令窗口"
            disabled={mutation.isPending}
            onClick={onClose}
          >
            ×
          </button>
        </header>
        <form onSubmit={(event) => void submit(event)}>
          <p>
            当前 revision：<code>r{collaboration.revision}</code>。系统只会在服务端确认新 revision
            和目标状态后显示成功。
          </p>
          <label>
            <span>{collaborationCommandLabel(action)}结构化负载</span>
            <textarea
              autoFocus
              rows={12}
              spellCheck={false}
              value={payloadSource}
              disabled={mutation.isPending}
              onChange={(event) => setPayloadSource(event.target.value)}
            />
          </label>
          {payloadSource && payload === null ? (
            <div className="interaction-operation-error" role="alert">
              命令负载必须是有效 JSON 对象；字段会再次经过共享契约校验。
            </div>
          ) : null}
          {error ? (
            <div className="interaction-operation-error" role="alert">
              {error}
            </div>
          ) : null}
          <footer>
            <button type="button" disabled={mutation.isPending} onClick={onClose}>
              取消
            </button>
            <button type="submit" disabled={!canSubmit}>
              {mutation.isPending ? '等待服务端确认…' : `提交${collaborationCommandLabel(action)}`}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}

function parseJsonObject(source: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(source);
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function defaultCollaborationPayload(
  action: CollaborationCommandAction,
  collaboration: Collaboration,
): Record<string, unknown> {
  switch (action) {
    case 'COMMIT':
      return {
        committedDueAt: collaboration.dueAt,
        outputSchema: collaboration.expectedOutputSchema,
        conditions: [],
      };
    case 'DELIVER':
      return {
        deliverableId: '00000000-0000-7000-8000-000000000000',
        deliverableVersion: 1,
        evidenceRefs: [
          {
            evidenceId: '00000000-0000-7000-8000-000000000000',
            version: 1,
            contentHash: null,
          },
        ],
        summary: '请替换占位 ID 并填写真实交付摘要。',
      };
    case 'ACCEPT':
      return {
        acceptanceId: '00000000-0000-7000-8000-000000000000',
        acceptanceVersion: 1,
        comment: '请替换占位 ID 并填写验收结论。',
      };
    case 'REJECT':
      return {
        acceptanceId: null,
        acceptanceVersion: null,
        nonConformities: ['请描述不符合项。'],
        requiredChanges: ['请描述必须修改的内容。'],
      };
    case 'ESCALATE':
      return {
        decisionRoleAssignmentId: '00000000-0000-7000-8000-000000000000',
        reason: 'OTHER',
        impact: '请描述影响。',
        requestedDecision: '请描述需要的决策。',
        evidenceRefs: [
          {
            evidenceId: '00000000-0000-7000-8000-000000000000',
            version: 1,
            contentHash: null,
          },
        ],
      };
    case 'CANCEL':
      return {
        reason: '请填写取消原因。',
        impact: '请填写取消影响。',
        compensationActions: [],
      };
  }
}

export function TaskCorrectionPanel({ taskId }: { taskId: string }): React.JSX.Element {
  const list = useTaskCorrections(taskId);
  const corrections = list.data?.items;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [feedbackAction, setFeedbackAction] = useState<CorrectionFeedbackAction | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!corrections) return;
    setSelectedId((current) =>
      current && corrections.some((item) => item.id === current)
        ? current
        : (corrections[0]?.id ?? null),
    );
  }, [corrections]);

  const selected = corrections?.find((correction) => correction.id === selectedId) ?? null;

  if (list.isPending && list.data === undefined) {
    return (
      <InteractionState
        title="正在读取纠偏"
        description="等待服务端返回当前任务可见的规则与模型发现…"
        busy
      />
    );
  }
  if (list.isError) {
    return (
      <InteractionErrorState
        title={isWorkbenchCapabilityUnavailable(list.error) ? '纠偏能力未接通' : '纠偏加载失败'}
        error={list.error}
        onRetry={() => void list.refetch()}
      />
    );
  }
  if (!corrections?.length) {
    return (
      <InteractionState
        title="暂无纠偏"
        description="服务端已成功响应，但当前任务没有可见纠偏；这里不会生成模拟告警。"
      />
    );
  }

  return (
    <section
      id="task-mode-panel-correction"
      role="tabpanel"
      aria-labelledby="task-mode-tab-correction"
      className="task-interaction-panel"
    >
      {notice ? (
        <div className="interaction-notice success" role="status">
          {notice}
          <button type="button" aria-label="关闭成功提示" onClick={() => setNotice(null)}>
            ×
          </button>
        </div>
      ) : null}
      <header className="interaction-panel-header">
        <div>
          <p className="eyebrow">Correction feedback loop</p>
          <h2>纠偏闭环</h2>
          <p>事件、依据、影响、建议和基于 revision 的人工反馈。</p>
        </div>
        <button type="button" disabled={list.isFetching} onClick={() => void list.refetch()}>
          {list.isFetching ? '刷新中…' : '刷新'}
        </button>
      </header>

      <div className="interaction-layout">
        <div className="interaction-record-list" role="list" aria-label="任务纠偏列表">
          {corrections.map((correction) => (
            <button
              key={correction.id}
              type="button"
              role="listitem"
              className={correction.id === selectedId ? 'selected' : ''}
              aria-current={correction.id === selectedId ? 'true' : undefined}
              onClick={() => setSelectedId(correction.id)}
            >
              <span>{correction.severity.slice(0, 1)}</span>
              <span>
                <strong>{correction.trigger}</strong>
                <small>
                  {correctionStatusLabel(correction.status)} · {correction.severity} · r
                  {correction.revision}
                </small>
                <code>{shortBusinessId(correction.correlationId)}</code>
              </span>
            </button>
          ))}
          {list.data.pageInfo.hasMore ? (
            <p className="interaction-page-hint">服务端还有更多纠偏记录；已保留分页游标。</p>
          ) : null}
        </div>

        {selected ? <CorrectionDetail correction={selected} onAction={setFeedbackAction} /> : null}
      </div>

      {selected && feedbackAction ? (
        <CorrectionFeedbackDialog
          taskId={taskId}
          correction={selected}
          action={feedbackAction}
          onClose={() => setFeedbackAction(null)}
          onSaved={() => {
            setFeedbackAction(null);
            setNotice('纠偏反馈已由服务端确认，列表正在刷新。');
          }}
        />
      ) : null}
    </section>
  );
}

function CorrectionDetail({
  correction,
  onAction,
}: {
  correction: CorrectionCase;
  onAction: (action: CorrectionFeedbackAction) => void;
}): React.JSX.Element {
  const actions = correctionActionsFor(correction.status);
  return (
    <article className="interaction-detail-card correction-detail-card">
      <header>
        <div>
          <p className="eyebrow">{correction.category}</p>
          <h3>{correction.trigger}</h3>
          <p>{correction.impact}</p>
        </div>
        <span className={`correction-severity ${correction.severity.toLowerCase()}`}>
          {correction.severity} · {Math.round(correction.confidence * 100)}%
        </span>
      </header>
      <IdentityTrace
        entries={[
          ['Correlation ID', correction.correlationId],
          ['Correction ID', correction.id],
          ['Objective', correction.objectiveId],
          ['Task', correction.taskId],
          ['Process Instance', correction.processInstanceId],
          ['Revision', `r${correction.revision}`],
        ]}
      />
      <div className="correction-finding-grid">
        <section>
          <strong>规则发现</strong>
          <ul>
            {correction.ruleFindings.map((finding) => (
              <li key={finding}>{finding}</li>
            ))}
          </ul>
        </section>
        <section>
          <strong>建议动作</strong>
          <ul>
            {correction.suggestedActions.map((action) => (
              <li key={action}>{action}</li>
            ))}
          </ul>
        </section>
      </div>
      {correction.modelFinding ? (
        <p className="correction-model-finding">
          <strong>模型发现：</strong>
          {correction.modelFinding}
        </p>
      ) : null}
      <section className="correction-evidence-list">
        <header>
          <strong>依据</strong>
          <span>{correction.evidenceRefs.length}</span>
        </header>
        {correction.evidenceRefs.map((reference) => (
          <code key={`${reference.evidenceId}:${reference.version}`}>
            {shortBusinessId(reference.evidenceId)} · v{reference.version}
          </code>
        ))}
      </section>
      <footer className="correction-actions">
        {actions.length > 0 ? (
          actions.map((action) => (
            <button key={action} type="button" onClick={() => onAction(action)}>
              {correctionActionLabel(action)}
            </button>
          ))
        ) : (
          <button type="button" disabled>
            纠偏已终态
          </button>
        )}
      </footer>
    </article>
  );
}

function CorrectionFeedbackDialog({
  taskId,
  correction,
  action,
  onClose,
  onSaved,
}: {
  taskId: string;
  correction: CorrectionCase;
  action: CorrectionFeedbackAction;
  onClose: () => void;
  onSaved: () => void;
}): React.JSX.Element {
  const titleId = useId();
  const mutation = useSubmitTaskCorrectionFeedback(taskId);
  const [comment, setComment] = useState('');
  const [evidenceSource, setEvidenceSource] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [idempotencyKey] = useState(() => `desktop-correction:${crypto.randomUUID()}`);
  const evidenceRequired = correctionActionRequiresEvidence(action);
  const evidenceIds = evidenceSource
    .split(/[\s,]+/)
    .map((value) => value.trim())
    .filter(Boolean);
  const canSubmit =
    !mutation.isPending &&
    comment.trim().length > 0 &&
    (!evidenceRequired || evidenceIds.length > 0);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!canSubmit) return;
    setError(null);
    const input: CorrectionFeedbackRequest = {
      expectedRevision: correction.revision,
      action,
      comment,
      evidenceIds,
      effectiveAt: new Date().toISOString(),
      idempotencyKey,
    };
    try {
      await mutation.mutateAsync({ correctionId: correction.id, input });
      onSaved();
    } catch (caught) {
      setError(workbenchInteractionError(caught));
    }
  };

  return (
    <div
      className="correction-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target && !mutation.isPending) onClose();
      }}
    >
      <section
        className="correction-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <header>
          <div>
            <p className="eyebrow">Revision-bound feedback</p>
            <h2 id={titleId}>{correctionActionLabel(action)}</h2>
          </div>
          <button
            type="button"
            aria-label="关闭纠偏反馈窗口"
            disabled={mutation.isPending}
            onClick={onClose}
          >
            ×
          </button>
        </header>
        <form onSubmit={(event) => void submit(event)}>
          <p>
            当前 revision：<code>r{correction.revision}</code>
          </p>
          <label>
            <span>反馈说明</span>
            <textarea
              autoFocus
              rows={4}
              value={comment}
              disabled={mutation.isPending}
              onChange={(event) => setComment(event.target.value)}
            />
          </label>
          <label>
            <span>证据 ID{evidenceRequired ? '（必填）' : '（可选）'}</span>
            <textarea
              rows={3}
              value={evidenceSource}
              disabled={mutation.isPending}
              placeholder="多个 UUID 使用换行或逗号分隔"
              onChange={(event) => setEvidenceSource(event.target.value)}
            />
          </label>
          {error ? (
            <div className="interaction-operation-error" role="alert">
              {error}
            </div>
          ) : null}
          <footer>
            <button type="button" disabled={mutation.isPending} onClick={onClose}>
              取消
            </button>
            <button type="submit" disabled={!canSubmit}>
              {mutation.isPending ? '等待服务端确认…' : '提交反馈'}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}

function IdentityTrace({
  entries,
  compact = false,
}: {
  entries: ReadonlyArray<readonly [string, string | null]>;
  compact?: boolean;
}): React.JSX.Element {
  return (
    <dl className={`interaction-identity-trace ${compact ? 'compact' : ''}`}>
      {entries.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd title={value ?? undefined}>
            {value === null ? '—' : value.startsWith('r') ? value : shortBusinessId(value)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function InteractionState({
  title,
  description,
  busy = false,
  compact = false,
  alert = false,
}: {
  title: string;
  description: string;
  busy?: boolean;
  compact?: boolean;
  alert?: boolean;
}): React.JSX.Element {
  return (
    <div
      className={`task-interaction-state ${alert ? 'error' : ''} ${compact ? 'compact' : ''}`}
      role={alert ? 'alert' : busy ? 'status' : undefined}
      aria-busy={busy}
    >
      <span aria-hidden="true">{busy ? '…' : '◇'}</span>
      <strong>{title}</strong>
      <p>{description}</p>
    </div>
  );
}

function InteractionErrorState({
  title,
  error,
  onRetry,
  compact = false,
}: {
  title: string;
  error: unknown;
  onRetry: () => void;
  compact?: boolean;
}): React.JSX.Element {
  return (
    <div
      className={`task-interaction-state error ${compact ? 'compact' : ''}`}
      role="alert"
      data-capability-state={isWorkbenchCapabilityUnavailable(error) ? 'unavailable' : 'error'}
    >
      <span aria-hidden="true">!</span>
      <strong>{title}</strong>
      <p>{workbenchInteractionError(error)}</p>
      <button type="button" onClick={onRetry}>
        重试
      </button>
    </div>
  );
}
