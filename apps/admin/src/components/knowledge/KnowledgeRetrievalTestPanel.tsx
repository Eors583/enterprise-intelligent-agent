import type { KnowledgeBase, KnowledgeRetrievalTestResponse } from '@enterprise/contracts';
import { useState, type FormEvent, type ReactNode } from 'react';

import { testKnowledgeRetrieval } from '@/api/admin-api';
import { messageFromError } from '@/api/client';
import { EmptyState, FieldError, Notice, Spinner } from '@/components/ui';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function score(value: number): string {
  return value.toFixed(3);
}

export function KnowledgeRetrievalTestPanel({
  knowledgeBaseId,
  knowledgeBaseStatus,
}: {
  knowledgeBaseId: string;
  knowledgeBaseStatus: KnowledgeBase['status'];
}): ReactNode {
  const [query, setQuery] = useState('');
  const [userId, setUserId] = useState('');
  const [limit, setLimit] = useState(8);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<KnowledgeRetrievalTestResponse | null>(null);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setResult(null);
    const normalizedQuery = query.trim();
    const normalizedUserId = userId.trim();
    if (normalizedQuery.length < 2) {
      setError('请输入至少 2 个字符的问题。');
      return;
    }
    if (normalizedUserId && !UUID_PATTERN.test(normalizedUserId)) {
      setError('模拟用户 ID 必须是有效的 UUID。');
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      setResult(
        await testKnowledgeRetrieval(knowledgeBaseId, {
          query: normalizedQuery,
          limit,
          ...(normalizedUserId ? { userId: normalizedUserId } : {}),
        }),
      );
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="card knowledge-retrieval-panel knowledge-tab-panel">
      <header className="card-header">
        <div>
          <h2>检索测试</h2>
          <p>用真实权限和已发布版本验证智能体能否检索到正确切片。</p>
        </div>
      </header>
      {knowledgeBaseStatus === 'DRAFT' ? (
        <Notice tone="info">
          当前知识库仍是草稿。这里的结果仅供管理员预览，不会被员工智能体使用；验证完成并启用知识库后才会进入正式检索。
        </Notice>
      ) : null}
      {knowledgeBaseStatus === 'ARCHIVED' ? (
        <Notice tone="info">
          当前知识库已归档。这里保留历史检索诊断入口，但员工智能体不会使用该知识库。
        </Notice>
      ) : null}
      <form className="knowledge-retrieval-form" onSubmit={(event) => void submit(event)}>
        <label className="knowledge-retrieval-query">
          <span>测试问题</span>
          <textarea
            rows={3}
            value={query}
            maxLength={2000}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="例如：员工出差报销需要哪些材料？"
          />
        </label>
        <div className="form-grid two">
          <label>
            <span>模拟用户 ID（可选）</span>
            <input
              value={userId}
              onChange={(event) => setUserId(event.target.value)}
              placeholder="留空时使用当前管理员"
            />
          </label>
          <label>
            <span>最多返回</span>
            <select value={limit} onChange={(event) => setLimit(Number(event.target.value))}>
              {[5, 8, 10, 15, 20].map((value) => (
                <option value={value} key={value}>
                  {value} 个切片
                </option>
              ))}
            </select>
          </label>
        </div>
        <FieldError message={error} />
        <div className="editor-footer align-end">
          <button className="button primary" type="submit" disabled={submitting}>
            {submitting ? <Spinner label="正在检索…" /> : '运行检索测试'}
          </button>
        </div>
      </form>

      {result ? (
        <div className="knowledge-retrieval-results" aria-live="polite">
          <div className="knowledge-retrieval-summary">
            <span>
              检索模式 <strong>{result.mode === 'HYBRID' ? '语义混合检索' : '仅词法检索'}</strong>
            </span>
            <span>
              重排{' '}
              <strong>
                {result.reranker === 'CROSS_ENCODER' ? '模型 Reranker' : result.reranker}
              </strong>
            </span>
            <span>
              命中 <strong>{result.items.length}</strong> 个切片
            </span>
            <span>
              耗时 <strong>{Math.round(result.elapsedMs)} ms</strong>
            </span>
            <span>
              权限内知识库 <strong>{result.accessibleKnowledgeBaseIds.length}</strong> 个
            </span>
            <span>
              候选 <strong>{result.lexicalCandidateCount}</strong> 词法 /{' '}
              <strong>{result.vectorCandidateCount}</strong> 向量
            </span>
            <span>
              向量覆盖 <strong>{Math.round(result.semanticCoverage * 100)}%</strong>
            </span>
          </div>
          {result.degradedReason ? (
            <Notice tone="info">
              语义检索已安全降级（{result.degradedReason}）。当前结果不可标记为完整语义 RAG。
            </Notice>
          ) : null}
          {result.noAnswer || result.items.length === 0 ? (
            <Notice tone="info">
              未找到达到阈值且当前用户有权访问的内容。智能体应返回“暂无可信答案”，不会拼接无依据回复。
            </Notice>
          ) : (
            <div className="knowledge-retrieval-result-list">
              {result.items.map((item, index) => (
                <article key={item.chunkId}>
                  <header>
                    <span className="knowledge-result-rank">{index + 1}</span>
                    <div>
                      <strong>{item.title}</strong>
                      <small>
                        {item.knowledgeBaseName} · v{item.documentVersion}
                        {item.headingPath.length > 0 ? ` · ${item.headingPath.join(' / ')}` : ''}
                      </small>
                    </div>
                    <span className="knowledge-result-score">综合 {score(item.finalScore)}</span>
                  </header>
                  <p>{item.excerpt}</p>
                  <footer>
                    <span>关键词 {score(item.keywordScore)}</span>
                    <span>模糊匹配 {score(item.fuzzyScore)}</span>
                    <span>
                      向量 {item.semanticScore === null ? '—' : score(item.semanticScore)}
                    </span>
                    <span>融合 {score(item.fusionScore)}</span>
                    <span>
                      Reranker {item.rerankerScore === null ? '—' : score(item.rerankerScore)}
                    </span>
                    <code>{item.chunkId}</code>
                  </footer>
                </article>
              ))}
            </div>
          )}
        </div>
      ) : (
        <EmptyState
          title="验证知识是否可检索"
          description="输入一个员工可能提出的问题，查看命中的文档版本、章节、分数与耗时。"
        />
      )}
    </section>
  );
}
