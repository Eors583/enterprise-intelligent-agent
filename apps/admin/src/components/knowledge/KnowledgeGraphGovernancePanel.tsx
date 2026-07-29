import type {
  CreateKnowledgeGraphCorrectionRequest,
  KnowledgeGraphConflict,
  KnowledgeGraphCorrectionAction,
  KnowledgeGraphGovernanceOverview,
  KnowledgeOntologyEntityTypeInput,
  KnowledgeOntologyPredicateInput,
  KnowledgeOntologyVersion,
} from '@enterprise/contracts';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';

import {
  createKnowledgeGraphCorrection,
  createKnowledgeOntology,
  getKnowledgeGraphGovernance,
  transitionKnowledgeGraphCorrection,
  transitionKnowledgeOntologyVersion,
} from '@/api/admin-api';
import { messageFromError } from '@/api/client';
import { EmptyState, FieldError, LoadingPanel, Notice, Spinner } from '@/components/ui';

const DEFAULT_ENTITY_TYPES: readonly KnowledgeOntologyEntityTypeInput[] = [
  {
    key: 'DOCUMENT',
    name: '文档',
    description: '可追溯的企业文档。',
    attributesSchema: {},
  },
  {
    key: 'PERSON',
    name: '人员',
    description: '企业成员或外部联系人。',
    attributesSchema: {},
  },
  {
    key: 'ORGANIZATION',
    name: '组织',
    description: '企业、部门或业务单元。',
    attributesSchema: {},
  },
];

const DEFAULT_PREDICATES: readonly KnowledgeOntologyPredicateInput[] = [
  {
    key: 'OWNED_BY',
    predicate: 'OWNED_BY',
    label: '负责人',
    domainTypeKey: 'DOCUMENT',
    rangeTypeKey: 'PERSON',
    inversePredicateKey: 'OWNS',
    symmetric: false,
    functional: true,
    allowSelfLoop: false,
    temporal: true,
    attributesSchema: {},
  },
  {
    key: 'OWNS',
    predicate: 'OWNS',
    label: '负责',
    domainTypeKey: 'PERSON',
    rangeTypeKey: 'DOCUMENT',
    inversePredicateKey: 'OWNED_BY',
    symmetric: false,
    functional: false,
    allowSelfLoop: false,
    temporal: true,
    attributesSchema: {},
  },
];

export function KnowledgeGraphGovernancePanel({
  knowledgeBaseId,
}: {
  knowledgeBaseId: string;
}): ReactNode {
  const [overview, setOverview] = useState<KnowledgeGraphGovernanceOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [mutating, setMutating] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void getKnowledgeGraphGovernance(knowledgeBaseId, controller.signal)
      .then(setOverview)
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) setError(messageFromError(caught));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [knowledgeBaseId, reloadKey]);

  const reload = (): void => setReloadKey((value) => value + 1);

  const transitionVersion = async (
    version: KnowledgeOntologyVersion,
    action: 'SUBMIT' | 'REQUEST_CHANGES' | 'PUBLISH' | 'RETIRE',
  ): Promise<void> => {
    const comment = window.prompt('填写本次治理变更、复核或发布说明：')?.trim();
    if (!comment) return;
    setMutating(`version:${version.id}`);
    setError(null);
    try {
      await transitionKnowledgeOntologyVersion(knowledgeBaseId, version.id, {
        action,
        expectedRevision: version.revision,
        comment,
        idempotencyKey: governanceKey(`ontology-${version.id}-${action}`),
      });
      setNotice(
        action === 'PUBLISH'
          ? '本体版本已由独立复核人发布，检索读模型会立即使用已发布版本。'
          : '本体版本状态已更新。',
      );
      reload();
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setMutating(null);
    }
  };

  const transitionCorrection = async (
    correctionId: string,
    revision: number,
    action: 'SUBMIT' | 'APPROVE' | 'REJECT' | 'APPLY',
  ): Promise<void> => {
    const comment = window.prompt('填写人工复核证据或执行说明：')?.trim();
    if (!comment) return;
    setMutating(`correction:${correctionId}`);
    setError(null);
    try {
      await transitionKnowledgeGraphCorrection(knowledgeBaseId, correctionId, {
        action,
        expectedRevision: revision,
        comment,
        idempotencyKey: governanceKey(`correction-${correctionId}-${action}`),
      });
      setNotice(
        action === 'APPLY' ? '修正已应用并写入审计、Outbox 与关系读模型。' : '修正状态已更新。',
      );
      reload();
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setMutating(null);
    }
  };

  const proposeConflictResolution = async (conflict: KnowledgeGraphConflict): Promise<void> => {
    const resolution = window
      .prompt('填写冲突裁决结论、保留事实及依据；该操作只创建草稿，不会直接改变检索：')
      ?.trim();
    if (!resolution) return;
    setMutating(`conflict:${conflict.id}`);
    setError(null);
    try {
      await createKnowledgeGraphCorrection(knowledgeBaseId, {
        action: 'RESOLVE_CONFLICT',
        patch: { conflictId: conflict.id, resolution },
        evidence: [
          {
            source: 'KNOWLEDGE_GRAPH_CONFLICT_REVIEW',
            conflictId: conflict.id,
            conflictType: conflict.conflictType,
            targetType: conflict.targetType,
            targetId: conflict.targetId,
            originalEvidence: conflict.evidence,
          },
        ],
        idempotencyKey: governanceKey(`resolve-conflict-${conflict.id}`),
      });
      setNotice('冲突裁决草稿已创建；必须经提交、独立复核和显式应用后才会关闭冲突。');
      reload();
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setMutating(null);
    }
  };

  if (loading && overview === null) {
    return <LoadingPanel label="正在读取本体版本、冲突与人工修正记录…" />;
  }
  if (overview === null && error) {
    return (
      <section className="card knowledge-tab-panel">
        <Notice tone="info">{error}</Notice>
        <button className="button secondary" type="button" onClick={reload}>
          重新加载图谱治理
        </button>
      </section>
    );
  }
  if (overview === null) return null;

  const openConflicts = overview.conflicts.filter((item) =>
    ['OPEN', 'IN_REVIEW'].includes(item.status),
  );
  return (
    <section className="card knowledge-tab-panel knowledge-graph-governance">
      <header className="card-header">
        <div>
          <h2>企业本体与关系治理</h2>
          <p>
            本体按草稿、复核、发布、退役进行版本化；只有已发布、在有效期内、无冲突且已归一到规范实体的关系会进入检索。
          </p>
        </div>
        <button
          className="button secondary compact"
          type="button"
          onClick={reload}
          disabled={loading}
        >
          刷新治理状态
        </button>
      </header>

      {notice ? (
        <Notice tone="success" onClose={() => setNotice(null)}>
          {notice}
        </Notice>
      ) : null}
      {error ? <Notice tone="info">{error}</Notice> : null}

      <div className="knowledge-graph-metrics">
        <GovernanceMetric
          label="已发布本体版本"
          value={overview.retrieval.publishedOntologyVersionCount}
        />
        <GovernanceMetric label="可检索关系" value={overview.retrieval.eligibleRelationCount} />
        <GovernanceMetric label="规范实体合并" value={overview.retrieval.mergedEntityCount} />
        <GovernanceMetric
          label="冲突排除"
          value={overview.retrieval.excludedConflictCount}
          warning={overview.retrieval.excludedConflictCount > 0}
        />
      </div>

      {openConflicts.length > 0 ? (
        <Notice tone="info">
          当前有 {openConflicts.length} 条未关闭冲突；相关实体或关系已从可信关系检索读模型中排除。
        </Notice>
      ) : (
        <Notice tone="success">当前没有会阻断可信关系检索的开放冲突。</Notice>
      )}

      <div className="knowledge-governance-grid">
        <section>
          <h3>本体版本</h3>
          {overview.ontologies.length === 0 ? (
            <EmptyState
              title="尚未创建业务本体"
              description="先定义实体类型与谓词约束，再提交另一位管理员复核发布。"
            />
          ) : (
            overview.ontologies.map((ontology) => (
              <article className="knowledge-governance-record" key={ontology.id}>
                <header>
                  <span>
                    <strong>{ontology.name}</strong>
                    <code>{ontology.code}</code>
                  </span>
                  <small>revision {ontology.revision}</small>
                </header>
                {ontology.versions.map((version) => (
                  <div className="knowledge-governance-version" key={version.id}>
                    <span>
                      <strong>v{version.versionNumber}</strong>
                      <em>{version.status}</em>
                      {version.systemBootstrap ? <small>迁移凭证</small> : null}
                    </span>
                    <small>
                      {version.entityTypes.length} 类实体 · {version.predicates.length} 类关系 ·{' '}
                      {version.schemaHash.slice(0, 12)}
                    </small>
                    <div>
                      {version.status === 'DRAFT' && !version.systemBootstrap ? (
                        <button
                          className="button secondary compact"
                          type="button"
                          disabled={mutating !== null}
                          onClick={() => void transitionVersion(version, 'SUBMIT')}
                        >
                          提交复核
                        </button>
                      ) : null}
                      {version.status === 'IN_REVIEW' ? (
                        <>
                          <button
                            className="button secondary compact"
                            type="button"
                            disabled={mutating !== null}
                            onClick={() => void transitionVersion(version, 'REQUEST_CHANGES')}
                          >
                            退回修改
                          </button>
                          <button
                            className="button primary compact"
                            type="button"
                            disabled={mutating !== null}
                            onClick={() => void transitionVersion(version, 'PUBLISH')}
                          >
                            独立复核并发布
                          </button>
                        </>
                      ) : null}
                      {version.status === 'PUBLISHED' && !version.systemBootstrap ? (
                        <button
                          className="button secondary compact"
                          type="button"
                          disabled={mutating !== null}
                          onClick={() => void transitionVersion(version, 'RETIRE')}
                        >
                          退役版本
                        </button>
                      ) : null}
                    </div>
                  </div>
                ))}
              </article>
            ))
          )}
        </section>

        <section>
          <h3>人工修正队列</h3>
          {overview.corrections.length === 0 ? (
            <p className="inline-empty">尚无实体合并、别名、时态关系或冲突修正。</p>
          ) : (
            overview.corrections.slice(0, 20).map((correction) => (
              <article className="knowledge-governance-record" key={correction.id}>
                <header>
                  <span>
                    <strong>{correction.action}</strong>
                    <code>{correction.id}</code>
                  </span>
                  <em>{correction.status}</em>
                </header>
                <small>
                  证据 {correction.evidenceHash.slice(0, 16)} · revision {correction.revision}
                </small>
                <div>
                  {correction.status === 'DRAFT' ? (
                    <button
                      className="button secondary compact"
                      type="button"
                      disabled={mutating !== null}
                      onClick={() =>
                        void transitionCorrection(correction.id, correction.revision, 'SUBMIT')
                      }
                    >
                      提交复核
                    </button>
                  ) : null}
                  {correction.status === 'IN_REVIEW' ? (
                    <>
                      <button
                        className="button secondary compact"
                        type="button"
                        disabled={mutating !== null}
                        onClick={() =>
                          void transitionCorrection(correction.id, correction.revision, 'REJECT')
                        }
                      >
                        驳回
                      </button>
                      <button
                        className="button primary compact"
                        type="button"
                        disabled={mutating !== null}
                        onClick={() =>
                          void transitionCorrection(correction.id, correction.revision, 'APPROVE')
                        }
                      >
                        独立复核
                      </button>
                    </>
                  ) : null}
                  {correction.status === 'APPROVED' ? (
                    <button
                      className="button primary compact"
                      type="button"
                      disabled={mutating !== null}
                      onClick={() =>
                        void transitionCorrection(correction.id, correction.revision, 'APPLY')
                      }
                    >
                      应用修正
                    </button>
                  ) : null}
                </div>
              </article>
            ))
          )}
        </section>

        <section>
          <h3>关系冲突队列</h3>
          {openConflicts.length === 0 ? (
            <p className="inline-empty">当前没有待裁决的实体或关系冲突。</p>
          ) : (
            openConflicts.slice(0, 20).map((conflict) => (
              <article className="knowledge-governance-record" key={conflict.id}>
                <header>
                  <span>
                    <strong>{conflict.conflictType}</strong>
                    <code>{conflict.id}</code>
                  </span>
                  <em>{conflict.status}</em>
                </header>
                <small>
                  {conflict.targetType} · {conflict.targetId} · revision {conflict.revision}
                </small>
                <pre>{JSON.stringify(conflict.details, null, 2)}</pre>
                <button
                  className="button primary compact"
                  type="button"
                  disabled={mutating !== null}
                  onClick={() => void proposeConflictResolution(conflict)}
                >
                  创建裁决草稿
                </button>
              </article>
            ))
          )}
        </section>
      </div>

      <details className="knowledge-governance-create">
        <summary>创建受治理的本体版本</summary>
        <CreateOntologyForm
          knowledgeBaseId={knowledgeBaseId}
          onCreated={() => {
            setNotice('本体草稿已创建；发布前必须由另一位管理员独立复核。');
            reload();
          }}
        />
      </details>

      <details className="knowledge-governance-create">
        <summary>提交实体/关系人工修正</summary>
        <CreateCorrectionForm
          knowledgeBaseId={knowledgeBaseId}
          onCreated={() => {
            setNotice('人工修正草稿已保存；不会在独立复核与显式应用前影响检索。');
            reload();
          }}
        />
      </details>
    </section>
  );
}

function CreateOntologyForm({
  knowledgeBaseId,
  onCreated,
}: {
  knowledgeBaseId: string;
  onCreated: () => void;
}): ReactNode {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [changeSummary, setChangeSummary] = useState('');
  const [entityTypes, setEntityTypes] = useState(JSON.stringify(DEFAULT_ENTITY_TYPES, null, 2));
  const [predicates, setPredicates] = useState(JSON.stringify(DEFAULT_PREDICATES, null, 2));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await createKnowledgeOntology(knowledgeBaseId, {
        code,
        name,
        description: description.trim() || null,
        changeSummary,
        entityTypes: parseJsonArray(entityTypes, '实体类型') as KnowledgeOntologyEntityTypeInput[],
        predicates: parseJsonArray(predicates, '谓词') as KnowledgeOntologyPredicateInput[],
        idempotencyKey: governanceKey('ontology-create'),
      });
      onCreated();
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form className="form-stack" onSubmit={(event) => void submit(event)}>
      <div className="form-grid two">
        <label>
          <span>本体代码</span>
          <input value={code} onChange={(event) => setCode(event.target.value.toUpperCase())} />
        </label>
        <label>
          <span>本体名称</span>
          <input value={name} onChange={(event) => setName(event.target.value)} />
        </label>
      </div>
      <label>
        <span>说明</span>
        <textarea
          rows={2}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </label>
      <label>
        <span>变更摘要</span>
        <input value={changeSummary} onChange={(event) => setChangeSummary(event.target.value)} />
      </label>
      <label>
        <span>实体类型 JSON</span>
        <textarea
          rows={10}
          value={entityTypes}
          onChange={(event) => setEntityTypes(event.target.value)}
        />
      </label>
      <label>
        <span>谓词约束 JSON</span>
        <textarea
          rows={12}
          value={predicates}
          onChange={(event) => setPredicates(event.target.value)}
        />
      </label>
      <Notice tone="info">
        inversePredicateKey 必须双向互指；domain/range
        必须引用同版本实体类型。发布后定义不可变，只能创建新版本。
      </Notice>
      <FieldError message={error} />
      <button className="button primary" type="submit" disabled={submitting}>
        {submitting ? <Spinner label="正在创建…" /> : '创建本体草稿'}
      </button>
    </form>
  );
}

function CreateCorrectionForm({
  knowledgeBaseId,
  onCreated,
}: {
  knowledgeBaseId: string;
  onCreated: () => void;
}): ReactNode {
  const [action, setAction] = useState<KnowledgeGraphCorrectionAction>('MERGE_ENTITY');
  const [patch, setPatch] = useState(
    JSON.stringify(
      {
        sourceEntityId: '00000000-0000-4000-8000-000000000000',
        targetEntityId: '00000000-0000-4000-8000-000000000001',
        reason: '重复实体消歧',
      },
      null,
      2,
    ),
  );
  const [evidence, setEvidence] = useState(
    JSON.stringify([{ source: 'human-review', reason: '同一业务主键与来源证据' }], null, 2),
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const input = {
        action,
        patch: parseJsonObject(patch, '修正内容'),
        evidence: parseJsonArray(evidence, '修正证据'),
        idempotencyKey: governanceKey(`correction-${action}`),
      } as CreateKnowledgeGraphCorrectionRequest;
      await createKnowledgeGraphCorrection(knowledgeBaseId, input);
      onCreated();
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form className="form-stack" onSubmit={(event) => void submit(event)}>
      <label>
        <span>修正类型</span>
        <select value={action} onChange={(event) => setAction(event.target.value as typeof action)}>
          <option value="MERGE_ENTITY">合并重复实体</option>
          <option value="ADD_ALIAS">添加实体别名</option>
          <option value="UPSERT_RELATION_VALIDITY">更新关系本体与有效期</option>
          <option value="RESOLVE_CONFLICT">关闭冲突</option>
        </select>
      </label>
      <label>
        <span>结构化修正内容 JSON</span>
        <textarea rows={8} value={patch} onChange={(event) => setPatch(event.target.value)} />
      </label>
      <label>
        <span>审批证据 JSON 数组</span>
        <textarea rows={5} value={evidence} onChange={(event) => setEvidence(event.target.value)} />
      </label>
      <Notice tone="info">
        修正必须经过“提交复核 → 独立复核 → 显式应用”，系统不会自动覆盖企业事实。
      </Notice>
      <FieldError message={error} />
      <button className="button primary" type="submit" disabled={submitting}>
        {submitting ? <Spinner label="正在保存…" /> : '保存修正草稿'}
      </button>
    </form>
  );
}

function GovernanceMetric({
  label,
  value,
  warning = false,
}: {
  label: string;
  value: number;
  warning?: boolean;
}): ReactNode {
  return (
    <div className={warning ? 'warning' : ''}>
      <span>{label}</span>
      <strong>{value.toLocaleString()}</strong>
    </div>
  );
}

function parseJsonArray(value: string, label: string): Record<string, unknown>[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed)) throw new Error(`${label}必须是 JSON 数组。`);
  return parsed.map((item) => {
    if (item === null || Array.isArray(item) || typeof item !== 'object') {
      throw new Error(`${label}的每一项必须是 JSON 对象。`);
    }
    return item as Record<string, unknown>;
  });
}

function parseJsonObject(value: string, label: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error(`${label}必须是 JSON 对象。`);
  }
  return parsed as Record<string, unknown>;
}

function governanceKey(prefix: string): string {
  return `kg:${prefix}:${crypto.randomUUID()}`;
}
