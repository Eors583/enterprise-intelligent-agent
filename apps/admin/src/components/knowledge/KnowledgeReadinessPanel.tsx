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
  knowledgeCapabilityRecoveryPollingRequired,
  knowledgeCapabilityStatusLabel,
  knowledgeReadinessReasonLabel,
  knowledgeReadinessSummary,
} from './knowledge-readiness-view';
import {
  knowledgeGraphReadinessReasonLabel,
  knowledgeGraphStatusLabel,
} from './knowledge-graph-view';

const POLL_INTERVAL_MS = 3_000;
const CAPABILITY_RECOVERY_POLL_INTERVAL_MS = 5_000;

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
  const [capabilityReloadKey, setCapabilityReloadKey] = useState(0);
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
  }, [capabilityReloadKey, knowledgeBaseId, onReadinessChange, refreshToken, reloadKey]);

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

  useEffect(() => {
    if (!knowledgeCapabilityRecoveryPollingRequired(result)) return;
    let timer: number | null = null;
    const schedule = (): void => {
      if (timer !== null || document.visibilityState !== 'visible') return;
      timer = window.setTimeout(() => {
        timer = null;
        setCapabilityReloadKey((value) => value + 1);
      }, CAPABILITY_RECOVERY_POLL_INTERVAL_MS);
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
    <section className="card knowledge-readiness-panel" aria-label="检索运行状态与索引诊断">
      <header className="card-header">
        <div>
          <h2>检索运行状态</h2>
          <p>查看文档、向量、重排和关系图谱状态；诊断异常不会阻止知识库启用或文档发布。</p>
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

      {loading && result === null ? <LoadingPanel label="正在检查知识库检索状态…" /> : null}
      {error && result === null ? <ErrorState message={error} onRetry={retry} /> : null}
      {result ? (
        <div className="knowledge-readiness-content">
          <ReadinessHeadline readiness={result} />
          {error ? (
            <Notice tone="info">本次状态刷新失败，正在保留上一次安全结果：{error}</Notice>
          ) : null}
          <div className="knowledge-readiness-metrics">
            <Metric
              label="文档总数"
              value={Math.max(0, result.documents.total - result.documents.archived)}
            />
            <Metric label="已就绪" value={result.documents.ready} tone="ready" />
            <Metric label="处理中" value={result.documents.processing} tone="processing" />
            <Metric label="失败" value={result.documents.failed} tone="failed" />
            <Metric label="草稿" value={result.documents.draft} />
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
                  className={
                    graphOverview.status === 'READY' ? 'status-ready' : 'status-processing'
                  }
                >
                  {graphOverview.status === 'READY' ? '关系检索可用' : '可选增强未就绪'}
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
                {graphOverview.diagnostics.length > 0 ? (
                  <ul>
                    {graphOverview.diagnostics.map((reason) => (
                      <li key={reason}>{knowledgeGraphReadinessReasonLabel(reason)}</li>
                    ))}
                  </ul>
                ) : null}
              </>
            ) : graphError ? (
              <p>关系图谱状态检查失败：{graphError}。普通文档检索不受影响。</p>
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
          {result.retrievalMode === 'HYBRID' ? (
            <Notice tone="success">
              混合检索可用：关键词与向量召回会按知识库配置执行，Reranker 可按需参与重排。
            </Notice>
          ) : (
            <Notice tone="info">当前使用关键词检索；知识库仍可正常启用和验证。</Notice>
          )}
          {graphOverview?.status === 'READY' ? (
            <Notice tone="success">关系图谱增强可用，可在普通混合检索之外补充实体关系路径。</Notice>
          ) : (
            <Notice tone="info">
              关系图谱是可选增强；尚未构建或质量不足时，系统继续使用普通文档检索。
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
    READY: ['混合检索可用', '关键词与向量召回链路运行正常'],
    DEGRADED: ['关键词检索可用', '向量能力不可用时自动降级，不阻塞使用'],
    PROCESSING: ['正在构建索引', '处理完成后将自动重新检查'],
    FAILED: ['部分文档处理失败', '其他已发布文档仍可检索，可按需重试失败项'],
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
    local_fastembed: '本地中文模型',
  }[provider];
}
