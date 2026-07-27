import type {
  KnowledgeDocumentChunkListResponse,
  KnowledgeDocumentSummary,
  KnowledgeDocumentVersionSummary,
} from '@enterprise/contracts';
import { useEffect, useState, type ReactNode } from 'react';

import { listKnowledgeDocumentChunks } from '@/api/admin-api';
import { messageFromError } from '@/api/client';
import { EmptyState, ErrorState, LoadingPanel, Modal } from '@/components/ui';

const PAGE_SIZE = 10;

export function KnowledgeChunkPreviewModal({
  knowledgeBaseId,
  document,
  version,
  onClose,
}: {
  knowledgeBaseId: string;
  document: KnowledgeDocumentSummary;
  version: KnowledgeDocumentVersionSummary;
  onClose: () => void;
}): ReactNode {
  const [offset, setOffset] = useState(0);
  const [reloadKey, setReloadKey] = useState(0);
  const [result, setResult] = useState<KnowledgeDocumentChunkListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void listKnowledgeDocumentChunks(
      knowledgeBaseId,
      document.id,
      version.id,
      { offset, limit: PAGE_SIZE },
      controller.signal,
    )
      .then((response) => {
        if (!controller.signal.aborted) setResult(response);
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) setError(messageFromError(caught));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [document.id, knowledgeBaseId, offset, reloadKey, version.id]);

  const retry = (): void => setReloadKey((value) => value + 1);
  const total = result?.total ?? version.chunkCount;
  const pageNumber = Math.floor(offset / PAGE_SIZE) + 1;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <Modal
      title={`“${document.title}”v${version.versionNumber} · 解析切片`}
      description="检查解析后的正文、章节、页码和向量覆盖；智能体检索使用的是这里展示的切片。"
      onClose={onClose}
      size="wide"
    >
      {loading && result === null ? <LoadingPanel label="正在读取解析切片…" /> : null}
      {error && result === null ? <ErrorState message={error} onRetry={retry} /> : null}
      {result ? (
        <div className="knowledge-chunk-preview">
          <div className="knowledge-chunk-summary" aria-live="polite">
            <span>
              共 <strong>{result.total}</strong> 个切片
            </span>
            <span>
              已向量化{' '}
              <strong>
                {result.embeddedChunkCount} / {result.total}
              </strong>
            </span>
            <span>
              语义覆盖 <strong>{Math.round(result.semanticCoverage * 100)}%</strong>
            </span>
          </div>
          {error ? (
            <div className="knowledge-inline-error" role="alert">
              <span>刷新当前页失败：{error}</span>
              <button className="button secondary compact" type="button" onClick={retry}>
                重试
              </button>
            </div>
          ) : null}
          {result.items.length === 0 ? (
            <EmptyState
              title="当前版本没有可查看的切片"
              description="请等待解析完成；若处理失败，请返回文档列表重试。"
            />
          ) : (
            <div className="knowledge-chunk-list">
              {result.items.map((chunk) => (
                <article className="knowledge-chunk-card" key={chunk.id}>
                  <header>
                    <div>
                      <strong>切片 #{chunk.chunkIndex + 1}</strong>
                      <small>
                        {chunk.headingPath.length > 0
                          ? chunk.headingPath.join(' / ')
                          : '未识别章节标题'}
                      </small>
                    </div>
                    <span>{formatPageRange(chunk.pageStart, chunk.pageEnd)}</span>
                  </header>
                  <pre>{chunk.content}</pre>
                  <footer>
                    <span>{chunk.tokenCount.toLocaleString()} tokens</span>
                    <span>
                      Embedding：
                      {chunk.embeddingModels.length > 0
                        ? chunk.embeddingModels.join('、')
                        : '未生成'}
                    </span>
                    <code title={chunk.contentHash}>哈希 {chunk.contentHash.slice(0, 12)}…</code>
                  </footer>
                </article>
              ))}
            </div>
          )}
          <div className="knowledge-chunk-pagination" aria-label="切片分页">
            <button
              className="button secondary compact"
              type="button"
              disabled={loading || offset === 0}
              onClick={() => setOffset((value) => Math.max(0, value - PAGE_SIZE))}
            >
              上一页
            </button>
            <span>
              第 {pageNumber} / {pageCount} 页
            </span>
            <button
              className="button secondary compact"
              type="button"
              disabled={loading || offset + PAGE_SIZE >= total}
              onClick={() => setOffset((value) => value + PAGE_SIZE)}
            >
              下一页
            </button>
          </div>
        </div>
      ) : null}
    </Modal>
  );
}

function formatPageRange(pageStart: number | null, pageEnd: number | null): string {
  if (pageStart === null) return '无页码信息';
  if (pageEnd === null || pageEnd === pageStart) return `第 ${pageStart} 页`;
  return `第 ${pageStart}–${pageEnd} 页`;
}
