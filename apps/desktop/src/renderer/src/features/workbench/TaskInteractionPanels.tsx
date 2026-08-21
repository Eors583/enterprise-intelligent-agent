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
  useEmployeeTaskExecution,
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
export type CollaborationOutputTemplate =
  'document' | 'table' | 'proposal' | 'approval' | 'checklist';

export const COLLABORATION_OUTPUT_TEMPLATES: ReadonlyArray<{
  readonly id: CollaborationOutputTemplate;
  readonly label: string;
}> = [
  { id: 'document', label: '文档' },
  { id: 'table', label: '表格' },
  { id: 'proposal', label: '方案' },
  { id: 'approval', label: '审批结果' },
  { id: 'checklist', label: '清单' },
];

export function collaborationOutputSchema(
  template: CollaborationOutputTemplate,
): Record<string, unknown> {
  const schemas: Record<CollaborationOutputTemplate, Record<string, unknown>> = {
    document: {
      type: 'object',
      properties: { title: { type: 'string' }, content: { type: 'string' } },
      required: ['title', 'content'],
    },
    table: {
      type: 'object',
      properties: {
        columns: { type: 'array', items: { type: 'string' } },
        rows: { type: 'array', items: { type: 'object' } },
      },
      required: ['columns', 'rows'],
    },
    proposal: {
      type: 'object',
      properties: {
        objective: { type: 'string' },
        approach: { type: 'string' },
        risks: { type: 'array', items: { type: 'string' } },
      },
      required: ['objective', 'approach'],
    },
    approval: {
      type: 'object',
      properties: { decision: { type: 'string' }, comment: { type: 'string' } },
      required: ['decision', 'comment'],
    },
    checklist: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: { item: { type: 'string' }, completed: { type: 'boolean' } },
            required: ['item', 'completed'],
          },
        },
      },
      required: ['items'],
    },
  };
  return schemas[template];
}

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
                  <small>{collaborationStatusLabel(collaboration.status)}</small>
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
      <div className="collaboration-message-list">
        {response.messages.length > 0 ? (
          response.messages.map((message) => (
            <article key={message.id}>
              <header>
                <span>{collaborationMessageLabel(message.type)}</span>
                <strong>{formatWorkbenchDate(message.occurredAt)}</strong>
              </header>
              <details className="interaction-advanced-details">
                <summary>高级详情</summary>
                <IdentityTrace
                  entries={[
                    ['Message ID', message.id],
                    ['Correlation ID', message.correlationId],
                    ['Causation ID', message.causationId],
                    ['Sender role', message.senderRoleAssignmentId],
                    ['Revision', `r${message.revision}`],
                  ]}
                  compact
                />
                <div className="interaction-business-message">
                  {collaborationBusinessText(message.payload).map((item) => (
                    <p key={item}>{item}</p>
                  ))}
                  <small>其余流程与校验信息已由系统安全保存。</small>
                </div>
              </details>
            </article>
          ))
        ) : (
          <p className="interaction-empty-copy">该协同详情没有服务端返回的协议消息。</p>
        )}
      </div>
      <details className="interaction-advanced-details">
        <summary>协同追踪详情</summary>
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
      </details>
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
  const [outputTemplate, setOutputTemplate] = useState<CollaborationOutputTemplate>('document');
  const [error, setError] = useState<string | null>(null);
  const [idempotencyKey] = useState(() => `desktop-collaboration:create:${crypto.randomUUID()}`);

  useEffect(() => {
    const first = candidates.data?.items.find((candidate) => candidate.canActAsRequester);
    if (first && !actingRoleAssignmentId) setActingRoleAssignmentId(first.roleAssignmentId);
  }, [actingRoleAssignmentId, candidates.data?.items]);

  const dueAtDate = dueAt ? new Date(dueAt) : null;
  const canSubmit =
    !mutation.isPending &&
    actingRoleAssignmentId.length > 0 &&
    recipientRoleAssignmentIds.length > 0 &&
    background.trim().length > 0 &&
    commonGoal.trim().length > 0 &&
    requestedInput.trim().length > 0 &&
    dueAtDate !== null &&
    !Number.isNaN(dueAtDate.getTime()) &&
    dueAtDate.getTime() > Date.now();

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!canSubmit || dueAtDate === null) return;
    setError(null);
    const input: CreateCollaborationRequest = {
      actingRoleAssignmentId,
      recipientRoleAssignmentIds,
      background,
      commonGoal,
      requestedInput,
      expectedOutputSchema: collaborationOutputSchema(outputTemplate),
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
            <span>期望成果形式</span>
            <select
              value={outputTemplate}
              disabled={mutation.isPending}
              onChange={(event) =>
                setOutputTemplate(event.target.value as CollaborationOutputTemplate)
              }
            >
              {COLLABORATION_OUTPUT_TEMPLATES.map((template) => (
                <option key={template.id} value={template.id}>
                  {template.label}
                </option>
              ))}
            </select>
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
  const execution = useEmployeeTaskExecution(taskId);
  const candidates = useTaskCollaborationCandidates(taskId);
  const [error, setError] = useState<string | null>(null);
  const [selectedRecordId, setSelectedRecordId] = useState('');
  const [selectedEvidenceIds, setSelectedEvidenceIds] = useState<string[]>([]);
  const [summary, setSummary] = useState('');
  const [secondaryText, setSecondaryText] = useState('');
  const [escalationReason, setEscalationReason] = useState<
    'CONFLICT' | 'TIMEOUT' | 'PERMISSION' | 'RESOURCE' | 'QUALITY' | 'OTHER'
  >('OTHER');
  const [idempotencyKey] = useState(
    () => `desktop-collaboration:${action.toLowerCase()}:${crypto.randomUUID()}`,
  );
  const deliverables =
    execution.data?.deliverables.filter(
      (item) =>
        item.status === 'SUBMITTED' && item.artifactUri !== null && item.contentHash !== null,
    ) ?? [];
  const evidence = execution.data?.evidence.filter((item) => item.status === 'ACTIVE') ?? [];
  const acceptanceRequests =
    execution.data?.acceptanceRequests.filter(
      (item) => item.acceptanceId !== null && item.acceptanceVersion !== null,
    ) ?? [];
  const payload = collaborationCommandPayload({
    action,
    collaboration,
    selectedRecordId,
    selectedEvidenceIds,
    summary,
    secondaryText,
    escalationReason,
    deliverables,
    evidence,
    acceptanceRequests,
  });
  const directoryPending =
    (['DELIVER', 'ACCEPT', 'ESCALATE'] as CollaborationCommandAction[]).includes(action) &&
    (execution.isPending || (action === 'ESCALATE' && candidates.isPending));
  const canSubmit = !mutation.isPending && !directoryPending && payload !== null;

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!canSubmit) return;
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
            <p className="eyebrow">受控协同操作</p>
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
          <p>请选择真实业务记录并填写业务说明；系统会自动带出内部标识、版本和校验信息。</p>
          {action === 'DELIVER' ? (
            <>
              <label>
                <span>本次交付物</span>
                <select
                  value={selectedRecordId}
                  onChange={(event) => setSelectedRecordId(event.target.value)}
                >
                  <option value="">请选择已提交交付物</option>
                  {deliverables.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.title}
                    </option>
                  ))}
                </select>
              </label>
              <EvidenceChecklist
                evidence={evidence}
                selectedIds={selectedEvidenceIds}
                onChange={setSelectedEvidenceIds}
              />
              <BusinessTextArea label="交付摘要" value={summary} onChange={setSummary} />
            </>
          ) : null}
          {action === 'ACCEPT' ? (
            <>
              <label>
                <span>验收记录</span>
                <select
                  value={selectedRecordId}
                  onChange={(event) => setSelectedRecordId(event.target.value)}
                >
                  <option value="">请选择已形成结论的验收记录</option>
                  {acceptanceRequests.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.reason}（{item.status}）
                    </option>
                  ))}
                </select>
              </label>
              <BusinessTextArea label="验收意见" value={summary} onChange={setSummary} />
            </>
          ) : null}
          {action === 'REJECT' ? (
            <>
              <BusinessTextArea label="不符合项" value={summary} onChange={setSummary} />
              <BusinessTextArea
                label="需要修改的内容"
                value={secondaryText}
                onChange={setSecondaryText}
              />
            </>
          ) : null}
          {action === 'ESCALATE' ? (
            <>
              <label>
                <span>请求决策的负责人</span>
                <select
                  value={selectedRecordId}
                  onChange={(event) => setSelectedRecordId(event.target.value)}
                >
                  <option value="">请选择负责人</option>
                  {candidates.data?.items.map((candidate) => (
                    <option key={candidate.roleAssignmentId} value={candidate.roleAssignmentId}>
                      {candidate.userName} · {candidate.roleName} · {candidate.orgUnitName}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>升级原因</span>
                <select
                  value={escalationReason}
                  onChange={(event) =>
                    setEscalationReason(event.target.value as typeof escalationReason)
                  }
                >
                  <option value="CONFLICT">存在分歧</option>
                  <option value="TIMEOUT">即将或已经超时</option>
                  <option value="PERMISSION">缺少权限</option>
                  <option value="RESOURCE">缺少资源</option>
                  <option value="QUALITY">质量不达标</option>
                  <option value="OTHER">其他</option>
                </select>
              </label>
              <BusinessTextArea label="影响说明" value={summary} onChange={setSummary} />
              <BusinessTextArea
                label="需要负责人决定的事项"
                value={secondaryText}
                onChange={setSecondaryText}
              />
              <EvidenceChecklist
                evidence={evidence}
                selectedIds={selectedEvidenceIds}
                onChange={setSelectedEvidenceIds}
              />
            </>
          ) : null}
          {action === 'CANCEL' ? (
            <>
              <BusinessTextArea label="取消原因" value={summary} onChange={setSummary} />
              <BusinessTextArea
                label="取消影响"
                value={secondaryText}
                onChange={setSecondaryText}
              />
            </>
          ) : null}
          {directoryPending ? <p>正在读取当前任务可选择的业务记录…</p> : null}
          {!directoryPending && payload === null ? (
            <div className="interaction-operation-error" role="alert">
              请完成必填业务信息并选择真实关联记录；系统不会使用占位数据提交。
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

function collaborationCommandPayload(input: {
  action: CollaborationCommandAction;
  collaboration: Collaboration;
  selectedRecordId: string;
  selectedEvidenceIds: string[];
  summary: string;
  secondaryText: string;
  escalationReason: 'CONFLICT' | 'TIMEOUT' | 'PERMISSION' | 'RESOURCE' | 'QUALITY' | 'OTHER';
  deliverables: NonNullable<ReturnType<typeof useEmployeeTaskExecution>['data']>['deliverables'];
  evidence: NonNullable<ReturnType<typeof useEmployeeTaskExecution>['data']>['evidence'];
  acceptanceRequests: NonNullable<
    ReturnType<typeof useEmployeeTaskExecution>['data']
  >['acceptanceRequests'];
}): Record<string, unknown> | null {
  const summary = input.summary.trim();
  const secondaryText = input.secondaryText.trim();
  const evidenceRefs = input.selectedEvidenceIds.flatMap((id) => {
    const evidence = input.evidence.find((item) => item.id === id);
    return evidence
      ? [{ evidenceId: evidence.id, version: evidence.version, contentHash: evidence.contentHash }]
      : [];
  });
  switch (input.action) {
    case 'COMMIT':
      return {
        committedDueAt: input.collaboration.dueAt,
        outputSchema: input.collaboration.expectedOutputSchema,
        conditions: [],
      };
    case 'DELIVER': {
      const deliverable = input.deliverables.find((item) => item.id === input.selectedRecordId);
      if (!deliverable || evidenceRefs.length === 0 || summary.length === 0) return null;
      return {
        deliverableId: deliverable.id,
        deliverableVersion: deliverable.version,
        evidenceRefs,
        summary,
      };
    }
    case 'ACCEPT': {
      const request = input.acceptanceRequests.find(
        (item) => item.id === input.selectedRecordId && item.acceptanceId !== null,
      );
      if (!request?.acceptanceId || !request.acceptanceVersion || summary.length === 0) return null;
      return {
        acceptanceId: request.acceptanceId,
        acceptanceVersion: request.acceptanceVersion,
        comment: summary,
      };
    }
    case 'REJECT':
      if (summary.length === 0 || secondaryText.length === 0) return null;
      return {
        acceptanceId: null,
        acceptanceVersion: null,
        nonConformities: [summary],
        requiredChanges: [secondaryText],
      };
    case 'ESCALATE':
      if (
        input.selectedRecordId.length === 0 ||
        summary.length === 0 ||
        secondaryText.length === 0 ||
        evidenceRefs.length === 0
      ) {
        return null;
      }
      return {
        decisionRoleAssignmentId: input.selectedRecordId,
        reason: input.escalationReason,
        impact: summary,
        requestedDecision: secondaryText,
        evidenceRefs,
      };
    case 'CANCEL':
      if (summary.length === 0 || secondaryText.length === 0) return null;
      return {
        reason: summary,
        impact: secondaryText,
        compensationActions: [],
      };
  }
}

function BusinessTextArea({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}): React.JSX.Element {
  return (
    <label>
      <span>{label}</span>
      <textarea rows={3} value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function EvidenceChecklist({
  evidence,
  selectedIds,
  onChange,
}: {
  evidence: NonNullable<ReturnType<typeof useEmployeeTaskExecution>['data']>['evidence'];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
}): React.JSX.Element {
  return (
    <fieldset>
      <legend>关联可信证据</legend>
      {evidence.length === 0 ? <p>当前任务还没有可选择的可信证据。</p> : null}
      {evidence.map((item) => (
        <label key={item.id}>
          <input
            type="checkbox"
            checked={selectedIds.includes(item.id)}
            onChange={(event) =>
              onChange(
                event.target.checked
                  ? [...new Set([...selectedIds, item.id])]
                  : selectedIds.filter((id) => id !== item.id),
              )
            }
          />
          <span>{item.summary}</span>
        </label>
      ))}
    </fieldset>
  );
}

function collaborationBusinessText(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
  const record = payload as Record<string, unknown>;
  return ['background', 'commonGoal', 'requestedInput', 'summary', 'reason', 'comment']
    .map((key) => record[key])
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
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
          <p>汇总事件、依据、影响与建议，并基于当前版本提交人工反馈。</p>
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
                  {correctionStatusLabel(correction.status)} · {correction.severity}
                </small>
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
      <details className="interaction-advanced-details">
        <summary>高级详情与追踪依据</summary>
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
      </details>
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
  const execution = useEmployeeTaskExecution(taskId);
  const [comment, setComment] = useState('');
  const [evidenceIds, setEvidenceIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [idempotencyKey] = useState(() => `desktop-correction:${crypto.randomUUID()}`);
  const evidenceRequired = correctionActionRequiresEvidence(action);
  const trustedEvidence =
    execution.data?.evidence.filter(
      (evidence) => evidence.status === 'ACTIVE' && evidence.trustLevel === 'VERIFIED',
    ) ?? [];
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
            <p className="eyebrow">受控反馈</p>
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
          <fieldset disabled={mutation.isPending || execution.isPending}>
            <legend>选择当前任务可信依据{evidenceRequired ? '（必选）' : '（可选）'}</legend>
            {trustedEvidence.length > 0 ? (
              trustedEvidence.map((evidence) => (
                <label key={evidence.id}>
                  <input
                    type="checkbox"
                    checked={evidenceIds.includes(evidence.id)}
                    onChange={(event) =>
                      setEvidenceIds((current) =>
                        event.target.checked
                          ? [...new Set([...current, evidence.id])]
                          : current.filter((id) => id !== evidence.id),
                      )
                    }
                  />
                  <span>
                    {evidence.summary} · {evidence.sourceType}
                  </span>
                </label>
              ))
            ) : (
              <p>当前任务暂无已核验且有效的可信依据。</p>
            )}
          </fieldset>
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
