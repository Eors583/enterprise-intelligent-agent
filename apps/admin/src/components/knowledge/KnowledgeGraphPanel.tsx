import type { KnowledgeGraphOverview, KnowledgeGraphResponse } from '@enterprise/contracts';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';

import { getKnowledgeGraph, getKnowledgeGraphOverview } from '@/api/admin-api';
import { messageFromError } from '@/api/client';
import { Icon } from '@/components/Icons';
import { EmptyState, ErrorState, LoadingPanel, Notice, Spinner } from '@/components/ui';

import {
  knowledgeGraphReadinessReasonLabel,
  knowledgeGraphReadinessSummary,
  knowledgeGraphStatusLabel,
} from './knowledge-graph-view';
import { KnowledgeGraphGovernancePanel } from './KnowledgeGraphGovernancePanel';

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function confidence(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export function KnowledgeGraphPanel({ knowledgeBaseId }: { knowledgeBaseId: string }): ReactNode {
  const [overview, setOverview] = useState<KnowledgeGraphOverview | null>(null);
  const [graph, setGraph] = useState<KnowledgeGraphResponse | null>(null);
  const [query, setQuery] = useState('');
  const [entityType, setEntityType] = useState('');
  const [focusEntityId, setFocusEntityId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void Promise.all([
      getKnowledgeGraphOverview(knowledgeBaseId, controller.signal),
      getKnowledgeGraph(knowledgeBaseId, { limit: 50 }, controller.signal),
    ])
      .then(([nextOverview, nextGraph]) => {
        if (controller.signal.aborted) return;
        setOverview(nextOverview);
        setGraph(nextGraph);
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) setError(messageFromError(caught));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [knowledgeBaseId, reloadKey]);

  const runSearch = async (
    event?: FormEvent,
    selectedEntityId: string | null = focusEntityId,
  ): Promise<void> => {
    event?.preventDefault();
    setSearching(true);
    setError(null);
    try {
      setGraph(
        await getKnowledgeGraph(knowledgeBaseId, {
          limit: 50,
          ...(query.trim() ? { query: query.trim() } : {}),
          ...(entityType ? { entityType } : {}),
          ...(selectedEntityId ? { focusEntityId: selectedEntityId } : {}),
        }),
      );
      setFocusEntityId(selectedEntityId);
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setSearching(false);
    }
  };

  if (loading && overview === null) {
    return <LoadingPanel label="正在读取实体、关系与证据覆盖…" />;
  }
  if (error && overview === null) {
    return <ErrorState message={error} onRetry={() => setReloadKey((value) => value + 1)} />;
  }
  if (overview === null) return null;

  const summary = knowledgeGraphReadinessSummary(overview);
  return (
    <>
      <KnowledgeGraphGovernancePanel knowledgeBaseId={knowledgeBaseId} />
      <section className="card knowledge-graph-panel knowledge-tab-panel">
        <header className="card-header">
          <div>
            <h2>关系知识治理</h2>
            <p>查看实体、关系、来源证据与跨切片扩展；图谱是普通文档检索之外的可选增强。</p>
          </div>
          <button
            className="button secondary compact"
            type="button"
            onClick={() => setReloadKey((value) => value + 1)}
            disabled={loading}
          >
            <Icon name="refresh" size={15} /> 重新检查
          </button>
        </header>

        <div className="knowledge-graph-content">
          <div className={`knowledge-graph-headline status-${summary.toLowerCase()}`}>
            <span>{knowledgeGraphStatusLabel(overview.status)}</span>
            <strong>
              {overview.status === 'READY'
                ? '实体、关系与证据链可用于关系扩展'
                : '关系图谱尚未就绪，普通文档检索继续可用'}
            </strong>
            <em>{overview.status === 'READY' ? 'GRAPH READY' : 'OPTIONAL'}</em>
          </div>

          <div className="knowledge-graph-metrics">
            <GraphMetric label="实体" value={overview.entityCount} />
            <GraphMetric label="关系" value={overview.relationCount} />
            <GraphMetric label="实体提及" value={overview.mentionCount} />
            <GraphMetric label="关系证据" value={overview.evidenceCount} />
            <GraphMetric
              label="孤立实体"
              value={overview.orphanEntityCount}
              warning={overview.orphanEntityCount > 0}
            />
            <GraphMetric
              label="无证据关系"
              value={overview.relationsWithoutEvidenceCount}
              warning={overview.relationsWithoutEvidenceCount > 0}
            />
          </div>

          <div className="knowledge-graph-coverage">
            <Coverage
              label="切片实体提及覆盖"
              value={overview.mentionCoverage}
              detail={`${overview.linkedChunkCount.toLocaleString()} / ${overview.publishedChunkCount.toLocaleString()} 个已发布切片`}
            />
            <Coverage
              label="关系证据覆盖"
              value={overview.evidenceCoverage}
              detail={`${Math.max(0, overview.relationCount - overview.relationsWithoutEvidenceCount).toLocaleString()} / ${overview.relationCount.toLocaleString()} 条关系`}
            />
          </div>

          {overview.diagnostics.length > 0 ? (
            <div className="knowledge-activation-blockers" role="status">
              <strong>关系图谱诊断</strong>
              <ul>
                {overview.diagnostics.map((reason) => (
                  <li key={reason}>{knowledgeGraphReadinessReasonLabel(reason)}</li>
                ))}
              </ul>
            </div>
          ) : (
            <Notice tone="success">关系图谱状态正常，关系扩展可作为混合检索的补充。</Notice>
          )}

          <div className="knowledge-graph-taxonomy">
            <GraphTypeDistribution
              title="实体类型"
              empty="尚未提取实体类型"
              items={overview.entityTypes.map((item) => ({
                key: item.type,
                label: item.type,
                count: item.count,
              }))}
            />
            <GraphTypeDistribution
              title="关系类型"
              empty="尚未提取关系类型"
              items={overview.relationTypes.map((item) => ({
                key: item.predicate,
                label: item.predicate,
                count: item.count,
              }))}
            />
          </div>

          <form
            className="knowledge-graph-search"
            onSubmit={(event) => void runSearch(event, null)}
          >
            <label>
              <span>查找实体或关系</span>
              <input
                value={query}
                maxLength={500}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setFocusEntityId(null);
                }}
                placeholder="输入人员、部门、制度、系统或关系名称"
              />
            </label>
            <label>
              <span>实体类型</span>
              <select
                value={entityType}
                onChange={(event) => {
                  setEntityType(event.target.value);
                  setFocusEntityId(null);
                }}
              >
                <option value="">全部类型</option>
                {overview.entityTypes.map((item) => (
                  <option value={item.type} key={item.type}>
                    {item.type}（{item.count}）
                  </option>
                ))}
              </select>
            </label>
            <button className="button primary" type="submit" disabled={searching}>
              {searching ? <Spinner label="正在查询…" /> : '查询图谱'}
            </button>
          </form>

          {error ? <Notice tone="info">图谱查询失败，已保留上一次结果：{error}</Notice> : null}
          {graph && (graph.entities.length > 0 || graph.relations.length > 0) ? (
            <div className="knowledge-graph-browser">
              <section>
                <header>
                  <strong>实体</strong>
                  <span>
                    显示 {graph.entities.length} / {graph.totalEntities}
                  </span>
                </header>
                <div className="knowledge-entity-list">
                  {graph.entities.map((entity) => (
                    <button
                      type="button"
                      key={entity.id}
                      className={focusEntityId === entity.id ? 'selected' : ''}
                      onClick={() => void runSearch(undefined, entity.id)}
                    >
                      <span className="knowledge-entity-type">{entity.entityType}</span>
                      <strong>{entity.canonicalName}</strong>
                      {entity.description ? <small>{entity.description}</small> : null}
                      {entity.aliases.length > 0 ? (
                        <small>别名：{entity.aliases.slice(0, 3).join('、')}</small>
                      ) : null}
                      <footer>
                        <span>提及 {entity.mentionCount}</span>
                        <span>关系 {entity.relationCount}</span>
                        <span>置信度 {confidence(entity.confidence)}</span>
                      </footer>
                    </button>
                  ))}
                </div>
              </section>

              <section>
                <header>
                  <strong>有向关系与证据</strong>
                  <span>
                    显示 {graph.relations.length} / {graph.totalRelations}
                  </span>
                </header>
                <div className="knowledge-relation-list">
                  {graph.relations.map((relation) => (
                    <article key={relation.id}>
                      <header>
                        <strong>{relation.subjectEntityName}</strong>
                        <span>{relation.predicate}</span>
                        <strong>{relation.objectEntityName}</strong>
                      </header>
                      <div className="knowledge-relation-meta">
                        <span>置信度 {confidence(relation.confidence)}</span>
                        <span>证据 {relation.evidenceCount}</span>
                        <code>{relation.id}</code>
                      </div>
                      {relation.evidence.length > 0 ? (
                        <details>
                          <summary>查看来源证据（{relation.evidence.length}）</summary>
                          <div className="knowledge-relation-evidence">
                            {relation.evidence.map((evidence) => (
                              <blockquote key={evidence.id}>
                                <p>{evidence.excerpt}</p>
                                <footer>
                                  <span>证据置信度 {confidence(evidence.confidence)}</span>
                                  <code>chunk:{evidence.chunkId}</code>
                                </footer>
                              </blockquote>
                            ))}
                          </div>
                        </details>
                      ) : (
                        <Notice tone="info">该关系没有可验证的来源切片，不能进入可信检索。</Notice>
                      )}
                    </article>
                  ))}
                </div>
              </section>
            </div>
          ) : (
            <EmptyState
              title="暂无可浏览的实体关系"
              description="完成文档解析、实体消歧、关系抽取与证据绑定后，可在这里按实体展开一至两跳关系。"
            />
          )}
        </div>
      </section>
    </>
  );
}

function GraphMetric({
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

function Coverage({
  label,
  value,
  detail,
}: {
  label: string;
  value: number;
  detail: string;
}): ReactNode {
  return (
    <div>
      <header>
        <strong>{label}</strong>
        <span>{percent(value)}</span>
      </header>
      <progress max={1} value={value} aria-label={label} />
      <small>{detail}</small>
    </div>
  );
}

function GraphTypeDistribution({
  title,
  empty,
  items,
}: {
  title: string;
  empty: string;
  items: ReadonlyArray<{ key: string; label: string; count: number }>;
}): ReactNode {
  return (
    <section>
      <strong>{title}</strong>
      {items.length > 0 ? (
        <div>
          {items.map((item) => (
            <span key={item.key}>
              {item.label} <b>{item.count}</b>
            </span>
          ))}
        </div>
      ) : (
        <small>{empty}</small>
      )}
    </section>
  );
}
