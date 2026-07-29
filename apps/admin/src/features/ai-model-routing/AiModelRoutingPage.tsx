import type {
  AiGovernanceStatus,
  AiModelCatalogVersion,
  AiModelConnectivityProbeResult,
  AiModelRoutePolicyVersion,
  AiModelRoutingDashboard,
} from '@enterprise/contracts';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';

import { messageFromError } from '@/api/client';
import { Notice, StatusPill } from '@/components/ui';

import {
  createAiModelCatalogVersion,
  createAiModelRoutePolicyVersion,
  loadAiModelRoutingDashboard,
  runAiModelConnectivityProbe,
  transitionAiModelCatalogVersion,
  transitionAiModelRoutePolicyVersion,
} from './api';
import './ai-model-routing.css';

export function AiModelRoutingPage(): ReactNode {
  const [dashboard, setDashboard] = useState<AiModelRoutingDashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [probeBusy, setProbeBusy] = useState(false);
  const [probeResult, setProbeResult] = useState<AiModelConnectivityProbeResult | null>(null);

  const reload = (): void => setReloadKey((value) => value + 1);
  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    void loadAiModelRoutingDashboard(controller.signal)
      .then(setDashboard)
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) setError(messageFromError(caught));
      });
    return () => controller.abort();
  }, [reloadKey]);

  const transition = async (
    kind: 'catalog' | 'policy',
    record: AiModelCatalogVersion | AiModelRoutePolicyVersion,
    action: 'SUBMIT' | 'PUBLISH' | 'RETIRE',
  ): Promise<void> => {
    setBusyId(record.id);
    setError(null);
    try {
      const command = {
        action,
        expectedRevision: record.revision,
        reason: `${action} from model governance console`,
        idempotencyKey: crypto.randomUUID(),
      } as const;
      if (kind === 'catalog') await transitionAiModelCatalogVersion(record.id, command);
      else await transitionAiModelRoutePolicyVersion(record.id, command);
      setNotice('治理状态已由服务端确认，路由快照只会引用已发布版本。');
      reload();
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setBusyId(null);
    }
  };

  const runConnectivityProbe = async (): Promise<void> => {
    setProbeBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await runAiModelConnectivityProbe({
        idempotencyKey: crypto.randomUUID(),
      });
      setProbeResult(result);
      if (result.evidenceStatus === 'VERIFIED') {
        setNotice(
          '真实模型连通性测试成功，可信 Provider 成功回执已写入。若仍有其他候选缺少凭据，请继续测试。',
        );
      } else {
        setError(`连通性测试未形成可信成功凭据：${result.reasonCode ?? 'UNKNOWN'}`);
      }
      reload();
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setProbeBusy(false);
    }
  };

  return (
    <section className="page-section ai-routing-page">
      <header className="page-header">
        <div>
          <span className="eyebrow">MODEL ROUTING & AI SAFETY</span>
          <h1>模型路由与安全</h1>
          <p>
            管理不可变模型目录、任务路由、故障熔断与安全阻断。凭据字段只接受密钥库引用，不接收明文密钥。
          </p>
        </div>
        <button className="button secondary" type="button" onClick={reload}>
          刷新状态
        </button>
      </header>

      {notice ? (
        <Notice tone="success" onClose={() => setNotice(null)}>
          {notice}
        </Notice>
      ) : null}
      {error ? <Notice tone="error">{error}</Notice> : null}

      {dashboard ? (
        <Readiness
          dashboard={dashboard}
          probeBusy={probeBusy}
          probeResult={probeResult}
          onProbe={() => void runConnectivityProbe()}
        />
      ) : (
        <p>正在加载模型治理状态…</p>
      )}

      <div className="ai-routing-editor-grid">
        <CatalogForm
          onSaved={() => {
            setNotice('模型目录草稿已创建。请提交后由另一位管理员发布。');
            reload();
          }}
          onError={setError}
        />
        <PolicyForm
          catalogs={dashboard?.catalogVersions ?? []}
          onSaved={() => {
            setNotice('任务路由草稿已创建。');
            reload();
          }}
          onError={setError}
        />
      </div>

      <GovernanceTable
        title="模型目录版本"
        records={dashboard?.catalogVersions ?? []}
        busyId={busyId}
        onTransition={(record, action) => void transition('catalog', record, action)}
        renderDetail={(record) =>
          `${record.provider} · ${record.modelName} · ${record.dataResidency} · ${record.credentialReference}`
        }
      />
      <GovernanceTable
        title="任务路由版本"
        records={dashboard?.routePolicies ?? []}
        busyId={busyId}
        onTransition={(record, action) => void transition('policy', record, action)}
        renderDetail={(record) =>
          `${record.taskClass} · ${record.candidates
            .map(
              (candidate) => `${candidate.ordinal}:${candidate.routeKey}/${candidate.circuitState}`,
            )
            .join(' → ')}`
        }
      />
    </section>
  );
}

function Readiness({
  dashboard,
  probeBusy,
  probeResult,
  onProbe,
}: {
  dashboard: AiModelRoutingDashboard;
  probeBusy: boolean;
  probeResult: AiModelConnectivityProbeResult | null;
  onProbe: () => void;
}): ReactNode {
  const canProbe =
    dashboard.readiness.activeCandidateCount > 0 &&
    dashboard.readiness.invalidPublishedPolicyCount === 0 &&
    dashboard.readiness.openCircuitCount === 0 &&
    dashboard.readiness.runtime.status === 'READY' &&
    dashboard.readiness.runtime.requireTrustedRoute === true &&
    dashboard.readiness.runtime.providerReady === true &&
    dashboard.readiness.runtimeAllowlistedCandidateCount ===
      dashboard.readiness.activeCandidateCount &&
    dashboard.readiness.recentSuccessfulCandidateCount < dashboard.readiness.activeCandidateCount;
  return (
    <div className="ai-routing-readiness">
      <article className={dashboard.readiness.status === 'READY' ? 'ready' : 'blocked'}>
        <span>运行就绪</span>
        <strong>{dashboard.readiness.status}</strong>
      </article>
      <article className={dashboard.readiness.evidenceStatus === 'VERIFIED' ? 'ready' : 'blocked'}>
        <span>证据状态</span>
        <strong>{dashboard.readiness.evidenceStatus}</strong>
      </article>
      <article>
        <span>已发布模型</span>
        <strong>{dashboard.readiness.publishedCatalogCount}</strong>
      </article>
      <article>
        <span>已发布路由</span>
        <strong>{dashboard.readiness.publishedPolicyCount}</strong>
      </article>
      <article className={dashboard.readiness.openCircuitCount > 0 ? 'blocked' : ''}>
        <span>打开的熔断器</span>
        <strong>{dashboard.readiness.openCircuitCount}</strong>
      </article>
      <article
        className={
          dashboard.readiness.runtimeAllowlistedCandidateCount ===
          dashboard.readiness.activeCandidateCount
            ? ''
            : 'blocked'
        }
      >
        <span>Runtime 允许列表</span>
        <strong>
          {dashboard.readiness.runtimeAllowlistedCandidateCount}/
          {dashboard.readiness.activeCandidateCount}
        </strong>
      </article>
      <article
        className={
          dashboard.readiness.recentSuccessfulCandidateCount ===
          dashboard.readiness.activeCandidateCount
            ? ''
            : 'blocked'
        }
      >
        <span>24h 真实调用证据</span>
        <strong>
          {dashboard.readiness.recentSuccessfulCandidateCount}/
          {dashboard.readiness.activeCandidateCount}
        </strong>
      </article>
      <article className={dashboard.readiness.runtime.status === 'READY' ? '' : 'blocked'}>
        <span>Runtime 本地探针</span>
        <strong>{dashboard.readiness.runtime.status}</strong>
      </article>
      <article className={dashboard.readiness.blockedSafetyDecisionCount24h > 0 ? 'warn' : ''}>
        <span>24h 安全阻断</span>
        <strong>{dashboard.readiness.blockedSafetyDecisionCount24h}</strong>
      </article>
      {dashboard.readiness.reasonCodes.length > 0 ? (
        <code>{dashboard.readiness.reasonCodes.join(' · ')}</code>
      ) : null}
      <section className="ai-routing-recovery">
        <div>
          <strong>真实 Provider 恢复验证</strong>
          <p>{readinessRecoveryGuidance(dashboard)}</p>
          <small>
            本地 Runtime 探针只证明配置存在，不能代替供应商调用。此测试会创建独立受控 Agent
            Run，并继续执行发布路由、精确允许列表、输入输出安全、租户配额、并发与用量结算。
          </small>
        </div>
        <button
          className="button primary"
          type="button"
          disabled={!canProbe || probeBusy}
          onClick={onProbe}
        >
          {probeBusy ? '正在调用真实模型…' : '执行真实模型连通性测试'}
        </button>
        {probeResult ? (
          <dl>
            <div>
              <dt>测试 Run</dt>
              <dd>{probeResult.runId}</dd>
            </div>
            <div>
              <dt>目标目录版本</dt>
              <dd>{probeResult.targetCatalogVersionId}</dd>
            </div>
            <div>
              <dt>结果</dt>
              <dd>
                {probeResult.status} · {probeResult.evidenceStatus}
              </dd>
            </div>
            <div>
              <dt>阻断码</dt>
              <dd>{probeResult.reasonCode ?? '无'}</dd>
            </div>
          </dl>
        ) : null}
      </section>
    </div>
  );
}

function readinessRecoveryGuidance(dashboard: AiModelRoutingDashboard): string {
  const reasons = new Set(dashboard.readiness.reasonCodes);
  if (dashboard.readiness.ready) {
    return '所有已发布候选均具备 24 小时内真实成功回执，无需执行恢复测试。';
  }
  if (reasons.has('NO_PUBLISHED_MODEL') || reasons.has('NO_PUBLISHED_ROUTE_POLICY')) {
    return '先完成模型目录和任务路由的双人审核发布，再执行真实连通性测试。';
  }
  if (reasons.has('INVALID_PUBLISHED_ROUTE_POLICY')) {
    return '先修复已发布策略的候选数量、能力、驻留、分级或成本约束。';
  }
  if (
    reasons.has('RUNTIME_READINESS_UNAVAILABLE') ||
    reasons.has('RUNTIME_PROVIDER_NOT_READY') ||
    reasons.has('RUNTIME_TRUSTED_ROUTE_NOT_REQUIRED')
  ) {
    return '先恢复 AI Runtime，并启用可信路由与真实 Provider；本地配置未就绪时禁止付费测试。';
  }
  if (reasons.has('RUNTIME_ALLOWLIST_MISMATCH')) {
    return '先让 Runtime 的 routeKey、目录版本、Provider、模型和配置摘要与已发布目录完全一致。';
  }
  if (reasons.has('MODEL_CIRCUIT_OPEN')) {
    return '等待熔断窗口结束或排查供应商故障；熔断期间不会发起恢复测试。';
  }
  if (reasons.has('NO_RECENT_SUCCESSFUL_PROVIDER_EVIDENCE')) {
    return '前置治理已就绪。请执行受控真实调用；每次测试一个缺少凭据的候选，直至计数完整。';
  }
  return '请先处理上方阻断码；只有前置治理完整时才允许真实 Provider 测试。';
}

function CatalogForm({
  onSaved,
  onError,
}: {
  onSaved: () => void;
  onError: (message: string) => void;
}): ReactNode {
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true);
    try {
      await createAiModelCatalogVersion({
        routeKey: text(data, 'routeKey').toUpperCase(),
        provider: text(data, 'provider') as 'OPENAI_COMPATIBLE' | 'MANUS',
        modelName: text(data, 'modelName'),
        credentialReference: text(data, 'credentialReference'),
        dataResidency: text(data, 'dataResidency'),
        maximumClassification: text(data, 'maximumClassification') as 'INTERNAL',
        capabilities: splitList(text(data, 'capabilities')),
        maxContextTokens: number(data, 'maxContextTokens'),
        maxOutputTokens: number(data, 'maxOutputTokens'),
        inputCostMicrosPerMillion: text(data, 'inputCostMicrosPerMillion'),
        outputCostMicrosPerMillion: text(data, 'outputCostMicrosPerMillion'),
        p95LatencyMs: number(data, 'p95LatencyMs'),
        idempotencyKey: crypto.randomUUID(),
      });
      event.currentTarget.reset();
      onSaved();
    } catch (caught) {
      onError(messageFromError(caught));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="card ai-routing-form" onSubmit={(event) => void submit(event)}>
      <header>
        <h2>新建模型目录版本</h2>
        <p>模型端点和真实密钥由 Runtime 运维配置维护。</p>
      </header>
      <label>
        Route Key
        <input name="routeKey" required placeholder="GENERAL.PRIMARY" />
      </label>
      <label>
        Provider
        <select name="provider" defaultValue="OPENAI_COMPATIBLE">
          <option value="OPENAI_COMPATIBLE">OpenAI Compatible</option>
          <option value="MANUS">Manus</option>
        </select>
      </label>
      <label>
        模型名
        <input name="modelName" required placeholder="model-a" />
      </label>
      <label>
        凭据引用
        <input name="credentialReference" required placeholder="vault://ai/providers/general" />
      </label>
      <div className="ai-routing-form-row">
        <label>
          数据驻留
          <input name="dataResidency" defaultValue="CN" required />
        </label>
        <label>
          最高分级
          <select name="maximumClassification" defaultValue="CONFIDENTIAL">
            <option value="PUBLIC">PUBLIC</option>
            <option value="INTERNAL">INTERNAL</option>
            <option value="CONFIDENTIAL">CONFIDENTIAL</option>
            <option value="RESTRICTED">RESTRICTED</option>
          </select>
        </label>
      </div>
      <label>
        能力（逗号分隔）
        <input name="capabilities" defaultValue="chat" required />
      </label>
      <div className="ai-routing-form-row">
        <label>
          上下文 Token
          <input name="maxContextTokens" type="number" defaultValue="128000" min="1" required />
        </label>
        <label>
          输出 Token
          <input name="maxOutputTokens" type="number" defaultValue="4000" min="1" required />
        </label>
      </div>
      <div className="ai-routing-form-row">
        <label>
          输入成本 μ/百万
          <input name="inputCostMicrosPerMillion" defaultValue="1000" required />
        </label>
        <label>
          输出成本 μ/百万
          <input name="outputCostMicrosPerMillion" defaultValue="2000" required />
        </label>
      </div>
      <label>
        P95 延迟上限（ms）
        <input name="p95LatencyMs" type="number" defaultValue="8000" min="1" required />
      </label>
      <button className="button primary" type="submit" disabled={busy}>
        {busy ? '保存中…' : '创建草稿'}
      </button>
    </form>
  );
}

function PolicyForm({
  catalogs,
  onSaved,
  onError,
}: {
  catalogs: readonly AiModelCatalogVersion[];
  onSaved: () => void;
  onError: (message: string) => void;
}): ReactNode {
  const [busy, setBusy] = useState(false);
  const eligible = catalogs.filter(
    ({ status }) => status === 'IN_REVIEW' || status === 'PUBLISHED',
  );
  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true);
    try {
      await createAiModelRoutePolicyVersion({
        taskClass: text(data, 'taskClass').toUpperCase(),
        allowedResidencies: splitList(text(data, 'allowedResidencies')),
        maximumClassification: text(data, 'maximumClassification') as 'INTERNAL',
        requiredCapabilities: splitList(text(data, 'requiredCapabilities')),
        maxP95LatencyMs: number(data, 'maxP95LatencyMs'),
        maxInputCostMicrosPerMillion: text(data, 'maxInputCostMicrosPerMillion'),
        maxOutputCostMicrosPerMillion: text(data, 'maxOutputCostMicrosPerMillion'),
        maximumAttempts: number(data, 'maximumAttempts'),
        circuitFailureThreshold: number(data, 'circuitFailureThreshold'),
        circuitOpenSeconds: number(data, 'circuitOpenSeconds'),
        catalogVersionIds: data.getAll('catalogVersionIds').map(String),
        idempotencyKey: crypto.randomUUID(),
      });
      event.currentTarget.reset();
      onSaved();
    } catch (caught) {
      onError(messageFromError(caught));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="card ai-routing-form" onSubmit={(event) => void submit(event)}>
      <header>
        <h2>新建任务路由版本</h2>
        <p>候选顺序即主模型与有限 fallback 顺序，最多三次。</p>
      </header>
      <label>
        任务分类
        <input name="taskClass" defaultValue="GENERAL_QA" required />
      </label>
      <label>
        候选模型（按选择顺序）
        <select name="catalogVersionIds" multiple size={Math.min(5, Math.max(2, eligible.length))}>
          {eligible.map((catalog) => (
            <option key={catalog.id} value={catalog.id}>
              {catalog.routeKey} v{catalog.version} · {catalog.status}
            </option>
          ))}
        </select>
      </label>
      <div className="ai-routing-form-row">
        <label>
          驻留（逗号分隔）
          <input name="allowedResidencies" defaultValue="CN" required />
        </label>
        <label>
          最高分级
          <select name="maximumClassification" defaultValue="INTERNAL">
            <option value="PUBLIC">PUBLIC</option>
            <option value="INTERNAL">INTERNAL</option>
            <option value="CONFIDENTIAL">CONFIDENTIAL</option>
            <option value="RESTRICTED">RESTRICTED</option>
          </select>
        </label>
      </div>
      <label>
        必需能力
        <input name="requiredCapabilities" defaultValue="chat" required />
      </label>
      <div className="ai-routing-form-row">
        <label>
          最大尝试
          <input name="maximumAttempts" type="number" min="1" max="3" defaultValue="2" required />
        </label>
        <label>
          P95 上限
          <input name="maxP95LatencyMs" type="number" min="1" defaultValue="8000" required />
        </label>
      </div>
      <div className="ai-routing-form-row">
        <label>
          输入成本上限
          <input name="maxInputCostMicrosPerMillion" defaultValue="5000" required />
        </label>
        <label>
          输出成本上限
          <input name="maxOutputCostMicrosPerMillion" defaultValue="10000" required />
        </label>
      </div>
      <div className="ai-routing-form-row">
        <label>
          熔断失败阈值
          <input name="circuitFailureThreshold" type="number" min="1" defaultValue="5" required />
        </label>
        <label>
          熔断秒数
          <input name="circuitOpenSeconds" type="number" min="1" defaultValue="60" required />
        </label>
      </div>
      <button className="button primary" type="submit" disabled={busy || eligible.length === 0}>
        {busy ? '保存中…' : eligible.length === 0 ? '先创建模型目录' : '创建草稿'}
      </button>
    </form>
  );
}

function GovernanceTable<
  T extends { id: string; version: number; revision: number; status: AiGovernanceStatus },
>({
  title,
  records,
  busyId,
  onTransition,
  renderDetail,
}: {
  title: string;
  records: readonly T[];
  busyId: string | null;
  onTransition: (record: T, action: 'SUBMIT' | 'PUBLISH' | 'RETIRE') => void;
  renderDetail: (record: T) => string;
}): ReactNode {
  return (
    <article className="card ai-routing-table">
      <header>
        <h2>{title}</h2>
        <span>{records.length} 个版本</span>
      </header>
      {records.length === 0 ? (
        <p>暂无版本。</p>
      ) : (
        <div className="ai-routing-table-scroll">
          <table>
            <thead>
              <tr>
                <th>版本</th>
                <th>配置 / 故障状态</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {records.map((record) => (
                <tr key={record.id}>
                  <td>
                    v{record.version} · r{record.revision}
                  </td>
                  <td>{renderDetail(record)}</td>
                  <td>
                    <StatusPill value={record.status} label={record.status} />
                  </td>
                  <td>
                    {record.status === 'DRAFT' ? (
                      <button
                        type="button"
                        className="button secondary compact"
                        disabled={busyId === record.id}
                        onClick={() => onTransition(record, 'SUBMIT')}
                      >
                        提交审核
                      </button>
                    ) : null}
                    {record.status === 'IN_REVIEW' ? (
                      <button
                        type="button"
                        className="button primary compact"
                        disabled={busyId === record.id}
                        onClick={() => onTransition(record, 'PUBLISH')}
                      >
                        审核并发布
                      </button>
                    ) : null}
                    {record.status === 'PUBLISHED' ? (
                      <button
                        type="button"
                        className="button secondary compact"
                        disabled={busyId === record.id}
                        onClick={() => onTransition(record, 'RETIRE')}
                      >
                        退役
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </article>
  );
}

function text(data: FormData, key: string): string {
  return String(data.get(key) ?? '').trim();
}

function number(data: FormData, key: string): number {
  return Number.parseInt(text(data, key), 10);
}

function splitList(value: string): string[] {
  return [
    ...new Set(
      value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}
