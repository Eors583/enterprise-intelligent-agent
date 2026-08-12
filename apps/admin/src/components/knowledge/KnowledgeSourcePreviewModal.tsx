import type {
  KnowledgeRetrievalTestResponse,
  KnowledgeStructuredDocumentPreview,
} from '@enterprise/contracts';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { getKnowledgeDocumentSource, getKnowledgeStructuredDocumentPreview } from '@/api/admin-api';
import type { BinaryApiResponse } from '@/api/client';
import { messageFromError } from '@/api/client';
import { LoadingPanel, Modal, Notice } from '@/components/ui';

import { StructuredContentPreview } from './KnowledgeStructuredPreviewModal';

type RetrievalItem = KnowledgeRetrievalTestResponse['items'][number];

interface LoadedSource extends BinaryApiResponse {
  readonly objectUrl: string;
}

export function KnowledgeSourcePreviewModal({
  item,
  onClose,
}: {
  item: RetrievalItem;
  onClose: () => void;
}): ReactNode {
  const [source, setSource] = useState<LoadedSource | null>(null);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [structured, setStructured] = useState<KnowledgeStructuredDocumentPreview | null>(null);
  const [structuredError, setStructuredError] = useState<string | null>(null);

  useEffect(() => {
    if (!item.sourceDownloadAvailable) return;
    const controller = new AbortController();
    let objectUrl: string | null = null;
    void getKnowledgeDocumentSource(
      item.knowledgeBaseId,
      item.documentId,
      item.documentVersionId,
      controller.signal,
    )
      .then((response) => {
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(response.blob);
        setSource({ ...response, objectUrl });
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) setSourceError(messageFromError(caught));
      });
    return () => {
      controller.abort();
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
    };
  }, [item.documentId, item.documentVersionId, item.knowledgeBaseId, item.sourceDownloadAvailable]);

  useEffect(() => {
    if (!item.structuredPreviewAvailable || item.sheetName === null) return;
    const controller = new AbortController();
    void getKnowledgeStructuredDocumentPreview(
      item.knowledgeBaseId,
      item.documentId,
      item.documentVersionId,
      controller.signal,
    )
      .then((response) => {
        if (!controller.signal.aborted) setStructured(response);
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) setStructuredError(messageFromError(caught));
      });
    return () => controller.abort();
  }, [
    item.documentId,
    item.documentVersionId,
    item.knowledgeBaseId,
    item.sheetName,
    item.structuredPreviewAvailable,
  ]);

  const pdf = isPdfSource(item, source?.mimeType ?? null);
  const locator = knowledgeSourceLocatorLabel(item);
  const sourceFileName = source?.fileName ?? item.sourceFileName ?? item.title;
  return (
    <Modal
      title={`原文定位 · ${item.title}`}
      description={`v${item.documentVersion} · ${locator}`}
      onClose={onClose}
      size="wide"
    >
      <div className="knowledge-source-preview">
        <section className="knowledge-source-location-card">
          <div>
            <span>已定位</span>
            <strong>{locator}</strong>
          </div>
          {item.headingPath.length > 0 ? <p>{item.headingPath.join(' / ')}</p> : null}
          <blockquote>{sourceEvidenceExcerpt(item.excerpt)}</blockquote>
          <div className="knowledge-source-actions">
            {source ? (
              <a className="button secondary" href={source.objectUrl} download={sourceFileName}>
                下载原文件
              </a>
            ) : null}
            {item.sourceUri ? (
              <a className="button ghost" href={item.sourceUri} target="_blank" rel="noreferrer">
                打开原网页
              </a>
            ) : null}
          </div>
        </section>

        {item.sourceDownloadAvailable && source === null && sourceError === null ? (
          <LoadingPanel label="正在安全读取原文件…" />
        ) : null}
        {sourceError ? <Notice tone="error">原文件读取失败：{sourceError}</Notice> : null}

        {pdf && source ? (
          <section className="knowledge-source-pdf">
            <header>
              <div>
                <span>PDF 原文预览</span>
                <h3>{sourceFileName}</h3>
              </div>
              <small>{item.pageStart === null ? '未标注页码' : `第 ${item.pageStart} 页`}</small>
            </header>
            <KnowledgePdfPagePreview
              blob={source.blob}
              pageNumber={item.pageStart ?? 1}
              title={`${item.title} PDF 原文`}
            />
          </section>
        ) : null}

        {item.sheetName !== null &&
        item.structuredPreviewAvailable &&
        structured === null &&
        structuredError === null ? (
          <LoadingPanel label={`正在定位工作表“${item.sheetName}”…`} />
        ) : null}
        {structuredError ? <Notice tone="error">工作表定位失败：{structuredError}</Notice> : null}
        {structured && item.sheetName ? (
          <StructuredContentPreview content={structured.content} targetSheetName={item.sheetName} />
        ) : null}

        {!pdf && item.sheetName === null ? (
          <Notice tone="info">
            已定位到上方章节和引用片段。浏览器无法原生嵌入此文件格式时，可下载原件后在 Office
            或系统默认程序中打开。
          </Notice>
        ) : null}
      </div>
    </Modal>
  );
}

function KnowledgePdfPagePreview({
  blob,
  pageNumber,
  title,
}: {
  blob: Blob;
  pageNumber: number;
  title: string;
}): ReactNode {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [resolvedPage, setResolvedPage] = useState(pageNumber);
  const [pageCount, setPageCount] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    let renderTask: { cancel: () => void } | null = null;
    let loadingTask: { destroy: () => Promise<void> } | null = null;
    setLoading(true);
    setError(null);
    void (async () => {
      const [{ getDocument, GlobalWorkerOptions }, workerModule] = await Promise.all([
        import('pdfjs-dist'),
        import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
      ]);
      GlobalWorkerOptions.workerSrc = workerModule.default;
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (cancelled) return;
      const task = getDocument({ data: bytes });
      loadingTask = task;
      const document = await task.promise;
      const targetPage = Math.min(document.numPages, Math.max(1, pageNumber));
      const page = await document.getPage(targetPage);
      if (cancelled) return;
      const canvas = canvasRef.current;
      const context = canvas?.getContext('2d');
      if (canvas === null || context === null || context === undefined) {
        throw new Error('浏览器不支持 PDF 画布预览。');
      }
      const viewport = page.getViewport({ scale: 1.45 });
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const taskRender = page.render({ canvas, canvasContext: context, viewport });
      renderTask = taskRender;
      await taskRender.promise;
      if (cancelled) return;
      setResolvedPage(targetPage);
      setPageCount(document.numPages);
      setLoading(false);
    })().catch((caught: unknown) => {
      if (cancelled || (caught instanceof Error && caught.name === 'RenderingCancelledException')) {
        return;
      }
      setError(messageFromError(caught));
      setLoading(false);
    });
    return () => {
      cancelled = true;
      renderTask?.cancel();
      void loadingTask?.destroy();
    };
  }, [blob, pageNumber]);

  return (
    <div className="knowledge-source-pdf-canvas" aria-label={title}>
      {loading ? <LoadingPanel label={`正在渲染 PDF 第 ${pageNumber} 页…`} /> : null}
      {error ? <Notice tone="error">PDF 页面渲染失败：{error}</Notice> : null}
      <canvas ref={canvasRef} hidden={loading || error !== null} />
      {!loading && error === null && pageCount !== null ? (
        <small>
          已渲染第 {resolvedPage} / {pageCount} 页
        </small>
      ) : null}
    </div>
  );
}

export function knowledgeSourceLocatorLabel(
  item: Pick<RetrievalItem, 'pageStart' | 'pageEnd' | 'sheetName' | 'headingPath'>,
): string {
  if (item.sheetName !== null) return `工作表“${item.sheetName}”`;
  if (item.pageStart !== null) {
    return item.pageEnd !== null && item.pageEnd !== item.pageStart
      ? `第 ${item.pageStart}–${item.pageEnd} 页`
      : `第 ${item.pageStart} 页`;
  }
  return item.headingPath.length > 0 ? `章节“${item.headingPath.join(' / ')}”` : '原文引用片段';
}

function isPdfSource(
  item: Pick<RetrievalItem, 'sourceMimeType' | 'sourceFileName'>,
  loadedMimeType: string | null,
): boolean {
  const mimeType = loadedMimeType ?? item.sourceMimeType;
  return (
    mimeType === 'application/pdf' ||
    item.sourceFileName?.toLocaleLowerCase().endsWith('.pdf') === true
  );
}

function sourceEvidenceExcerpt(excerpt: string): string {
  if (!excerpt.startsWith('[结构化 SQL 查询结果]')) return excerpt;
  return excerpt
    .replace(/^\[结构化 SQL 查询结果\]\s*/u, '')
    .replace(/\s+SQL：[\s\S]*$/u, '')
    .trim();
}
