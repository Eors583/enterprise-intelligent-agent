import type {
  KnowledgeDocumentSummary,
  KnowledgeDocumentVersionSummary,
  KnowledgeStructuredDocumentPreview,
} from '@enterprise/contracts';
import { useEffect, useState, type ReactNode } from 'react';

import { getKnowledgeStructuredDocumentPreview } from '@/api/admin-api';
import { messageFromError } from '@/api/client';
import { ErrorState, LoadingPanel, Modal, Notice } from '@/components/ui';

interface StructuredWorkbookTable {
  readonly name: string;
  readonly rows: readonly (readonly string[])[];
}

export function KnowledgeStructuredPreviewModal({
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
  const [reloadKey, setReloadKey] = useState(0);
  const [result, setResult] = useState<KnowledgeStructuredDocumentPreview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setResult(null);
    setError(null);
    void getKnowledgeStructuredDocumentPreview(
      knowledgeBaseId,
      document.id,
      version.id,
      controller.signal,
    )
      .then((response) => {
        if (!controller.signal.aborted) setResult(response);
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) setError(messageFromError(caught));
      });
    return () => controller.abort();
  }, [document.id, knowledgeBaseId, reloadKey, version.id]);

  return (
    <Modal
      title={`“${document.title}” v${version.versionNumber} · 结构化解析`}
      description="先按工作表检查表头和数据是否正确；需要排查解析细节时再展开原始结构数据。"
      onClose={onClose}
      size="wide"
    >
      {result === null && error === null ? <LoadingPanel label="正在读取结构化解析结果…" /> : null}
      {error ? (
        <ErrorState message={error} onRetry={() => setReloadKey((value) => value + 1)} />
      ) : null}
      {result ? (
        <div className="knowledge-chunk-preview">
          <div className="knowledge-chunk-summary">
            <span>格式：{result.format}</span>
            <span>大小：{formatBytes(result.size)}</span>
            <code title={result.sha256}>SHA-256 {result.sha256.slice(0, 12)}…</code>
          </div>
          {result.truncated ? (
            <Notice tone="info">
              当前页面只展示安全裁剪后的预览，完整解析结果仍保存在对象存储中。
            </Notice>
          ) : null}
          <StructuredContentPreview content={result.content} />
          <details className="knowledge-structured-raw">
            <summary>查看原始结构数据（高级）</summary>
            <article className="knowledge-chunk-card">
              <pre>{JSON.stringify(result.content, null, 2)}</pre>
            </article>
          </details>
        </div>
      ) : null}
    </Modal>
  );
}

export function StructuredContentPreview({
  content,
  targetSheetName = null,
}: {
  content: unknown;
  targetSheetName?: string | null;
}): ReactNode {
  const tables = extractWorkbookTables(content);
  if (tables.length === 0) {
    return (
      <Notice tone="info">当前格式暂不能转换成可视表格。请展开“原始结构数据”检查解析内容。</Notice>
    );
  }
  const normalizedTarget = targetSheetName?.trim().toLocaleLowerCase() ?? null;
  const targetTable =
    normalizedTarget === null
      ? undefined
      : tables.find((table) => table.name.trim().toLocaleLowerCase() === normalizedTarget);
  const visibleTables = targetTable === undefined ? tables : [targetTable];
  return (
    <div className="knowledge-structured-sheets">
      {targetSheetName === null ? (
        <Notice tone="success">
          已识别 {tables.length}{' '}
          个工作表。请重点核对表头、行列和关键数值；这里仅用于预览，不会修改原文件。
        </Notice>
      ) : targetTable ? (
        <Notice tone="success">已精确定位到工作表“{targetTable.name}”。</Notice>
      ) : (
        <Notice tone="info">
          未找到名为“{targetSheetName}”的工作表，已展示全部 {tables.length} 个工作表供核对。
        </Notice>
      )}
      {visibleTables.map((table, tableIndex) => {
        const [header = [], ...dataRows] = table.rows;
        const visibleRows = dataRows.slice(0, 50);
        return (
          <section className="knowledge-structured-sheet" key={`${table.name}-${tableIndex}`}>
            <header>
              <div>
                <span>{targetTable ? '定位工作表' : `工作表 ${tableIndex + 1}`}</span>
                <h3>{table.name}</h3>
              </div>
              <small>
                {dataRows.length.toLocaleString()} 行 · {header.length.toLocaleString()} 列
              </small>
            </header>
            <div className="knowledge-structured-table-wrap">
              <table>
                <thead>
                  <tr>
                    {header.map((cell, columnIndex) => (
                      <th key={`${columnIndex}-${cell}`}>{cell || `第 ${columnIndex + 1} 列`}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {visibleRows.map((row, rowIndex) => (
                    <tr key={rowIndex}>
                      {header.map((_, columnIndex) => (
                        <td key={columnIndex}>{row[columnIndex] ?? ''}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {visibleRows.length < dataRows.length ? (
              <p>当前预览前 50 行，完整数据仍保存在原始文件与结构化产物中。</p>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

export function extractWorkbookTables(content: unknown): readonly StructuredWorkbookTable[] {
  if (!isRecord(content)) return [];
  if (content.kind === 'docling-document') return extractDoclingTables(content);
  if (content.kind !== 'workbook' || !Array.isArray(content.sheets)) return [];
  return content.sheets.flatMap((sheet, sheetIndex): StructuredWorkbookTable[] => {
    if (!isRecord(sheet) || !Array.isArray(sheet.rows)) return [];
    const rows = sheet.rows.flatMap((row): string[][] => {
      if (!isRecord(row) || !Array.isArray(row.cells)) return [];
      const cells = row.cells
        .flatMap((cell): { column: number; display: string }[] => {
          if (!isRecord(cell) || !Number.isSafeInteger(cell.column)) return [];
          const display = displayValue(cell.display);
          return display === null ? [] : [{ column: cell.column as number, display }];
        })
        .sort((left, right) => left.column - right.column);
      return cells.length === 0 ? [] : [cells.map((cell) => cell.display)];
    });
    if (rows.length === 0) return [];
    return [
      {
        name:
          typeof sheet.name === 'string' && sheet.name.trim()
            ? sheet.name.trim()
            : `工作表 ${sheetIndex + 1}`,
        rows,
      },
    ];
  });
}

function extractDoclingTables(
  content: Record<string, unknown>,
): readonly StructuredWorkbookTable[] {
  const document = content.document;
  if (!isRecord(document) || !Array.isArray(document.tables)) return [];
  const sheetNames = new Map<string, string>();
  if (Array.isArray(document.groups)) {
    for (const group of document.groups) {
      if (
        !isRecord(group) ||
        typeof group.self_ref !== 'string' ||
        typeof group.name !== 'string'
      ) {
        continue;
      }
      const name = group.name.replace(/^sheet:\s*/iu, '').trim();
      if (name) sheetNames.set(group.self_ref, name);
    }
  }
  return document.tables.flatMap((table, tableIndex): StructuredWorkbookTable[] => {
    if (!isRecord(table) || !isRecord(table.data) || !Array.isArray(table.data.grid)) return [];
    const rows = table.data.grid.flatMap((row): string[][] => {
      if (!Array.isArray(row)) return [];
      const cells = row.map((cell) => {
        if (!isRecord(cell)) return '';
        return displayValue(cell.text) ?? '';
      });
      return cells.length === 0 ? [] : [cells];
    });
    if (rows.length === 0) return [];
    const parentRef =
      isRecord(table.parent) && typeof table.parent.$ref === 'string' ? table.parent.$ref : '';
    return [
      {
        name: sheetNames.get(parentRef) ?? `工作表 ${tableIndex + 1}`,
        rows,
      },
    ];
  });
}

function displayValue(value: unknown): string | null {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1_048_576) return `${(value / 1_024).toFixed(1)} KB`;
  return `${(value / 1_048_576).toFixed(1)} MB`;
}
