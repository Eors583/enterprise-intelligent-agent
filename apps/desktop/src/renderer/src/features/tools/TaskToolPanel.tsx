import type {
  AvailableTool,
  ToolInvocation,
  ToolInvocationDecisionRequest,
} from '@enterprise/contracts';
import { useEffect, useMemo, useState, type FormEvent } from 'react';

import {
  useAvailableTaskTools,
  useCreateTaskToolCompensation,
  useCreateTaskToolInvocation,
  useDecideTaskToolInvocation,
  useTaskToolApprovals,
  useTaskToolInvocations,
  useToolReconciliationStatus,
} from './hooks';
import {
  initialToolInput,
  parseToolInput,
  requesterActionsFor,
  requesterToolActionLabel,
  toolInputFields,
  toolInputValue,
  toolInvocationStatusLabel,
  toolOperationError,
  toolRiskLabel,
  updateToolInput,
  type RequesterToolAction,
} from './tool-view';
import './tools.css';

export function TaskToolPanel({ taskId }: { readonly taskId: string }): React.JSX.Element {
  const tools = useAvailableTaskTools(taskId);
  const invocations = useTaskToolInvocations(taskId);
  const approvals = useTaskToolApprovals(taskId);
  const createInvocation = useCreateTaskToolInvocation(taskId);
  const createCompensation = useCreateTaskToolCompensation(taskId);
  const decideInvocation = useDecideTaskToolInvocation(taskId);
  const [selectedToolVersionId, setSelectedToolVersionId] = useState<string | null>(null);
  const [selectedInvocationId, setSelectedInvocationId] = useState<string | null>(null);
  const [selectedApprovalId, setSelectedApprovalId] = useState<string | null>(null);
  const [input, setInput] = useState('{}');
  const [reason, setReason] = useState('');
  const [dryRun, setDryRun] = useState(false);
  const [actionReason, setActionReason] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);

  useEffect(() => {
    const available = tools.data ?? [];
    setSelectedToolVersionId((current) =>
      current && available.some((tool) => tool.toolVersionId === current)
        ? current
        : (available[0]?.toolVersionId ?? null),
    );
  }, [tools.data]);

  useEffect(() => {
    const visible = invocations.data ?? [];
    setSelectedInvocationId((current) =>
      current && visible.some((invocation) => invocation.id === current) ? current : null,
    );
  }, [invocations.data]);

  useEffect(() => {
    const visible = approvals.data ?? [];
    setSelectedApprovalId((current) =>
      current && visible.some((invocation) => invocation.id === current) ? current : null,
    );
  }, [approvals.data]);

  const selectedTool =
    tools.data?.find((tool) => tool.toolVersionId === selectedToolVersionId) ?? null;
  const selectedInvocation =
    invocations.data?.find((invocation) => invocation.id === selectedInvocationId) ?? null;
  const selectedApproval =
    approvals.data?.find((invocation) => invocation.id === selectedApprovalId) ?? null;

  useEffect(() => {
    if (!selectedTool) return;
    setInput(initialToolInput(selectedTool));
    setDryRun(selectedTool.dryRunMode === 'VALIDATE_ONLY');
  }, [selectedTool?.toolVersionId]);

  const refresh = async (): Promise<void> => {
    setOperationError(null);
    await Promise.all([tools.refetch(), invocations.refetch(), approvals.refetch()]);
  };

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!selectedTool || !reason.trim()) return;
    setOperationError(null);
    setNotice(null);
    try {
      const created = await createInvocation.mutateAsync({
        toolVersionId: selectedTool.toolVersionId,
        taskId,
        correlationId: crypto.randomUUID(),
        dryRun,
        input: parseToolInput(input),
        reason: reason.trim(),
        idempotencyKey: `desktop-tool:${crypto.randomUUID()}`,
      });
      setSelectedInvocationId(created.id);
      setReason('');
      setNotice(
        created.status === 'PENDING_CONFIRMATION'
          ? '调用已登记，请核对输入后完成本人确认。'
          : created.status === 'PENDING_APPROVAL'
            ? '调用已登记，正在等待独立审批。'
            : '调用已由服务端登记并进入受控执行链路。',
      );
    } catch (error) {
      setOperationError(toolOperationError(error));
    }
  };

  const decide = async (invocation: ToolInvocation, action: RequesterToolAction): Promise<void> => {
    if (!actionReason.trim()) return;
    setOperationError(null);
    setNotice(null);
    try {
      if (action === 'COMPENSATE') {
        const compensation = await createCompensation.mutateAsync({
          original: invocation,
          request: {
            expectedRevision: invocation.revision,
            reason: actionReason.trim(),
            idempotencyKey: `desktop-tool-compensation:${crypto.randomUUID()}`,
          },
        });
        setSelectedInvocationId(compensation.id);
        setActionReason('');
        setNotice(
          compensation.status === 'PENDING_CONFIRMATION'
            ? '补偿调用已登记，请确认由系统生成的原调用绑定后继续。'
            : compensation.status === 'PENDING_APPROVAL'
              ? '补偿调用已登记，正在等待独立审批。'
              : '补偿调用已进入受控执行链路。',
        );
        return;
      }
      const request: ToolInvocationDecisionRequest = {
        expectedRevision: invocation.revision,
        action,
        reason: actionReason.trim(),
        idempotencyKey: `desktop-tool-action:${crypto.randomUUID()}`,
      };
      const updated = await decideInvocation.mutateAsync({ invocation, request });
      setSelectedInvocationId(updated.id);
      setActionReason('');
      setNotice(
        action === 'RECONCILE'
          ? '结果核对请求已写入审计与事件队列。'
          : action === 'RETRY'
            ? '已创建新的关联重试调用，原调用记录保持不变。'
            : '工具调用状态已由服务端确认更新。',
      );
    } catch (error) {
      setOperationError(toolOperationError(error));
    }
  };

  const review = async (
    invocation: ToolInvocation,
    action: Extract<ToolInvocationDecisionRequest['action'], 'APPROVE' | 'REJECT'>,
  ): Promise<void> => {
    if (!actionReason.trim()) return;
    setOperationError(null);
    setNotice(null);
    try {
      const updated = await decideInvocation.mutateAsync({
        invocation,
        request: {
          expectedRevision: invocation.revision,
          action,
          reason: actionReason.trim(),
          idempotencyKey: `desktop-tool-review:${crypto.randomUUID()}`,
        },
      });
      setSelectedApprovalId(null);
      setActionReason('');
      setNotice(
        updated.status === 'APPROVED'
          ? '独立审批已通过，调用将由受信执行服务继续处理。'
          : '独立审批已拒绝，调用不会执行。',
      );
    } catch (error) {
      setOperationError(toolOperationError(error));
    }
  };

  const initialLoading =
    (tools.isPending && tools.data === undefined) ||
    (invocations.isPending && invocations.data === undefined) ||
    (approvals.isPending && approvals.data === undefined);
  if (initialLoading) {
    return (
      <ToolState
        title="正在加载受控工具"
        description="正在校验任务、任命、数据密级和工具策略。"
        busy
      />
    );
  }

  return (
    <section
      id="task-mode-panel-tools"
      role="tabpanel"
      aria-labelledby="task-mode-tab-tools"
      className="task-interaction-panel task-tool-panel"
    >
      {notice ? (
        <div className="tool-notice" role="status">
          <span>{notice}</span>
          <button type="button" aria-label="关闭提示" onClick={() => setNotice(null)}>
            ×
          </button>
        </div>
      ) : null}
      {operationError ? (
        <div className="tool-operation-error" role="alert">
          {operationError}
        </div>
      ) : null}

      <header className="interaction-panel-header">
        <div>
          <p className="eyebrow">Governed tool gateway</p>
          <h2>任务工具</h2>
          <p>只展示当前任务和有效角色任命可调用的已发布版本；敏感连接配置不会下发桌面端。</p>
        </div>
        <button
          type="button"
          disabled={tools.isFetching || invocations.isFetching || approvals.isFetching}
          onClick={() => void refresh()}
        >
          {tools.isFetching || invocations.isFetching || approvals.isFetching ? '刷新中…' : '刷新'}
        </button>
      </header>

      {tools.isError || invocations.isError || approvals.isError ? (
        <ToolState
          title="工具能力加载失败"
          description={toolOperationError(tools.error ?? invocations.error ?? approvals.error)}
          action={
            <button type="button" onClick={() => void refresh()}>
              重新加载
            </button>
          }
          error
        />
      ) : (
        <div className="task-tool-layout">
          <aside className="task-tool-sidebar">
            <ToolCatalog
              tools={tools.data ?? []}
              selectedToolVersionId={selectedToolVersionId}
              onSelect={(tool) => {
                setSelectedToolVersionId(tool.toolVersionId);
                setSelectedInvocationId(null);
                setSelectedApprovalId(null);
                setOperationError(null);
              }}
            />
            <InvocationList
              invocations={invocations.data ?? []}
              selectedInvocationId={selectedInvocationId}
              onSelect={(invocation) => {
                setSelectedInvocationId(invocation.id);
                setSelectedApprovalId(null);
                setOperationError(null);
              }}
            />
            <ApprovalList
              approvals={approvals.data ?? []}
              selectedApprovalId={selectedApprovalId}
              onSelect={(invocation) => {
                setSelectedApprovalId(invocation.id);
                setSelectedInvocationId(null);
                setOperationError(null);
              }}
            />
          </aside>

          {selectedApproval ? (
            <ApprovalDetail
              invocation={selectedApproval}
              reason={actionReason}
              pending={decideInvocation.isPending}
              onReasonChange={setActionReason}
              onDecision={(action) => void review(selectedApproval, action)}
            />
          ) : selectedInvocation ? (
            <InvocationDetail
              invocation={selectedInvocation}
              actionReason={actionReason}
              pending={decideInvocation.isPending || createCompensation.isPending}
              onReasonChange={setActionReason}
              onAction={(action) => void decide(selectedInvocation, action)}
              onCreateNew={() => setSelectedInvocationId(null)}
            />
          ) : selectedTool ? (
            <ToolInvocationForm
              tool={selectedTool}
              input={input}
              reason={reason}
              dryRun={dryRun}
              pending={createInvocation.isPending}
              onInputChange={setInput}
              onReasonChange={setReason}
              onDryRunChange={setDryRun}
              onSubmit={(event) => void submit(event)}
            />
          ) : (
            <ToolState
              title="当前任务没有可用工具"
              description="服务端未返回通过任务、任命、动作权限与密级策略校验的已发布工具。"
              compact
            />
          )}
        </div>
      )}
    </section>
  );
}

function ToolCatalog({
  tools,
  selectedToolVersionId,
  onSelect,
}: {
  readonly tools: readonly AvailableTool[];
  readonly selectedToolVersionId: string | null;
  readonly onSelect: (tool: AvailableTool) => void;
}): React.JSX.Element {
  return (
    <section className="tool-catalog">
      <header>
        <strong>可用工具</strong>
        <span>{tools.length}</span>
      </header>
      {tools.length === 0 ? (
        <p>没有通过当前任务策略校验的工具。</p>
      ) : (
        <div role="list" aria-label="任务可用工具">
          {tools.map((tool) => (
            <button
              key={tool.toolVersionId}
              type="button"
              role="listitem"
              className={tool.toolVersionId === selectedToolVersionId ? 'selected' : ''}
              onClick={() => onSelect(tool)}
            >
              <span>工</span>
              <span>
                <strong>{tool.name}</strong>
                <small>{toolRiskLabel(tool.riskClass)}</small>
              </span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function InvocationList({
  invocations,
  selectedInvocationId,
  onSelect,
}: {
  readonly invocations: readonly ToolInvocation[];
  readonly selectedInvocationId: string | null;
  readonly onSelect: (invocation: ToolInvocation) => void;
}): React.JSX.Element {
  return (
    <section className="tool-invocation-list">
      <header>
        <strong>本任务调用</strong>
        <span>{invocations.length}</span>
      </header>
      {invocations.length === 0 ? (
        <p>还没有真实调用记录。</p>
      ) : (
        <div role="list" aria-label="任务工具调用">
          {invocations.map((invocation) => (
            <button
              key={invocation.id}
              type="button"
              role="listitem"
              className={invocation.id === selectedInvocationId ? 'selected' : ''}
              onClick={() => onSelect(invocation)}
            >
              <span className={`tool-status-dot ${invocation.status.toLowerCase()}`} />
              <span>
                <strong>{toolInvocationStatusLabel(invocation.status)}</strong>
                <small>{formatToolTime(invocation.updatedAt)}</small>
              </span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function ApprovalList({
  approvals,
  selectedApprovalId,
  onSelect,
}: {
  readonly approvals: readonly ToolInvocation[];
  readonly selectedApprovalId: string | null;
  readonly onSelect: (invocation: ToolInvocation) => void;
}): React.JSX.Element {
  return (
    <section className="tool-invocation-list tool-approval-list">
      <header>
        <strong>待我独立审批</strong>
        <span>{approvals.length}</span>
      </header>
      {approvals.length === 0 ? (
        <p>当前任务没有分配给你的高风险审批。</p>
      ) : (
        <div role="list" aria-label="待我审批的工具调用">
          {approvals.map((invocation) => (
            <button
              key={invocation.id}
              type="button"
              role="listitem"
              className={invocation.id === selectedApprovalId ? 'selected' : ''}
              onClick={() => onSelect(invocation)}
            >
              <span className="tool-status-dot pending_approval" />
              <span>
                <strong>高风险工具审批</strong>
                <small>{formatToolTime(invocation.updatedAt)}</small>
              </span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function ApprovalDetail({
  invocation,
  reason,
  pending,
  onReasonChange,
  onDecision,
}: {
  readonly invocation: ToolInvocation;
  readonly reason: string;
  readonly pending: boolean;
  readonly onReasonChange: (value: string) => void;
  readonly onDecision: (action: 'APPROVE' | 'REJECT') => void;
}): React.JSX.Element {
  return (
    <article className="tool-invocation-detail tool-approval-detail">
      <header>
        <div>
          <p className="eyebrow">Maker-checker approval</p>
          <h3>高风险工具独立审批</h3>
          <p>{toolRiskLabel(invocation.riskClass)} · 需要另一位有权限的员工复核</p>
        </div>
        <span className="tool-risk high_risk_approval">职责分离</span>
      </header>
      <div className="tool-gate-message">
        请根据当前任务目标与操作影响独立判断；申请人不能审批自己的请求。
      </div>
      <details className="tool-advanced-details">
        <summary>高级详情</summary>
        <dl className="tool-trace-grid">
          <Trace label="Invocation" value={invocation.id} />
          <Trace label="Requester" value={invocation.requesterUserId} />
          <Trace label="Task" value={invocation.taskId} />
          <Trace label="Tool Version" value={invocation.toolVersionId} />
          <Trace label="Policy" value={invocation.policyDecisionId} />
          <Trace label="Input Hash" value={invocation.inputHash} />
        </dl>
        <section className="tool-payload-grid">
          <div>
            <strong>待审批输入</strong>
            <BusinessDataSummary value={invocation.input} />
          </div>
          <div>
            <strong>策略快照</strong>
            <p>执行范围、权限和审批要求已由系统策略锁定。</p>
          </div>
        </section>
      </details>
      <section className="tool-action-zone">
        <label>
          审批意见
          <textarea
            rows={4}
            maxLength={500}
            value={reason}
            placeholder="记录批准或拒绝的业务依据"
            onChange={(event) => onReasonChange(event.target.value)}
          />
        </label>
        <div>
          <button
            type="button"
            className="secondary"
            disabled={pending || !reason.trim()}
            onClick={() => onDecision('REJECT')}
          >
            拒绝执行
          </button>
          <button
            type="button"
            disabled={pending || !reason.trim()}
            onClick={() => onDecision('APPROVE')}
          >
            批准执行
          </button>
        </div>
      </section>
    </article>
  );
}

function ToolInvocationForm({
  tool,
  input,
  reason,
  dryRun,
  pending,
  onInputChange,
  onReasonChange,
  onDryRunChange,
  onSubmit,
}: {
  readonly tool: AvailableTool;
  readonly input: string;
  readonly reason: string;
  readonly dryRun: boolean;
  readonly pending: boolean;
  readonly onInputChange: (value: string) => void;
  readonly onReasonChange: (value: string) => void;
  readonly onDryRunChange: (value: boolean) => void;
  readonly onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}): React.JSX.Element {
  const fields = toolInputFields(tool);
  const gates = useMemo(
    () =>
      [
        tool.requiresConfirmation ? '本人确认' : null,
        tool.requiresApproval ? '独立审批' : null,
      ].filter(Boolean),
    [tool.requiresApproval, tool.requiresConfirmation],
  );
  return (
    <form className="tool-invocation-form" onSubmit={onSubmit}>
      <header>
        <div>
          <p className="eyebrow">任务工具</p>
          <h3>{tool.name}</h3>
          <p>{tool.description}</p>
        </div>
        <span className={`tool-risk ${tool.riskClass.toLowerCase()}`}>
          {toolRiskLabel(tool.riskClass)}
        </span>
      </header>
      <div className="tool-policy-summary">
        <span>资料范围：由当前任务权限自动控制</span>
        <span>{tool.dryRunMode === 'UNSUPPORTED' ? '不支持预演' : '支持先预演'}</span>
        <span>{gates.length > 0 ? `执行前：${gates.join(' + ')}` : '策略通过后自动执行'}</span>
      </div>
      <div className="tool-business-fields">
        {fields.map((field) => (
          <ToolBusinessField
            key={field.key}
            field={field}
            value={toolInputValue(input, field.key)}
            onChange={(value) => onInputChange(updateToolInput(input, field.key, value))}
          />
        ))}
      </div>
      <p className="tool-form-note">
        输入项由工具配置自动生成；字段格式、必填规则和敏感信息保护由系统统一校验。
      </p>
      <label>
        业务原因
        <textarea
          rows={3}
          maxLength={500}
          value={reason}
          placeholder="说明为什么当前任务需要调用此工具"
          onChange={(event) => onReasonChange(event.target.value)}
        />
      </label>
      <label className="tool-dry-run">
        <input
          type="checkbox"
          checked={dryRun}
          disabled={tool.dryRunMode === 'UNSUPPORTED' || tool.dryRunMode === 'VALIDATE_ONLY'}
          onChange={(event) => onDryRunChange(event.target.checked)}
        />
        <span>
          仅验证 / 演练
          <small>
            {tool.dryRunMode === 'VALIDATE_ONLY'
              ? '该版本只执行网关校验，不会向供应商分发。'
              : tool.dryRunMode === 'NATIVE'
                ? '供应商声明支持原生演练。'
                : '该版本不支持演练。'}
          </small>
        </span>
      </label>
      <footer>
        <span>系统会自动记录本次操作及审批结果。</span>
        <button type="submit" disabled={pending || !reason.trim()}>
          {pending ? '登记中…' : '通过网关调用'}
        </button>
      </footer>
    </form>
  );
}

function InvocationDetail({
  invocation,
  actionReason,
  pending,
  onReasonChange,
  onAction,
  onCreateNew,
}: {
  readonly invocation: ToolInvocation;
  readonly actionReason: string;
  readonly pending: boolean;
  readonly onReasonChange: (value: string) => void;
  readonly onAction: (action: RequesterToolAction) => void;
  readonly onCreateNew: () => void;
}): React.JSX.Element {
  const actions = requesterActionsFor(invocation);
  const reconciliation = useToolReconciliationStatus(
    invocation.id,
    invocation.status === 'UNKNOWN',
  );
  return (
    <article className="tool-invocation-detail">
      <header>
        <div>
          <p className="eyebrow">Immutable invocation trace</p>
          <h3>{toolInvocationStatusLabel(invocation.status)}</h3>
          <p>
            {toolRiskLabel(invocation.riskClass)} · {formatToolTime(invocation.updatedAt)}
          </p>
        </div>
        <button type="button" onClick={onCreateNew}>
          新建调用
        </button>
      </header>
      {invocation.status === 'PENDING_APPROVAL' ? (
        <div className="tool-gate-message">
          已完成本人确认，必须由不同员工的有效审批任命独立审批；申请人不能自批。
        </div>
      ) : null}
      {invocation.status === 'UNKNOWN' ? (
        <div className="tool-gate-message warning">
          外部执行结果不确定。请先请求核对，避免盲目重复执行；如需重试会生成独立关联记录。
        </div>
      ) : null}
      {invocation.status === 'UNKNOWN' && reconciliation.data ? (
        <div className="tool-gate-message" data-testid="tool-reconciliation-status">
          对账状态：{reconciliationStatusLabel(reconciliation.data.state)}
          {reconciliation.data.reasonCode ? `（${reconciliation.data.reasonCode}）` : ''}
          。系统只查询原请求状态，不会重放原副作用。
        </div>
      ) : null}
      <details className="tool-advanced-details">
        <summary>高级详情</summary>
        <dl className="tool-trace-grid">
          <Trace label="Invocation" value={invocation.id} />
          <Trace label="Task" value={invocation.taskId} />
          <Trace label="Role Assignment" value={invocation.roleAssignmentId} />
          <Trace label="Correlation" value={invocation.correlationId} />
          <Trace label="Policy" value={invocation.policyDecisionId} />
          <Trace label="Input Hash" value={invocation.inputHash} />
        </dl>
        <section className="tool-payload-grid">
          <div>
            <strong>输入</strong>
            <BusinessDataSummary value={invocation.input} />
          </div>
          <div>
            <strong>{invocation.output ? '输出' : '策略快照'}</strong>
            {invocation.output ? (
              <BusinessDataSummary value={invocation.output} />
            ) : (
              <p>执行范围、权限和审批要求已由系统策略锁定。</p>
            )}
          </div>
        </section>
      </details>
      {invocation.errorCode || invocation.errorDetail ? (
        <div className="tool-provider-error" role="alert">
          <strong>{invocation.errorCode ?? 'PROVIDER_ERROR'}</strong>
          <span>{invocation.errorDetail ?? '工具执行未返回可展示的错误详情。'}</span>
        </div>
      ) : null}
      {actions.length > 0 ? (
        <section className="tool-action-zone">
          <label>
            操作原因
            <textarea
              rows={3}
              maxLength={500}
              value={actionReason}
              onChange={(event) => onReasonChange(event.target.value)}
            />
          </label>
          <div>
            {actions.map((action) => (
              <button
                key={action}
                type="button"
                disabled={pending || !actionReason.trim()}
                className={action === 'CANCEL' ? 'secondary' : ''}
                onClick={() => onAction(action)}
              >
                {requesterToolActionLabel(action)}
              </button>
            ))}
          </div>
        </section>
      ) : (
        <p className="tool-terminal-note">
          当前状态没有申请人可执行的动作；执行、审批、补偿由受信服务或独立审批人完成。
        </p>
      )}
    </article>
  );
}

function Trace({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd title={value}>{value}</dd>
    </div>
  );
}

function ToolBusinessField({
  field,
  value,
  onChange,
}: {
  readonly field: ReturnType<typeof toolInputFields>[number];
  readonly value: unknown;
  readonly onChange: (value: unknown) => void;
}): React.JSX.Element {
  if (field.kind === 'unsupported') {
    return (
      <div className="tool-field-unsupported">
        <strong>{field.label}</strong>
        <span>该复合字段请在“高级输入与技术详情”中配置。</span>
      </div>
    );
  }
  if (field.kind === 'boolean') {
    return (
      <label className="tool-dry-run">
        <input
          type="checkbox"
          checked={value === true}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span>
          {field.label}
          {field.description ? <small>{field.description}</small> : null}
        </span>
      </label>
    );
  }
  return (
    <label>
      {field.label}
      {field.required ? <small>必填</small> : null}
      {field.enumValues.length > 0 ? (
        <select
          value={typeof value === 'string' ? value : ''}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">请选择</option>
          {field.enumValues.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      ) : (
        <input
          type={field.kind === 'number' ? 'number' : 'text'}
          value={typeof value === 'string' || typeof value === 'number' ? value : ''}
          onChange={(event) =>
            onChange(field.kind === 'number' ? Number(event.target.value) : event.target.value)
          }
        />
      )}
      {field.description ? <small>{field.description}</small> : null}
    </label>
  );
}

function reconciliationStatusLabel(
  state: 'NONE' | 'PENDING' | 'INCONCLUSIVE' | 'RESOLVED',
): string {
  if (state === 'PENDING') return '查询中';
  if (state === 'INCONCLUSIVE') return '仍无法确认，保持未知';
  if (state === 'RESOLVED') return '已由可信回执确认';
  return '尚未请求';
}

function BusinessDataSummary({ value }: { readonly value: unknown }): React.JSX.Element {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return <p>{String(value ?? '暂无可展示内容')}</p>;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  return (
    <dl className="tool-business-data-summary">
      {entries.map(([key, item]) => (
        <div key={key}>
          <dt>{businessFieldLabel(key)}</dt>
          <dd>
            {Array.isArray(item)
              ? `${item.length} 项`
              : item && typeof item === 'object'
                ? '已记录'
                : typeof item === 'boolean'
                  ? item
                    ? '是'
                    : '否'
                  : String(item ?? '—')}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function businessFieldLabel(key: string): string {
  const labels: Record<string, string> = {
    query: '查询内容',
    title: '标题',
    description: '说明',
    customer: '客户',
    amount: '金额',
    status: '状态',
    reason: '原因',
    result: '结果',
  };
  return labels[key] ?? '业务字段';
}

function ToolState({
  title,
  description,
  busy = false,
  error = false,
  compact = false,
  action,
}: {
  readonly title: string;
  readonly description: string;
  readonly busy?: boolean;
  readonly error?: boolean;
  readonly compact?: boolean;
  readonly action?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div
      className={`tool-state${error ? ' error' : ''}${compact ? ' compact' : ''}`}
      role={error ? 'alert' : busy ? 'status' : undefined}
    >
      <span>{error ? '!' : busy ? '…' : '工'}</span>
      <strong>{title}</strong>
      <p>{description}</p>
      {action}
    </div>
  );
}

function formatToolTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}
