import {
  createAcceptanceRequestSchema,
  createDeliverableRequestSchema,
  createEvidenceLinkRequestSchema,
  createObjectiveRelationRequestSchema,
  createTaskDependencyRequestSchema,
  transitionAcceptanceRequestSchema,
  transitionDeliverableRequestSchema,
  transitionEvidenceLinkRequestSchema,
  transitionObjectiveRelationRequestSchema,
  transitionTaskDependencyRequestSchema,
  updateAcceptanceRequestSchema,
  updateDeliverableRequestSchema,
  updateEvidenceLinkRequestSchema,
  updateObjectiveRelationRequestSchema,
  updateTaskDependencyRequestSchema,
  type Acceptance,
  type CreateAcceptanceRequest,
  type CreateDeliverableRequest,
  type CreateEvidenceLinkRequest,
  type CreateObjectiveRelationRequest,
  type CreateTaskDependencyRequest,
  type Deliverable,
  type Evidence,
  type EvidenceLink,
  type Objective,
  type ObjectiveRelation,
  type Task,
  type TaskDependency,
  type TransitionAcceptanceRequest,
  type TransitionDeliverableRequest,
  type TransitionEvidenceLinkRequest,
  type TransitionObjectiveRelationRequest,
  type TransitionTaskDependencyRequest,
  type UpdateAcceptanceRequest,
  type UpdateDeliverableRequest,
  type UpdateEvidenceLinkRequest,
  type UpdateObjectiveRelationRequest,
  type UpdateTaskDependencyRequest,
} from '@enterprise/contracts';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { ZodType } from 'zod';

import { messageFromError } from '@/api/client';
import { EmptyState, ErrorState, LoadingPanel, Notice, StatusPill } from '@/components/ui';

import {
  createDeliverableAcceptance,
  createEvidenceLink,
  createObjectiveRelation,
  createTaskDeliverable,
  createTaskDependency,
  listDeliverableAcceptances,
  listEvidenceLinks,
  listObjectiveRelations,
  listTaskDeliverables,
  listTaskDependencies,
  transitionDeliverableAcceptance,
  transitionEvidenceLink,
  transitionObjectiveRelation,
  transitionTaskDeliverable,
  transitionTaskDependency,
  updateDeliverableAcceptance,
  updateEvidenceLink,
  updateObjectiveRelation,
  updateTaskDeliverable,
  updateTaskDependency,
} from './api';
import {
  formatDate,
  formatEffectivePeriod,
  semanticStatusLabel,
  shortId,
} from './business-semantics-view';
import { ContractJsonEditor, type ContractJsonEditorConfig } from './ContractJsonEditor';

export function ObjectiveRelationsPanel({ objective }: { objective: Objective }): ReactNode {
  const [relations, setRelations] = useState<ObjectiveRelation[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);
  const [editor, setEditor] = useState<ContractJsonEditorConfig | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void listObjectiveRelations(controller.signal)
      .then(setRelations)
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) setError(messageFromError(caught));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [reloadKey]);

  const visible = useMemo(
    () =>
      (relations ?? []).filter(
        (relation) =>
          relation.sourceObjectiveId === objective.id ||
          relation.targetObjectiveId === objective.id,
      ),
    [objective.id, relations],
  );
  const reload = (): void => setReloadKey((value) => value + 1);
  const saved = (): void => {
    setEditor(null);
    setNotice('目标关系操作已由服务端确认。');
    reload();
  };

  return (
    <section className="card semantic-child-panel">
      <header className="semantic-child-heading">
        <div>
          <span className="eyebrow">OBJECTIVE GRAPH</span>
          <h3>目标关系</h3>
          <p>父子、因果和支撑关系必须无环并满足方向规则。</p>
        </div>
        <button
          className="button compact primary"
          type="button"
          aria-haspopup="dialog"
          onClick={() => setEditor(createObjectiveRelationConfig(objective))}
        >
          新建关系
        </button>
      </header>
      {notice ? (
        <Notice tone="success" onClose={() => setNotice(null)}>
          {notice}
        </Notice>
      ) : null}
      {loading && relations === null ? <LoadingPanel label="正在读取目标关系…" /> : null}
      {error && relations === null ? <ErrorState message={error} onRetry={reload} /> : null}
      {error && relations !== null ? <Notice tone="error">{error}</Notice> : null}
      {relations !== null && visible.length === 0 ? (
        <EmptyState title="暂无关联" description="该目标尚未出现在服务端返回的目标关系中。" />
      ) : null}
      {visible.length > 0 ? (
        <div className="semantic-relation-list">
          {visible.map((relation) => (
            <article key={relation.id}>
              <span className={`semantic-link-direction ${relation.status.toLowerCase()}`}>
                {relation.sourceObjectiveId === objective.id ? '发出' : '指向'}
              </span>
              <div>
                <strong>{relation.type}</strong>
                <code>
                  {shortId(relation.sourceObjectiveId)} → {shortId(relation.targetObjectiveId)}
                </code>
                <small>
                  权重 {relation.weight} · 滞后 {relation.lagDays} 天 ·{' '}
                  {semanticStatusLabel(relation.status)}
                </small>
              </div>
              <div>
                <button
                  className="button compact secondary"
                  type="button"
                  onClick={() => setEditor(updateObjectiveRelationConfig(relation))}
                >
                  编辑
                </button>
                {relation.status === 'ACTIVE' ? (
                  <button
                    className="button compact danger-ghost"
                    type="button"
                    onClick={() => setEditor(retireObjectiveRelationConfig(relation))}
                  >
                    停用
                  </button>
                ) : null}
              </div>
            </article>
          ))}
        </div>
      ) : null}
      {editor ? (
        <ContractJsonEditor config={editor} onClose={() => setEditor(null)} onSaved={saved} />
      ) : null}
    </section>
  );
}

export function TaskGovernancePanel({
  task,
  onTaskChanged,
}: {
  task: Task;
  onTaskChanged: () => void;
}): ReactNode {
  const [dependencies, setDependencies] = useState<TaskDependency[] | null>(null);
  const [deliverables, setDeliverables] = useState<Deliverable[] | null>(null);
  const [selectedDeliverableId, setSelectedDeliverableId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);
  const [editor, setEditor] = useState<ContractJsonEditorConfig | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void Promise.all([
      listTaskDependencies(controller.signal),
      listTaskDeliverables(task.id, controller.signal),
    ])
      .then(([loadedDependencies, loadedDeliverables]) => {
        setDependencies(loadedDependencies);
        setDeliverables(loadedDeliverables);
        setSelectedDeliverableId((current) =>
          current && loadedDeliverables.some((item) => item.id === current)
            ? current
            : (loadedDeliverables[0]?.id ?? null),
        );
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) setError(messageFromError(caught));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [reloadKey, task.id]);

  const visibleDependencies = (dependencies ?? []).filter(
    (dependency) =>
      dependency.predecessorTaskId === task.id || dependency.successorTaskId === task.id,
  );
  const selectedDeliverable =
    deliverables?.find((item) => item.id === selectedDeliverableId) ?? null;
  const reload = (): void => setReloadKey((value) => value + 1);
  const saved = (): void => {
    setEditor(null);
    setNotice('任务治理记录已由服务端确认。');
    reload();
    onTaskChanged();
  };

  return (
    <section className="card semantic-child-panel task-governance-panel">
      <header className="semantic-child-heading">
        <div>
          <span className="eyebrow">DELIVERY GOVERNANCE</span>
          <h3>依赖、交付物与验收</h3>
          <p>交付决定与 Evidence 身份分离，状态只在服务端命令成功后变化。</p>
        </div>
        <div>
          <button
            className="button compact secondary"
            type="button"
            aria-haspopup="dialog"
            onClick={() => setEditor(createTaskDependencyConfig(task))}
          >
            新建依赖
          </button>
          <button
            className="button compact primary"
            type="button"
            aria-haspopup="dialog"
            onClick={() => setEditor(createDeliverableConfig(task))}
          >
            新建交付物
          </button>
        </div>
      </header>
      {notice ? (
        <Notice tone="success" onClose={() => setNotice(null)}>
          {notice}
        </Notice>
      ) : null}
      {loading && dependencies === null && deliverables === null ? (
        <LoadingPanel label="正在读取任务治理记录…" />
      ) : null}
      {error && dependencies === null && deliverables === null ? (
        <ErrorState message={error} onRetry={reload} />
      ) : null}
      {error && (dependencies !== null || deliverables !== null) ? (
        <Notice tone="error">{error}</Notice>
      ) : null}

      {dependencies !== null ? (
        <section className="semantic-subsection">
          <header>
            <strong>任务依赖</strong>
            <span>{visibleDependencies.length}</span>
          </header>
          {visibleDependencies.length === 0 ? (
            <p className="semantic-subsection-empty">当前任务没有前置或后继依赖。</p>
          ) : (
            <div className="semantic-relation-list compact">
              {visibleDependencies.map((dependency) => (
                <article key={dependency.id}>
                  <span className={`semantic-link-direction ${dependency.status.toLowerCase()}`}>
                    {dependency.predecessorTaskId === task.id ? '前置' : '后继'}
                  </span>
                  <div>
                    <strong>{dependency.type}</strong>
                    <code>
                      {shortId(dependency.predecessorTaskId)} →{' '}
                      {shortId(dependency.successorTaskId)}
                    </code>
                    <small>
                      lag {dependency.lagMinutes} 分钟 · {semanticStatusLabel(dependency.status)}
                    </small>
                  </div>
                  <div>
                    <button
                      className="button compact secondary"
                      type="button"
                      onClick={() => setEditor(updateTaskDependencyConfig(dependency))}
                    >
                      编辑
                    </button>
                    {dependency.status === 'ACTIVE' ? (
                      <button
                        className="button compact danger-ghost"
                        type="button"
                        onClick={() => setEditor(removeTaskDependencyConfig(dependency))}
                      >
                        移除
                      </button>
                    ) : null}
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      ) : null}

      {deliverables !== null ? (
        <section className="semantic-subsection">
          <header>
            <strong>交付物</strong>
            <span>{deliverables.length}</span>
          </header>
          {deliverables.length === 0 ? (
            <EmptyState
              title="还没有交付物"
              description="已交付、已接受或已拒绝任务必须具有可追溯交付物。"
            />
          ) : (
            <div className="deliverable-layout">
              <div className="deliverable-list" aria-label="交付物列表">
                {deliverables.map((deliverable) => (
                  <button
                    key={deliverable.id}
                    type="button"
                    className={deliverable.id === selectedDeliverableId ? 'selected' : ''}
                    aria-current={deliverable.id === selectedDeliverableId ? 'true' : undefined}
                    onClick={() => setSelectedDeliverableId(deliverable.id)}
                  >
                    <span>交</span>
                    <span>
                      <strong>{deliverable.title}</strong>
                      <code>{deliverable.code}</code>
                      <small>
                        {semanticStatusLabel(deliverable.status)} · 截止{' '}
                        {formatDate(deliverable.dueAt)}
                      </small>
                    </span>
                  </button>
                ))}
              </div>
              {selectedDeliverable ? (
                <DeliverableDetail
                  task={task}
                  deliverable={selectedDeliverable}
                  onEdit={() => setEditor(updateDeliverableConfig(task, selectedDeliverable))}
                  onTransition={() => {
                    const config = transitionDeliverableConfig(task, selectedDeliverable);
                    if (config) setEditor(config);
                  }}
                  onSaved={saved}
                />
              ) : null}
            </div>
          )}
        </section>
      ) : null}

      {editor ? (
        <ContractJsonEditor config={editor} onClose={() => setEditor(null)} onSaved={saved} />
      ) : null}
    </section>
  );
}

function DeliverableDetail({
  task,
  deliverable,
  onEdit,
  onTransition,
  onSaved,
}: {
  task: Task;
  deliverable: Deliverable;
  onEdit: () => void;
  onTransition: () => void;
  onSaved: () => void;
}): ReactNode {
  const [acceptances, setAcceptances] = useState<Acceptance[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);
  const [editor, setEditor] = useState<ContractJsonEditorConfig | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void listDeliverableAcceptances(task.id, deliverable.id, controller.signal)
      .then(setAcceptances)
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) setError(messageFromError(caught));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [deliverable.id, reloadKey, task.id]);

  const saved = (): void => {
    setEditor(null);
    setReloadKey((value) => value + 1);
    onSaved();
  };
  const transition = transitionDeliverableConfig(task, deliverable);

  return (
    <article className="deliverable-detail">
      <header>
        <div>
          <span className="eyebrow">{deliverable.code}</span>
          <h4>{deliverable.title}</h4>
          <p>{deliverable.description}</p>
        </div>
        <StatusPill value={deliverable.status} label={semanticStatusLabel(deliverable.status)} />
      </header>
      <dl>
        <div>
          <dt>有效期</dt>
          <dd>{formatEffectivePeriod(deliverable)}</dd>
        </div>
        <div>
          <dt>提交时间</dt>
          <dd>{deliverable.submittedAt ? formatDate(deliverable.submittedAt) : '尚未提交'}</dd>
        </div>
        <div>
          <dt>Artifact</dt>
          <dd>{deliverable.artifactUri ?? '尚未提交'}</dd>
        </div>
      </dl>
      <div className="deliverable-actions">
        <button className="button compact secondary" type="button" onClick={onEdit}>
          编辑交付物
        </button>
        {transition ? (
          <button className="button compact primary" type="button" onClick={onTransition}>
            {deliverable.status === 'DRAFT' ? '提交交付物' : '撤回交付物'}
          </button>
        ) : null}
        <button
          className="button compact secondary"
          type="button"
          aria-haspopup="dialog"
          onClick={() => setEditor(createAcceptanceConfig(task, deliverable))}
        >
          新建验收
        </button>
      </div>
      {deliverable.status === 'DRAFT' ? (
        <p className="semantic-subsection-empty">
          交付物请在员工任务工作台通过上传文件、选择现有文档或填写资料链接提交，系统会生成校验信息并关联可信证据。
        </p>
      ) : null}
      <section className="acceptance-section">
        <header>
          <strong>验收决定</strong>
          <span>{acceptances?.length ?? 0}</span>
        </header>
        {loading && acceptances === null ? <LoadingPanel label="正在读取验收记录…" /> : null}
        {error && acceptances === null ? (
          <ErrorState message={error} onRetry={() => setReloadKey((value) => value + 1)} />
        ) : null}
        {acceptances?.length === 0 ? (
          <p className="semantic-subsection-empty">还没有服务端验收记录。</p>
        ) : null}
        {acceptances && acceptances.length > 0 ? (
          <div className="acceptance-list">
            {acceptances.map((acceptance) => (
              <article key={acceptance.id}>
                <header>
                  <strong>{acceptance.decision}</strong>
                  <StatusPill
                    value={acceptance.status}
                    label={semanticStatusLabel(acceptance.status)}
                  />
                </header>
                <p>{acceptance.comment}</p>
                <small>
                  {acceptance.criteria.filter((criterion) => criterion.passed).length}/
                  {acceptance.criteria.length} 项通过 · {acceptance.evidenceIds.length} 个证据
                </small>
                <footer>
                  <button
                    className="button compact secondary"
                    type="button"
                    onClick={() => setEditor(updateAcceptanceConfig(task, deliverable, acceptance))}
                  >
                    编辑
                  </button>
                  {acceptance.status === 'ACTIVE' ? (
                    <button
                      className="button compact danger-ghost"
                      type="button"
                      onClick={() => setEditor(voidAcceptanceConfig(task, deliverable, acceptance))}
                    >
                      作废
                    </button>
                  ) : null}
                </footer>
              </article>
            ))}
          </div>
        ) : null}
      </section>
      {editor ? (
        <ContractJsonEditor config={editor} onClose={() => setEditor(null)} onSaved={saved} />
      ) : null}
    </article>
  );
}

export function EvidenceLinksPanel({ evidence }: { evidence: Evidence }): ReactNode {
  const [links, setLinks] = useState<EvidenceLink[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);
  const [editor, setEditor] = useState<ContractJsonEditorConfig | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void listEvidenceLinks(evidence.id, controller.signal)
      .then(setLinks)
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) setError(messageFromError(caught));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [evidence.id, reloadKey]);

  const reload = (): void => setReloadKey((value) => value + 1);
  const saved = (): void => {
    setEditor(null);
    setNotice('Evidence Link 操作已由服务端确认。');
    reload();
  };

  return (
    <section className="card semantic-child-panel">
      <header className="semantic-child-heading">
        <div>
          <span className="eyebrow">EVIDENCE GRAPH</span>
          <h3>Evidence Link</h3>
          <p>证据必须通过带版本的链接支持、反驳、限定或派生目标。</p>
        </div>
        <button
          className="button compact primary"
          type="button"
          aria-haspopup="dialog"
          onClick={() => setEditor(createEvidenceLinkConfig(evidence))}
        >
          新建证据链接
        </button>
      </header>
      {notice ? (
        <Notice tone="success" onClose={() => setNotice(null)}>
          {notice}
        </Notice>
      ) : null}
      {loading && links === null ? <LoadingPanel label="正在读取证据链接…" /> : null}
      {error && links === null ? <ErrorState message={error} onRetry={reload} /> : null}
      {error && links !== null ? <Notice tone="error">{error}</Notice> : null}
      {links?.length === 0 ? (
        <EmptyState
          title="证据尚未连接业务对象"
          description="完整 trace 要求每条 Evidence 至少存在一个有效 Evidence Link。"
        />
      ) : null}
      {links && links.length > 0 ? (
        <div className="semantic-relation-list">
          {links.map((link) => (
            <article key={link.id}>
              <span className={`semantic-link-direction ${link.status.toLowerCase()}`}>
                {link.type}
              </span>
              <div>
                <strong>{link.targetType}</strong>
                <code>
                  {shortId(link.targetId)} · v{link.targetVersion}
                </code>
                <small>
                  相关度 {Math.round(link.relevance * 100)}% · {semanticStatusLabel(link.status)}
                </small>
                <p>{link.statement}</p>
              </div>
              <div>
                <button
                  className="button compact secondary"
                  type="button"
                  onClick={() => setEditor(updateEvidenceLinkConfig(evidence, link))}
                >
                  编辑
                </button>
                {link.status === 'ACTIVE' ? (
                  <button
                    className="button compact danger-ghost"
                    type="button"
                    onClick={() => setEditor(removeEvidenceLinkConfig(evidence, link))}
                  >
                    移除
                  </button>
                ) : null}
              </div>
            </article>
          ))}
        </div>
      ) : null}
      {editor ? (
        <ContractJsonEditor config={editor} onClose={() => setEditor(null)} onSaved={saved} />
      ) : null}
    </section>
  );
}

function createObjectiveRelationConfig(objective: Objective): ContractJsonEditorConfig {
  return editor<CreateObjectiveRelationRequest>({
    title: '新建目标关系',
    description: 'CAUSES 必须从 LEADING 目标指向 LAGGING 目标；PARENT_CHILD 的 lagDays 必须为 0。',
    initialValue: {
      code: 'OBJECTIVE.RELATION.NEW',
      sourceObjectiveId: objective.id,
      targetObjectiveId: '<target-objective-id>',
      type: 'SUPPORTS',
      weight: 1,
      lagDays: 0,
      owner: objective.owner,
      effectiveFrom: objective.effectiveFrom,
      effectiveTo: objective.effectiveTo,
      permissionLabels: objective.permissionLabels,
    },
    schema: createObjectiveRelationRequestSchema,
    submitLabel: '创建目标关系',
    submit: createObjectiveRelation,
  });
}

function updateObjectiveRelationConfig(relation: ObjectiveRelation): ContractJsonEditorConfig {
  return editor<UpdateObjectiveRelationRequest>({
    title: `编辑 ${relation.code}`,
    description: '端点、自环、方向和有效期会再次由服务端校验。',
    initialValue: {
      expectedRevision: relation.revision,
      code: relation.code,
      sourceObjectiveId: relation.sourceObjectiveId,
      targetObjectiveId: relation.targetObjectiveId,
      type: relation.type,
      weight: relation.weight,
      lagDays: relation.lagDays,
      owner: relation.owner,
      effectiveFrom: relation.effectiveFrom,
      effectiveTo: relation.effectiveTo,
      permissionLabels: relation.permissionLabels,
    },
    schema: updateObjectiveRelationRequestSchema,
    submitLabel: '保存目标关系',
    submit: (input) => updateObjectiveRelation(relation.id, input),
  });
}

function retireObjectiveRelationConfig(relation: ObjectiveRelation): ContractJsonEditorConfig {
  return editor<TransitionObjectiveRelationRequest>({
    title: `停用 ${relation.code}`,
    description: '关系不会物理删除，历史 trace 仍保留。',
    initialValue: {
      expectedRevision: relation.revision,
      action: 'RETIRE',
      reason: '',
      effectiveAt: new Date().toISOString(),
    },
    schema: transitionObjectiveRelationRequestSchema,
    submitLabel: '停用目标关系',
    submit: (input) => transitionObjectiveRelation(relation.id, input),
  });
}

function createTaskDependencyConfig(task: Task): ContractJsonEditorConfig {
  return editor<CreateTaskDependencyRequest>({
    title: '新建任务依赖',
    description: '活动依赖必须无环；前置与后继任务不能相同。',
    initialValue: {
      code: 'TASK.DEPENDENCY.NEW',
      predecessorTaskId: '<predecessor-task-id>',
      successorTaskId: task.id,
      type: 'FINISH_TO_START',
      lagMinutes: 0,
      owner: task.owner,
      effectiveFrom: task.effectiveFrom,
      effectiveTo: task.effectiveTo,
      permissionLabels: task.permissionLabels,
    },
    schema: createTaskDependencyRequestSchema,
    submitLabel: '创建任务依赖',
    submit: createTaskDependency,
  });
}

function updateTaskDependencyConfig(dependency: TaskDependency): ContractJsonEditorConfig {
  return editor<UpdateTaskDependencyRequest>({
    title: `编辑 ${dependency.code}`,
    description: '依赖图循环和重复端点由服务端原子检查。',
    initialValue: {
      expectedRevision: dependency.revision,
      code: dependency.code,
      predecessorTaskId: dependency.predecessorTaskId,
      successorTaskId: dependency.successorTaskId,
      type: dependency.type,
      lagMinutes: dependency.lagMinutes,
      owner: dependency.owner,
      effectiveFrom: dependency.effectiveFrom,
      effectiveTo: dependency.effectiveTo,
      permissionLabels: dependency.permissionLabels,
    },
    schema: updateTaskDependencyRequestSchema,
    submitLabel: '保存任务依赖',
    submit: (input) => updateTaskDependency(dependency.id, input),
  });
}

function removeTaskDependencyConfig(dependency: TaskDependency): ContractJsonEditorConfig {
  return editor<TransitionTaskDependencyRequest>({
    title: `移除 ${dependency.code}`,
    description: '依赖将进入 REMOVED 状态，历史记录不会被删除。',
    initialValue: {
      expectedRevision: dependency.revision,
      action: 'REMOVE',
      reason: '',
      effectiveAt: new Date().toISOString(),
    },
    schema: transitionTaskDependencyRequestSchema,
    submitLabel: '移除任务依赖',
    submit: (input) => transitionTaskDependency(dependency.id, input),
  });
}

function createDeliverableConfig(task: Task): ContractJsonEditorConfig {
  return editor<CreateDeliverableRequest>({
    title: '新建交付物',
    description: '交付物有效期和截止时间必须落在任务有效期内。',
    initialValue: {
      code: 'DELIVERABLE.NEW',
      taskId: task.id,
      title: '',
      description: '',
      owner: task.owner,
      effectiveFrom: task.effectiveFrom,
      effectiveTo: task.effectiveTo,
      dueAt: task.dueAt,
      permissionLabels: task.permissionLabels,
    },
    schema: createDeliverableRequestSchema,
    submitLabel: '创建 Deliverable',
    submit: (input) => createTaskDeliverable(task.id, input),
  });
}

function updateDeliverableConfig(task: Task, deliverable: Deliverable): ContractJsonEditorConfig {
  return editor<UpdateDeliverableRequest>({
    title: `编辑 ${deliverable.code}`,
    description: '提交后的 artifact 身份不通过普通更新请求修改。',
    initialValue: {
      expectedRevision: deliverable.revision,
      code: deliverable.code,
      title: deliverable.title,
      description: deliverable.description,
      owner: deliverable.owner,
      effectiveFrom: deliverable.effectiveFrom,
      effectiveTo: deliverable.effectiveTo,
      dueAt: deliverable.dueAt,
      permissionLabels: deliverable.permissionLabels,
    },
    schema: updateDeliverableRequestSchema,
    submitLabel: '保存 Deliverable',
    submit: (input) => updateTaskDeliverable(task.id, deliverable.id, input),
  });
}

function transitionDeliverableConfig(
  task: Task,
  deliverable: Deliverable,
): ContractJsonEditorConfig | null {
  if (deliverable.status === 'DRAFT') {
    return null;
  }
  if (deliverable.status === 'SUBMITTED') {
    return editor<TransitionDeliverableRequest>({
      title: `撤回 ${deliverable.code}`,
      description: '撤回保留已经登记的审计身份。',
      initialValue: {
        expectedRevision: deliverable.revision,
        action: 'WITHDRAW',
        reason: '',
        effectiveAt: new Date().toISOString(),
      },
      schema: transitionDeliverableRequestSchema,
      submitLabel: '撤回 Deliverable',
      submit: (input) => transitionTaskDeliverable(task.id, deliverable.id, input),
    });
  }
  return null;
}

function createAcceptanceConfig(task: Task, deliverable: Deliverable): ContractJsonEditorConfig {
  return editor<CreateAcceptanceRequest>({
    title: '新建验收决定',
    description: '必选验收项失败时不能给出 ACCEPTED；标准权重必须合计为 1。',
    initialValue: {
      code: 'ACCEPTANCE.NEW',
      deliverableId: deliverable.id,
      decision: 'ACCEPTED',
      decidedBy: task.owner,
      decidedAt: new Date().toISOString(),
      criteria: [
        {
          code: 'CRITERION.MAIN',
          description: '',
          mandatory: true,
          passed: true,
          weight: 1,
          comment: null,
        },
      ],
      evidenceIds: ['<evidence-id>'],
      comment: '',
      owner: task.owner,
      permissionLabels: task.permissionLabels,
    },
    schema: createAcceptanceRequestSchema,
    submitLabel: '创建 Acceptance',
    submit: (input) => createDeliverableAcceptance(task.id, deliverable.id, input),
  });
}

function updateAcceptanceConfig(
  task: Task,
  deliverable: Deliverable,
  acceptance: Acceptance,
): ContractJsonEditorConfig {
  return editor<UpdateAcceptanceRequest>({
    title: `编辑 ${acceptance.code}`,
    description: '决定、标准结果和证据引用必须保持一致。',
    initialValue: {
      expectedRevision: acceptance.revision,
      decision: acceptance.decision,
      decidedBy: acceptance.decidedBy,
      decidedAt: acceptance.decidedAt,
      criteria: acceptance.criteria,
      evidenceIds: acceptance.evidenceIds,
      comment: acceptance.comment,
      owner: acceptance.owner,
      permissionLabels: acceptance.permissionLabels,
    },
    schema: updateAcceptanceRequestSchema,
    submitLabel: '保存 Acceptance',
    submit: (input) => updateDeliverableAcceptance(task.id, deliverable.id, acceptance.id, input),
  });
}

function voidAcceptanceConfig(
  task: Task,
  deliverable: Deliverable,
  acceptance: Acceptance,
): ContractJsonEditorConfig {
  return editor<TransitionAcceptanceRequest>({
    title: `作废 ${acceptance.code}`,
    description: '验收决定不会物理删除，trace 中仍可追溯。',
    initialValue: {
      expectedRevision: acceptance.revision,
      action: 'VOID',
      reason: '',
      effectiveAt: new Date().toISOString(),
    },
    schema: transitionAcceptanceRequestSchema,
    submitLabel: '作废 Acceptance',
    submit: (input) =>
      transitionDeliverableAcceptance(task.id, deliverable.id, acceptance.id, input),
  });
}

function createEvidenceLinkConfig(evidence: Evidence): ContractJsonEditorConfig {
  return editor<CreateEvidenceLinkRequest>({
    title: '新建 Evidence Link',
    description: '目标 ID 与 targetVersion 必须同时匹配真实业务对象版本。',
    initialValue: {
      code: 'EVIDENCE.LINK.NEW',
      evidenceId: evidence.id,
      targetType: 'TASK',
      targetId: '<target-id>',
      targetVersion: 1,
      type: 'SUPPORTS',
      relevance: 1,
      statement: '',
      owner: evidence.owner,
      effectiveFrom: evidence.effectiveFrom,
      effectiveTo: evidence.effectiveTo,
      permissionLabels: evidence.permissionLabels,
    },
    schema: createEvidenceLinkRequestSchema,
    submitLabel: '创建 Evidence Link',
    submit: (input) => createEvidenceLink(evidence.id, input),
  });
}

function updateEvidenceLinkConfig(
  evidence: Evidence,
  link: EvidenceLink,
): ContractJsonEditorConfig {
  return editor<UpdateEvidenceLinkRequest>({
    title: `编辑 ${link.code}`,
    description: '目标身份不可通过普通更新替换；需要时请创建新的链接。',
    initialValue: {
      expectedRevision: link.revision,
      type: link.type,
      relevance: link.relevance,
      statement: link.statement,
      owner: link.owner,
      effectiveFrom: link.effectiveFrom,
      effectiveTo: link.effectiveTo,
      permissionLabels: link.permissionLabels,
    },
    schema: updateEvidenceLinkRequestSchema,
    submitLabel: '保存 Evidence Link',
    submit: (input) => updateEvidenceLink(evidence.id, link.id, input),
  });
}

function removeEvidenceLinkConfig(
  evidence: Evidence,
  link: EvidenceLink,
): ContractJsonEditorConfig {
  return editor<TransitionEvidenceLinkRequest>({
    title: `移除 ${link.code}`,
    description: '移除链接后，如果证据没有其他活动链接，完整 trace 校验会失败。',
    initialValue: {
      expectedRevision: link.revision,
      action: 'REMOVE',
      reason: '',
      effectiveAt: new Date().toISOString(),
    },
    schema: transitionEvidenceLinkRequestSchema,
    submitLabel: '移除 Evidence Link',
    submit: (input) => transitionEvidenceLink(evidence.id, link.id, input),
  });
}

function editor<T>(input: {
  title: string;
  description: string;
  initialValue: unknown;
  schema: ZodType<T>;
  submitLabel: string;
  submit: (value: T) => Promise<unknown>;
}): ContractJsonEditorConfig {
  return {
    title: input.title,
    description: input.description,
    initialValue: input.initialValue,
    submitLabel: input.submitLabel,
    parse: (value) => input.schema.parse(value),
    submit: (value) => input.submit(value as T),
  };
}
