import type { AdminAgent, AdminAgentUsageSummary, KnowledgeBase } from '@enterprise/contracts';
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';

import {
  getAgentUsageSummary,
  listAgents,
  listKnowledgeBases,
  updateAgentUsageLimits,
} from '@/api/admin-api';
import { messageFromError } from '@/api/client';
import { Icon } from '@/components/Icons';
import { EmptyState, ErrorState, LoadingPanel, Notice, StatusPill } from '@/components/ui';
import { AgentEditor } from './AgentEditor';
import { agentConfigurationStatusLabel } from './agent-status-view';

export function AgentsPage({ canManageLimits = false }: { canManageLimits?: boolean }): ReactNode {
  const [items, setItems] = useState<AdminAgent[]>([]);
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>([]);
  const [usage, setUsage] = useState<AdminAgentUsageSummary | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void Promise.all([
      listAgents(controller.signal),
      listKnowledgeBases(controller.signal),
      getAgentUsageSummary(controller.signal),
    ])
      .then(([{ items: loaded }, { items: loadedKnowledgeBases }, loadedUsage]) => {
        setItems(loaded);
        setKnowledgeBases(loadedKnowledgeBases);
        setUsage(loadedUsage);
        setSelectedId((current) =>
          current !== null && loaded.some((item) => item.id === current)
            ? current
            : (loaded[0]?.id ?? null),
        );
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) setError(messageFromError(caught));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [reloadKey]);

  const reload = (): void => setReloadKey((value) => value + 1);
  const selected = items.find((item) => item.id === selectedId) ?? null;
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return items.filter(
      (item) =>
        !normalized ||
        item.name.toLowerCase().includes(normalized) ||
        item.owner.displayName.toLowerCase().includes(normalized),
    );
  }, [items, query]);

  return (
    <section className="page-section">
      <header className="page-header">
        <div>
          <span className="eyebrow">AGENT OPERATIONS</span>
          <h1>智能体管理</h1>
          <p>配置成员智能体的身份提示词、可见范围和启停状态，并查看最近运行结果。</p>
        </div>
        <div className="page-actions">
          <button className="button secondary" type="button" onClick={reload} disabled={loading}>
            <Icon name="refresh" size={17} /> 刷新
          </button>
        </div>
      </header>

      {notice ? (
        <Notice tone="success" onClose={() => setNotice(null)}>
          {notice}
        </Notice>
      ) : null}
      {usage ? (
        <AgentUsageOverview
          usage={usage}
          canManageLimits={canManageLimits}
          onLimitsUpdated={(limits) =>
            setUsage((current) => (current === null ? current : { ...current, limits }))
          }
        />
      ) : null}
      <Notice tone="info">
        “配置已启用”只表示允许进入运行就绪度检查，不代表模型供应商在线。员工端仅在 Runtime、
        路由允许列表和近期真实成功凭据全部通过后才开放联系；未配置或证据不足时保持不可用。
      </Notice>
      {loading && items.length === 0 ? <LoadingPanel label="正在读取智能体配置…" /> : null}
      {error && items.length === 0 ? <ErrorState message={error} onRetry={reload} /> : null}
      {!loading && !error && items.length === 0 ? (
        <EmptyState
          title="还没有成员智能体"
          description="完成飞书成员同步后，系统会为在职成员自动创建个人智能体。"
        />
      ) : null}

      {items.length > 0 ? (
        <div className="knowledge-layout agent-admin-layout">
          <aside className="card knowledge-list-card">
            <div className="knowledge-list-header">
              <div className="search-input">
                <span aria-hidden="true">⌕</span>
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="搜索成员或智能体"
                  aria-label="搜索智能体"
                />
              </div>
            </div>
            <div className="knowledge-list">
              {filtered.map((item) => (
                <button
                  type="button"
                  key={item.id}
                  className={selectedId === item.id ? 'selected' : ''}
                  onClick={() => setSelectedId(item.id)}
                >
                  <span className="knowledge-glyph">AI</span>
                  <span className="knowledge-list-copy">
                    <strong>{item.owner.displayName}</strong>
                    <small>{item.name}</small>
                  </span>
                  <StatusPill
                    value={item.status}
                    label={agentConfigurationStatusLabel(item.status)}
                  />
                </button>
              ))}
              {filtered.length === 0 ? <p className="inline-empty">没有匹配的智能体</p> : null}
            </div>
          </aside>

          <section className="knowledge-detail">
            {selected ? (
              <AgentEditor
                key={`${selected.id}-${selected.versionId}`}
                agent={selected}
                knowledgeBases={knowledgeBases}
                onSaved={(updated) => {
                  setItems((current) =>
                    current.map((item) => (item.id === updated.id ? updated : item)),
                  );
                  setNotice('智能体配置已保存，新消息将使用最新配置。');
                }}
                onReconciled={() => {
                  setNotice('已确认运行时仍持有该任务，系统将继续对账并保留额度占位。');
                  reload();
                }}
              />
            ) : (
              <EmptyState title="请选择智能体" description="从左侧选择需要配置的成员智能体。" />
            )}
          </section>
        </div>
      ) : null}
    </section>
  );
}

function AgentUsageOverview({
  usage,
  canManageLimits,
  onLimitsUpdated,
}: {
  usage: AdminAgentUsageSummary;
  canManageLimits: boolean;
  onLimitsUpdated: (limits: AdminAgentUsageSummary['limits']) => void;
}): ReactNode {
  const [concurrentRuns, setConcurrentRuns] = useState(String(usage.limits.concurrentRuns));
  const [runsPerMinute, setRunsPerMinute] = useState(String(usage.limits.runsPerMinute));
  const [monthlyTokens, setMonthlyTokens] = useState(usage.limits.monthlyTokens);
  const [updatingLimits, setUpdatingLimits] = useState(false);
  const [limitError, setLimitError] = useState<string | null>(null);
  const usedAndReserved =
    BigInt(usage.current.totalTokens) +
    BigInt(usage.current.quotaChargedTokens) +
    BigInt(usage.current.reservedTokens);
  const monthlyLimit = BigInt(usage.limits.monthlyTokens);
  const quotaPercent = percentage(usedAndReserved, monthlyLimit);
  const hasOperationalRisk =
    usage.current.unknownRuns > 0 ||
    usage.current.unverifiedUsageRuns > 0 ||
    usedAndReserved >= monthlyLimit;

  const submitLimits = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setUpdatingLimits(true);
    setLimitError(null);
    try {
      const limits = await updateAgentUsageLimits({
        concurrentRuns: Number(concurrentRuns),
        runsPerMinute: Number(runsPerMinute),
        monthlyTokens,
        expectedUpdatedAt: usage.limits.updatedAt,
      });
      onLimitsUpdated(limits);
      setConcurrentRuns(String(limits.concurrentRuns));
      setRunsPerMinute(String(limits.runsPerMinute));
      setMonthlyTokens(limits.monthlyTokens);
    } catch (caught) {
      setLimitError(messageFromError(caught));
    } finally {
      setUpdatingLimits(false);
    }
  };

  return (
    <>
      {hasOperationalRisk ? (
        <Notice tone="info">
          {usage.current.unknownRuns > 0
            ? `当前有 ${usage.current.unknownRuns} 个状态未知的运行；其预留 Token 不会释放，请先排查运行结果。`
            : usage.current.unverifiedUsageRuns > 0
              ? `本月有 ${usage.current.unverifiedUsageRuns} 个运行未返回可信 Token；其中 ${usage.current.quotaUpperBoundRuns} 个已按额度上限保守结算，真实用量仍保持未上报。`
              : '本月 Token 配额已用尽，新运行将被拒绝，直至管理员调整配额或进入下个周期。'}
        </Notice>
      ) : null}
      <div className="summary-grid" aria-label="智能体运行用量概览">
        <article className="summary-card accent">
          <span>本月 TOKEN（可信用量 + 保守结算 + 预留）</span>
          <strong>
            {formatInteger(usedAndReserved)} / {formatInteger(monthlyLimit)}
          </strong>
          <small>
            可信用量 {formatInteger(usage.current.totalTokens)}，保守结算{' '}
            {formatInteger(usage.current.quotaChargedTokens)}，预留{' '}
            {formatInteger(usage.current.reservedTokens)} · {quotaPercent}%
          </small>
        </article>
        <article className="summary-card">
          <span>并发与速率</span>
          <strong>
            {usage.current.activeRuns} / {usage.limits.concurrentRuns} 个运行中
          </strong>
          <small>
            近一分钟 {usage.current.runsLastMinute} / {usage.limits.runsPerMinute} 次
          </small>
        </article>
        <article className="summary-card">
          <span>本月运行质量</span>
          <strong>
            {usage.current.averageLatencyMs === null
              ? '暂无延迟数据'
              : `${formatInteger(usage.current.averageLatencyMs)} ms`}
          </strong>
          <small>
            成功 {usage.current.completedRuns} · 失败 {usage.current.failedRuns} · 未知{' '}
            {usage.current.unknownRuns} · 成本 {formatInteger(usage.current.costMicros)} 微单位
            {usage.current.unreportedCostRuns > 0
              ? `（${usage.current.unreportedCostRuns} 次未上报）`
              : ''}
          </small>
        </article>
      </div>
      {canManageLimits ? (
        <form className="card usage-limit-form" onSubmit={(event) => void submitLimits(event)}>
          <div>
            <strong>租户运行配额</strong>
            <small>仅企业所有者可修改；变更使用乐观锁并写入审计日志。</small>
          </div>
          <label>
            <span>并发</span>
            <input
              type="number"
              min="1"
              max="1000"
              value={concurrentRuns}
              onChange={(event) => setConcurrentRuns(event.target.value)}
            />
          </label>
          <label>
            <span>每分钟</span>
            <input
              type="number"
              min="1"
              max="100000"
              value={runsPerMinute}
              onChange={(event) => setRunsPerMinute(event.target.value)}
            />
          </label>
          <label>
            <span>月 Token</span>
            <input
              inputMode="numeric"
              value={monthlyTokens}
              onChange={(event) => setMonthlyTokens(event.target.value)}
            />
          </label>
          <button className="button secondary" type="submit" disabled={updatingLimits}>
            {updatingLimits ? '保存中…' : '保存配额'}
          </button>
          {limitError ? <span className="field-error">{limitError}</span> : null}
        </form>
      ) : null}
    </>
  );
}

function formatInteger(value: bigint | number | string): string {
  return BigInt(value).toLocaleString('zh-CN');
}

function percentage(value: bigint, limit: bigint): string {
  if (limit === 0n) return '100.00';
  const basisPoints = (value * 10_000n) / limit;
  return `${basisPoints / 100n}.${(basisPoints % 100n).toString().padStart(2, '0')}`;
}
