import type {
  KnowledgeGraphConflict,
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
  transitionKnowledgeGraphRelationCorrectionBatch,
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
  const [actionComment, setActionComment] = useState('已核对当前知识图谱及来源证据。');
  const [conflictResolutions, setConflictResolutions] = useState<Record<string, string>>({});

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
    const comment = actionComment.trim();
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
          ? '本体版本已发布；存量关系已自动形成待独立复核批次，模式缺口已按发布证据关闭。'
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
    const comment = actionComment.trim();
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

  const transitionRelationBatch = async (
    ontologyVersionId: string,
    action: 'APPROVE' | 'APPLY',
  ): Promise<void> => {
    const comment = actionComment.trim();
    if (!comment) return;
    setMutating(`relation-batch:${ontologyVersionId}:${action}`);
    setError(null);
    try {
      const result = await transitionKnowledgeGraphRelationCorrectionBatch(knowledgeBaseId, {
        ontologyVersionId,
        action,
        comment,
        idempotencyKey: governanceKey(`relation-batch-${ontologyVersionId}-${action}`),
      });
      setNotice(
        action === 'APPROVE'
          ? `已独立复核 ${result.transitionedCount} 条关系；${result.skippedCount} 条因状态或复核人限制未变更。`
          : `已应用 ${result.transitionedCount} 条关系并写入受治理检索读模型。`,
      );
      reload();
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setMutating(null);
    }
  };

  const proposeConflictResolution = async (conflict: KnowledgeGraphConflict): Promise<void> => {
    const resolution = conflictResolutions[conflict.id]?.trim();
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
  const publishedVersion = overview.ontologies
    .flatMap((ontology) => ontology.versions)
    .find((version) => version.status === 'PUBLISHED');
  const hasUserOntology = overview.ontologies.some((ontology) =>
    ontology.versions.some((version) => !version.systemBootstrap),
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

      <section className="knowledge-governance-journey" aria-label="关系治理三步流程">
        <header>
          <div>
            <h3>按三步启用可信关系检索</h3>
            <p>系统已根据当前图谱归纳实体和关系，不需要手写技术字段。</p>
          </div>
          <span>
            {overview.suggestedOntology.sourceEntityCount} 个实体 ·{' '}
            {overview.suggestedOntology.sourceRelationCount} 条关系
          </span>
        </header>
        <ol>
          <li className={hasUserOntology ? 'done' : 'current'}>
            <strong>1. 创建本体草稿</strong>
            <span>
              系统建议 {overview.suggestedOntology.entityTypes.length} 类实体、
              {overview.suggestedOntology.predicates.length} 类关系
            </span>
          </li>
          <li
            className={publishedVersion !== undefined ? 'done' : hasUserOntology ? 'current' : ''}
          >
            <strong>2. 另一位管理员复核发布</strong>
            <span>发布后自动覆盖存量模式缺口并生成关系复核批次</span>
          </li>
          <li
            className={
              overview.retrieval.ungovernedRelationCount === 0 && publishedVersion !== undefined
                ? 'done'
                : publishedVersion !== undefined
                  ? 'current'
                  : ''
            }
          >
            <strong>3. 批量复核并应用关系</strong>
            <span>
              待复核 {overview.retrieval.pendingReviewRelationCount} 条 · 待应用{' '}
              {overview.retrieval.approvedRelationCount} 条
            </span>
          </li>
        </ol>
        <label className="knowledge-governance-comment">
          <span>本次操作说明（会进入审计记录）</span>
          <input
            value={actionComment}
            onChange={(event) => setActionComment(event.target.value)}
            placeholder="例如：已核对关系类型和抽样来源证据"
          />
        </label>
        {publishedVersion ? (
          <div className="button-row">
            <button
              className="button primary"
              type="button"
              disabled={
                mutating !== null ||
                actionComment.trim() === '' ||
                overview.retrieval.pendingReviewRelationCount === 0
              }
              onClick={() => void transitionRelationBatch(publishedVersion.id, 'APPROVE')}
            >
              批量独立复核 {overview.retrieval.pendingReviewRelationCount} 条
            </button>
            <button
              className="button primary"
              type="button"
              disabled={
                mutating !== null ||
                actionComment.trim() === '' ||
                overview.retrieval.approvedRelationCount === 0
              }
              onClick={() => void transitionRelationBatch(publishedVersion.id, 'APPLY')}
            >
              批量应用 {overview.retrieval.approvedRelationCount} 条
            </button>
          </div>
        ) : null}
      </section>

      <div className="knowledge-graph-metrics">
        <GovernanceMetric
          label="已发布本体版本"
          value={overview.retrieval.publishedOntologyVersionCount}
        />
        <GovernanceMetric label="可检索关系" value={overview.retrieval.eligibleRelationCount} />
        <GovernanceMetric label="规范实体合并" value={overview.retrieval.mergedEntityCount} />
        <GovernanceMetric
          label="尚未治理关系"
          value={overview.retrieval.ungovernedRelationCount}
          warning={overview.retrieval.ungovernedRelationCount > 0}
        />
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
          {!hasUserOntology ? (
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
                          disabled={mutating !== null || actionComment.trim() === ''}
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
                            disabled={mutating !== null || actionComment.trim() === ''}
                            onClick={() => void transitionVersion(version, 'REQUEST_CHANGES')}
                          >
                            退回修改
                          </button>
                          <button
                            className="button primary compact"
                            type="button"
                            disabled={mutating !== null || actionComment.trim() === ''}
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
                          disabled={mutating !== null || actionComment.trim() === ''}
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
                      disabled={mutating !== null || actionComment.trim() === ''}
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
                        disabled={mutating !== null || actionComment.trim() === ''}
                        onClick={() =>
                          void transitionCorrection(correction.id, correction.revision, 'REJECT')
                        }
                      >
                        驳回
                      </button>
                      <button
                        className="button primary compact"
                        type="button"
                        disabled={mutating !== null || actionComment.trim() === ''}
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
                      disabled={mutating !== null || actionComment.trim() === ''}
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
                <label className="knowledge-conflict-resolution">
                  <span>裁决结论与依据</span>
                  <textarea
                    rows={2}
                    value={conflictResolutions[conflict.id] ?? ''}
                    onChange={(event) =>
                      setConflictResolutions((current) => ({
                        ...current,
                        [conflict.id]: event.target.value,
                      }))
                    }
                    placeholder="说明保留、合并或排除该关系的理由"
                  />
                </label>
                <button
                  className="button primary compact"
                  type="button"
                  disabled={
                    mutating !== null || (conflictResolutions[conflict.id]?.trim() ?? '') === ''
                  }
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
          suggestion={overview.suggestedOntology}
          onCreated={() => {
            setNotice('本体草稿已创建；发布前必须由另一位管理员独立复核。');
            reload();
          }}
        />
      </details>

      <Notice tone="info">
        实体与关系修正请从上方冲突记录或实体详情发起，系统会自动带入目标、版本和来源证据，不再接受手工结构化内容。
      </Notice>
    </section>
  );
}

function CreateOntologyForm({
  knowledgeBaseId,
  suggestion,
  onCreated,
}: {
  knowledgeBaseId: string;
  suggestion: KnowledgeGraphGovernanceOverview['suggestedOntology'];
  onCreated: () => void;
}): ReactNode {
  const [name, setName] = useState('企业知识关系本体');
  const [description, setDescription] = useState(
    '根据当前知识库实体和关系自动归纳的业务语义模型。',
  );
  const [changeSummary, setChangeSummary] = useState('建立首版关系检索实体类型和关系约束。');
  const [template, setTemplate] = useState<
    'GRAPH_SUGGESTION' | 'DOCUMENT_OWNERSHIP' | 'DOCUMENT_ONLY'
  >(suggestion.entityTypes.length > 0 ? 'GRAPH_SUGGESTION' : 'DOCUMENT_OWNERSHIP');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const entityTypes =
        template === 'GRAPH_SUGGESTION'
          ? suggestion.entityTypes
          : template === 'DOCUMENT_ONLY'
            ? [DEFAULT_ENTITY_TYPES[0]!]
            : [...DEFAULT_ENTITY_TYPES];
      const predicates =
        template === 'GRAPH_SUGGESTION'
          ? suggestion.predicates
          : template === 'DOCUMENT_ONLY'
            ? []
            : [...DEFAULT_PREDICATES];
      await createKnowledgeOntology(knowledgeBaseId, {
        code: generatedOntologyCode(name),
        name,
        description: description.trim() || null,
        changeSummary,
        entityTypes,
        predicates,
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
      <label>
        <span>关系模板</span>
        <select
          value={template}
          onChange={(event) => setTemplate(event.target.value as typeof template)}
        >
          {suggestion.entityTypes.length > 0 ? (
            <option value="GRAPH_SUGGESTION">
              根据当前图谱自动生成（{suggestion.entityTypes.length} 类实体 /{' '}
              {suggestion.predicates.length} 类关系）
            </option>
          ) : null}
          <option value="DOCUMENT_OWNERSHIP">文档、人员与组织责任关系</option>
          <option value="DOCUMENT_ONLY">仅管理文档实体</option>
        </select>
        <small>
          推荐使用当前图谱建议；系统会把 {suggestion.sourceRelationCount}{' '}
          条已识别关系归纳为可复核定义。
        </small>
      </label>
      <label>
        <span>本体名称</span>
        <input required value={name} onChange={(event) => setName(event.target.value)} />
      </label>
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
      <Notice tone="info">
        系统会自动生成内部标识并校验关系方向。发布后定义不可直接修改，如需调整请创建新版本。
      </Notice>
      <FieldError message={error} />
      <button className="button primary" type="submit" disabled={submitting}>
        {submitting ? <Spinner label="正在创建…" /> : '创建本体草稿'}
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

function generatedOntologyCode(name: string): string {
  const normalized = name
    .normalize('NFKC')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/gu, '_')
    .replace(/^_+|_+$/gu, '')
    .slice(0, 48);
  return `ONTOLOGY_${normalized || 'KNOWLEDGE'}_${Date.now().toString(36).toUpperCase()}`;
}

function governanceKey(prefix: string): string {
  return `kg:${prefix}:${crypto.randomUUID()}`;
}
