import type {
  KnowledgeBaseIndexReadiness,
  KnowledgeCapabilityReadiness,
  KnowledgeGraphOverview,
} from '@enterprise/contracts';
import { useEffect, useState, type ReactNode } from 'react';

import { getKnowledgeBaseReadiness, getKnowledgeGraphOverview } from '@/api/admin-api';
import { messageFromError } from '@/api/client';
import { Icon } from '@/components/Icons';
import { ErrorState, LoadingPanel, Notice, Spinner } from '@/components/ui';

import {
  knowledgeCapabilityStatusLabel,
  knowledgeReadinessReasonLabel,
  knowledgeReadinessSummary,
} from './knowledge-readiness-view';
import {
  knowledgeGraphReadinessReasonLabel,
  knowledgeGraphStatusLabel,
} from './knowledge-graph-view';

const POLL_INTERVAL_MS = 3_000;

export function KnowledgeReadinessPanel({
  knowledgeBaseId,
  refreshToken,
  onReadinessChange,
  onGraphOverviewChange,
  onReviewFailures,
}: {
  knowledgeBaseId: string;
  refreshToken: string;
  onReadinessChange: (readiness: KnowledgeBaseIndexReadiness | null) => void;
  onGraphOverviewChange: (overview: KnowledgeGraphOverview | null) => void;
  onReviewFailures: () => void;
}): ReactNode {
  const [reloadKey, setReloadKey] = useState(0);
  const [result, setResult] = useState<KnowledgeBaseIndexReadiness | null>(null);
  const [graphOverview, setGraphOverview] = useState<KnowledgeGraphOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [graphLoading, setGraphLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [graphError, setGraphError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void getKnowledgeBaseReadiness(knowledgeBaseId, controller.signal)
      .then((response) => {
        if (controller.signal.aborted) return;
        setResult(response);
        onReadinessChange(response);
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted) return;
        setError(messageFromError(caught));
        onReadinessChange(null);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [knowledgeBaseId, onReadinessChange, refreshToken, reloadKey]);

  useEffect(() => {
    const controller = new AbortController();
    setGraphLoading(true);
    setGraphError(null);
    void getKnowledgeGraphOverview(knowledgeBaseId, controller.signal)
      .then((response) => {
        if (controller.signal.aborted) return;
        setGraphOverview(response);
        onGraphOverviewChange(response);
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted) return;
        setGraphError(messageFromError(caught));
        onGraphOverviewChange(null);
      })
      .finally(() => {
        if (!controller.signal.aborted) setGraphLoading(false);
      });
    return () => controller.abort();
  }, [knowledgeBaseId, onGraphOverviewChange, refreshToken, reloadKey]);

  useEffect(() => {
    if ((result?.documents.processing ?? 0) === 0) return;
    let timer: number | null = null;
    const schedule = (): void => {
      if (timer !== null || document.visibilityState !== 'visible') return;
      timer = window.setTimeout(() => {
        timer = null;
        setReloadKey((value) => value + 1);
      }, POLL_INTERVAL_MS);
    };
    const visibilityChanged = (): void => {
      if (document.visibilityState === 'visible') schedule();
      else if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
    };
    schedule();
    document.addEventListener('visibilitychange', visibilityChanged);
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', visibilityChanged);
    };
  }, [result]);

  const retry = (): void => setReloadKey((value) => value + 1);
  return (
    <section className="card knowledge-readiness-panel" aria-label="企业就绪度与索引治理">
      <header className="card-header">
        <div>
          <h2>企业就绪度</h2>
          <p>核对已发布文档、当前模型向量覆盖以及语义与重排服务状态。</p>
        </div>
        <button
          className="button secondary compact"
          type="button"
          onClick={retry}
          disabled={loading}
        >
          {loading || graphLoading ? (
            <Spinner label="检查中…" />
          ) : (
            <>
              <Icon name="refresh" size={15} /> 重新检查
            </>
          )}
        </button>
      </header>

      {loading && result === null ? <LoadingPanel label="正在检查知识库企业就绪度…" /> : null}
      {error && result === null ? <ErrorState message={error} onRetry={retry} /> : null}
      {result ? (
        <div className="knowledge-readiness-content">
          <ReadinessHeadline readiness={result} />
          {error ? (
            <Notice tone="info">本次状态刷新失败，正在保留上一次安全结果：{error}</Notice>
          ) : null}
          <div className="knowledge-readiness-metrics">
            <Metric label="文档总数" value={result.documents.total} />
            <Metric label="已就绪" value={result.documents.ready} tone="ready" />
            <Metric label="处理中" value={result.documents.processing} tone="processing" />
            <Metric label="失败" value={result.documents.failed} tone="failed" />
            <Metric label="草稿" value={result.documents.draft} />
            <Metric label="已归档" value={result.documents.archived} />
          </div>
          <div className="knowledge-index-summary">
            <div>
              <span>已发布切片</span>
              <strong>{result.publishedChunkCount.toLocaleString()}</strong>
            </div>
            <div>
              <span>当前模型向量</span>
              <strong>
                {result.embeddedChunkCount.toLocaleString()} /{' '}
                {result.publishedChunkCount.toLocaleString()}
              </strong>
            </div>
            <div>
              <span>语义覆盖</span>
              <strong>{Math.round(result.semanticCoverage * 100)}%</strong>
              <progress max={1} value={result.semanticCoverage} aria-label="当前模型语义覆盖率" />
            </div>
          </div>
          <div className="knowledge-capability-grid">
            <CapabilityCard title="Embedding" capability={result.embedding} />
            <CapabilityCard title="Reranker" capability={result.rerank} />
          </div>
          <div className="knowledge-graph-readiness-inline">
            <header>
              <div>
                <strong>关系图谱</strong>
                <span>
                  {graphOverview
                    ? knowledgeGraphStatusLabel(graphOverview.status)
                    : graphLoading
                      ? '检查中'
                      : '不可用'}
                </span>
              </div>
              {graphOverview ? (
                <em
                  className={graphOverview.strongRetrievalReady ? 'status-ready' : 'status-failed'}
                >
                  {graphOverview.strongRetrievalReady ? '强关系检索就绪' : '未通过关系门禁'}
                </em>
              ) : null}
            </header>
            {graphOverview ? (
              <>
                <dl>
                  <div>
                    <dt>实体</dt>
                    <dd>{graphOverview.entityCount.toLocaleString()}</dd>
                  </div>
                  <div>
                    <dt>关系</dt>
                    <dd>{graphOverview.relationCount.toLocaleString()}</dd>
                  </div>
                  <div>
                    <dt>切片提及覆盖</dt>
                    <dd>{Math.round(graphOverview.mentionCoverage * 100)}%</dd>
                  </div>
                  <div>
                    <dt>关系证据覆盖</dt>
                    <dd>{Math.round(graphOverview.evidenceCoverage * 100)}%</dd>
                  </div>
                </dl>
                {graphOverview.readinessBlockers.length > 0 ? (
                  <ul>
                    {graphOverview.readinessBlockers.map((reason) => (
                      <li key={reason}>{knowledgeGraphReadinessReasonLabel(reason)}</li>
                    ))}
                  </ul>
                ) : null}
              </>
            ) : graphError ? (
              <p>关系图谱状态检查失败：{graphError}。为避免误标，当前不能声明强关系检索已就绪。</p>
            ) : (
              <p>正在核对实体、关系与来源证据。</p>
            )}
          </div>
          {result.degradedReason ? (
            <Notice tone="info">
              当前仅提供词法降级检索：{knowledgeReadinessReasonLabel(result.degradedReason)}（
              {result.degradedReason}）
            </Notice>
          ) : null}
          {result.activationBlockers.length > 0 ? (
            <div className="knowledge-activation-blockers" role="status">
              <strong>暂不能启用为企业知识库</strong>
              <ul>
                {result.activationBlockers.map((reason) => (
                  <li key={reason}>{knowledgeReadinessReasonLabel(reason)}</li>
                ))}
              </ul>
            </div>
          ) : (
            <Notice tone="success">
              已满足启用门禁：发布切片、当前模型向量覆盖及 Reranker 均已就绪。
            </Notice>
          )}
          {graphOverview?.strongRetrievalReady ? (
            <Notice tone="success">
              已满足强关系检索门禁：实体与关系可浏览，且关系均可追溯到来源切片证据。
            </Notice>
          ) : (
            <Notice tone="info">
              强关系检索门禁尚未通过；知识库即使具备语义检索，也不能标记为关系型知识库就绪。
            </Notice>
          )}
          {result.documents.failed > 0 || result.documents.processing > 0 ? (
            <div className="knowledge-readiness-actions">
              <span>
                {result.documents.failed > 0
                  ? `有 ${result.documents.failed} 篇文档处理失败，可进入文档管理查看安全错误原因并重试。`
                  : `有 ${result.documents.processing} 篇文档正在处理，页面可见时每 3 秒自动更新。`}
              </span>
              <button className="button secondary compact" type="button" onClick={onReviewFailures}>
                进入文档管理
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function ReadinessHeadline({ readiness }: { readiness: KnowledgeBaseIndexReadiness }): ReactNode {
  const summary = knowledgeReadinessSummary(readiness);
  const copy = {
    READY: ['企业就绪', '混合检索与重排链路已就绪'],
    DEGRADED: ['尚未就绪', '请完成下方阻断项后再启用'],
    PROCESSING: ['正在构建索引', '处理完成后将自动重新检查'],
    FAILED: ['存在失败文档', '请查看失败原因并安全重试'],
  }[summary];
  return (
    <div className={`knowledge-readiness-headline status-${summary.toLowerCase()}`}>
      <span>{copy[0]}</span>
      <strong>{copy[1]}</strong>
      <em>{readiness.retrievalMode === 'HYBRID' ? 'HYBRID' : 'LEXICAL'}</em>
    </div>
  );
}

function Metric({
  label,
  value,
  tone = 'neutral',
}: {
  label: string;
  value: number;
  tone?: 'neutral' | 'ready' | 'processing' | 'failed';
}): ReactNode {
  return (
    <div className={`knowledge-readiness-metric tone-${tone}`}>
      <span>{label}</span>
      <strong>{value.toLocaleString()}</strong>
    </div>
  );
}

function CapabilityCard({
  title,
  capability,
}: {
  title: string;
  capability: KnowledgeCapabilityReadiness;
}): ReactNode {
  return (
    <article className="knowledge-capability-card">
      <header>
        <strong>{title}</strong>
        <span className={`status-${capability.status.toLowerCase()}`}>
          {knowledgeCapabilityStatusLabel(capability.status)}
        </span>
      </header>
      <dl>
        <div>
          <dt>Provider</dt>
          <dd>{providerLabel(capability.provider)}</dd>
        </div>
        <div>
          <dt>模型</dt>
          <dd>{capability.model ?? '—'}</dd>
        </div>
        <div>
          <dt>维度</dt>
          <dd>{capability.dimensions?.toLocaleString() ?? '—'}</dd>
        </div>
      </dl>
    </article>
  );
}

function providerLabel(provider: KnowledgeCapabilityReadiness['provider']): string {
  return {
    disabled: '未配置',
    openai_compatible: 'OpenAI Compatible',
    cohere_compatible: 'Cohere Compatible',
  }[provider];
}
