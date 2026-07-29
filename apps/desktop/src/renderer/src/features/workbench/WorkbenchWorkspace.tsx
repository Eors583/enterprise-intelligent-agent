import type { BusinessSemanticTraceResponse, Objective, Task } from '@enterprise/contracts';
import { useEffect, useMemo, useState } from 'react';

import { TaskToolPanel } from '../tools/TaskToolPanel';
import { useWorkbenchTaskTrace } from './hooks';
import { TaskExecutionPanel } from './TaskExecutionPanel';
import {
  TaskCollaborationPanel,
  TaskCorrectionPanel,
  WorkbenchTaskModeTabs,
  type WorkbenchTaskMode,
} from './TaskInteractionPanels';
import {
  buildObjectiveForest,
  businessTraceSteps,
  formatWorkbenchDate,
  objectiveStatusLabel,
  rootTaskTrace,
  shortBusinessId,
  taskPriorityLabel,
  taskStatusLabel,
  type ObjectiveTreeNode,
} from './workbench-view';
import './workbench.css';

interface WorkbenchSidebarProps {
  objectives: Objective[] | undefined;
  tasks: Task[] | undefined;
  selectedObjectiveId: string | null;
  selectedTaskId: string | null;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  isRefreshing: boolean;
  onSelectObjective: (objectiveId: string) => void;
  onSelectTask: (taskId: string) => void;
  onRetry: () => void;
}

export function WorkbenchSidebar({
  objectives,
  tasks,
  selectedObjectiveId,
  selectedTaskId,
  isLoading,
  isError,
  error,
  isRefreshing,
  onSelectObjective,
  onSelectTask,
  onRetry,
}: WorkbenchSidebarProps): React.JSX.Element {
  const forest = useMemo(() => buildObjectiveForest(objectives ?? []), [objectives]);
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(objectives?.map((objective) => objective.id) ?? []),
  );
  useEffect(() => {
    setExpanded((current) => {
      const next = new Set(current);
      for (const objective of objectives ?? []) next.add(objective.id);
      return next;
    });
  }, [objectives]);
  const visibleTasks =
    selectedObjectiveId === null
      ? (tasks ?? [])
      : (tasks ?? []).filter((task) => task.objectiveId === selectedObjectiveId);

  const toggle = (objectiveId: string): void => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(objectiveId)) next.delete(objectiveId);
      else next.add(objectiveId);
      return next;
    });
  };

  const renderNode = (node: ObjectiveTreeNode, depth: number): React.JSX.Element => {
    const open = expanded.has(node.objective.id);
    return (
      <div
        key={node.objective.id}
        className="workbench-objective-node"
        role="treeitem"
        aria-expanded={node.children.length > 0 ? open : undefined}
      >
        <div style={{ '--objective-depth': depth } as React.CSSProperties}>
          <button
            type="button"
            className="objective-toggle"
            aria-label={`${open ? '收起' : '展开'} ${node.objective.name}`}
            disabled={node.children.length === 0}
            onClick={() => toggle(node.objective.id)}
          >
            {node.children.length > 0 ? (open ? '⌄' : '›') : '·'}
          </button>
          <button
            type="button"
            className={
              node.objective.id === selectedObjectiveId
                ? 'objective-select selected'
                : 'objective-select'
            }
            aria-current={node.objective.id === selectedObjectiveId ? 'true' : undefined}
            onClick={() => onSelectObjective(node.objective.id)}
          >
            <span>{node.objective.bscPerspective.slice(0, 1)}</span>
            <span>
              <strong>{node.objective.name}</strong>
              <small>
                {objectiveStatusLabel(node.objective.status)}
                {node.orphan ? ' · 层级待校验' : ''}
                {node.cycle ? ' · 检测到循环' : ''}
              </small>
            </span>
          </button>
        </div>
        {open && node.children.length > 0 ? (
          <div role="group">{node.children.map((child) => renderNode(child, depth + 1))}</div>
        ) : null}
      </div>
    );
  };

  return (
    <aside
      className="directory-sidebar module-sidebar objective-task-sidebar"
      aria-label="目标与任务"
    >
      <header className="workbench-sidebar-header">
        <div>
          <p className="eyebrow">Objective & task</p>
          <h1>目标与任务</h1>
        </div>
        <button type="button" onClick={onRetry} disabled={isRefreshing}>
          {isRefreshing ? '刷新中…' : '刷新'}
        </button>
      </header>
      <p className="workbench-sidebar-intro">只展示当前账号经服务端授权返回的目标和任务。</p>

      {isError ? (
        <div className="workbench-sidebar-error" role="alert">
          <strong>目标或任务刷新失败</strong>
          <span>{readableError(error)}</span>
        </div>
      ) : null}
      {isLoading && objectives === undefined && tasks === undefined ? (
        <div className="workbench-sidebar-loading" role="status">
          正在读取目标与任务…
        </div>
      ) : (
        <>
          <section className="workbench-objectives">
            <header>
              <strong>目标树</strong>
              <span>{objectives?.length ?? 0}</span>
            </header>
            {forest.length > 0 ? (
              <div role="tree" aria-label="我的目标树">
                {forest.map((node) => renderNode(node, 0))}
              </div>
            ) : (
              <p>当前账号暂无可见目标。</p>
            )}
          </section>

          <section className="workbench-task-list">
            <header>
              <strong>关联任务</strong>
              <span>{visibleTasks.length}</span>
            </header>
            {visibleTasks.length > 0 ? (
              visibleTasks.map((task) => (
                <button
                  key={task.id}
                  type="button"
                  className={task.id === selectedTaskId ? 'selected' : ''}
                  aria-current={task.id === selectedTaskId ? 'true' : undefined}
                  onClick={() => onSelectTask(task.id)}
                >
                  <span
                    className={`task-state-mark ${task.status.toLowerCase()}`}
                    aria-hidden="true"
                  >
                    任
                  </span>
                  <span>
                    <strong>{task.title}</strong>
                    <code>{task.code}</code>
                    <small>
                      {taskStatusLabel(task.status)} · {taskPriorityLabel(task.priority)}优先级
                    </small>
                  </span>
                </button>
              ))
            ) : (
              <p>{selectedObjectiveId ? '该目标暂无可见任务。' : '当前账号暂无可见任务。'}</p>
            )}
          </section>
        </>
      )}
    </aside>
  );
}

export function WorkbenchTaskWorkspace({
  task,
  objective,
  isLoading,
}: {
  task: Task | null;
  objective: Objective | null;
  isLoading: boolean;
}): React.JSX.Element {
  const [traceOpen, setTraceOpen] = useState(false);
  const [mode, setMode] = useState<WorkbenchTaskMode>('overview');
  const trace = useWorkbenchTaskTrace(task?.id ?? null, traceOpen);

  useEffect(() => {
    setTraceOpen(false);
    setMode('overview');
  }, [task?.id]);

  if (isLoading && task === null) {
    return (
      <WorkbenchState title="正在加载任务" description="正在读取当前账号可见的目标与任务…" busy />
    );
  }
  if (task === null) {
    return (
      <WorkbenchState
        title="暂无可查看任务"
        description="服务端没有返回当前账号可访问的任务；这里不会生成示例任务。"
      />
    );
  }

  return (
    <article className="objective-task-workspace" aria-labelledby="task-workspace-title">
      <header className="task-workspace-hero">
        <div className={`task-hero-mark ${task.status.toLowerCase()}`} aria-hidden="true">
          任
        </div>
        <div>
          <p className="eyebrow">{task.code}</p>
          <h1 id="task-workspace-title">{task.title}</h1>
          <div className="task-hero-badges">
            <span className={`task-status ${task.status.toLowerCase()}`}>
              {taskStatusLabel(task.status)}
            </span>
            <span className={`task-priority ${task.priority.toLowerCase()}`}>
              {taskPriorityLabel(task.priority)}优先级
            </span>
            <span>
              v{task.version} · r{task.revision}
            </span>
          </div>
          <p>{task.description}</p>
        </div>
        <div className="task-due-card">
          <span>截止时间</span>
          <strong>{formatWorkbenchDate(task.dueAt)}</strong>
          <small>{formatDue(task.dueAt)}</small>
        </div>
      </header>

      <WorkbenchTaskModeTabs active={mode} onChange={setMode} />

      {mode === 'overview' ? (
        <div
          id="task-mode-panel-overview"
          className="task-workspace-body"
          role="tabpanel"
          aria-labelledby="task-mode-tab-overview"
        >
          <section className="task-context-grid" aria-label="任务业务上下文">
            <ContextCard
              mark="目"
              label="Objective"
              title={objective?.name ?? '目标身份'}
              value={objective?.code ?? shortBusinessId(task.objectiveId)}
            />
            <ContextCard
              mark="值"
              label="Value version"
              title={shortBusinessId(task.valueVersionId)}
              value={`定义 ${shortBusinessId(task.valueDefinitionId)}`}
            />
            <ContextCard
              mark="流"
              label="Process node"
              title={task.processRef.definitionCode}
              value={`${task.processRef.nodeCode} · v${task.processRef.version}`}
            />
            <ContextCard
              mark="权"
              label="Permission labels"
              title={
                task.permissionLabels.length > 0
                  ? task.permissionLabels.join(' · ')
                  : '无资源级标签'
              }
              value={`Owner ${task.owner.type}`}
            />
          </section>

          <section className="task-trace-launcher">
            <div>
              <span className="trace-launcher-mark" aria-hidden="true">
                链
              </span>
              <div>
                <p className="eyebrow">Immutable trace</p>
                <h2>完整经营语义链</h2>
                <p>
                  展开后从服务端读取 Value、Strategy、Objective、Metric、Process、Task、
                  Deliverable、Acceptance 与 Evidence 快照。
                </p>
              </div>
            </div>
            <button
              type="button"
              className="trace-toggle"
              aria-expanded={traceOpen}
              aria-controls="task-semantic-trace"
              disabled={traceOpen && trace.isPending}
              onClick={() => setTraceOpen((current) => !current)}
            >
              {traceOpen
                ? trace.isPending
                  ? '加载全链 trace…'
                  : '收起全链 trace'
                : '展开全链 trace'}
            </button>
          </section>

          {traceOpen ? (
            <section id="task-semantic-trace" className="task-semantic-trace" aria-live="polite">
              {trace.isPending ? (
                <TraceState
                  title="正在读取全链 trace"
                  description="等待服务端返回并通过共享契约校验…"
                />
              ) : trace.isError ? (
                <TraceState
                  title="全链 trace 加载失败"
                  description={readableError(trace.error)}
                  error
                  action={
                    <button type="button" onClick={() => void trace.refetch()}>
                      重试
                    </button>
                  }
                />
              ) : trace.data ? (
                <TraceContent trace={trace.data} />
              ) : (
                <TraceState title="暂无 trace" description="服务端未返回可展示的追溯快照。" />
              )}
            </section>
          ) : null}
        </div>
      ) : mode === 'execution' ? (
        <TaskExecutionPanel taskId={task.id} />
      ) : mode === 'collaboration' ? (
        <TaskCollaborationPanel taskId={task.id} />
      ) : mode === 'correction' ? (
        <TaskCorrectionPanel taskId={task.id} />
      ) : (
        <TaskToolPanel taskId={task.id} />
      )}
    </article>
  );
}

function TraceContent({ trace }: { trace: BusinessSemanticTraceResponse }): React.JSX.Element {
  const root = rootTaskTrace(trace);
  const steps = businessTraceSteps(trace);
  const taskById = new Map(trace.tasks.map((task) => [task.id, task]));
  const acceptancesByDeliverable = new Map(
    root.deliverables.map((deliverable) => [
      deliverable.id,
      root.acceptances.filter((acceptance) => acceptance.deliverableId === deliverable.id),
    ]),
  );

  return (
    <div className="trace-content">
      <header className="trace-audit-header">
        <div>
          <p className="eyebrow">Contract-validated snapshot</p>
          <h2>全链 trace</h2>
        </div>
        <dl>
          <div>
            <dt>Trace ID</dt>
            <dd>{shortBusinessId(trace.traceId)}</dd>
          </div>
          <div>
            <dt>生成时间</dt>
            <dd>{formatWorkbenchDate(trace.generatedAt)}</dd>
          </div>
        </dl>
      </header>

      <div className="trace-step-flow" aria-label="经营语义追溯链">
        {steps.map((step, index) => (
          <article key={step.key}>
            <span>{index + 1}</span>
            <p>{step.label}</p>
            <strong>{step.title}</strong>
            <code>{step.code}</code>
            <small>{step.meta}</small>
          </article>
        ))}
      </div>

      <div className="trace-detail-grid">
        <section className="trace-detail-card">
          <header>
            <div>
              <p className="eyebrow">Dependencies</p>
              <h3>任务依赖</h3>
            </div>
            <span>{root.dependencies.length}</span>
          </header>
          {root.dependencies.length > 0 ? (
            <div className="trace-dependency-list">
              {root.dependencies.map((dependency) => (
                <article key={dependency.id}>
                  <span>{dependency.type}</span>
                  <strong>
                    {taskById.get(dependency.predecessorTaskId)?.title ??
                      shortBusinessId(dependency.predecessorTaskId)}
                  </strong>
                  <i aria-hidden="true">→</i>
                  <strong>
                    {taskById.get(dependency.successorTaskId)?.title ??
                      shortBusinessId(dependency.successorTaskId)}
                  </strong>
                  <small>
                    {dependency.status} · lag {dependency.lagMinutes} 分钟
                  </small>
                </article>
              ))}
            </div>
          ) : (
            <p className="trace-empty-copy">该任务没有服务端返回的依赖。</p>
          )}
        </section>

        <section className="trace-detail-card trace-deliverable-card">
          <header>
            <div>
              <p className="eyebrow">Delivery decisions</p>
              <h3>交付物与验收</h3>
            </div>
            <span>{root.deliverables.length}</span>
          </header>
          {root.deliverables.length > 0 ? (
            <div className="trace-deliverable-list">
              {root.deliverables.map((deliverable) => (
                <article key={deliverable.id}>
                  <header>
                    <div>
                      <strong>{deliverable.title}</strong>
                      <code>{deliverable.code}</code>
                    </div>
                    <span className={`trace-status ${deliverable.status.toLowerCase()}`}>
                      {deliverable.status}
                    </span>
                  </header>
                  <p>{deliverable.description}</p>
                  <small>
                    截止 {formatWorkbenchDate(deliverable.dueAt)}
                    {deliverable.submittedAt
                      ? ` · 提交 ${formatWorkbenchDate(deliverable.submittedAt)}`
                      : ''}
                  </small>
                  <div className="trace-acceptance-list">
                    {(acceptancesByDeliverable.get(deliverable.id) ?? []).map((acceptance) => (
                      <div key={acceptance.id}>
                        <span>{acceptance.decision}</span>
                        <strong>{acceptance.comment}</strong>
                        <small>
                          {acceptance.criteria.filter((criterion) => criterion.passed).length}/
                          {acceptance.criteria.length} 标准通过 · {acceptance.evidenceIds.length}{' '}
                          条证据
                        </small>
                      </div>
                    ))}
                    {(acceptancesByDeliverable.get(deliverable.id) ?? []).length === 0 ? (
                      <p>尚无验收决定。</p>
                    ) : null}
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <p className="trace-empty-copy">该任务尚无交付物。</p>
          )}
        </section>

        <section className="trace-detail-card trace-evidence-card">
          <header>
            <div>
              <p className="eyebrow">Evidence</p>
              <h3>证据与链接</h3>
            </div>
            <span>{root.evidence.length}</span>
          </header>
          {root.evidence.length > 0 ? (
            <div className="trace-evidence-list">
              {root.evidence.map((evidence) => {
                const links = root.evidenceLinks.filter((link) => link.evidenceId === evidence.id);
                return (
                  <article key={evidence.id}>
                    <header>
                      <div>
                        <strong>{evidence.summary}</strong>
                        <code>{evidence.code}</code>
                      </div>
                      <span>{evidence.trustLevel}</span>
                    </header>
                    <small>
                      {evidence.sourceSystem} / {evidence.sourceRecordId} · 置信度{' '}
                      {Math.round(evidence.confidence * 100)}%
                    </small>
                    <div>
                      {links.map((link) => (
                        <span key={link.id}>
                          {link.type} {link.targetType} v{link.targetVersion}
                        </span>
                      ))}
                    </div>
                  </article>
                );
              })}
            </div>
          ) : (
            <p className="trace-empty-copy">该任务链上暂无关联证据。</p>
          )}
        </section>
      </div>
    </div>
  );
}

function ContextCard({
  mark,
  label,
  title,
  value,
}: {
  mark: string;
  label: string;
  title: string;
  value: string;
}): React.JSX.Element {
  return (
    <article>
      <span aria-hidden="true">{mark}</span>
      <div>
        <p>{label}</p>
        <strong>{title}</strong>
        <small>{value}</small>
      </div>
    </article>
  );
}

function WorkbenchState({
  title,
  description,
  busy = false,
}: {
  title: string;
  description: string;
  busy?: boolean;
}): React.JSX.Element {
  return (
    <div className="workbench-state" role={busy ? 'status' : undefined} aria-busy={busy}>
      <span aria-hidden="true">目</span>
      <h1>{title}</h1>
      <p>{description}</p>
    </div>
  );
}

function TraceState({
  title,
  description,
  error = false,
  action,
}: {
  title: string;
  description: string;
  error?: boolean;
  action?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className={`trace-state ${error ? 'error' : ''}`} role={error ? 'alert' : 'status'}>
      <span aria-hidden="true">{error ? '!' : '链'}</span>
      <div>
        <strong>{title}</strong>
        <p>{description}</p>
      </div>
      {action}
    </div>
  );
}

function formatDue(value: string): string {
  const due = Date.parse(value);
  if (Number.isNaN(due)) return '截止时间由服务端提供';
  const days = Math.ceil((due - Date.now()) / 86_400_000);
  if (days < 0) return `已逾期 ${Math.abs(days)} 天`;
  if (days === 0) return '今天截止';
  return `还有 ${days} 天`;
}

function readableError(error: unknown): string {
  return error instanceof Error ? error.message : '请稍后重试。';
}
