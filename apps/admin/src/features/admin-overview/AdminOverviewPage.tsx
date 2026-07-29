import type {
  AdminOverviewAlert,
  AdminOverviewResponse,
  AdminOverviewRunWindow,
} from '@enterprise/contracts';
import { useEffect, useState, type ReactNode } from 'react';

import { messageFromError } from '@/api/client';
import { Notice } from '@/components/ui';

import { loadAdminOverview } from './api';
import './admin-overview.css';

export function AdminOverviewPage(): ReactNode {
  const [overview, setOverview] = useState<AdminOverviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    const load = async (): Promise<void> => {
      try {
        const result = await loadAdminOverview(controller.signal);
        if (!controller.signal.aborted) setOverview(result);
      } catch (caught) {
        if (!controller.signal.aborted) setError(messageFromError(caught));
      }
    };
    void load();
    return () => controller.abort();
  }, [reloadKey]);

  return (
    <section className="page-section admin-overview-page">
      <header className="admin-overview-hero">
        <div>
          <span className="eyebrow">ENTERPRISE CONTROL PLANE</span>
          <h1>管理概览</h1>
          <p>
            汇总成员、智能体真实可用性、可信模型用量、知识入库、通讯录同步和运行风险。所有数字均来自服务端持久化状态，不使用演示数据补位。
          </p>
        </div>
        <button
          className="button secondary"
          type="button"
          onClick={() => setReloadKey((v) => v + 1)}
        >
          刷新总览
        </button>
      </header>

      {error ? (
        <Notice tone="error">
          <strong>总览加载失败</strong>
          <span>{error}</span>
        </Notice>
      ) : null}
      {overview === null && error === null ? (
        <div className="admin-overview-loading" role="status">
          正在读取企业运行状态…
        </div>
      ) : null}
      {overview ? <OverviewContent overview={overview} /> : null}
    </section>
  );
}

function OverviewContent({ overview }: { overview: AdminOverviewResponse }): ReactNode {
  return (
    <>
      <section className="admin-overview-kpis" aria-label="企业运行概况">
        <Kpi
          label="启用成员"
          value={`${overview.people.active}/${overview.people.total}`}
          detail={
            overview.people.pendingInvitations > 0
              ? `近 7 天活跃 ${overview.people.activeUsers7d} · ${overview.people.pendingInvitations} 个邀请待接受`
              : `近 7 天活跃 ${overview.people.activeUsers7d}`
          }
          target="members"
        />
        <Kpi
          label="真实可用智能体"
          value={`${overview.agents.available}/${overview.agents.total}`}
          detail={`${overview.agents.notReady + overview.agents.degraded + overview.agents.unknown} 个未达运行门禁`}
          target="ai-model-routing"
          warning={overview.agents.available < overview.agents.total}
        />
        <Kpi
          label="今日 Agent Run"
          value={String(overview.ai.today.total)}
          detail={`${overview.ai.today.succeeded} 成功 · ${overview.ai.today.failed + overview.ai.today.unknown} 异常`}
          target="runtime-governance"
          warning={overview.ai.today.failed + overview.ai.today.unknown > 0}
        />
        <Kpi
          label="可发布知识文档"
          value={`${overview.knowledge.readyDocuments}/${overview.knowledge.totalDocuments}`}
          detail={`${overview.knowledge.pendingParseReviews} 个解析版本待复核`}
          target="knowledge"
          warning={
            overview.knowledge.failedDocuments +
              overview.knowledge.failedIngestionJobs +
              overview.knowledge.pendingParseReviews >
            0
          }
        />
        <Kpi
          label="高优先级告警"
          value={String(overview.alerts.filter(({ severity }) => severity === 'CRITICAL').length)}
          detail={`${overview.alerts.length} 类运行事项待关注`}
          target="runtime-governance"
          warning={overview.alerts.some(({ severity }) => severity === 'CRITICAL')}
        />
      </section>

      <section className="admin-overview-grid">
        <article className="admin-overview-card ai-usage-card">
          <header>
            <div>
              <span className="eyebrow">TRUSTED AI USAGE</span>
              <h2>模型用量与质量</h2>
            </div>
            <button type="button" onClick={() => navigate('finance-finops')}>
              查看 FinOps
            </button>
          </header>
          <div className="admin-overview-window-grid">
            <RunWindow title="今日" value={overview.ai.today} />
            <RunWindow title="本月" value={overview.ai.month} />
          </div>
        </article>

        <article className="admin-overview-card knowledge-health-card">
          <header>
            <div>
              <span className="eyebrow">KNOWLEDGE HEALTH</span>
              <h2>知识入库与索引</h2>
            </div>
            <button type="button" onClick={() => navigate('knowledge')}>
              进入知识库
            </button>
          </header>
          <dl className="admin-overview-definition-grid">
            <Metric label="启用知识库" value={overview.knowledge.activeBases} />
            <Metric label="失败文档" value={overview.knowledge.failedDocuments} warning />
            <Metric label="失败入库任务" value={overview.knowledge.failedIngestionJobs} warning />
            <Metric label="解析待复核" value={overview.knowledge.pendingParseReviews} />
            <Metric label="解析被驳回" value={overview.knowledge.rejectedParseReviews} warning />
            <Metric
              label="向量覆盖"
              value={`${overview.knowledge.chunksWithEmbeddings}/${overview.knowledge.totalChunks}`}
              warning={overview.knowledge.chunksMissingEmbeddings > 0}
            />
          </dl>
          <p className="admin-overview-evidence-note">
            “向量覆盖”只统计是否存在任意 Embedding；指定模型、非空切片和真实 Reranker
            仍以知识就绪探针及企业问题集验收为准。
          </p>
        </article>

        <article className="admin-overview-card directory-health-card">
          <header>
            <div>
              <span className="eyebrow">DIRECTORY & EVENT DELIVERY</span>
              <h2>连接器与运行队列</h2>
            </div>
            <button type="button" onClick={() => navigate('organization')}>
              查看同步
            </button>
          </header>
          <dl className="admin-overview-definition-grid">
            <Metric label="最近同步" value={overview.directory.latestRunStatus ?? '尚无记录'} />
            <Metric label="24h 同步失败" value={overview.directory.failedRuns24h} warning />
            <Metric label="待处理差异" value={overview.directory.pendingPreviewItems} />
            <Metric label="Outbox 待投递" value={overview.operations.pendingOutboxEvents} />
            <Metric label="Outbox 失败" value={overview.operations.failedOutboxEvents} warning />
            <Metric label="Outbox 未确认" value={overview.operations.unknownOutboxEvents} warning />
            <Metric label="事件隔离" value={overview.operations.quarantinedOutboxEvents} warning />
          </dl>
        </article>

        <article className="admin-overview-card alert-card">
          <header>
            <div>
              <span className="eyebrow">ACTIONABLE RISKS</span>
              <h2>待处理事项</h2>
            </div>
            <small>更新于 {formatTime(overview.generatedAt)}</small>
          </header>
          {overview.alerts.length === 0 ? (
            <div className="admin-overview-empty">
              当前没有由持久化状态触发的运行告警；这不替代外部供应商、IdP 和灾备验收。
            </div>
          ) : (
            <div className="admin-overview-alert-list" role="list">
              {overview.alerts.map((alert) => (
                <AlertItem alert={alert} key={alert.code} />
              ))}
            </div>
          )}
        </article>
      </section>
    </>
  );
}

function Kpi({
  label,
  value,
  detail,
  target,
  warning = false,
}: {
  label: string;
  value: string;
  detail: string;
  target: string;
  warning?: boolean;
}): ReactNode {
  return (
    <button
      className={`admin-overview-kpi ${warning ? 'warning' : ''}`}
      type="button"
      onClick={() => navigate(target)}
    >
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </button>
  );
}

function RunWindow({ title, value }: { title: string; value: AdminOverviewRunWindow }): ReactNode {
  return (
    <section>
      <header>
        <strong>{title}</strong>
        <small>P95 {value.p95LatencyMs === null ? '无样本' : `${value.p95LatencyMs} ms`}</small>
      </header>
      <dl>
        <Metric label="运行" value={value.total} />
        <Metric label="成功" value={value.succeeded} />
        <Metric label="失败/未确认" value={value.failed + value.unknown} warning />
        <Metric label="可信 Token" value={formatInteger(value.totalTokens)} />
        <Metric
          label="保守额度结算"
          value={formatInteger(value.quotaChargedTokens)}
          warning={value.quotaUpperBoundRuns > 0}
        />
        <Metric label="成本微单位" value={formatCost(value.costMicros)} />
        <Metric label="未报告用量" value={value.unreportedUsageRuns} warning />
        <Metric
          label="可信引用回答"
          value={`${value.groundedSucceededRuns}/${value.succeeded}`}
          warning={value.ungroundedSucceededRuns > 0}
        />
        <Metric
          label="用户好评率"
          value={
            value.helpfulRateBps === null
              ? '无样本'
              : `${(value.helpfulRateBps / 100).toFixed(1)}% (${value.feedbackSampleCount})`
          }
          warning={value.notHelpfulFeedback > 0}
        />
      </dl>
    </section>
  );
}

function Metric({
  label,
  value,
  warning = false,
}: {
  label: string;
  value: string | number;
  warning?: boolean;
}): ReactNode {
  const activeWarning = warning && value !== 0 && value !== '0';
  return (
    <div className={activeWarning ? 'warning' : ''}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function AlertItem({ alert }: { alert: AdminOverviewAlert }): ReactNode {
  return (
    <article className={`admin-overview-alert ${alert.severity.toLowerCase()}`} role="listitem">
      <span className="admin-overview-alert-count">{alert.count}</span>
      <div>
        <strong>{alert.title}</strong>
        <p>{alert.description}</p>
        <code>{alert.code}</code>
      </div>
      {alert.target ? (
        <button type="button" onClick={() => navigate(alert.target!)}>
          处理
        </button>
      ) : null}
    </article>
  );
}

function navigate(target: string): void {
  window.location.hash = target;
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function formatInteger(value: string): string {
  try {
    return new Intl.NumberFormat('zh-CN').format(BigInt(value));
  } catch {
    return value;
  }
}

function formatCost(micros: string): string {
  // Agent Run's legacy usage receipt has no currency dimension. Present the
  // immutable raw micro-unit total instead of inventing a CNY symbol or
  // aggregating it into a misleading monetary amount.
  return `${formatInteger(micros)} 微单位`;
}
