import type {
  Deliverable,
  EmployeeTaskCapability,
  EmployeeTaskExecutionSnapshot,
  EmployeeTaskTransitionRequest,
  Evidence,
} from '@enterprise/contracts';
import { useEffect, useMemo, useState, type FormEvent } from 'react';

import { ApiClientError } from '../../shared/api/client';
import {
  useContributeEmployeeEvidence,
  useEmployeeTaskExecution,
  useRequestEmployeeAcceptance,
  useSubmitEmployeeDeliverable,
  useTransitionEmployeeTask,
} from './hooks';
import { formatWorkbenchDate, shortBusinessId, taskStatusLabel } from './workbench-view';

type CapabilityAction = EmployeeTaskCapability['action'];
type TaskAction = EmployeeTaskTransitionRequest['action'];

const CAPABILITY_LABEL: Record<CapabilityAction, string> = {
  'business.task.execute': '推进任务',
  'business.deliverable.submit': '提交交付物',
  'business.evidence.contribute': '贡献证据',
  'business.acceptance.request': '发起验收',
};

const TASK_ACTION_LABEL: Record<TaskAction, string> = {
  START: '开始任务',
  BLOCK: '标记阻塞',
  UNBLOCK: '恢复执行',
  DELIVER: '确认任务已交付',
};

export function TaskExecutionPanel({ taskId }: { taskId: string }): React.JSX.Element {
  const snapshot = useEmployeeTaskExecution(taskId);
  const [notice, setNotice] = useState<string | null>(null);
  const [operationError, setOperationError] = useState<unknown>(null);

  if (snapshot.isPending && snapshot.data === undefined) {
    return (
      <ExecutionState
        title="正在读取任务执行上下文"
        description="服务端正在校验任务范围、有效角色授权和可执行动作。"
        busy
      />
    );
  }
  if (snapshot.isError || snapshot.data === undefined) {
    return (
      <ExecutionState
        title="任务执行上下文加载失败"
        description={executionErrorText(snapshot.error)}
        error
        action={
          <button type="button" onClick={() => void snapshot.refetch()}>
            重新加载
          </button>
        }
      />
    );
  }

  const data = snapshot.data;
  return (
    <section
      id="task-mode-panel-execution"
      role="tabpanel"
      aria-labelledby="task-mode-tab-execution"
      className="task-execution-panel"
    >
      {notice ? (
        <div className="task-execution-notice success" role="status">
          <span>{notice}</span>
          <button type="button" aria-label="关闭成功提示" onClick={() => setNotice(null)}>
            ×
          </button>
        </div>
      ) : null}
      {operationError ? (
        <div
          className="task-execution-notice error"
          role="alert"
          data-conflict={isRevisionConflict(operationError) ? 'true' : 'false'}
        >
          <span>{executionErrorText(operationError)}</span>
          <button
            type="button"
            disabled={snapshot.isFetching}
            onClick={() => {
              setOperationError(null);
              void snapshot.refetch();
            }}
          >
            {snapshot.isFetching ? '刷新中…' : '刷新任务状态'}
          </button>
        </div>
      ) : null}

      <header className="task-execution-header">
        <div>
          <p className="eyebrow">Authorized task execution</p>
          <h2>任务执行与验收</h2>
          <p>所有写入均绑定当前有效角色、任务范围和 revision，由服务端确认后才显示成功。</p>
        </div>
        <button
          type="button"
          disabled={snapshot.isFetching}
          onClick={() => void snapshot.refetch()}
        >
          {snapshot.isFetching ? '刷新中…' : '刷新'}
        </button>
      </header>

      <CapabilitySummary capabilities={data.capabilities} />
      <TaskTransitionSection
        snapshot={data}
        onConfirmed={(message) => {
          setOperationError(null);
          setNotice(message);
        }}
        onError={(error) => {
          setNotice(null);
          setOperationError(error);
        }}
      />
      <EvidenceContributionSection
        snapshot={data}
        onConfirmed={(message) => {
          setOperationError(null);
          setNotice(message);
        }}
        onError={(error) => {
          setNotice(null);
          setOperationError(error);
        }}
      />
      <DeliverableSection
        snapshot={data}
        onConfirmed={(message) => {
          setOperationError(null);
          setNotice(message);
        }}
        onError={(error) => {
          setNotice(null);
          setOperationError(error);
        }}
      />
    </section>
  );
}

function CapabilitySummary({
  capabilities,
}: {
  capabilities: EmployeeTaskExecutionSnapshot['capabilities'];
}): React.JSX.Element {
  const grouped = new Map<CapabilityAction, string[]>();
  for (const capability of capabilities) {
    const ids = grouped.get(capability.action) ?? [];
    ids.push(capability.roleAssignmentId);
    grouped.set(capability.action, ids);
  }
  return (
    <section className="task-execution-capabilities" aria-label="当前任务授权">
      {(Object.keys(CAPABILITY_LABEL) as CapabilityAction[]).map((action) => {
        const assignments = grouped.get(action) ?? [];
        return (
          <article key={action} data-authorized={assignments.length > 0 ? 'true' : 'false'}>
            <span>{assignments.length > 0 ? '已授权' : '未授权'}</span>
            <strong>{CAPABILITY_LABEL[action]}</strong>
            <small>
              {assignments.length > 0
                ? `${assignments.length} 个有效角色 · ${shortBusinessId(assignments[0]!)}`
                : '服务端未返回可用角色'}
            </small>
          </article>
        );
      })}
    </section>
  );
}

function TaskTransitionSection({
  snapshot,
  onConfirmed,
  onError,
}: ExecutionSectionProps): React.JSX.Element {
  const mutation = useTransitionEmployeeTask(snapshot.task.id);
  const [reason, setReason] = useState('');
  const roleAssignmentId = capabilityRole(snapshot, 'business.task.execute');
  const actions = actionsForStatus(snapshot.task.status);
  const processControlled = snapshot.task.processRef.instanceId !== null;

  const run = async (action: TaskAction): Promise<void> => {
    if (roleAssignmentId === null || reason.trim().length === 0 || processControlled) return;
    try {
      const updated = await mutation.mutateAsync({
        expectedRevision: snapshot.task.revision,
        action,
        roleAssignmentId,
        reason: reason.trim(),
        effectiveAt: new Date().toISOString(),
      });
      setReason('');
      onConfirmed(
        `服务端已确认任务状态为“${taskStatusLabel(updated.status)}”（r${updated.revision}）。`,
      );
    } catch (error) {
      onError(error);
    }
  };

  return (
    <section className="task-execution-section">
      <header>
        <div>
          <p className="eyebrow">Revision-bound transition</p>
          <h3>任务状态</h3>
        </div>
        <span>
          {taskStatusLabel(snapshot.task.status)} · r{snapshot.task.revision}
        </span>
      </header>
      {processControlled ? (
        <p className="task-execution-warning">
          此任务由流程实例 {shortBusinessId(snapshot.task.processRef.instanceId!)}{' '}
          控制，请在对应流程步骤中推进。
        </p>
      ) : null}
      <label>
        <span>执行说明</span>
        <textarea
          rows={2}
          value={reason}
          disabled={mutation.isPending || roleAssignmentId === null || processControlled}
          placeholder="说明本次状态变化的实际业务原因"
          onChange={(event) => setReason(event.target.value)}
        />
      </label>
      <div className="task-execution-actions">
        {actions.length > 0 ? (
          actions.map((action) => (
            <button
              key={action}
              type="button"
              disabled={
                mutation.isPending ||
                roleAssignmentId === null ||
                reason.trim().length === 0 ||
                processControlled
              }
              onClick={() => void run(action)}
            >
              {mutation.isPending ? '等待服务端确认…' : TASK_ACTION_LABEL[action]}
            </button>
          ))
        ) : (
          <button type="button" disabled>
            当前状态没有员工可执行的转换
          </button>
        )}
      </div>
      <AuthorizationHint roleAssignmentId={roleAssignmentId} />
    </section>
  );
}

function EvidenceContributionSection({
  snapshot,
  onConfirmed,
  onError,
}: ExecutionSectionProps): React.JSX.Element {
  const mutation = useContributeEmployeeEvidence(snapshot.task.id);
  const roleAssignmentId = capabilityRole(snapshot, 'business.evidence.contribute');
  const [form, setForm] = useState({
    code: '',
    sourceType: 'DOCUMENT' as 'DOCUMENT' | 'HUMAN_ATTESTATION',
    sourceSystem: '',
    sourceRecordId: '',
    sourceVersion: '',
    sourceUri: '',
    contentHash: '',
    summary: '',
  });
  const valid =
    form.code.trim().length > 0 &&
    form.sourceSystem.trim().length > 0 &&
    form.sourceRecordId.trim().length > 0 &&
    form.sourceVersion.trim().length > 0 &&
    /^[a-f0-9]{64}$/.test(form.contentHash.trim().toLowerCase()) &&
    form.summary.trim().length > 0;

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!valid || roleAssignmentId === null || mutation.isPending) return;
    const observedAt = new Date().toISOString();
    try {
      const created = await mutation.mutateAsync({
        roleAssignmentId,
        code: form.code.trim(),
        sourceType: form.sourceType,
        sourceSystem: form.sourceSystem.trim(),
        sourceRecordId: form.sourceRecordId.trim(),
        sourceVersion: form.sourceVersion.trim(),
        sourceUri: form.sourceUri.trim() || null,
        observedAt,
        contentHash: form.contentHash.trim().toLowerCase(),
        summary: form.summary.trim(),
        effectiveFrom: observedAt,
        effectiveTo: null,
        permissionLabels: snapshot.task.permissionLabels,
      });
      setForm({
        code: '',
        sourceType: 'DOCUMENT',
        sourceSystem: '',
        sourceRecordId: '',
        sourceVersion: '',
        sourceUri: '',
        contentHash: '',
        summary: '',
      });
      onConfirmed(`证据 ${created.code} 已真实入库为草稿；管理员核验为 ACTIVE 后才能用于交付。`);
    } catch (error) {
      onError(error);
    }
  };

  return (
    <section className="task-execution-section">
      <header>
        <div>
          <p className="eyebrow">Provenance-first evidence</p>
          <h3>贡献证据</h3>
        </div>
        <span>员工提交后：DRAFT / UNVERIFIED</span>
      </header>
      <form className="task-evidence-form" onSubmit={(event) => void submit(event)}>
        <label>
          <span>证据编码</span>
          <input
            value={form.code}
            disabled={mutation.isPending || roleAssignmentId === null}
            placeholder="EVIDENCE.CUSTOMER.REVIEW"
            onChange={(event) => setForm((current) => ({ ...current, code: event.target.value }))}
          />
        </label>
        <label>
          <span>来源类型</span>
          <select
            value={form.sourceType}
            disabled={mutation.isPending || roleAssignmentId === null}
            onChange={(event) =>
              setForm((current) => ({
                ...current,
                sourceType: event.target.value as typeof current.sourceType,
              }))
            }
          >
            <option value="DOCUMENT">文档</option>
            <option value="HUMAN_ATTESTATION">人工证明</option>
          </select>
        </label>
        <label>
          <span>来源系统</span>
          <input
            value={form.sourceSystem}
            disabled={mutation.isPending || roleAssignmentId === null}
            placeholder="SYSTEM.DOCUMENT"
            onChange={(event) =>
              setForm((current) => ({ ...current, sourceSystem: event.target.value }))
            }
          />
        </label>
        <label>
          <span>来源记录 ID</span>
          <input
            value={form.sourceRecordId}
            disabled={mutation.isPending || roleAssignmentId === null}
            onChange={(event) =>
              setForm((current) => ({ ...current, sourceRecordId: event.target.value }))
            }
          />
        </label>
        <label>
          <span>来源版本</span>
          <input
            value={form.sourceVersion}
            disabled={mutation.isPending || roleAssignmentId === null}
            onChange={(event) =>
              setForm((current) => ({ ...current, sourceVersion: event.target.value }))
            }
          />
        </label>
        <label>
          <span>来源链接（可选）</span>
          <input
            type="url"
            value={form.sourceUri}
            disabled={mutation.isPending || roleAssignmentId === null}
            onChange={(event) =>
              setForm((current) => ({ ...current, sourceUri: event.target.value }))
            }
          />
        </label>
        <label className="wide">
          <span>内容 SHA-256</span>
          <input
            value={form.contentHash}
            disabled={mutation.isPending || roleAssignmentId === null}
            placeholder="64 位小写十六进制摘要"
            onChange={(event) =>
              setForm((current) => ({ ...current, contentHash: event.target.value }))
            }
          />
        </label>
        <label className="wide">
          <span>证据摘要</span>
          <textarea
            rows={3}
            value={form.summary}
            disabled={mutation.isPending || roleAssignmentId === null}
            onChange={(event) =>
              setForm((current) => ({ ...current, summary: event.target.value }))
            }
          />
        </label>
        <footer className="wide">
          <AuthorizationHint roleAssignmentId={roleAssignmentId} />
          <button
            type="submit"
            disabled={!valid || roleAssignmentId === null || mutation.isPending}
          >
            {mutation.isPending ? '等待服务端入库…' : '提交待核验证据'}
          </button>
        </footer>
      </form>
      <EvidenceList evidence={snapshot.evidence} />
    </section>
  );
}

function DeliverableSection({
  snapshot,
  onConfirmed,
  onError,
}: ExecutionSectionProps): React.JSX.Element {
  const roleForSubmit = capabilityRole(snapshot, 'business.deliverable.submit');
  const roleForAcceptance = capabilityRole(snapshot, 'business.acceptance.request');

  return (
    <section className="task-execution-section">
      <header>
        <div>
          <p className="eyebrow">Evidence-sealed output</p>
          <h3>交付物与验收</h3>
        </div>
        <span>{snapshot.deliverables.length} 项交付物</span>
      </header>
      {snapshot.deliverables.length > 0 ? (
        <div className="task-deliverable-list">
          {snapshot.deliverables.map((deliverable) => (
            <DeliverableCard
              key={deliverable.id}
              snapshot={snapshot}
              deliverable={deliverable}
              roleForSubmit={roleForSubmit}
              roleForAcceptance={roleForAcceptance}
              onConfirmed={onConfirmed}
              onError={onError}
            />
          ))}
        </div>
      ) : (
        <p className="task-execution-empty">
          当前任务尚未定义交付物。员工端不会伪造交付物，请联系管理员先配置验收对象。
        </p>
      )}
    </section>
  );
}

function DeliverableCard({
  snapshot,
  deliverable,
  roleForSubmit,
  roleForAcceptance,
  onConfirmed,
  onError,
}: {
  snapshot: EmployeeTaskExecutionSnapshot;
  deliverable: Deliverable;
  roleForSubmit: string | null;
  roleForAcceptance: string | null;
  onConfirmed: (message: string) => void;
  onError: (error: unknown) => void;
}): React.JSX.Element {
  const submitMutation = useSubmitEmployeeDeliverable(snapshot.task.id);
  const acceptanceMutation = useRequestEmployeeAcceptance(snapshot.task.id);
  const activeEvidence = snapshot.evidence.filter((item) => item.status === 'ACTIVE');
  const [artifactUri, setArtifactUri] = useState(deliverable.artifactUri ?? '');
  const [contentHash, setContentHash] = useState(deliverable.contentHash ?? '');
  const [selectedEvidenceIds, setSelectedEvidenceIds] = useState<string[]>([]);
  const [acceptanceReason, setAcceptanceReason] = useState('');
  const [dueAt, setDueAt] = useState('');
  const existingRequest = snapshot.acceptanceRequests.find(
    (request) =>
      request.deliverableId === deliverable.id &&
      request.deliverableVersion === deliverable.version,
  );

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (
      roleForSubmit === null ||
      selectedEvidenceIds.length === 0 ||
      !artifactUri.trim() ||
      !/^[a-f0-9]{64}$/.test(contentHash.trim().toLowerCase())
    ) {
      return;
    }
    try {
      const updated = await submitMutation.mutateAsync({
        deliverableId: deliverable.id,
        input: {
          expectedRevision: deliverable.revision,
          roleAssignmentId: roleForSubmit,
          submittedAt: new Date().toISOString(),
          artifactUri: artifactUri.trim(),
          contentHash: contentHash.trim().toLowerCase(),
          evidenceIds: selectedEvidenceIds,
        },
      });
      onConfirmed(`交付物 ${updated.code} 已由服务端封存证据并确认提交。`);
    } catch (error) {
      onError(error);
    }
  };

  const requestAcceptance = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (
      roleForAcceptance === null ||
      acceptanceReason.trim().length === 0 ||
      !dueAt ||
      existingRequest?.status === 'REQUESTED'
    ) {
      return;
    }
    try {
      const created = await acceptanceMutation.mutateAsync({
        deliverableId: deliverable.id,
        input: {
          expectedDeliverableRevision: deliverable.revision,
          roleAssignmentId: roleForAcceptance,
          reason: acceptanceReason.trim(),
          dueAt: new Date(dueAt).toISOString(),
        },
      });
      setAcceptanceReason('');
      setDueAt('');
      onConfirmed(`验收申请已持久化，截止 ${formatWorkbenchDate(created.dueAt)}。`);
    } catch (error) {
      onError(error);
    }
  };

  return (
    <article className="task-deliverable-card">
      <header>
        <div>
          <strong>{deliverable.title}</strong>
          <code>{deliverable.code}</code>
        </div>
        <span>
          {deliverable.status} · r{deliverable.revision}
        </span>
      </header>
      <p>{deliverable.description}</p>
      {deliverable.status === 'DRAFT' ? (
        <form className="task-deliverable-form" onSubmit={(event) => void submit(event)}>
          <label>
            <span>交付物地址</span>
            <input
              type="url"
              value={artifactUri}
              disabled={submitMutation.isPending || roleForSubmit === null}
              onChange={(event) => setArtifactUri(event.target.value)}
            />
          </label>
          <label>
            <span>内容 SHA-256</span>
            <input
              value={contentHash}
              disabled={submitMutation.isPending || roleForSubmit === null}
              onChange={(event) => setContentHash(event.target.value)}
            />
          </label>
          <fieldset disabled={submitMutation.isPending || roleForSubmit === null}>
            <legend>选择已核验并关联本任务的证据</legend>
            {activeEvidence.length > 0 ? (
              activeEvidence.map((item) => (
                <label key={item.id}>
                  <input
                    type="checkbox"
                    checked={selectedEvidenceIds.includes(item.id)}
                    onChange={(event) =>
                      setSelectedEvidenceIds((current) =>
                        event.target.checked
                          ? [...current, item.id]
                          : current.filter((id) => id !== item.id),
                      )
                    }
                  />
                  <span>
                    {item.code} · {item.trustLevel}
                  </span>
                </label>
              ))
            ) : (
              <p>暂无 ACTIVE 证据；员工贡献的草稿需先由管理员核验。</p>
            )}
          </fieldset>
          <footer>
            <AuthorizationHint roleAssignmentId={roleForSubmit} />
            <button
              type="submit"
              disabled={
                submitMutation.isPending ||
                roleForSubmit === null ||
                selectedEvidenceIds.length === 0 ||
                !artifactUri.trim() ||
                !/^[a-f0-9]{64}$/.test(contentHash.trim().toLowerCase())
              }
            >
              {submitMutation.isPending ? '正在封存证据…' : '提交交付物'}
            </button>
          </footer>
        </form>
      ) : null}
      {deliverable.status === 'SUBMITTED' ? (
        <form className="task-acceptance-form" onSubmit={(event) => void requestAcceptance(event)}>
          {existingRequest ? (
            <p className={`task-acceptance-status ${existingRequest.status.toLowerCase()}`}>
              验收状态：{existingRequest.status} · 截止 {formatWorkbenchDate(existingRequest.dueAt)}
            </p>
          ) : null}
          <label>
            <span>验收说明</span>
            <textarea
              rows={2}
              value={acceptanceReason}
              disabled={
                acceptanceMutation.isPending ||
                roleForAcceptance === null ||
                existingRequest?.status === 'REQUESTED'
              }
              onChange={(event) => setAcceptanceReason(event.target.value)}
            />
          </label>
          <label>
            <span>验收截止时间</span>
            <input
              type="datetime-local"
              value={dueAt}
              disabled={
                acceptanceMutation.isPending ||
                roleForAcceptance === null ||
                existingRequest?.status === 'REQUESTED'
              }
              onChange={(event) => setDueAt(event.target.value)}
            />
          </label>
          <footer>
            <AuthorizationHint roleAssignmentId={roleForAcceptance} />
            <button
              type="submit"
              disabled={
                acceptanceMutation.isPending ||
                roleForAcceptance === null ||
                acceptanceReason.trim().length === 0 ||
                !dueAt ||
                existingRequest?.status === 'REQUESTED'
              }
            >
              {acceptanceMutation.isPending
                ? '正在持久化申请…'
                : existingRequest?.status === 'REQUESTED'
                  ? '已申请，等待治理角色验收'
                  : '发起验收'}
            </button>
          </footer>
        </form>
      ) : null}
      {deliverable.status !== 'DRAFT' && deliverable.status !== 'SUBMITTED' ? (
        <p className="task-execution-empty">该交付物已处于终态，员工端不提供验收决策入口。</p>
      ) : null}
    </article>
  );
}

function EvidenceList({ evidence }: { evidence: readonly Evidence[] }): React.JSX.Element {
  return (
    <div className="task-evidence-list">
      <header>
        <strong>任务证据</strong>
        <span>{evidence.length}</span>
      </header>
      {evidence.length > 0 ? (
        evidence.map((item) => (
          <article key={item.id}>
            <span className={item.status.toLowerCase()}>{item.status}</span>
            <div>
              <strong>{item.code}</strong>
              <small>{item.summary}</small>
            </div>
            <code>{shortBusinessId(item.id)}</code>
          </article>
        ))
      ) : (
        <p>当前任务尚无可见证据。</p>
      )}
    </div>
  );
}

function AuthorizationHint({
  roleAssignmentId,
}: {
  roleAssignmentId: string | null;
}): React.JSX.Element {
  return (
    <small className={roleAssignmentId === null ? 'authorization-denied' : ''}>
      {roleAssignmentId === null
        ? '没有匹配此动作和任务范围的有效角色授权'
        : `以授权角色 ${shortBusinessId(roleAssignmentId)} 执行`}
    </small>
  );
}

function ExecutionState({
  title,
  description,
  busy = false,
  error = false,
  action,
}: {
  title: string;
  description: string;
  busy?: boolean;
  error?: boolean;
  action?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div
      className={`task-execution-state ${error ? 'error' : ''}`}
      role={error ? 'alert' : 'status'}
    >
      <span aria-hidden="true">{busy ? '…' : error ? '!' : '•'}</span>
      <strong>{title}</strong>
      <p>{description}</p>
      {action}
    </div>
  );
}

function capabilityRole(
  snapshot: EmployeeTaskExecutionSnapshot,
  action: CapabilityAction,
): string | null {
  return (
    snapshot.capabilities.find((capability) => capability.action === action)?.roleAssignmentId ??
    null
  );
}

function actionsForStatus(status: EmployeeTaskExecutionSnapshot['task']['status']): TaskAction[] {
  switch (status) {
    case 'READY':
      return ['START'];
    case 'IN_PROGRESS':
      return ['BLOCK', 'DELIVER'];
    case 'BLOCKED':
      return ['UNBLOCK'];
    default:
      return [];
  }
}

function isRevisionConflict(error: unknown): boolean {
  return error instanceof ApiClientError && error.kind === 'http' && error.status === 409;
}

function executionErrorText(error: unknown): string {
  if (isRevisionConflict(error)) {
    return '任务或交付物已被其他人更新。请刷新最新 revision，确认后再执行。';
  }
  if (error instanceof ApiClientError) {
    if (error.status === 403) {
      return '当前账号或有效角色没有此任务动作的授权，服务端已拒绝写入。';
    }
    if (error.status === 404) {
      return '该任务在当前租户和授权范围内不可见。';
    }
    return error.message;
  }
  return error instanceof Error ? error.message : '任务执行请求失败，请刷新后重试。';
}

interface ExecutionSectionProps {
  readonly snapshot: EmployeeTaskExecutionSnapshot;
  readonly onConfirmed: (message: string) => void;
  readonly onError: (error: unknown) => void;
}
