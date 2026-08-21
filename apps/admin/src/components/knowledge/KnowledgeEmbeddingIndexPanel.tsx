import type {
  KnowledgeBase,
  KnowledgeBaseIndexReadiness,
  KnowledgeEmbeddingIndexVersion,
} from '@enterprise/contracts';
import { useEffect, useMemo, useState, type ReactNode } from 'react';

import {
  activateKnowledgeEmbeddingIndexVersion,
  createKnowledgeEmbeddingIndexVersion,
  listKnowledgeEmbeddingIndexVersions,
} from '@/api/admin-api';
import { messageFromError } from '@/api/client';

export function KnowledgeEmbeddingIndexPanel({
  knowledgeBase,
  readiness,
  onChanged,
}: {
  knowledgeBase: KnowledgeBase;
  readiness: KnowledgeBaseIndexReadiness | null;
  onChanged: (message: string) => void;
}): ReactNode {
  const [items, setItems] = useState<KnowledgeEmbeddingIndexVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const runtimeProfile = useMemo(() => runtimeEmbeddingProfile(readiness), [readiness]);
  const active = knowledgeBase.activeEmbeddingIndexVersion;
  const pending = knowledgeBase.pendingEmbeddingIndexVersion;

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void listKnowledgeEmbeddingIndexVersions(knowledgeBase.id, controller.signal)
      .then((response) => {
        setItems([...response.items]);
        setError(null);
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) setError(messageFromError(caught));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [knowledgeBase.id, active?.id, pending?.id]);

  const createVersion = async (): Promise<void> => {
    if (runtimeProfile === null) {
      setError('AI Runtime 当前没有可用的向量化模型，请先在高级设置中配置并启动模型。');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await createKnowledgeEmbeddingIndexVersion(knowledgeBase.id, runtimeProfile);
      onChanged('新的向量索引版本已创建。请重建当前发布文档，覆盖完成后再激活。');
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setSubmitting(false);
    }
  };

  const activate = async (): Promise<void> => {
    if (pending === null) return;
    setSubmitting(true);
    setError(null);
    try {
      await activateKnowledgeEmbeddingIndexVersion(knowledgeBase.id, pending.id);
      onChanged(`向量索引 v${pending.version} 已激活，旧版本已保留为可追溯历史。`);
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setSubmitting(false);
    }
  };

  const runtimeMatchesActive =
    runtimeProfile !== null &&
    active !== null &&
    runtimeProfile.provider === active.provider &&
    runtimeProfile.model === active.model &&
    runtimeProfile.dimensions === active.dimensions;

  return (
    <section className="form-stack knowledge-embedding-index-panel">
      <header className="card-header">
        <div>
          <h3>向量模型与索引版本</h3>
          <p>模型、维度和索引版本绑定保存。更换模型会先建立新索引，不会直接覆盖当前可用版本。</p>
        </div>
      </header>

      <div className="form-grid two">
        <IndexSummary title="当前生效" index={active} empty="尚未配置语义索引" />
        <IndexSummary title="待切换" index={pending} empty="没有正在重建的版本" />
      </div>

      <div className="knowledge-index-runtime-summary">
        <strong>AI Runtime 当前提供：</strong>{' '}
        {runtimeProfile === null
          ? '向量化能力未就绪'
          : `${runtimeProfile.provider} · ${runtimeProfile.model} · ${runtimeProfile.dimensions} 维`}
      </div>

      {pending === null ? (
        <button
          type="button"
          className="secondary-button"
          disabled={submitting || runtimeProfile === null || runtimeMatchesActive}
          onClick={() => void createVersion()}
        >
          {runtimeMatchesActive ? '当前模型已经生效' : '用当前 AI Runtime 创建新索引版本'}
        </button>
      ) : (
        <div className="form-stack">
          <p className="muted-text">
            下一步：到“文档管理”中为每份当前发布文档执行“重建向量”，完成后返回这里激活。
          </p>
          <button
            type="button"
            className="primary-button"
            disabled={submitting}
            onClick={() => void activate()}
          >
            校验覆盖率并激活 v{pending.version}
          </button>
        </div>
      )}

      {error === null ? null : <p className="form-error">{error}</p>}

      <details className="knowledge-advanced-settings">
        <summary>索引版本历史</summary>
        {loading ? (
          <p className="muted-text">正在读取索引版本……</p>
        ) : items.length === 0 ? (
          <p className="muted-text">暂无索引版本。</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>版本</th>
                  <th>状态</th>
                  <th>模型</th>
                  <th>维度</th>
                  <th>创建时间</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id}>
                    <td>v{item.version}</td>
                    <td>{indexStatusLabel(item.status)}</td>
                    <td>{item.model}</td>
                    <td>{item.dimensions}</td>
                    <td>{new Date(item.createdAt).toLocaleString('zh-CN')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </details>
    </section>
  );
}

function IndexSummary({
  title,
  index,
  empty,
}: {
  title: string;
  index: KnowledgeEmbeddingIndexVersion | null;
  empty: string;
}): ReactNode {
  return (
    <article className="knowledge-embedding-version-summary">
      <strong>{title}</strong>
      {index === null ? (
        <p>{empty}</p>
      ) : (
        <dl>
          <div>
            <dt>版本</dt>
            <dd>v{index.version}</dd>
          </div>
          <div>
            <dt>模型</dt>
            <dd>{index.model}</dd>
          </div>
          <div>
            <dt>维度</dt>
            <dd>{index.dimensions}</dd>
          </div>
          <div>
            <dt>状态</dt>
            <dd>{indexStatusLabel(index.status)}</dd>
          </div>
        </dl>
      )}
    </article>
  );
}

function runtimeEmbeddingProfile(readiness: KnowledgeBaseIndexReadiness | null): {
  provider: 'openai_compatible' | 'local_fastembed';
  model: string;
  dimensions: number;
  distance: 'COSINE';
  normalization: 'L2';
} | null {
  const embedding = readiness?.embedding;
  if (
    embedding?.status !== 'READY' ||
    (embedding.provider !== 'openai_compatible' && embedding.provider !== 'local_fastembed') ||
    embedding.model === null ||
    embedding.dimensions === null
  ) {
    return null;
  }
  return {
    provider: embedding.provider,
    model: embedding.model,
    dimensions: embedding.dimensions,
    distance: 'COSINE',
    normalization: 'L2',
  };
}

function indexStatusLabel(status: KnowledgeEmbeddingIndexVersion['status']): string {
  return {
    BUILDING: '重建中',
    ACTIVE: '生效中',
    RETIRED: '已退役',
    FAILED: '失败',
  }[status];
}
