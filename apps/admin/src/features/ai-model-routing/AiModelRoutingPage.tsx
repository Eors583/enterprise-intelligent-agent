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
          catalogs={dashboard?.catalogVersions ?? []}
          onSaved={() => {
            setNotice('模型目录草稿已创建。请提交后由另一位管理员发布。');
            reload();
          }}
          onError={setError}
        />
        <PolicyForm
          catalogs={dashboard?.catalogVersions ?? []}
          policies={dashboard?.routePolicies ?? []}
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
        renderDetail={(record) => (
          <details className="ai-routing-advanced-details">
            <summary>高级技术详情</summary>
            <span>
              {record.provider} · {record.modelName} · {record.dataResidency} ·{' '}
              {record.credentialReference}
            </span>
            <small>
              能力 {record.capabilities.join('、')} · Context {record.maxContextTokens} · Output{' '}
              {record.maxOutputTokens} · P95 {record.p95LatencyMs}ms
            </small>
          </details>
        )}
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
    return '先发布模型目录和任务路由；企业所有者可直接发布，受委托管理员仍需另一名管理员复核。';
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
  catalogs,
  onSaved,
  onError,
}: {
  catalogs: readonly AiModelCatalogVersion[];
  onSaved: () => void;
  onError: (message: string) => void;
}): ReactNode {
  const [busy, setBusy] = useState(false);
  const [selectedId, setSelectedId] = useState(catalogs[0]?.id ?? '');
  const [provider, setProvider] = useState<'OPENAI_COMPATIBLE' | 'MANUS'>('OPENAI_COMPATIBLE');
  const [modelName, setModelName] = useState('');
  const [capabilities, setCapabilities] = useState<string[]>(['chat']);
  const selected = catalogs.find((catalog) => catalog.id === selectedId) ?? null;

  useEffect(() => {
    setSelectedId((current) =>
      catalogs.some((catalog) => catalog.id === current) ? current : (catalogs[0]?.id ?? ''),
    );
  }, [catalogs]);

  const cloneExisting = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!selected) return;
    setBusy(true);
    try {
      await createAiModelCatalogVersion(catalogDraftFromExisting(selected, crypto.randomUUID()));
      onSaved();
    } catch (caught) {
      onError(messageFromError(caught));
    } finally {
      setBusy(false);
    }
  };

  const submitAdvanced = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true);
    try {
      await createAiModelCatalogVersion({
        routeKey: aiRouteCode(provider, modelName || 'MODEL'),
        provider,
        modelName,
        credentialReference: text(data, 'credentialReference'),
        dataResidency: text(data, 'dataResidency'),
        maximumClassification: text(data, 'maximumClassification') as 'INTERNAL',
        capabilities,
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
    <section className="card ai-routing-form">
      <header>
        <h2>选择模型服务</h2>
        <p>优先复用已登记模型服务；能力、上下文、成本与延迟会从所选目录版本继承。</p>
      </header>
      {catalogs.length > 0 ? (
        <form className="ai-routing-business-form" onSubmit={(event) => void cloneExisting(event)}>
          <label>
            已登记模型服务
            <select
              name="existingCatalogId"
              value={selectedId}
              onChange={(event) => setSelectedId(event.target.value)}
            >
              {catalogs.map((catalog) => (
                <option key={catalog.id} value={catalog.id}>
                  {catalog.routeKey} v{catalog.version} · {catalog.status}
                </option>
              ))}
            </select>
          </label>
          {selected ? (
            <p className="ai-routing-inheritance-note">
              将继承所选服务的能力、上下文窗口、输出上限、成本、延迟、安全分级和凭据引用，并创建新的治理草稿。
            </p>
          ) : null}
          <button className="button primary" type="submit" disabled={busy || !selected}>
            {busy ? '保存中…' : '确认并创建新版本'}
          </button>
        </form>
      ) : (
        <p className="ai-routing-empty">
          当前没有可选择的模型服务。系统不会生成示例模型；请由有权限的运维人员在下方高级技术设置中登记真实服务。
        </p>
      )}
      <details className="ai-routing-advanced-details">
        <summary>高级技术设置：登记外部模型服务</summary>
        <p>
          Provider、模型标识和凭据引用必须来自实际
          Runtime/密钥库配置；此处不接收明文密钥，也不会探测或伪造凭据。
        </p>
        <form
          className="ai-routing-technical-form"
          onSubmit={(event) => void submitAdvanced(event)}
        >
          <label>
            Provider
            <select
              name="provider"
              value={provider}
              onChange={(event) => setProvider(event.target.value as 'OPENAI_COMPATIBLE' | 'MANUS')}
            >
              <option value="OPENAI_COMPATIBLE">OpenAI Compatible</option>
              <option value="MANUS">Manus</option>
            </select>
          </label>
          <label>
            模型标识
            <input
              name="modelName"
              required
              value={modelName}
              onChange={(event) => setModelName(event.target.value)}
              placeholder="来自供应商或 Runtime 配置"
            />
          </label>
          <label>
            凭据引用
            <input name="credentialReference" required placeholder="vault://ai/providers/general" />
          </label>
          <div className="ai-routing-form-row">
            <label>
              数据驻留
              <select name="dataResidency" defaultValue="CN" required>
                <option value="CN">中国大陆</option>
                <option value="SG">新加坡</option>
                <option value="EU">欧盟</option>
                <option value="US">美国</option>
              </select>
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
          <fieldset className="ai-routing-capability-picker">
            <legend>服务能力</legend>
            {(
              [
                ['chat', '文字对话'],
                ['vision', '图片理解'],
                ['tools', '工具调用'],
                ['embedding', '知识向量化'],
                ['rerank', '检索重排'],
              ] as const
            ).map(([value, label]) => (
              <label key={value}>
                <input
                  type="checkbox"
                  checked={capabilities.includes(value)}
                  onChange={(event) =>
                    setCapabilities((current) =>
                      event.target.checked
                        ? [...new Set([...current, value])]
                        : current.filter((item) => item !== value),
                    )
                  }
                />
                <span>{label}</span>
              </label>
            ))}
          </fieldset>
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
          <button
            className="button primary"
            type="submit"
            disabled={busy || !modelName.trim() || capabilities.length === 0}
          >
            {busy ? '保存中…' : '登记真实服务草稿'}
          </button>
        </form>
      </details>
    </section>
  );
}

export function aiRouteCode(
  provider: AiModelCatalogVersion['provider'],
  modelName: string,
): string {
  return `MODEL.${provider}.${modelName}`
    .toUpperCase()
    .replace(/[^A-Z0-9._-]+/gu, '.')
    .replace(/\.+/gu, '.')
    .replace(/\.$/u, '')
    .slice(0, 120);
}

export function catalogDraftFromExisting(
  catalog: AiModelCatalogVersion,
  idempotencyKey: string,
): Parameters<typeof createAiModelCatalogVersion>[0] {
  return {
    routeKey: catalog.routeKey,
    provider: catalog.provider,
    modelName: catalog.modelName,
    credentialReference: catalog.credentialReference,
    dataResidency: catalog.dataResidency,
    maximumClassification: catalog.maximumClassification,
    capabilities: [...catalog.capabilities],
    maxContextTokens: catalog.maxContextTokens,
    maxOutputTokens: catalog.maxOutputTokens,
    inputCostMicrosPerMillion: catalog.inputCostMicrosPerMillion,
    outputCostMicrosPerMillion: catalog.outputCostMicrosPerMillion,
    p95LatencyMs: catalog.p95LatencyMs,
    idempotencyKey,
  };
}

function PolicyForm({
  catalogs,
  policies,
  onSaved,
  onError,
}: {
  catalogs: readonly AiModelCatalogVersion[];
  policies: readonly AiModelRoutePolicyVersion[];
  onSaved: () => void;
  onError: (message: string) => void;
}): ReactNode {
  const [busy, setBusy] = useState(false);
  const [selectedPolicyId, setSelectedPolicyId] = useState(policies[0]?.id ?? '');
  const [selectedCatalogIds, setSelectedCatalogIds] = useState<string[]>([]);
  const [taskClass, setTaskClass] = useState('GENERAL_QA');
  const [preset, setPreset] = useState<PolicyPreset>('BALANCED');
  const [maximumClassification, setMaximumClassification] =
    useState<AiModelRoutePolicyVersion['maximumClassification']>('INTERNAL');
  const eligible = catalogs.filter(
    ({ status }) => status === 'IN_REVIEW' || status === 'PUBLISHED',
  );
  const selectedPolicy = policies.find((policy) => policy.id === selectedPolicyId) ?? null;
  const selectedCatalogs = selectedCatalogIds
    .map((id) => eligible.find((catalog) => catalog.id === id))
    .filter((catalog): catalog is AiModelCatalogVersion => catalog !== undefined);
  const constraints = derivePolicyConstraints(selectedCatalogs, preset);

  useEffect(() => {
    setSelectedPolicyId((current) =>
      policies.some((policy) => policy.id === current) ? current : (policies[0]?.id ?? ''),
    );
  }, [policies]);

  const clonePolicy = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!selectedPolicy) return;
    setBusy(true);
    try {
      await createAiModelRoutePolicyVersion(
        policyDraftFromExisting(selectedPolicy, crypto.randomUUID()),
      );
      onSaved();
    } catch (caught) {
      onError(messageFromError(caught));
    } finally {
      setBusy(false);
    }
  };

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!constraints) {
      onError('请选择至少一个已有模型服务。');
      return;
    }
    if (constraints.requiredCapabilities.length === 0) {
      onError('所选模型服务没有共同能力，不能组成同一路由策略。');
      return;
    }
    setBusy(true);
    try {
      await createAiModelRoutePolicyVersion({
        taskClass,
        allowedResidencies: constraints.allowedResidencies,
        maximumClassification,
        requiredCapabilities: constraints.requiredCapabilities,
        maxP95LatencyMs: constraints.maxP95LatencyMs,
        maxInputCostMicrosPerMillion: constraints.maxInputCostMicrosPerMillion,
        maxOutputCostMicrosPerMillion: constraints.maxOutputCostMicrosPerMillion,
        maximumAttempts: constraints.maximumAttempts,
        circuitFailureThreshold: constraints.circuitFailureThreshold,
        circuitOpenSeconds: constraints.circuitOpenSeconds,
        catalogVersionIds: selectedCatalogIds,
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
    <section className="card ai-routing-form">
      <header>
        <h2>选择路由策略</h2>
        <p>可复用既有策略，或从已登记模型服务创建受控路由；能力、驻留、成本和延迟自动继承。</p>
      </header>
      {policies.length > 0 ? (
        <form className="ai-routing-business-form" onSubmit={(event) => void clonePolicy(event)}>
          <label>
            已有路由策略
            <select
              name="existingPolicyId"
              value={selectedPolicyId}
              onChange={(event) => setSelectedPolicyId(event.target.value)}
            >
              {policies.map((policy) => (
                <option key={policy.id} value={policy.id}>
                  {policy.taskClass} v{policy.version} · {policy.status}
                </option>
              ))}
            </select>
          </label>
          <button
            className="button primary"
            type="submit"
            disabled={busy || !selectedPolicy || selectedPolicy.candidates.length === 0}
          >
            {busy ? '保存中…' : '确认并复用策略'}
          </button>
          {selectedPolicy?.candidates.length === 0 ? (
            <p className="ai-routing-empty">该历史策略没有候选模型，不能直接复用。</p>
          ) : null}
        </form>
      ) : (
        <p className="ai-routing-empty">当前没有可复用的路由策略，可从下方已登记模型服务创建。</p>
      )}
      <form className="ai-routing-business-form" onSubmit={(event) => void submit(event)}>
        <label>
          任务分类
          <select
            name="taskClass"
            value={taskClass}
            onChange={(event) => setTaskClass(event.target.value)}
          >
            <option value="GENERAL_QA">通用问答</option>
            <option value="KNOWLEDGE_QA">企业知识问答</option>
            <option value="DOCUMENT_ANALYSIS">文档分析</option>
            <option value="TOOL_EXECUTION">工具执行</option>
          </select>
        </label>
        <fieldset>
          <legend>候选模型服务（最多三个，按勾选顺序路由）</legend>
          {eligible.length > 0 ? (
            eligible.map((catalog) => (
              <label key={catalog.id}>
                <input
                  type="checkbox"
                  checked={selectedCatalogIds.includes(catalog.id)}
                  disabled={
                    !selectedCatalogIds.includes(catalog.id) && selectedCatalogIds.length >= 3
                  }
                  onChange={(event) =>
                    setSelectedCatalogIds((current) =>
                      event.target.checked
                        ? [...current, catalog.id]
                        : current.filter((id) => id !== catalog.id),
                    )
                  }
                />
                <span>
                  {catalog.routeKey} v{catalog.version} · {catalog.status}
                </span>
              </label>
            ))
          ) : (
            <p>没有可用于路由的审核中或已发布模型服务。</p>
          )}
        </fieldset>
        <div className="ai-routing-form-row">
          <label>
            路由偏好
            <select
              name="policyPreset"
              value={preset}
              onChange={(event) => setPreset(event.target.value as PolicyPreset)}
            >
              <option value="BALANCED">均衡</option>
              <option value="RELIABILITY">可靠性优先</option>
              <option value="FAST_FAIL">快速失败</option>
            </select>
          </label>
          <label>
            最高分级
            <select
              name="maximumClassification"
              value={maximumClassification}
              onChange={(event) =>
                setMaximumClassification(
                  event.target.value as AiModelRoutePolicyVersion['maximumClassification'],
                )
              }
            >
              <option value="PUBLIC">PUBLIC</option>
              <option value="INTERNAL">INTERNAL</option>
              <option value="CONFIDENTIAL">CONFIDENTIAL</option>
              <option value="RESTRICTED">RESTRICTED</option>
            </select>
          </label>
        </div>
        {constraints ? (
          <p className="ai-routing-inheritance-note">
            已自动继承驻留 {constraints.allowedResidencies.join('、')}、共同能力{' '}
            {constraints.requiredCapabilities.join('、') || '无'}、P95/成本上限，并按“
            {POLICY_PRESETS[preset].label}”应用有限重试与熔断。
          </p>
        ) : null}
        <button className="button primary" type="submit" disabled={busy || eligible.length === 0}>
          {busy
            ? '保存中…'
            : eligible.length === 0
              ? '先登记模型服务'
              : selectedCatalogIds.length === 0
                ? '请选择模型服务'
                : '确认并创建路由草稿'}
        </button>
      </form>
    </section>
  );
}

export type PolicyPreset = 'BALANCED' | 'RELIABILITY' | 'FAST_FAIL';

const POLICY_PRESETS: Record<
  PolicyPreset,
  {
    readonly label: string;
    readonly maximumAttempts: number;
    readonly failureThreshold: number;
    readonly openSeconds: number;
  }
> = {
  BALANCED: { label: '均衡', maximumAttempts: 2, failureThreshold: 5, openSeconds: 60 },
  RELIABILITY: {
    label: '可靠性优先',
    maximumAttempts: 3,
    failureThreshold: 8,
    openSeconds: 30,
  },
  FAST_FAIL: { label: '快速失败', maximumAttempts: 1, failureThreshold: 3, openSeconds: 120 },
};

export interface DerivedPolicyConstraints {
  readonly allowedResidencies: string[];
  readonly requiredCapabilities: string[];
  readonly maxP95LatencyMs: number;
  readonly maxInputCostMicrosPerMillion: string;
  readonly maxOutputCostMicrosPerMillion: string;
  readonly maximumAttempts: number;
  readonly circuitFailureThreshold: number;
  readonly circuitOpenSeconds: number;
}

export function derivePolicyConstraints(
  catalogs: readonly AiModelCatalogVersion[],
  preset: PolicyPreset,
): DerivedPolicyConstraints | null {
  if (catalogs.length === 0) return null;
  const settings = POLICY_PRESETS[preset];
  const commonCapabilities = catalogs[0]!.capabilities.filter((capability) =>
    catalogs.every((catalog) => catalog.capabilities.includes(capability)),
  );
  return {
    allowedResidencies: [...new Set(catalogs.map((catalog) => catalog.dataResidency))],
    requiredCapabilities: commonCapabilities,
    maxP95LatencyMs: Math.max(...catalogs.map((catalog) => catalog.p95LatencyMs)),
    maxInputCostMicrosPerMillion: maxIntegerString(
      catalogs.map((catalog) => catalog.inputCostMicrosPerMillion),
    ),
    maxOutputCostMicrosPerMillion: maxIntegerString(
      catalogs.map((catalog) => catalog.outputCostMicrosPerMillion),
    ),
    maximumAttempts: Math.max(settings.maximumAttempts, catalogs.length),
    circuitFailureThreshold: settings.failureThreshold,
    circuitOpenSeconds: settings.openSeconds,
  };
}

export function policyDraftFromExisting(
  policy: AiModelRoutePolicyVersion,
  idempotencyKey: string,
): Parameters<typeof createAiModelRoutePolicyVersion>[0] {
  return {
    taskClass: policy.taskClass,
    allowedResidencies: [...policy.allowedResidencies],
    maximumClassification: policy.maximumClassification,
    requiredCapabilities: [...policy.requiredCapabilities],
    maxP95LatencyMs: policy.maxP95LatencyMs,
    maxInputCostMicrosPerMillion: policy.maxInputCostMicrosPerMillion,
    maxOutputCostMicrosPerMillion: policy.maxOutputCostMicrosPerMillion,
    maximumAttempts: policy.maximumAttempts,
    circuitFailureThreshold: policy.circuitFailureThreshold,
    circuitOpenSeconds: policy.circuitOpenSeconds,
    catalogVersionIds: policy.candidates.map((candidate) => candidate.catalogVersionId),
    idempotencyKey,
  };
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
  renderDetail: (record: T) => ReactNode;
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

function maxIntegerString(values: readonly string[]): string {
  return values.reduce((highest, value) => {
    const normalized = value.replace(/^0+(?=\d)/u, '');
    if (normalized.length !== highest.length) {
      return normalized.length > highest.length ? normalized : highest;
    }
    return normalized > highest ? normalized : highest;
  }, '0');
}
