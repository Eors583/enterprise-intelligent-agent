import type { KnowledgeBase, KnowledgeDocumentVersionDetail } from '@enterprise/contracts';
import { useCallback, useEffect, useState, type ReactNode } from 'react';

import { listPendingKnowledgeParseReviews, reviewKnowledgeDocumentParse } from '@/api/admin-api';
import { messageFromError } from '@/api/client';
import { FieldError, Spinner, StatusPill } from '@/components/ui';

export function KnowledgeParseReviewPanel({
  item,
  onChanged,
}: {
  readonly item: KnowledgeBase;
  readonly onChanged: (message: string) => void;
}): ReactNode {
  const [items, setItems] = useState<readonly KnowledgeDocumentVersionDetail[]>([]);
  const [loading, setLoading] = useState(true);
  const [changingId, setChangingId] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      try {
        const result = await listPendingKnowledgeParseReviews(item.id, signal);
        setItems(result.items);
        setError(null);
      } catch (caught) {
        if (signal?.aborted) return;
        setError(messageFromError(caught));
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [item.id],
  );

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const review = async (
    version: KnowledgeDocumentVersionDetail,
    decision: 'APPROVE' | 'REJECT',
  ): Promise<void> => {
    setChangingId(version.id);
    setError(null);
    try {
      await reviewKnowledgeDocumentParse(item.id, version.documentId, version.id, {
        decision,
        expectedReviewRevision: version.parseReviewRevision,
        ...(note.trim() === '' ? {} : { note: note.trim() }),
      });
      setSelectedId(null);
      setNote('');
      await load();
      onChanged(decision === 'APPROVE' ? '解析质检已批准，可进入评测发布。' : '解析质检已驳回。');
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setChangingId(null);
    }
  };

  if (loading) {
    return (
      <div id="knowledge-parse-review-queue" className="knowledge-parse-review-panel">
        <Spinner label="加载解析质检队列…" />
      </div>
    );
  }
  if (items.length === 0 && error === null) return null;

  return (
    <section
      id="knowledge-parse-review-queue"
      className="knowledge-parse-review-panel"
      aria-label="解析质检队列"
    >
      <header>
        <div>
          <strong>解析质检</strong>
          <span>{items.length} 个文件或网页版本等待独立复核</span>
        </div>
        <StatusPill value={items.length > 0 ? 'PENDING' : 'READY'} label={`${items.length} 待审`} />
      </header>
      <FieldError message={error} />
      {items.map((version) => {
        const document = item.documents.find((candidate) => candidate.id === version.documentId);
        const reasons = parseReasons(version.parseDiagnostics);
        const selected = selectedId === version.id;
        return (
          <article key={version.id}>
            <div>
              <strong>
                {document?.title ?? '知识文档'} · v{version.versionNumber}
              </strong>
              <small>
                {version.parserName ?? '未知解析器'} · 质量分{' '}
                {version.parseQualityScore === null
                  ? '未生成'
                  : `${Math.round(version.parseQualityScore * 100)}%`}
              </small>
              {version.sourceUri === null ? null : (
                <small className="knowledge-parse-source-uri" title={version.sourceUri}>
                  来源：{version.sourceUri}
                </small>
              )}
              {reasons.length > 0 ? <p>诊断：{reasons.join('、')}</p> : null}
            </div>
            {selected ? (
              <div className="knowledge-parse-review-form">
                <textarea
                  aria-label="解析质检意见"
                  placeholder="驳回时必须填写原因；批准意见可选"
                  maxLength={2000}
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  disabled={changingId !== null}
                />
                <div>
                  <button
                    className="button secondary compact"
                    type="button"
                    onClick={() => {
                      setSelectedId(null);
                      setNote('');
                    }}
                    disabled={changingId !== null}
                  >
                    取消
                  </button>
                  <button
                    className="button danger-ghost compact"
                    type="button"
                    onClick={() => void review(version, 'REJECT')}
                    disabled={changingId !== null || note.trim() === ''}
                  >
                    驳回
                  </button>
                  <button
                    className="button primary compact"
                    type="button"
                    onClick={() => void review(version, 'APPROVE')}
                    disabled={changingId !== null}
                  >
                    {changingId === version.id ? <Spinner label="提交中…" /> : '批准解析'}
                  </button>
                </div>
              </div>
            ) : (
              <button
                className="button secondary compact"
                type="button"
                onClick={() => setSelectedId(version.id)}
              >
                复核
              </button>
            )}
          </article>
        );
      })}
    </section>
  );
}

function parseReasons(diagnostics: Record<string, unknown>): string[] {
  const reasons = diagnostics.lowQualityReasons;
  if (!Array.isArray(reasons)) return [];
  return reasons.filter((reason): reason is string => typeof reason === 'string').slice(0, 5);
}
