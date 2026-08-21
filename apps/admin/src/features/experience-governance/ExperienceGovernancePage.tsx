import type {
  AdminOrganizationResponse,
  CreateExperienceCandidateRequest,
  Deliverable,
  Evidence,
  ExperienceCandidate,
  ExperienceKnowledgeProjection,
  ExperienceTransitionRequest,
  KnowledgeBase,
  PrepareExperienceKnowledgeProjectionRequest,
  RoleBlueprint,
  Task,
} from '@enterprise/contracts';
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';

import {
  createExperienceCandidate,
  getOrganization,
  getExperienceKnowledgeProjection,
  listKnowledgeBases,
  listRoleBlueprints,
  listExperienceCandidates,
  prepareExperienceKnowledgeProjection,
  transitionExperienceCandidate,
} from '@/api/admin-api';
import {
  EntityMultiPicker,
  EntitySelect,
  TagInput,
  type EntityOption,
} from '@/components/EntityPicker';
import {
  EmptyState,
  ErrorState,
  FieldError,
  Modal,
  Notice,
  Spinner,
  StatusPill,
} from '@/components/ui';
import { listEvidence, listTaskDeliverables, listTasks } from '@/features/business-semantics/api';

import {
  EXPERIENCE_STAGES,
  availableExperienceActions,
  experienceActionLabel,
  experienceErrorMessage,
  experienceProgress,
  experienceStatusLabel,
  formatExperienceDate,
  transitionPayloadTemplate,
  type ExperienceAction,
} from './experience-governance-view';
import './experience-governance.css';

export function ExperienceGovernancePage(): ReactNode {
  const [items, setItems] = useState<readonly ExperienceCandidate[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);
  const [transitionAction, setTransitionAction] = useState<ExperienceAction | null>(null);
  const [projectionOpen, setProjectionOpen] = useState(false);
  const [projection, setProjection] = useState<ExperienceKnowledgeProjection | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setItems(null);
    setError(null);
    void listExperienceCandidates({ limit: 100 }, controller.signal)
      .then((response) => {
        setItems(response.items);
        setSelectedId((current) =>
          current && response.items.some((item) => item.id === current)
            ? current
            : (response.items[0]?.id ?? null),
        );
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) setError(caught);
      });
    return () => controller.abort();
  }, [reloadKey]);

  const selected = items?.find((item) => item.id === selectedId) ?? null;
  const reload = (): void => setReloadKey((current) => current + 1);

  useEffect(() => {
    if (selectedId === null) {
      setProjection(null);
      return;
    }
    const controller = new AbortController();
    setProjection(null);
    void getExperienceKnowledgeProjection(selectedId, controller.signal)
      .then(setProjection)
      .catch(() => {
        if (!controller.signal.aborted) setProjection(null);
      });
    return () => controller.abort();
  }, [selectedId, reloadKey]);

  return (
    <section className="page-section experience-governance-page">
      <header className="page-header experience-header">
        <div>
          <span className="eyebrow">EXPERIENCE GOVERNANCE</span>
          <h1>经验治理中心</h1>
          <p>
            管理从业务成果中提取的候选经验。任何内容都必须完成脱敏、结构化、独立审核和验证，
            才能发布到正式知识域。
          </p>
        </div>
        <div className="experience-header-actions">
          <button className="button secondary" type="button" onClick={reload}>
            刷新状态
          </button>
          <button className="button primary" type="button" onClick={() => setCreateOpen(true)}>
            新建经验候选
          </button>
        </div>
      </header>

      <div className="experience-guardrail" role="note">
        <strong>发布门禁</strong>
        <span>未经专家审核或验证失败的经验不会进入生产知识库；员工私有记忆不会作为经验原料。</span>
      </div>

      {notice ? (
        <Notice tone="success" onClose={() => setNotice(null)}>
          {notice}
        </Notice>
      ) : null}

      {items === null ? (
        error ? (
          <ErrorState message={experienceErrorMessage(error)} onRetry={reload} />
        ) : (
          <div className="card experience-loading">
            <Spinner label="正在读取经验治理状态…" />
          </div>
        )
      ) : (
        <div className="experience-layout">
          <aside className="card experience-list" aria-label="经验候选列表">
            <header>
              <div>
                <span className="eyebrow">CANDIDATES</span>
                <h2>候选经验</h2>
              </div>
              <span className="experience-count">{items.length}</span>
            </header>
            {items.length === 0 ? (
              <EmptyState
                title="还没有经验候选"
                description="从已封存交付物、复盘和授权反馈中创建第一条候选经验。"
                action={
                  <button
                    className="button primary compact"
                    type="button"
                    onClick={() => setCreateOpen(true)}
                  >
                    新建候选
                  </button>
                }
              />
            ) : (
              <div className="experience-list-items">
                {items.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={item.id === selectedId ? 'selected' : ''}
                    aria-current={item.id === selectedId ? 'true' : undefined}
                    onClick={() => setSelectedId(item.id)}
                  >
                    <span className={`experience-list-mark status-${item.status.toLowerCase()}`}>
                      经
                    </span>
                    <span>
                      <strong>{item.title}</strong>
                      <small>
                        {experienceStatusLabel(item.status)} · r{item.revision}
                      </small>
                      <time>{formatExperienceDate(item.updatedAt)}</time>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </aside>

          {selected ? (
            <ExperienceDetail
              candidate={selected}
              projection={projection}
              onAction={setTransitionAction}
              onPrepareProjection={() => setProjectionOpen(true)}
            />
          ) : (
            <article className="card experience-detail">
              <EmptyState
                title="选择一条候选经验"
                description="查看其来源证据、治理进度、发布范围和运营效果。"
              />
            </article>
          )}
        </div>
      )}

      {createOpen ? (
        <CreateExperienceDialog
          onClose={() => setCreateOpen(false)}
          onSaved={(created) => {
            setCreateOpen(false);
            setSelectedId(created.id);
            setNotice('经验候选已登记，下一步必须完成脱敏。');
            reload();
          }}
        />
      ) : null}

      {selected && transitionAction ? (
        <ExperienceTransitionDialog
          candidate={selected}
          projection={projection}
          action={transitionAction}
          onClose={() => setTransitionAction(null)}
          onSaved={() => {
            setTransitionAction(null);
            setNotice('治理动作已由服务端确认并写入不可变审计链。');
            reload();
          }}
        />
      ) : null}

      {selected && projectionOpen ? (
        <PrepareExperienceProjectionDialog
          candidate={selected}
          onClose={() => setProjectionOpen(false)}
          onSaved={(prepared) => {
            setProjectionOpen(false);
            setProjection(prepared);
            setNotice(
              prepared.status === 'FAILED'
                ? `知识投影失败：${prepared.errorCode ?? 'UNKNOWN'}`
                : '知识版本已创建并进入解析、切片和向量索引流程。',
            );
          }}
        />
      ) : null}
    </section>
  );
}

function ExperienceDetail({
  candidate,
  projection,
  onAction,
  onPrepareProjection,
}: {
  candidate: ExperienceCandidate;
  projection: ExperienceKnowledgeProjection | null;
  onAction: (action: ExperienceAction) => void;
  onPrepareProjection: () => void;
}): ReactNode {
  const progress = experienceProgress(candidate);
  const actions = availableExperienceActions(candidate.status);
  return (
    <div className="experience-detail-stack">
      <article className="card experience-detail">
        <header>
          <div>
            <span className="eyebrow">EXPERIENCE · r{candidate.revision}</span>
            <h2>{candidate.title}</h2>
            <p>{candidate.candidateSummary}</p>
          </div>
          <StatusPill value={candidate.status} label={experienceStatusLabel(candidate.status)} />
        </header>

        <ol className="experience-progress" aria-label="经验治理进度">
          {EXPERIENCE_STAGES.map((stage, index) => (
            <li
              key={stage}
              className={
                candidate.status === 'REJECTED'
                  ? index < 3
                    ? 'complete'
                    : ''
                  : index < progress
                    ? 'complete'
                    : index === progress
                      ? 'current'
                      : ''
              }
            >
              <span>{index + 1}</span>
              <small>{experienceStatusLabel(stage)}</small>
            </li>
          ))}
        </ol>

        <dl className="experience-identity-grid">
          <div>
            <dt>来源任务</dt>
            <dd>{candidate.sourceTaskId}</dd>
          </div>
          <div>
            <dt>贡献者</dt>
            <dd>{candidate.contributorUserId}</dd>
          </div>
          <div>
            <dt>角色任命</dt>
            <dd>{candidate.contributorRoleAssignmentId}</dd>
          </div>
          <div>
            <dt>敏感级别</dt>
            <dd>{candidate.sensitivity}</dd>
          </div>
          <div>
            <dt>来源证据</dt>
            <dd>{candidate.sourceEvidenceIds.length} 条</dd>
          </div>
          <div>
            <dt>交付物</dt>
            <dd>{candidate.sourceDeliverableIds.length} 项</dd>
          </div>
        </dl>

        <section className="experience-stage-evidence">
          <GovernanceEvidence
            title="脱敏"
            ready={candidate.sanitization !== null}
            detail={
              candidate.sanitization
                ? `PII、密钥和客户标识已移除；${candidate.sanitization.findings.length} 项发现`
                : '等待受控脱敏与去标识'
            }
          />
          <GovernanceEvidence
            title="专家审核"
            ready={candidate.review?.decision === 'APPROVED'}
            detail={
              candidate.review
                ? `${candidate.review.decision} · ${candidate.review.evidenceIds.length} 条审核证据`
                : '等待独立角色负责人或领域专家'
            }
          />
          <GovernanceEvidence
            title="验证"
            ready={candidate.validation?.passed === true}
            detail={
              candidate.validation
                ? `得分 ${candidate.validation.score.toFixed(2)} / 门槛 ${candidate.validation.threshold.toFixed(2)}`
                : '等待版本化测试集或小范围任务验证'
            }
          />
          <GovernanceEvidence
            title="知识投影"
            ready={
              projection?.status === 'READY' ||
              projection?.status === 'PUBLISHED' ||
              projection?.status === 'RETIRED'
            }
            detail={
              projection
                ? `${projection.status} · 切片/向量 ${projection.ingestionStatus ?? '等待'} · 治理 ${projection.governanceReviewStatus ?? '等待'}`
                : '验证通过后创建受治理的知识版本'
            }
          />
          <GovernanceEvidence
            title="发布"
            ready={candidate.publication !== null}
            detail={
              candidate.publication
                ? `知识版本 v${candidate.publication.documentVersion}`
                : '未进入正式知识域'
            }
          />
        </section>

        <footer className="experience-actions">
          {candidate.status === 'VALIDATED' && projection === null ? (
            <button className="button secondary" type="button" onClick={onPrepareProjection}>
              准备知识版本
            </button>
          ) : null}
          {candidate.status === 'VALIDATED' &&
          projection !== null &&
          projection.status !== 'PUBLISHED' ? (
            <button className="button secondary" type="button" onClick={onPrepareProjection}>
              刷新/重试知识投影
            </button>
          ) : null}
          {actions.length === 0 ? (
            <span className="experience-terminal">
              {candidate.status === 'REJECTED' ? '该候选已驳回' : '当前状态没有可执行动作'}
            </span>
          ) : (
            actions.map((action) => (
              <button
                key={action}
                className={
                  action === 'REJECT' || action === 'RETIRE' ? 'button danger' : 'button primary'
                }
                type="button"
                disabled={action === 'PUBLISH' && projection?.status !== 'PUBLISHED'}
                onClick={() => onAction(action)}
              >
                {action === 'PUBLISH' && projection?.status !== 'PUBLISHED'
                  ? '等待知识评测发布'
                  : experienceActionLabel(action)}
              </button>
            ))
          )}
        </footer>
      </article>

      <article className="card experience-monitoring">
        <header>
          <div>
            <span className="eyebrow">MONITORING</span>
            <h2>复用效果</h2>
          </div>
          <small>最近更新 {formatExperienceDate(candidate.updatedAt)}</small>
        </header>
        <div>
          <Metric label="召回" value={candidate.monitoredUseCount} />
          <Metric label="采纳" value={candidate.monitoredAdoptionCount} />
          <Metric label="投诉" value={candidate.monitoredComplaintCount} tone="danger" />
          <Metric
            label="采纳率"
            value={
              candidate.monitoredUseCount === 0
                ? '—'
                : `${Math.round((candidate.monitoredAdoptionCount / candidate.monitoredUseCount) * 100)}%`
            }
          />
        </div>
      </article>
    </div>
  );
}

function GovernanceEvidence({
  title,
  ready,
  detail,
}: {
  title: string;
  ready: boolean;
  detail: string;
}): ReactNode {
  return (
    <div className={ready ? 'ready' : ''}>
      <span>{ready ? '✓' : '○'}</span>
      <strong>{title}</strong>
      <small>{detail}</small>
    </div>
  );
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: number | string;
  tone?: 'danger';
}): ReactNode {
  return (
    <div className={tone === 'danger' ? 'danger' : ''}>
      <small>{label}</small>
      <strong>{value}</strong>
    </div>
  );
}

function CreateExperienceDialog({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: (candidate: ExperienceCandidate) => void;
}): ReactNode {
  const [title, setTitle] = useState('');
  const [sourceTaskId, setSourceTaskId] = useState('');
  const [deliverableIds, setDeliverableIds] = useState<string[]>([]);
  const [evidenceIds, setEvidenceIds] = useState<string[]>([]);
  const [summary, setSummary] = useState('');
  const [labels, setLabels] = useState<string[]>([]);
  const [sensitivity, setSensitivity] =
    useState<CreateExperienceCandidateRequest['sensitivity']>('INTERNAL');
  const [tasks, setTasks] = useState<readonly Task[]>([]);
  const [deliverables, setDeliverables] = useState<readonly Deliverable[]>([]);
  const [evidence, setEvidence] = useState<readonly Evidence[]>([]);
  const [referencesLoading, setReferencesLoading] = useState(true);
  const [referencesError, setReferencesError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setReferencesLoading(true);
    setReferencesError(null);
    void Promise.all([listTasks(controller.signal), listEvidence(controller.signal)])
      .then(([loadedTasks, loadedEvidence]) => {
        setTasks(loadedTasks);
        setEvidence(loadedEvidence);
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) setReferencesError(experienceErrorMessage(caught));
      })
      .finally(() => {
        if (!controller.signal.aborted) setReferencesLoading(false);
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!sourceTaskId) {
      setDeliverables([]);
      setDeliverableIds([]);
      return;
    }
    const controller = new AbortController();
    void listTaskDeliverables(sourceTaskId, controller.signal)
      .then((items) => {
        setDeliverables(items);
        setDeliverableIds((current) =>
          current.filter((id) => items.some((item) => item.id === id)),
        );
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) setReferencesError(experienceErrorMessage(caught));
      });
    return () => controller.abort();
  }, [sourceTaskId]);

  const taskOptions = tasks.map<EntityOption>((task) => ({
    id: task.id,
    label: task.title,
    description: `${task.code} · ${task.status}`,
  }));
  const deliverableOptions = deliverables.map<EntityOption>((deliverable) => ({
    id: deliverable.id,
    label: deliverable.title,
    description: `${deliverable.code} · ${deliverable.status}`,
  }));
  const evidenceOptions = evidence.map<EntityOption>((item) => ({
    id: item.id,
    label: item.summary,
    description: `${item.code} · ${item.trustLevel} · ${item.status}`,
    disabled: item.status !== 'ACTIVE',
  }));

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const sourceEvidenceIds = [...evidenceIds];
      const input: CreateExperienceCandidateRequest = {
        title,
        sourceTaskId,
        sourceDeliverableIds: [...deliverableIds],
        sourceEvidenceIds,
        candidateSummary: summary,
        permissionLabels: [...labels],
        sensitivity,
        idempotencyKey: crypto.randomUUID(),
      };
      onSaved(await createExperienceCandidate(input));
    } catch (caught: unknown) {
      setError(experienceErrorMessage(caught));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title="新建经验候选"
      description="仅登记来源明确、可追溯的业务成果；登记并不代表可以用于生产回答。"
      onClose={onClose}
      size="wide"
      dismissible={!saving}
    >
      <form className="form-stack experience-create-form" onSubmit={(event) => void submit(event)}>
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
          <span>来源任务</span>
          <EntitySelect
            required
            value={sourceTaskId}
            options={taskOptions}
            onChange={setSourceTaskId}
            placeholder={referencesLoading ? '正在读取任务…' : '选择来源任务'}
            disabled={referencesLoading}
          />
        </label>
        <div className="experience-form-grid">
          <label>
            <span>来源交付物</span>
            <EntityMultiPicker
              value={deliverableIds}
              options={deliverableOptions}
              onChange={setDeliverableIds}
              ariaLabel="来源交付物"
              emptyText={sourceTaskId ? '该任务暂无交付物' : '请先选择来源任务'}
              disabled={!sourceTaskId}
            />
          </label>
          <label>
            <span>可信证据（至少一条）</span>
            <EntityMultiPicker
              value={evidenceIds}
              options={evidenceOptions}
              onChange={setEvidenceIds}
              ariaLabel="可信证据"
              disabled={referencesLoading}
            />
          </label>
        </div>
        <label>
          <span>候选摘要</span>
          <textarea
            required
            rows={5}
            maxLength={20_000}
            value={summary}
            onChange={(event) => setSummary(event.target.value)}
          />
        </label>
        <div className="experience-form-grid">
          <label>
            <span>权限标签</span>
            <TagInput
              value={labels}
              onChange={setLabels}
              ariaLabel="权限标签"
              placeholder="delivery, internal"
            />
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
        {referencesError ? <FieldError message={referencesError} /> : null}
        <FieldError message={error} />
        <div className="modal-actions">
          <button className="button secondary" type="button" disabled={saving} onClick={onClose}>
            取消
          </button>
          <button
            className="button primary"
            type="submit"
            disabled={saving || !sourceTaskId || evidenceIds.length === 0}
          >
            {saving ? <Spinner label="正在登记…" /> : '登记候选'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function PrepareExperienceProjectionDialog({
  candidate,
  onClose,
  onSaved,
}: {
  candidate: ExperienceCandidate;
  onClose: () => void;
  onSaved: (projection: ExperienceKnowledgeProjection) => void;
}): ReactNode {
  const [knowledgeBaseId, setKnowledgeBaseId] = useState('');
  const [roleTemplateIds, setRoleTemplateIds] = useState<string[]>([]);
  const [organizationUnitIds, setOrganizationUnitIds] = useState<string[]>([]);
  const [title, setTitle] = useState(`已验证经验 ${candidate.id.slice(0, 8)}`);
  const [references, setReferences] = useState<{
    knowledgeBases: readonly KnowledgeBase[];
    roleBlueprints: readonly RoleBlueprint[];
    organization: AdminOrganizationResponse | null;
  }>({ knowledgeBases: [], roleBlueprints: [], organization: null });
  const [referencesLoading, setReferencesLoading] = useState(true);
  const [referencesError, setReferencesError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setReferencesLoading(true);
    void Promise.all([
      listKnowledgeBases(controller.signal),
      listRoleBlueprints(controller.signal),
      getOrganization(controller.signal),
    ])
      .then(([knowledgeBases, roleBlueprints, organization]) => {
        setReferences({
          knowledgeBases: knowledgeBases.items,
          roleBlueprints: roleBlueprints.items,
          organization,
        });
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) setReferencesError(experienceErrorMessage(caught));
      })
      .finally(() => {
        if (!controller.signal.aborted) setReferencesLoading(false);
      });
    return () => controller.abort();
  }, []);

  const knowledgeBaseOptions = references.knowledgeBases.map<EntityOption>((item) => ({
    id: item.id,
    label: item.name,
    description: `${item.key} · ${item.status}`,
  }));
  const roleOptions = references.roleBlueprints.map<EntityOption>((item) => ({
    id: item.id,
    label: item.name,
    description: `${item.key} · r${item.revision}`,
  }));
  const organizationOptions =
    references.organization?.orgUnits.map<EntityOption>((item) => ({
      id: item.id,
      label: item.name,
      description: item.status === 'ACTIVE' ? '启用部门' : '已归档',
      disabled: item.status !== 'ACTIVE',
    })) ?? [];

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const input: PrepareExperienceKnowledgeProjectionRequest = {
        expectedRevision: candidate.revision,
        knowledgeBaseId: knowledgeBaseId.trim(),
        targetRoleTemplateIds: [...roleTemplateIds],
        targetOrgUnitIds: [...organizationUnitIds],
        ...(title.trim() === '' ? {} : { title: title.trim() }),
        idempotencyKey: crypto.randomUUID(),
      };
      onSaved(await prepareExperienceKnowledgeProjection(candidate.id, input));
    } catch (caught: unknown) {
      setError(experienceErrorMessage(caught));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title="准备受治理知识版本"
      description="系统会把已验证经验写入指定知识库，并沿用标准解析、切片和向量索引流水线。完成后仍需由独立审核人批准治理策略、运行评测并发布。"
      onClose={onClose}
      size="wide"
      dismissible={!saving}
    >
      <form
        className="form-stack experience-projection-form"
        onSubmit={(event) => void submit(event)}
      >
        <div className="experience-projection-note" role="note">
          <strong>不会直接进入员工检索</strong>
          <span>
            只有知识版本完成向量索引、治理审批、评测门禁和正式发布后，经验治理页才允许执行“发布经验”。
          </span>
        </div>
        <label>
          <span>目标知识库</span>
          <EntitySelect
            required
            value={knowledgeBaseId}
            options={knowledgeBaseOptions}
            onChange={setKnowledgeBaseId}
            placeholder={referencesLoading ? '正在读取知识库…' : '选择目标知识库'}
            disabled={referencesLoading}
          />
        </label>
        <label>
          <span>脱敏后的知识文档标题</span>
          <input
            required
            maxLength={300}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <div className="experience-form-grid">
          <label>
            <span>可访问角色模板</span>
            <EntityMultiPicker
              value={roleTemplateIds}
              options={roleOptions}
              onChange={setRoleTemplateIds}
              ariaLabel="可访问角色模板"
              disabled={referencesLoading}
            />
          </label>
          <label>
            <span>可访问组织单元</span>
            <EntityMultiPicker
              value={organizationUnitIds}
              options={organizationOptions}
              onChange={setOrganizationUnitIds}
              ariaLabel="可访问组织单元"
              disabled={referencesLoading}
            />
          </label>
        </div>
        {referencesError ? <FieldError message={referencesError} /> : null}
        <FieldError message={error} />
        <div className="modal-actions">
          <button className="button secondary" type="button" disabled={saving} onClick={onClose}>
            取消
          </button>
          <button
            className="button primary"
            type="submit"
            disabled={
              saving ||
              !knowledgeBaseId ||
              (roleTemplateIds.length === 0 && organizationUnitIds.length === 0)
            }
          >
            {saving ? <Spinner label="正在创建并索引…" /> : '创建知识版本'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ExperienceTransitionDialog({
  candidate,
  projection,
  action,
  onClose,
  onSaved,
}: {
  candidate: ExperienceCandidate;
  projection: ExperienceKnowledgeProjection | null;
  action: ExperienceAction;
  onClose: () => void;
  onSaved: (candidate: ExperienceCandidate) => void;
}): ReactNode {
  const payload = useMemo(
    () =>
      action === 'PUBLISH' && projection?.status === 'PUBLISHED'
        ? {
            knowledgeBaseId: projection.knowledgeBaseId,
            documentId: projection.documentId,
            documentVersionId: projection.documentVersionId,
            documentVersion: projection.documentVersion,
            targetRoleTemplateIds: projection.targetRoleTemplateIds,
            targetOrgUnitIds: projection.targetOrgUnitIds,
            publicationHash: projection.publicationHash,
          }
        : transitionPayloadTemplate(action, candidate),
    [action, candidate, projection],
  );
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const input: ExperienceTransitionRequest = {
        expectedRevision: candidate.revision,
        action,
        reason,
        payload,
        idempotencyKey: crypto.randomUUID(),
      };
      onSaved(await transitionExperienceCandidate(candidate.id, input));
    } catch (caught: unknown) {
      setError(experienceErrorMessage(caught));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={experienceActionLabel(action)}
      description={`服务端会使用 r${candidate.revision} 执行乐观并发校验，并把证据、操作者和状态变化写入审计链。`}
      onClose={onClose}
      size="wide"
      dismissible={!saving}
    >
      <form className="form-stack" onSubmit={(event) => void submit(event)}>
        <label>
          <span>操作理由</span>
          <textarea
            required
            maxLength={500}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </label>
        <Notice tone="info">
          关联知识库、文档版本、角色和组织范围均从当前候选及已确认投影中带出，系统会自动生成治理记录。
        </Notice>
        <FieldError message={error} />
        <div className="modal-actions">
          <button className="button secondary" type="button" disabled={saving} onClick={onClose}>
            取消
          </button>
          <button
            className={
              action === 'REJECT' || action === 'RETIRE' ? 'button danger' : 'button primary'
            }
            type="submit"
            disabled={saving}
          >
            {saving ? <Spinner label="正在提交…" /> : experienceActionLabel(action)}
          </button>
        </div>
      </form>
    </Modal>
  );
}
