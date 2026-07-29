import type {
  EmployeeCreateExperienceRequest,
  EmployeeExperienceCandidate,
  ExperienceStatus,
  Task,
} from '@enterprise/contracts';
import { useMemo, useState, type FormEvent } from 'react';

import {
  useCreateEmployeeExperience,
  useEmployeeAiUsage,
  useEmployeeExperiences,
  useEmployeeExperienceSources,
  type EmployeeAiUsageWindow,
} from './hooks';
import {
  EXPERIENCE_STATUS_OPTIONS,
  experienceStageSummary,
  experienceStatusLabel,
  formatCostMicros,
  formatUsageInteger,
  readableExperienceUsageError,
  usageTrustSummary,
} from './experience-usage-view';
import './experience-usage.css';

type ExperienceUsageTab = 'experience' | 'usage';

export function ExperienceUsageWorkspace({
  tasks,
}: {
  readonly tasks: readonly Task[];
}): React.JSX.Element {
  const [tab, setTab] = useState<ExperienceUsageTab>('experience');
  return (
    <section className="experience-usage-workspace" aria-labelledby="experience-usage-title">
      <header className="experience-usage-hero">
        <div>
          <p>Employee self-service</p>
          <h1 id="experience-usage-title">经验与 AI 用量</h1>
          <span>只展示当前账号贡献的经验候选和当前账号发起的 Agent Run。</span>
        </div>
        <div className="experience-usage-tabs" role="tablist" aria-label="经验与用量">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'experience'}
            className={tab === 'experience' ? 'active' : ''}
            onClick={() => setTab('experience')}
          >
            我的经验
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'usage'}
            className={tab === 'usage' ? 'active' : ''}
            onClick={() => setTab('usage')}
          >
            AI 用量
          </button>
        </div>
      </header>
      {tab === 'experience' ? <EmployeeExperiencePanel tasks={tasks} /> : <EmployeeUsagePanel />}
    </section>
  );
}

function EmployeeExperiencePanel({
  tasks,
}: {
  readonly tasks: readonly Task[];
}): React.JSX.Element {
  const [status, setStatus] = useState<ExperienceStatus | undefined>();
  const [createOpen, setCreateOpen] = useState(false);
  const query = useEmployeeExperiences(status);
  const items = useMemo(() => query.data?.pages.flatMap((page) => page.items) ?? [], [query.data]);

  return (
    <div className="employee-experience-panel">
      <div className="experience-toolbar">
        <label>
          <span>治理状态</span>
          <select
            value={status ?? ''}
            onChange={(event) =>
              setStatus((event.target.value || undefined) as ExperienceStatus | undefined)
            }
          >
            <option value="">全部状态</option>
            {EXPERIENCE_STATUS_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {experienceStatusLabel(option)}
              </option>
            ))}
          </select>
        </label>
        <div>
          <button type="button" onClick={() => void query.refetch()} disabled={query.isFetching}>
            {query.isFetching ? '刷新中…' : '刷新'}
          </button>
          <button type="button" className="primary" onClick={() => setCreateOpen(true)}>
            提交经验候选
          </button>
        </div>
      </div>

      <div className="experience-privacy-note">
        <strong>隐私边界</strong>
        <span>
          未脱敏正文不会在员工列表回显；审核、验证和发布仅由治理角色完成，未审核候选不会进入知识库。
        </span>
      </div>

      {query.isPending ? (
        <WorkspaceState
          title="正在读取经验候选"
          description="服务端正在校验贡献者身份与租户边界。"
          busy
        />
      ) : query.isError ? (
        <WorkspaceState
          title="经验候选加载失败"
          description={readableExperienceUsageError(query.error)}
          error
          action={
            <button type="button" onClick={() => void query.refetch()}>
              重新加载
            </button>
          }
        />
      ) : items.length === 0 ? (
        <WorkspaceState
          title="当前筛选下暂无经验候选"
          description="这里不会生成演示记录；你可以从自己有权访问的真实任务与验证证据提交候选。"
          action={
            <button type="button" onClick={() => setCreateOpen(true)}>
              提交第一个候选
            </button>
          }
        />
      ) : (
        <>
          <div className="experience-card-grid">
            {items.map((candidate) => (
              <ExperienceCard key={candidate.id} candidate={candidate} />
            ))}
          </div>
          {query.hasNextPage ? (
            <button
              type="button"
              className="load-more"
              disabled={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
            >
              {query.isFetchingNextPage ? '加载中…' : '加载更多'}
            </button>
          ) : null}
        </>
      )}

      {createOpen ? (
        <CreateExperienceDialog
          tasks={tasks}
          status={status}
          onClose={() => setCreateOpen(false)}
        />
      ) : null}
    </div>
  );
}

function ExperienceCard({
  candidate,
}: {
  readonly candidate: EmployeeExperienceCandidate;
}): React.JSX.Element {
  return (
    <article className="employee-experience-card">
      <header>
        <span className={`experience-status status-${candidate.status.toLowerCase()}`}>
          {experienceStatusLabel(candidate.status)}
        </span>
        <small>r{candidate.revision}</small>
      </header>
      <h2>{candidate.title}</h2>
      <p>{experienceStageSummary(candidate)}</p>
      {candidate.sanitized ? (
        <blockquote>{candidate.sanitized.safeContent}</blockquote>
      ) : (
        <div className="redacted-content">正文待脱敏，不在此处展示</div>
      )}
      <dl>
        <div>
          <dt>来源</dt>
          <dd>
            任务 1 · 交付物 {candidate.source.deliverableIds.length} · 证据{' '}
            {candidate.source.evidenceIds.length}
          </dd>
        </div>
        <div>
          <dt>适用范围</dt>
          <dd>
            {candidate.publication
              ? `角色 ${candidate.publication.targetRoleTemplateIds.length} · 部门 ${candidate.publication.targetOrgUnitIds.length}`
              : '尚未发布'}
          </dd>
        </div>
        <div>
          <dt>复用指标</dt>
          <dd>
            使用 {candidate.metrics.useCount} · 采纳 {candidate.metrics.adoptionCount} · 投诉{' '}
            {candidate.metrics.complaintCount}
          </dd>
        </div>
      </dl>
      <footer>
        <code>{shortId(candidate.source.taskId)}</code>
        <time>{formatDate(candidate.updatedAt)}</time>
      </footer>
    </article>
  );
}

function CreateExperienceDialog({
  tasks,
  status,
  onClose,
}: {
  readonly tasks: readonly Task[];
  readonly status: ExperienceStatus | undefined;
  readonly onClose: () => void;
}): React.JSX.Element {
  const [taskId, setTaskId] = useState(tasks[0]?.id ?? '');
  const [selectedDeliverables, setSelectedDeliverables] = useState<Set<string>>(new Set());
  const [selectedEvidence, setSelectedEvidence] = useState<Set<string>>(new Set());
  const [formError, setFormError] = useState<string | null>(null);
  const sources = useEmployeeExperienceSources(taskId || null);
  const create = useCreateEmployeeExperience(status);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setFormError(null);
    const values = new FormData(event.currentTarget);
    const title = String(values.get('title') ?? '').trim();
    const candidateSummary = String(values.get('candidateSummary') ?? '').trim();
    if (!taskId || !title || !candidateSummary || selectedEvidence.size === 0) {
      setFormError('请选择任务和至少一条已验证证据，并填写标题与候选摘要。');
      return;
    }
    const input: EmployeeCreateExperienceRequest = {
      title,
      sourceTaskId: taskId,
      sourceDeliverableIds: [...selectedDeliverables],
      sourceEvidenceIds: [...selectedEvidence],
      candidateSummary,
      permissionLabels: splitLabels(String(values.get('permissionLabels') ?? '')),
      sensitivity: String(
        values.get('sensitivity'),
      ) as EmployeeCreateExperienceRequest['sensitivity'],
      idempotencyKey: nextIdempotencyKey(),
    };
    try {
      await create.mutateAsync(input);
      onClose();
    } catch {
      // Mutation error is rendered below with the shared safe error formatter.
    }
  };

  return (
    <div className="experience-dialog-backdrop" role="presentation">
      <section
        className="experience-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-experience-title"
      >
        <header>
          <div>
            <p>Governed contribution</p>
            <h2 id="create-experience-title">提交经验候选</h2>
          </div>
          <button type="button" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </header>
        <form onSubmit={(event) => void submit(event)}>
          <label>
            <span>来源任务</span>
            <select
              name="taskId"
              value={taskId}
              required
              onChange={(event) => {
                setTaskId(event.target.value);
                setSelectedDeliverables(new Set());
                setSelectedEvidence(new Set());
              }}
            >
              {tasks.length === 0 ? <option value="">暂无可用任务</option> : null}
              {tasks.map((task) => (
                <option key={task.id} value={task.id}>
                  {task.title}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>候选标题</span>
            <input name="title" required maxLength={300} />
          </label>
          <label className="wide">
            <span>候选摘要（仅进入受控治理链路）</span>
            <textarea name="candidateSummary" required rows={5} maxLength={20_000} />
          </label>
          <div className="experience-source-picker wide">
            <header>
              <strong>真实交付物与验证证据</strong>
              <span>仅展示你对当前任务有权限且服务端确认可用的来源。</span>
            </header>
            {sources.isPending ? (
              <p role="status">正在读取任务来源…</p>
            ) : sources.isError ? (
              <p role="alert">{readableExperienceUsageError(sources.error)}</p>
            ) : sources.data ? (
              <div className="experience-source-columns">
                <fieldset>
                  <legend>已封存交付物（可选）</legend>
                  {sources.data.deliverables.length === 0 ? (
                    <p>暂无可用交付物</p>
                  ) : (
                    sources.data.deliverables.map((deliverable) => (
                      <label key={deliverable.id}>
                        <input
                          type="checkbox"
                          checked={selectedDeliverables.has(deliverable.id)}
                          onChange={(event) =>
                            setSelectedDeliverables(
                              toggled(selectedDeliverables, deliverable.id, event.target.checked),
                            )
                          }
                        />
                        <span>
                          {deliverable.title} · v{deliverable.version}
                        </span>
                      </label>
                    ))
                  )}
                </fieldset>
                <fieldset>
                  <legend>已验证证据（至少一条）</legend>
                  {sources.data.evidence.length === 0 ? (
                    <p>暂无与任务绑定的验证证据</p>
                  ) : (
                    sources.data.evidence.map((evidence) => (
                      <label key={evidence.id}>
                        <input
                          type="checkbox"
                          checked={selectedEvidence.has(evidence.id)}
                          onChange={(event) =>
                            setSelectedEvidence(
                              toggled(selectedEvidence, evidence.id, event.target.checked),
                            )
                          }
                        />
                        <span>
                          {evidence.code} · {evidence.sourceType}
                        </span>
                      </label>
                    ))
                  )}
                </fieldset>
              </div>
            ) : null}
          </div>
          <label>
            <span>敏感级别</span>
            <select name="sensitivity" defaultValue="INTERNAL">
              <option value="PUBLIC">公开</option>
              <option value="INTERNAL">内部</option>
              <option value="CONFIDENTIAL">机密</option>
              <option value="RESTRICTED">受限</option>
            </select>
          </label>
          <label>
            <span>权限标签（逗号分隔）</span>
            <input name="permissionLabels" maxLength={500} />
          </label>
          <div className="experience-submit-note wide">
            提交后先进入脱敏与独立审核；员工本人不能自行审核、验证或发布。
          </div>
          {formError || create.isError ? (
            <p className="experience-form-error wide" role="alert">
              {formError ?? readableExperienceUsageError(create.error)}
            </p>
          ) : null}
          <footer className="wide">
            <button type="button" onClick={onClose}>
              取消
            </button>
            <button
              type="submit"
              className="primary"
              disabled={create.isPending || sources.isPending || selectedEvidence.size === 0}
            >
              {create.isPending ? '提交中…' : '提交受控候选'}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}

function EmployeeUsagePanel(): React.JSX.Element {
  const [window, setWindow] = useState<EmployeeAiUsageWindow>({});
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [windowError, setWindowError] = useState<string | null>(null);
  const query = useEmployeeAiUsage(window);

  const applyWindow = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!fromDate || !toDate) {
      setWindowError('自定义时间窗必须同时填写开始和结束日期。');
      return;
    }
    const from = new Date(`${fromDate}T00:00:00.000Z`);
    const to = new Date(`${toDate}T23:59:59.999Z`);
    if (from >= to) {
      setWindowError('结束日期必须晚于开始日期。');
      return;
    }
    setWindowError(null);
    setWindow({ from: from.toISOString(), to: to.toISOString() });
  };

  return (
    <div className="employee-usage-panel">
      <div className="usage-toolbar">
        <form onSubmit={applyWindow}>
          <label>
            <span>开始日期</span>
            <input
              type="date"
              value={fromDate}
              onChange={(event) => setFromDate(event.target.value)}
            />
          </label>
          <label>
            <span>结束日期</span>
            <input type="date" value={toDate} onChange={(event) => setToDate(event.target.value)} />
          </label>
          <button type="submit">应用时间窗</button>
          <button
            type="button"
            onClick={() => {
              setFromDate('');
              setToDate('');
              setWindowError(null);
              setWindow({});
            }}
          >
            本月
          </button>
        </form>
        <button type="button" onClick={() => void query.refetch()} disabled={query.isFetching}>
          {query.isFetching ? '刷新中…' : '刷新用量'}
        </button>
      </div>
      {windowError ? (
        <p className="usage-window-error" role="alert">
          {windowError}
        </p>
      ) : null}

      {query.isPending ? (
        <WorkspaceState
          title="正在汇总 AI 用量"
          description="只统计当前账号发起的 Agent Run。"
          busy
        />
      ) : query.isError ? (
        <WorkspaceState
          title="AI 用量加载失败"
          description={readableExperienceUsageError(query.error)}
          error
          action={
            <button type="button" onClick={() => void query.refetch()}>
              重新加载
            </button>
          }
        />
      ) : query.data ? (
        <UsageSummary usage={query.data} />
      ) : null}
    </div>
  );
}

function UsageSummary({
  usage,
}: {
  readonly usage: NonNullable<ReturnType<typeof useEmployeeAiUsage>['data']>;
}): React.JSX.Element {
  return (
    <>
      <div className="usage-trust-note">
        <strong>可信计量口径</strong>
        <span>
          仅 `usage_recorded_at` / `cost_recorded_at` 已确认的记录计入 Token 与费用；未上报的 0/0/0
          不会伪装成真实用量。
        </span>
        <small>{usageTrustSummary(usage)}</small>
      </div>
      <div className="usage-metric-grid">
        <UsageMetric label="总 Run" value={formatUsageInteger(usage.runs.total)} />
        <UsageMetric
          label="成功 / 失败"
          value={`${usage.runs.succeeded} / ${usage.runs.failed + usage.runs.cancelled}`}
        />
        <UsageMetric label="结果未知" value={formatUsageInteger(usage.runs.unknown)} />
        <UsageMetric
          label="可信 Token"
          value={formatUsageInteger(usage.trustedUsage.totalTokens)}
        />
        <UsageMetric
          label="可信费用"
          value={`${formatCostMicros(usage.trustedUsage.costMicros)} 计费单位`}
        />
        <UsageMetric
          label="平均 / P95 延迟"
          value={
            usage.latency.sampleCount === 0
              ? '暂无样本'
              : `${formatUsageInteger(usage.latency.averageMs ?? 0)} / ${formatUsageInteger(usage.latency.p95Ms ?? 0)} ms`
          }
        />
      </div>
      {usage.runs.total === 0 ? (
        <WorkspaceState
          title="当前时间窗暂无 Agent Run"
          description="服务端返回了真实空结果，没有填充模拟用量。"
        />
      ) : (
        <div className="usage-group-grid">
          <UsageGroup title="按智能体" groups={usage.byAgent} emptyLabel="暂无智能体分组" />
          <UsageGroup title="按任务" groups={usage.byTask} emptyLabel="暂无任务分组" />
        </div>
      )}
      <p className="usage-period">
        统计区间：{formatDate(usage.period.from)} — {formatDate(usage.period.to)}
      </p>
    </>
  );
}

function UsageMetric({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <article>
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

function UsageGroup({
  title,
  groups,
  emptyLabel,
}: {
  readonly title: string;
  readonly groups: NonNullable<ReturnType<typeof useEmployeeAiUsage>['data']>['byAgent'];
  readonly emptyLabel: string;
}): React.JSX.Element {
  return (
    <section className="usage-group-card">
      <h2>{title}</h2>
      {groups.length === 0 ? (
        <p>{emptyLabel}</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>对象</th>
              <th>Run</th>
              <th>可信 Token</th>
              <th>未上报</th>
              <th>平均延迟</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((group) => (
              <tr key={group.id ?? 'unbound'}>
                <td>{group.name ?? '未关联任务'}</td>
                <td>{group.runs.total}</td>
                <td>{formatUsageInteger(group.trustedUsage.totalTokens)}</td>
                <td>{group.runs.tokenUnreported}</td>
                <td>
                  {group.latency.averageMs === null
                    ? '—'
                    : `${formatUsageInteger(group.latency.averageMs)} ms`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function WorkspaceState({
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
    <div
      className={`experience-usage-state${error ? ' error' : ''}`}
      role={error ? 'alert' : busy ? 'status' : undefined}
    >
      <span aria-hidden="true">{error ? '!' : busy ? '…' : '◇'}</span>
      <h2>{title}</h2>
      <p>{description}</p>
      {action}
    </div>
  );
}

function toggled(values: ReadonlySet<string>, id: string, checked: boolean): Set<string> {
  const next = new Set(values);
  if (checked) next.add(id);
  else next.delete(id);
  return next;
}

function splitLabels(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[,，]/u)
        .map((label) => label.trim())
        .filter(Boolean),
    ),
  ].slice(0, 100);
}

let idempotencySequence = 0;
function nextIdempotencyKey(): string {
  idempotencySequence += 1;
  return `employee-experience-${Date.now().toString(36)}-${idempotencySequence}`;
}

function shortId(value: string): string {
  return `${value.slice(0, 8)}…${value.slice(-4)}`;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}
