import {
  auditEventListQuerySchema,
  type AuditEventFilter,
  type AuditEventListQuery,
  type AuditEventRecord,
  type AuditIntegrityResponse,
} from '@enterprise/contracts';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';

import { messageFromError } from '@/api/client';
import { EmptyState, ErrorState, LoadingPanel, Notice } from '@/components/ui';

import { createAuditExport, listAuditEvents, verifyAuditIntegrity } from './api';
import { downloadAuditCsv, eventSummary, formatAuditDate, shortAuditHash } from './audit-view';
import './audit-governance.css';

interface AuditFilters {
  readonly action: string;
  readonly resourceType: string;
  readonly occurredFrom: string;
  readonly occurredTo: string;
}

const EMPTY_FILTERS: AuditFilters = {
  action: '',
  resourceType: '',
  occurredFrom: '',
  occurredTo: '',
};

export function AuditGovernancePage({ canExport }: { canExport: boolean }): ReactNode {
  const [filters, setFilters] = useState<AuditFilters>(EMPTY_FILTERS);
  const [applied, setApplied] = useState<AuditFilters>(EMPTY_FILTERS);
  const [events, setEvents] = useState<AuditEventRecord[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [integrity, setIntegrity] = useState<AuditIntegrityResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [exportReason, setExportReason] = useState('');
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setEvents(null);
    setError(null);
    const query = toQuery(applied);
    void Promise.all([
      listAuditEvents(query, controller.signal),
      verifyAuditIntegrity(controller.signal),
    ])
      .then(([page, verified]) => {
        setEvents(page.items);
        setNextCursor(page.nextCursor);
        setIntegrity(verified);
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) setError(messageFromError(caught));
      });
    return () => controller.abort();
  }, [applied, reloadKey]);

  const submitFilters = (event: FormEvent): void => {
    event.preventDefault();
    setApplied(filters);
  };

  const loadMore = async (): Promise<void> => {
    if (nextCursor === null) return;
    setLoadingMore(true);
    setError(null);
    try {
      const page = await listAuditEvents({ ...toQuery(applied), cursor: nextCursor });
      setEvents((current) => [...(current ?? []), ...page.items]);
      setNextCursor(page.nextCursor);
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setLoadingMore(false);
    }
  };

  const exportCsv = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setExporting(true);
    setError(null);
    try {
      const result = await createAuditExport({
        ...toFilter(applied),
        maximumRecords: 10_000,
        reason: exportReason,
      });
      downloadAuditCsv({
        csv: result.csv,
        fileName: result.fileName,
        type: result.mediaType,
      });
      setExportReason('');
      setNotice(
        `已导出 ${result.recordCount} 条审计记录，SHA-256：${shortAuditHash(result.sha256)}${result.truncated ? '（已达 10,000 条上限）' : ''}`,
      );
      setReloadKey((current) => current + 1);
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setExporting(false);
    }
  };

  return (
    <section className="page-section audit-governance-page">
      <header className="page-header">
        <div>
          <span className="eyebrow">AUDIT & COMPLIANCE</span>
          <h1>审计治理</h1>
          <p>查询租户审计事件、验证不可篡改摘要链，并生成带哈希清单的受控导出。</p>
        </div>
        <button
          className="button secondary"
          type="button"
          onClick={() => setReloadKey((current) => current + 1)}
        >
          重新验证
        </button>
      </header>

      {notice ? (
        <Notice tone="success" onClose={() => setNotice(null)}>
          {notice}
        </Notice>
      ) : null}
      {error ? (
        <ErrorState message={error} onRetry={() => setReloadKey((value) => value + 1)} />
      ) : null}

      <IntegrityCard value={integrity} />

      <form className="card audit-filter-card" onSubmit={submitFilters}>
        <label>
          <span>动作</span>
          <input
            value={filters.action}
            placeholder="例如 admin.role_version.published"
            onChange={(event) => setFilters({ ...filters, action: event.target.value })}
          />
        </label>
        <label>
          <span>资源类型</span>
          <input
            value={filters.resourceType}
            placeholder="例如 role_version"
            onChange={(event) => setFilters({ ...filters, resourceType: event.target.value })}
          />
        </label>
        <label>
          <span>开始时间</span>
          <input
            type="datetime-local"
            value={filters.occurredFrom}
            onChange={(event) => setFilters({ ...filters, occurredFrom: event.target.value })}
          />
        </label>
        <label>
          <span>结束时间</span>
          <input
            type="datetime-local"
            value={filters.occurredTo}
            onChange={(event) => setFilters({ ...filters, occurredTo: event.target.value })}
          />
        </label>
        <div className="audit-filter-actions">
          <button
            className="button secondary"
            type="button"
            onClick={() => setFilters(EMPTY_FILTERS)}
          >
            清空
          </button>
          <button className="button primary" type="submit">
            应用筛选
          </button>
        </div>
      </form>

      {canExport ? (
        <form className="card audit-export-card" onSubmit={(event) => void exportCsv(event)}>
          <div>
            <strong>受控 CSV 导出</strong>
            <p>仅企业所有者可导出。导出原因、筛选条件、记录数和文件哈希会写回审计链。</p>
          </div>
          <input
            value={exportReason}
            minLength={3}
            maxLength={500}
            required
            placeholder="填写审计或合规用途"
            onChange={(event) => setExportReason(event.target.value)}
          />
          <button
            className="button primary"
            type="submit"
            disabled={exporting || exportReason.trim().length < 3}
          >
            {exporting ? '正在生成…' : '生成并下载'}
          </button>
        </form>
      ) : null}

      <section className="card audit-events-card" aria-labelledby="audit-events-title">
        <header>
          <div>
            <h2 id="audit-events-title">审计事件</h2>
            <p>{events?.length ?? 0} 条当前可见记录</p>
          </div>
        </header>
        {events === null && error === null ? (
          <LoadingPanel label="正在读取审计链…" />
        ) : events?.length === 0 ? (
          <EmptyState title="没有匹配的审计事件" description="调整筛选条件后重新查询。" />
        ) : (
          <div className="audit-event-list">
            {events?.map((record) => (
              <AuditEventRow key={record.id} value={record} />
            ))}
          </div>
        )}
        {nextCursor ? (
          <button
            className="button secondary audit-load-more"
            type="button"
            disabled={loadingMore}
            onClick={() => void loadMore()}
          >
            {loadingMore ? '正在加载…' : '加载更多'}
          </button>
        ) : null}
      </section>
    </section>
  );
}

function IntegrityCard({ value }: { value: AuditIntegrityResponse | null }): ReactNode {
  return (
    <article
      className={`card audit-integrity-card ${value?.valid === false ? 'invalid' : ''}`}
      aria-live="polite"
    >
      <div className="audit-integrity-mark" aria-hidden="true">
        {value === null ? '…' : value.valid ? '✓' : '!'}
      </div>
      <div>
        <span className="eyebrow">HASH CHAIN INTEGRITY</span>
        <h2>{value === null ? '正在验证摘要链' : value.valid ? '摘要链完整' : '检测到链路异常'}</h2>
        <p>
          {value === null
            ? '正在由服务端逐条复算。'
            : `已校验 ${value.checkedRecords} 条，链头序号 ${value.headSequence}，链头 ${shortAuditHash(value.headHash)}。`}
        </p>
        {value?.firstInvalidEventId ? <code>首个异常事件：{value.firstInvalidEventId}</code> : null}
      </div>
    </article>
  );
}

function AuditEventRow({ value }: { value: AuditEventRecord }): ReactNode {
  return (
    <article className="audit-event-row">
      <div className="audit-sequence">#{value.chainSequence}</div>
      <div className="audit-event-main">
        <header>
          <strong>{eventSummary(value)}</strong>
          <time dateTime={value.occurredAt}>{formatAuditDate(value.occurredAt)}</time>
        </header>
        <p>
          {value.actorType} · {value.actorId}
        </p>
        <dl>
          <div>
            <dt>事件哈希</dt>
            <dd title={value.eventHash}>{shortAuditHash(value.eventHash)}</dd>
          </div>
          <div>
            <dt>前序哈希</dt>
            <dd title={value.previousHash ?? undefined}>{shortAuditHash(value.previousHash)}</dd>
          </div>
          <div>
            <dt>资源 ID</dt>
            <dd title={value.resourceId}>{value.resourceId}</dd>
          </div>
        </dl>
        <details>
          <summary>查看元数据</summary>
          <pre>{JSON.stringify(value.metadata, null, 2)}</pre>
        </details>
      </div>
    </article>
  );
}

function toQuery(filters: AuditFilters): AuditEventListQuery {
  return auditEventListQuerySchema.parse({ ...toFilter(filters), limit: 50 });
}

function toFilter(filters: AuditFilters): AuditEventFilter {
  return {
    ...(filters.action.trim() === '' ? {} : { action: filters.action.trim() }),
    ...(filters.resourceType.trim() === '' ? {} : { resourceType: filters.resourceType.trim() }),
    ...(filters.occurredFrom === ''
      ? {}
      : { occurredFrom: new Date(filters.occurredFrom).toISOString() }),
    ...(filters.occurredTo === ''
      ? {}
      : { occurredTo: new Date(filters.occurredTo).toISOString() }),
  };
}

export const auditGovernanceViewTestSupport = { toFilter, toQuery };
