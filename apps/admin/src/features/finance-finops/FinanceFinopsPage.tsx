import type {
  Evidence,
  FinopsBudget,
  FinopsCostEntry,
  FinopsDashboard,
  FinopsPriceSnapshot,
} from '@enterprise/contracts';
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';

import {
  acknowledgeFinopsAlert,
  createFinopsBudget,
  createFinopsBudgetEvent,
  createFinopsPriceSnapshot,
  decideFinopsRoutingSuggestion,
  loadFinopsDashboard,
  recordFinopsCost,
  recomputeFinopsRoi,
  reviewFinopsAllocationSet,
  reviewFinopsBenefitClaim,
  reviewFinopsBudget,
  reviewFinopsCost,
  reviewFinopsPriceSnapshot,
  reviewFinopsRoiFormula,
} from './api';
import { messageFromError } from '@/api/client';
import { Icon } from '@/components/Icons';
import { listEvidence } from '@/features/business-semantics/api';

import './finance-finops.css';

type FinopsTab = 'COST' | 'BUDGET' | 'ALLOCATION' | 'VALUE' | 'ROI' | 'EXCEPTIONS';

const TABS: ReadonlyArray<readonly [FinopsTab, string]> = [
  ['COST', '成本与价格'],
  ['BUDGET', '预算'],
  ['ALLOCATION', '归集'],
  ['VALUE', '价值收益'],
  ['ROI', 'ROI'],
  ['EXCEPTIONS', '异常'],
];

export function FinanceFinopsPage({
  currentUserId,
  tenantId,
}: {
  currentUserId: string;
  tenantId: string;
}): ReactNode {
  const [tab, setTab] = useState<FinopsTab>('COST');
  const [currency, setCurrency] = useState('CNY');
  const [dashboard, setDashboard] = useState<FinopsDashboard | null>(null);
  const [evidenceCatalog, setEvidenceCatalog] = useState<Evidence[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      setLoading(true);
      setError(null);
      try {
        setDashboard(await loadFinopsDashboard(currency, signal));
      } catch (caught) {
        if (!(caught instanceof DOMException && caught.name === 'AbortError')) {
          setError(messageFromError(caught));
        }
      } finally {
        setLoading(false);
      }
    },
    [currency],
  );

  useEffect(() => {
    const controller = new AbortController();
    void reload(controller.signal);
    return () => controller.abort();
  }, [reload]);

  useEffect(() => {
    const controller = new AbortController();
    void listEvidence(controller.signal)
      .then((items) =>
        setEvidenceCatalog(
          items.filter((item) => item.status === 'ACTIVE' && item.trustLevel === 'VERIFIED'),
        ),
      )
      .catch((caught: unknown) => {
        if (!(caught instanceof DOMException && caught.name === 'AbortError')) {
          setEvidenceCatalog([]);
        }
      });
    return () => controller.abort();
  }, []);

  const mutate = async (operation: () => Promise<unknown>): Promise<void> => {
    setError(null);
    try {
      await operation();
      await reload();
    } catch (caught) {
      setError(messageFromError(caught));
    }
  };

  const data = dashboard;
  return (
    <section
      className="finops-page"
      aria-labelledby="finops-title"
      data-testid="finance-finops-page"
    >
      <header className="finops-hero">
        <div>
          <span className="eyebrow">FIN-001 · 可复算成本与价值闭环</span>
          <h1 id="finops-title">AI FinOps 管理台</h1>
          <p>
            价格、原始用量、归集、收益证据、ROI 与预算均保留版本和来源；AI
            只能提出候选与路由建议，最终收益和策略边界由可信系统或独立人工确认。
          </p>
        </div>
        <div className="finops-toolbar">
          <label>
            币种
            <select value={currency} onChange={(event) => setCurrency(event.target.value)}>
              <option value="CNY">CNY</option>
              <option value="USD">USD</option>
              <option value="EUR">EUR</option>
            </select>
          </label>
          <button type="button" className="secondary-button" onClick={() => void reload()}>
            <Icon name="refresh" size={17} /> 刷新
          </button>
        </div>
      </header>

      {data ? (
        <div className="finops-kpis" aria-label="FinOps 实时概览">
          <Kpi label="已验证成本" value={money(data.totals.verifiedCost, currency)} />
          <Kpi label="待校验成本" value={money(data.totals.pendingCost, currency)} />
          <Kpi label="已确认收益" value={money(data.totals.confirmedBenefit, currency)} />
          <Kpi label="预算已结算" value={money(data.totals.activeBudgetSettled, currency)} />
          <Kpi label="开放异常" value={String(data.totals.openAlerts)} alert />
          <Kpi label="自动记账阻断" value={String(data.totals.openProjectionDiagnostics)} alert />
        </div>
      ) : null}

      <nav className="finops-tabs" aria-label="FinOps 管理视图">
        {TABS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={tab === id ? 'active' : ''}
            aria-current={tab === id ? 'page' : undefined}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </nav>

      {error ? (
        <div className="finops-error" role="alert">
          {error}
        </div>
      ) : null}
      {loading ? <p className="finops-loading">正在读取租户 FinOps 账本…</p> : null}
      {!loading && data === null ? (
        <Empty title="暂时无法读取 FinOps 状态" copy="请检查 API 连接后重试。" />
      ) : null}

      {!loading && data && tab === 'COST' ? (
        <CostPanel
          dashboard={data}
          currentUserId={currentUserId}
          evidenceCatalog={evidenceCatalog}
          onMutate={mutate}
        />
      ) : null}
      {!loading && data && tab === 'BUDGET' ? (
        <BudgetPanel
          dashboard={data}
          tenantId={tenantId}
          currentUserId={currentUserId}
          onMutate={mutate}
        />
      ) : null}
      {!loading && data && tab === 'ALLOCATION' ? (
        <AllocationPanel dashboard={data} currentUserId={currentUserId} onMutate={mutate} />
      ) : null}
      {!loading && data && tab === 'VALUE' ? (
        <ValuePanel dashboard={data} currentUserId={currentUserId} onMutate={mutate} />
      ) : null}
      {!loading && data && tab === 'ROI' ? (
        <RoiPanel dashboard={data} currentUserId={currentUserId} onMutate={mutate} />
      ) : null}
      {!loading && data && tab === 'EXCEPTIONS' ? (
        <ExceptionPanel dashboard={data} onMutate={mutate} />
      ) : null}
    </section>
  );
}

function CostPanel({
  dashboard,
  currentUserId,
  evidenceCatalog,
  onMutate,
}: {
  dashboard: FinopsDashboard;
  currentUserId: string;
  evidenceCatalog: Evidence[];
  onMutate: Mutate;
}): ReactNode {
  return (
    <div className="finops-grid">
      <section className="finops-card span-two">
        <CardTitle
          title="不可变价格快照"
          copy="模型、Embedding、Rerank、Tool、API、存储和人工审核统一定价。"
        />
        <PriceForm
          currency={dashboard.currency}
          onCreate={(input) => onMutate(() => createFinopsPriceSnapshot(input))}
        />
        <div className="finops-table-wrap">
          <table>
            <thead>
              <tr>
                <th>资源</th>
                <th>供应商 / SKU</th>
                <th>单位价格</th>
                <th>版本</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {dashboard.priceSnapshots.map((price) => (
                <tr key={price.id}>
                  <td>{price.resourceKind}</td>
                  <td>
                    {price.provider} / {price.sku}
                  </td>
                  <td>
                    {money(price.unitPrice, price.currency)} / {price.unitSize} {price.billingUnit}
                  </td>
                  <td>
                    {price.code} v{price.version}
                  </td>
                  <td>
                    <Status value={price.status} />
                  </td>
                  <td>
                    {price.status === 'DRAFT' ? (
                      <ReviewButton
                        disabled={price.createdByUserId === currentUserId}
                        label="批准"
                        onClick={() =>
                          onMutate(() =>
                            reviewFinopsPriceSnapshot(price.id, {
                              expectedRevision: price.revision,
                              decision: 'APPROVE',
                              comment: '价格来源和有效期已由独立复核人确认。',
                              idempotencyKey: key('price-review'),
                            }),
                          )
                        }
                      />
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {dashboard.priceSnapshots.length === 0 ? (
            <Empty title="尚无价格快照" copy="先登记来源可追溯的价格，再记录成本。" />
          ) : null}
        </div>
      </section>

      <section className="finops-card span-two">
        <CardTitle title="成本账本" copy="展示原始用量、价格版本、公式版本、校验状态和来源记录。" />
        <CostForm
          priceSnapshots={dashboard.priceSnapshots}
          onCreate={(input) => onMutate(() => recordFinopsCost(input))}
        />
        <div className="finops-table-wrap">
          <table>
            <thead>
              <tr>
                <th>发生时间</th>
                <th>对象</th>
                <th>资源</th>
                <th>数量 / 公式</th>
                <th>成本</th>
                <th>原始 / 生效校验</th>
                <th>来源</th>
                <th>独立复核</th>
              </tr>
            </thead>
            <tbody>
              {dashboard.costEntries.map((entry) => (
                <tr key={entry.id}>
                  <td>{date(entry.incurredAt)}</td>
                  <td>
                    {entry.subjectType}
                    <small>{shortId(entry.subjectId)}</small>
                  </td>
                  <td>{entry.resourceKind}</td>
                  <td>
                    {entry.quantity}
                    <small>
                      {entry.formulaCode} v{entry.formulaVersion}
                    </small>
                  </td>
                  <td>{money(entry.calculatedAmount, entry.currency)}</td>
                  <td>
                    <Status value={entry.originalVerificationStatus} />
                    <small>
                      生效：
                      <Status value={entry.effectiveVerificationStatus} />
                    </small>
                  </td>
                  <td>
                    {entry.source.system}
                    <small>
                      {entry.source.recordId} · {entry.source.recordVersion}
                    </small>
                  </td>
                  <td>
                    <span>
                      {entry.latestVerificationReview
                        ? entry.latestVerificationReview.basis
                        : '尚无复核'}
                      {entry.latestVerificationReview ? (
                        <>
                          <small>
                            复核人 {shortId(entry.latestVerificationReview.reviewerUserId)} · r
                            {entry.latestVerificationReview.revision}
                          </small>
                          {entry.latestVerificationReview.evidenceId ? (
                            <small>
                              Evidence {shortId(entry.latestVerificationReview.evidenceId)} v
                              {entry.latestVerificationReview.evidenceVersion}
                            </small>
                          ) : null}
                        </>
                      ) : null}
                    </span>
                    <CostReviewForm
                      entry={entry}
                      disabled={entry.recordedByUserId === currentUserId}
                      evidenceCatalog={evidenceCatalog}
                      onReview={(input) => onMutate(() => reviewFinopsCost(entry.id, input))}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {dashboard.costEntries.length === 0 ? (
            <Empty title="尚无成本记录" copy="成本只接受带价格快照与可信来源的后端账本记录。" />
          ) : null}
        </div>
      </section>
    </div>
  );
}

function BudgetPanel({
  dashboard,
  tenantId,
  currentUserId,
  onMutate,
}: {
  dashboard: FinopsDashboard;
  tenantId: string;
  currentUserId: string;
  onMutate: Mutate;
}): ReactNode {
  return (
    <div className="finops-grid">
      <section className="finops-card">
        <CardTitle title="新建预算版本" copy="预算金额与作用域创建后不可直接改写。" />
        <BudgetForm
          tenantId={tenantId}
          currency={dashboard.currency}
          dimensionMembers={dashboard.dimensionMembers}
          onCreate={(input) => onMutate(() => createFinopsBudget(input))}
        />
      </section>
      <section className="finops-card">
        <CardTitle title="预留 / 结算" copy="预留受硬限额约束，结算必须绑定已验证成本。" />
        <BudgetEventForm
          budgets={dashboard.budgets}
          costEntries={dashboard.costEntries}
          onCreate={(budgetId, input) => onMutate(() => createFinopsBudgetEvent(budgetId, input))}
        />
      </section>
      <section className="finops-card span-two">
        <CardTitle title="预算状态" copy="可用额由不可变预留、释放与结算事件实时派生。" />
        <div className="finops-table-wrap">
          <table>
            <thead>
              <tr>
                <th>预算</th>
                <th>作用域</th>
                <th>限额</th>
                <th>预留</th>
                <th>结算</th>
                <th>可用</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {dashboard.budgets.map((budget) => (
                <tr key={budget.id}>
                  <td>
                    {budget.code} v{budget.version}
                  </td>
                  <td>
                    {budget.scopeType}
                    <small>{shortId(budget.scopeId)}</small>
                  </td>
                  <td>{money(budget.limitAmount, budget.currency)}</td>
                  <td>{money(budget.reservedAmount, budget.currency)}</td>
                  <td>{money(budget.settledAmount, budget.currency)}</td>
                  <td>{money(budget.availableAmount, budget.currency)}</td>
                  <td>
                    <Status value={budget.status} />
                  </td>
                  <td>
                    {budget.status === 'DRAFT' ? (
                      <ReviewButton
                        disabled={budget.createdByUserId === currentUserId}
                        label="启用"
                        onClick={() =>
                          onMutate(() =>
                            reviewFinopsBudget(budget.id, {
                              expectedRevision: budget.revision,
                              decision: 'APPROVE',
                              comment: '预算作用域、期间和硬限额已独立复核。',
                              idempotencyKey: key('budget-review'),
                            }),
                          )
                        }
                      />
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {dashboard.budgets.length === 0 ? (
            <Empty
              title="尚无预算"
              copy="可按租户、人、角色、任务、流程、客户、项目或部门建预算。"
            />
          ) : null}
        </div>
      </section>
    </div>
  );
}

function AllocationPanel({
  dashboard,
  currentUserId,
  onMutate,
}: {
  dashboard: FinopsDashboard;
  currentUserId: string;
  onMutate: Mutate;
}): ReactNode {
  return (
    <section className="finops-card">
      <CardTitle
        title="多维成本归集"
        copy="归集规则固定版本，确认后历史不可修改；AI 建议必须由不同人工复核人确认。"
      />
      <div className="finops-table-wrap">
        <table>
          <thead>
            <tr>
              <th>成本记录</th>
              <th>规则</th>
              <th>来源</th>
              <th>明细</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {dashboard.allocationSets.map((set) => (
              <tr key={set.id}>
                <td>{shortId(set.costEntryId)}</td>
                <td>
                  {shortId(set.ruleId)} v{set.ruleVersion}
                </td>
                <td>{set.origin}</td>
                <td>
                  {set.lines.length} 条
                  <small>
                    {set.lines
                      .map((line) =>
                        [
                          line.employeeUserId ? '员工' : null,
                          line.roleAssignmentId ? '角色' : null,
                          line.taskId ? '任务' : null,
                          line.processDefinitionId ? '流程' : null,
                          line.customerId ? '客户' : null,
                          line.projectId ? '项目' : null,
                          line.departmentOrgUnitId ? '部门' : null,
                        ]
                          .filter(Boolean)
                          .join('/'),
                      )
                      .join('；')}
                  </small>
                </td>
                <td>
                  <Status value={set.status} />
                </td>
                <td>
                  {set.status === 'CANDIDATE' || set.status === 'PENDING_REVIEW' ? (
                    <ReviewButton
                      disabled={set.proposedByUserId === currentUserId}
                      label="确认归集"
                      onClick={() =>
                        onMutate(() =>
                          reviewFinopsAllocationSet(set.id, {
                            expectedRevision: set.revision,
                            decision: 'CONFIRM',
                            comment: '分摊规则、权重、金额及维度引用已独立复核。',
                            idempotencyKey: key('allocation-review'),
                          }),
                        )
                      }
                    />
                  ) : (
                    '—'
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {dashboard.allocationSets.length === 0 ? (
          <Empty title="尚无归集候选" copy="API 可按批准规则提交完整、可闭合的多维分摊集。" />
        ) : null}
      </div>
    </section>
  );
}

function ValuePanel({
  dashboard,
  currentUserId,
  onMutate,
}: {
  dashboard: FinopsDashboard;
  currentUserId: string;
  onMutate: Mutate;
}): ReactNode {
  return (
    <section className="finops-card">
      <CardTitle
        title="成果与价值收益归因"
        copy="每笔收益强制关联 Deliverable、Acceptance、Evidence、ValueVersion 与 Objective。"
      />
      <div className="finops-table-wrap">
        <table>
          <thead>
            <tr>
              <th>收益</th>
              <th>期间</th>
              <th>产出 / 验收</th>
              <th>证据 / 价值 / 目标</th>
              <th>来源</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {dashboard.benefitClaims.map((claim) => (
              <tr key={claim.id}>
                <td>
                  {money(claim.amount, claim.currency)}
                  <small>
                    {claim.code} v{claim.version}
                  </small>
                </td>
                <td>
                  {date(claim.periodStart)} — {date(claim.periodEnd)}
                </td>
                <td>
                  {shortId(claim.deliverableId)} / {shortId(claim.acceptanceId)}
                </td>
                <td>
                  {shortId(claim.evidenceId)} / {shortId(claim.valueVersionId)} /{' '}
                  {shortId(claim.objectiveId)}
                </td>
                <td>{claim.origin}</td>
                <td>
                  <Status value={claim.status} />
                </td>
                <td>
                  {claim.status === 'CANDIDATE' || claim.status === 'PENDING_REVIEW' ? (
                    <ReviewButton
                      disabled={claim.createdByUserId === currentUserId}
                      label="人工确认"
                      onClick={() =>
                        onMutate(() =>
                          reviewFinopsBenefitClaim(claim.id, {
                            expectedRevision: claim.revision,
                            decision: 'CONFIRM',
                            comment: '验收结论、可信证据、价值与目标归因已独立复核。',
                            trustedImportReceipt: null,
                            idempotencyKey: key('benefit-review'),
                          }),
                        )
                      }
                    />
                  ) : (
                    (claim.confirmationAuthority ?? '—')
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {dashboard.benefitClaims.length === 0 ? (
          <Empty title="尚无收益候选" copy="AI 只能提交候选；没有可信证据和验收就不能进入 ROI。" />
        ) : null}
      </div>
    </section>
  );
}

function RoiPanel({
  dashboard,
  currentUserId,
  onMutate,
}: {
  dashboard: FinopsDashboard;
  currentUserId: string;
  onMutate: Mutate;
}): ReactNode {
  const approved = dashboard.roiFormulas.filter((formula) => formula.status === 'APPROVED');
  return (
    <div className="finops-grid">
      <section className="finops-card">
        <CardTitle title="公式版本" copy="唯一允许的公式由独立人工批准，重算时固定版本。" />
        <ul className="finops-list">
          {dashboard.roiFormulas.map((formula) => (
            <li key={formula.id}>
              <span>
                <strong>
                  {formula.code} v{formula.version}
                </strong>
                <small>{formula.expression}</small>
              </span>
              <span>
                <Status value={formula.status} />
                {formula.status === 'DRAFT' ? (
                  <ReviewButton
                    disabled={formula.createdByUserId === currentUserId}
                    label="批准"
                    onClick={() =>
                      onMutate(() =>
                        reviewFinopsRoiFormula(formula.id, {
                          expectedRevision: formula.revision,
                          decision: 'APPROVE',
                          comment: 'ROI 公式及来源口径已独立复核。',
                          idempotencyKey: key('roi-formula-review'),
                        }),
                      )
                    }
                  />
                ) : null}
              </span>
            </li>
          ))}
        </ul>
        {dashboard.roiFormulas.length === 0 ? (
          <Empty title="尚无公式版本" copy="先通过 API 创建并由不同管理员批准公式。" />
        ) : null}
      </section>
      <section className="finops-card">
        <CardTitle title="重新计算" copy="成本和收益均由后端账本聚合，界面不能手填收益。" />
        <RoiForm
          formulaId={approved[0]?.id ?? null}
          currency={dashboard.currency}
          disabled={approved.length === 0}
          onSubmit={(input) => onMutate(() => recomputeFinopsRoi(input))}
        />
      </section>
      <section className="finops-card span-two">
        <CardTitle title="ROI 快照" copy="每次重算追加快照；成本为零时明确标记无效，不产生比率。" />
        <div className="finops-table-wrap">
          <table>
            <thead>
              <tr>
                <th>计算时间</th>
                <th>期间</th>
                <th>已验证成本</th>
                <th>已确认收益</th>
                <th>净收益</th>
                <th>ROI</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              {dashboard.roiSnapshots.map((snapshot) => (
                <tr key={snapshot.id}>
                  <td>{date(snapshot.createdAt)}</td>
                  <td>
                    {date(snapshot.periodStart)} — {date(snapshot.periodEnd)}
                  </td>
                  <td>{money(snapshot.verifiedCost, snapshot.currency)}</td>
                  <td>{money(snapshot.confirmedBenefit, snapshot.currency)}</td>
                  <td>{money(snapshot.netBenefit, snapshot.currency)}</td>
                  <td>
                    {snapshot.roiRatio === null
                      ? '不可计算'
                      : `${(Number(snapshot.roiRatio) * 100).toFixed(2)}%`}
                  </td>
                  <td>
                    <Status value={snapshot.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {dashboard.roiSnapshots.length === 0 ? (
            <Empty title="尚无 ROI 快照" copy="批准公式后可对选定期间执行可审计重算。" />
          ) : null}
        </div>
      </section>
    </div>
  );
}

function ExceptionPanel({
  dashboard,
  onMutate,
}: {
  dashboard: FinopsDashboard;
  onMutate: Mutate;
}): ReactNode {
  const unverified = dashboard.costEntries.filter(
    (entry) => entry.effectiveVerificationStatus !== 'VERIFIED',
  );
  return (
    <div className="finops-grid">
      <section className="finops-card">
        <CardTitle title="预算与结算告警" copy="告警可确认但不可删除，原始触发金额保持不变。" />
        <ul className="finops-list">
          {dashboard.alerts.map((alert) => (
            <li key={alert.id}>
              <span>
                <strong>{alert.type}</strong>
                <small>{alert.message}</small>
              </span>
              <span>
                <Status value={alert.status} />
                {alert.status === 'OPEN' ? (
                  <ReviewButton
                    label="确认"
                    onClick={() =>
                      onMutate(() =>
                        acknowledgeFinopsAlert(alert.id, {
                          expectedRevision: alert.revision,
                          comment: '已确认告警并进入人工处置流程。',
                          idempotencyKey: key('alert-ack'),
                        }),
                      )
                    }
                  />
                ) : null}
              </span>
            </li>
          ))}
        </ul>
        {dashboard.alerts.length === 0 ? (
          <Empty title="没有预算告警" copy="当前币种下未发现阈值或结算异常。" />
        ) : null}
      </section>
      <section className="finops-card">
        <CardTitle title="待校验成本" copy="未验证记录不会进入 ROI 的成本分母。" />
        <ul className="finops-list">
          {unverified.map((entry) => (
            <li key={entry.id}>
              <span>
                <strong>{money(entry.calculatedAmount, entry.currency)}</strong>
                <small>
                  {entry.subjectType} · {entry.source.system}/{entry.source.recordId}
                </small>
              </span>
              <Status value={entry.effectiveVerificationStatus} />
            </li>
          ))}
        </ul>
        {unverified.length === 0 ? (
          <Empty title="没有待校验成本" copy="当前加载的账本记录均已通过来源校验。" />
        ) : null}
      </section>
      <section className="finops-card span-two">
        <CardTitle
          title="自动记账诊断"
          copy="仅确认终态、可信用量并与已批准价格精确核对的运行会进入账本；阻断项修复后由对账器自动关闭。"
        />
        <ul className="finops-list">
          {dashboard.projectionDiagnostics.map((diagnostic) => (
            <li key={diagnostic.id}>
              <span>
                <strong>{diagnostic.code}</strong>
                <small>
                  {diagnostic.sourceKind} · {shortId(diagnostic.sourceId)} · {diagnostic.detail}
                </small>
              </span>
              <Status value={diagnostic.status} />
            </li>
          ))}
        </ul>
        {dashboard.projectionDiagnostics.length === 0 ? (
          <Empty
            title="没有自动记账阻断"
            copy="当前已发现的运行结算均已投影，或尚未产生可对账的终态运行。"
          />
        ) : null}
      </section>
      <section className="finops-card span-two">
        <CardTitle
          title="模型路由建议"
          copy="接受只代表进入策略评审，系统不会自动改路由或突破质量、权限与预算边界。"
        />
        <div className="finops-table-wrap">
          <table>
            <thead>
              <tr>
                <th>当前路由</th>
                <th>建议路由</th>
                <th>预计节省</th>
                <th>质量下限</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {dashboard.routingSuggestions.map((suggestion) => (
                <tr key={suggestion.id}>
                  <td>{suggestion.currentRoute}</td>
                  <td>{suggestion.suggestedRoute}</td>
                  <td>{money(suggestion.estimatedSavings, suggestion.currency)}</td>
                  <td>{(suggestion.qualityFloor * 100).toFixed(1)}%</td>
                  <td>
                    <Status value={suggestion.status} />
                  </td>
                  <td>
                    {suggestion.status === 'PROPOSED' ? (
                      <ReviewButton
                        label="进入评审"
                        onClick={() =>
                          onMutate(() =>
                            decideFinopsRoutingSuggestion(suggestion.id, {
                              expectedRevision: suggestion.revision,
                              decision: 'ACCEPT_FOR_REVIEW',
                              comment: '只进入模型策略评审，不自动应用。',
                              idempotencyKey: key('route-review'),
                            }),
                          )
                        }
                      />
                    ) : (
                      '未自动应用'
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {dashboard.routingSuggestions.length === 0 ? (
            <Empty title="没有路由建议" copy="建议只由真实运行与价格状态生成，不展示静态推荐。" />
          ) : null}
        </div>
      </section>
    </div>
  );
}

function CostForm({
  priceSnapshots,
  onCreate,
}: {
  priceSnapshots: FinopsDashboard['priceSnapshots'];
  onCreate: (input: Parameters<typeof recordFinopsCost>[0]) => Promise<void>;
}): ReactNode {
  const [formError, setFormError] = useState<string | null>(null);
  const approvedPrices = priceSnapshots.filter((price) => price.status === 'APPROVED');
  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const subjectType = required(data, 'subjectType') as FinopsCostEntry['subjectType'];
    const priceSnapshotId = required(data, 'priceSnapshotId');
    const price = approvedPrices.find((candidate) => candidate.id === priceSnapshotId);
    if (!price) {
      setFormError('请选择当前已批准的计价方案。');
      return;
    }
    const quantity = required(data, 'quantity');
    const incurredAt = new Date(required(data, 'incurredAt')).toISOString();
    const subjectId = `manual-${crypto.randomUUID()}`;
    const sourceContent = JSON.stringify({
      subjectType,
      subjectId,
      priceSnapshotId,
      quantity,
      incurredAt,
    });
    setFormError(null);
    try {
      await onCreate({
        subjectType,
        subjectId,
        agentRunId: null,
        toolInvocationId: null,
        knowledgeDocumentVersionId: null,
        humanUserId: null,
        priceSnapshotId,
        quantity,
        rawUsage: { billingUnit: price.billingUnit, quantity },
        formulaCode: 'LINEAR_UNIT_RATE',
        formulaVersion: 1,
        formulaExpression: '(quantity / unitSize) * unitPrice',
        verificationStatus: 'PENDING',
        source: {
          authority: 'HUMAN_ATTESTED',
          system: 'ADMIN_MANUAL_ENTRY',
          recordId: subjectId,
          recordVersion: '1',
          contentHash: await sha256Hex(sourceContent),
          evidenceId: null,
          evidenceVersion: null,
        },
        incurredAt,
        idempotencyKey: key('cost-record'),
      });
      form.reset();
    } catch (caught) {
      setFormError(messageFromError(caught));
    }
  };
  return (
    <form className="finops-inline-form" onSubmit={submit}>
      <label>
        成本对象
        <select name="subjectType" defaultValue="API">
          <option value="API">接口调用</option>
          <option value="STORAGE">文件存储</option>
        </select>
      </label>
      <label>
        已批准价格
        <select name="priceSnapshotId" required disabled={approvedPrices.length === 0}>
          <option value="">选择价格快照</option>
          {approvedPrices.map((price) => (
            <option key={price.id} value={price.id}>
              {price.code} v{price.version} · {price.provider}/{price.sku}
            </option>
          ))}
        </select>
      </label>
      <label>
        用量
        <input name="quantity" required inputMode="decimal" />
      </label>
      <label>
        发生时间
        <input name="incurredAt" type="datetime-local" required />
      </label>
      <small>
        记录标识、来源版本、校验值和计价公式由系统生成；智能体、工具和知识处理成本只从真实运行记录自动归集。
      </small>
      <button type="submit" className="primary-button" disabled={approvedPrices.length === 0}>
        <Icon name="plus" size={16} /> 登记待复核成本
      </button>
      <small>金额由数据库使用已批准价格快照、数量与固定公式计算，表单不接受金额。</small>
      {formError ? <small className="finops-form-error">{formError}</small> : null}
    </form>
  );
}

function CostReviewForm({
  entry,
  disabled,
  evidenceCatalog,
  onReview,
}: {
  entry: FinopsCostEntry;
  disabled: boolean;
  evidenceCatalog: Evidence[];
  onReview: (input: Parameters<typeof reviewFinopsCost>[1]) => Promise<void>;
}): ReactNode {
  const [basis, setBasis] =
    useState<Parameters<typeof reviewFinopsCost>[1]['basis']>('TRUSTED_EVIDENCE');
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const evidence = evidenceCatalog.find((item) => item.id === optional(data, 'evidence'));
    void onReview({
      decision: required(data, 'decision') as Parameters<typeof reviewFinopsCost>[1]['decision'],
      basis,
      evidenceId: evidence?.id ?? null,
      evidenceVersion: evidence?.version ?? null,
      comment: required(data, 'comment'),
      idempotencyKey: key('cost-review'),
    }).then(() => form.reset());
  };
  if (disabled) return <small>登记人与复核人必须分离</small>;
  return (
    <details className="finops-review">
      <summary>复核成本 {shortId(entry.id)}</summary>
      <form className="finops-review-form" onSubmit={submit}>
        <label>
          决定
          <select name="decision" defaultValue="VERIFIED">
            <option value="VERIFIED">验证通过</option>
            <option value="DISPUTED">有争议</option>
            <option value="REJECTED">拒绝</option>
          </select>
        </label>
        <label>
          依据
          <select
            name="basis"
            value={basis}
            onChange={(event) =>
              setBasis(event.target.value as Parameters<typeof reviewFinopsCost>[1]['basis'])
            }
          >
            <option value="TRUSTED_EVIDENCE">有效可信 Evidence</option>
            <option value="TRUSTED_SOURCE">受信来源</option>
            <option value="REVIEWER_JUDGMENT">复核判断（不可验证通过）</option>
          </select>
        </label>
        {basis === 'TRUSTED_EVIDENCE' ? (
          <label>
            可信证据
            <select name="evidence" required disabled={evidenceCatalog.length === 0}>
              <option value="">请选择已验证证据</option>
              {evidenceCatalog.map((evidence) => (
                <option key={evidence.id} value={evidence.id}>
                  {evidence.summary}（版本 {evidence.version}）
                </option>
              ))}
            </select>
            {evidenceCatalog.length === 0 ? (
              <small>当前没有可用于成本复核的已验证证据，请先在经营主链完成证据验证。</small>
            ) : null}
          </label>
        ) : null}
        <label>
          复核意见
          <textarea name="comment" required />
        </label>
        <button type="submit" className="finops-action">
          提交不可变复核
        </button>
      </form>
    </details>
  );
}

function PriceForm({
  currency,
  onCreate,
}: {
  currency: string;
  onCreate: (input: Parameters<typeof createFinopsPriceSnapshot>[0]) => Promise<void>;
}): ReactNode {
  const [resourceKind, setResourceKind] = useState<FinopsPriceSnapshot['resourceKind']>('MODEL');
  const [provider, setProvider] = useState('');
  const [sku, setSku] = useState('');
  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const code = finopsCode('PRICE', resourceKind, provider || 'PROVIDER', sku || 'SKU');
    const billingUnit = required(data, 'billingUnit') as FinopsPriceSnapshot['billingUnit'];
    const unitSize = required(data, 'unitSize');
    const unitPrice = required(data, 'unitPrice');
    const effectiveFrom = day(required(data, 'effectiveFrom'));
    const recordId = `manual-price-${crypto.randomUUID()}`;
    const sourceContent = JSON.stringify({
      code,
      resourceKind,
      provider,
      sku,
      currency,
      billingUnit,
      unitSize,
      unitPrice,
      effectiveFrom,
    });
    await onCreate({
      code,
      resourceKind,
      provider,
      sku,
      currency,
      billingUnit,
      unitSize,
      unitPrice,
      effectiveFrom,
      effectiveTo: null,
      source: {
        authority: 'HUMAN_ATTESTED',
        system: 'ADMIN_MANUAL_PRICE',
        recordId,
        recordVersion: '1',
        contentHash: await sha256Hex(sourceContent),
        evidenceId: null,
        evidenceVersion: null,
      },
      idempotencyKey: key('price-create'),
    });
    form.reset();
  };
  return (
    <form className="finops-inline-form" onSubmit={submit}>
      <label>
        资源
        <select
          name="resourceKind"
          value={resourceKind}
          onChange={(event) =>
            setResourceKind(event.target.value as FinopsPriceSnapshot['resourceKind'])
          }
        >
          {['MODEL', 'EMBEDDING', 'RERANK', 'TOOL', 'API', 'STORAGE', 'HUMAN_REVIEW'].map(
            (value) => (
              <option key={value}>{value}</option>
            ),
          )}
        </select>
      </label>
      <label>
        供应商
        <input
          name="provider"
          required
          value={provider}
          onChange={(event) => setProvider(event.target.value)}
        />
      </label>
      <label>
        SKU
        <input name="sku" required value={sku} onChange={(event) => setSku(event.target.value)} />
      </label>
      <label>
        计价单位
        <select name="billingUnit" defaultValue="TOKEN">
          {['INPUT_TOKEN', 'OUTPUT_TOKEN', 'TOKEN', 'REQUEST', 'CALL', 'HOUR', 'GB_MONTH'].map(
            (value) => (
              <option key={value}>{value}</option>
            ),
          )}
        </select>
      </label>
      <label>
        单位数量
        <input name="unitSize" required inputMode="decimal" defaultValue="1000" />
      </label>
      <label>
        单位价格
        <input name="unitPrice" required inputMode="decimal" />
      </label>
      <label>
        生效日
        <input name="effectiveFrom" required type="date" />
      </label>
      <p className="finops-form-note">
        系统将自动生成价格代码：
        {finopsCode('PRICE', resourceKind, provider || 'PROVIDER', sku || 'SKU')}
      </p>
      <p className="finops-form-note">
        内部代码、来源记录、版本和校验值由系统生成；供应商账单价格应通过账单连接器导入后再复核。
      </p>
      <button type="submit" className="primary-button">
        <Icon name="plus" size={16} /> 新建草稿
      </button>
    </form>
  );
}

function BudgetForm({
  tenantId,
  currency,
  dimensionMembers,
  onCreate,
}: {
  tenantId: string;
  currency: string;
  dimensionMembers: FinopsDashboard['dimensionMembers'];
  onCreate: (input: Parameters<typeof createFinopsBudget>[0]) => Promise<void>;
}): ReactNode {
  const [scopeType, setScopeType] = useState<'TENANT' | 'CUSTOMER' | 'PROJECT'>('TENANT');
  const visibleScopes = dimensionMembers.filter((member) => member.dimension === scopeType);
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const periodStart = required(data, 'periodStart');
    void onCreate({
      code: finopsCode('BUDGET', scopeType, currency, periodStart.slice(0, 7)),
      scopeType,
      scopeId: scopeType === 'TENANT' ? tenantId : required(data, 'scopeId'),
      scopeVersion: null,
      currency,
      limitAmount: required(data, 'limitAmount'),
      alertThresholdRatio: required(data, 'alertThresholdRatio'),
      periodStart: day(periodStart),
      periodEnd: day(required(data, 'periodEnd')),
      idempotencyKey: key('budget-create'),
    }).then(() => form.reset());
  };
  return (
    <form className="finops-form" onSubmit={submit}>
      <label>
        作用域
        <select
          name="scopeType"
          value={scopeType}
          onChange={(event) =>
            setScopeType(event.target.value as 'TENANT' | 'CUSTOMER' | 'PROJECT')
          }
        >
          <option value="TENANT">当前企业</option>
          <option
            value="CUSTOMER"
            disabled={!dimensionMembers.some((item) => item.dimension === 'CUSTOMER')}
          >
            客户
          </option>
          <option
            value="PROJECT"
            disabled={!dimensionMembers.some((item) => item.dimension === 'PROJECT')}
          >
            项目
          </option>
        </select>
      </label>
      {scopeType === 'TENANT' ? (
        <p className="finops-form-note">预算范围自动继承当前企业，无需填写内部 ID。</p>
      ) : (
        <label>
          {scopeType === 'CUSTOMER' ? '客户' : '项目'}
          <select name="scopeId" required>
            <option value="">请选择</option>
            {visibleScopes.map((member) => (
              <option key={member.id} value={member.id}>
                {member.name}（{member.code}）
              </option>
            ))}
          </select>
        </label>
      )}
      <label>
        硬限额
        <input name="limitAmount" required inputMode="decimal" />
      </label>
      <label>
        告警比例
        <input name="alertThresholdRatio" required inputMode="decimal" defaultValue="0.8" />
      </label>
      <label>
        开始
        <input name="periodStart" required type="date" />
      </label>
      <label>
        结束
        <input name="periodEnd" required type="date" />
      </label>
      <p className="finops-form-note">
        预算代码由范围、币种和开始月份自动生成；其他业务范围需先接入受治理对象目录。
      </p>
      <button type="submit" className="primary-button">
        新建预算草稿
      </button>
    </form>
  );
}

function BudgetEventForm({
  budgets,
  costEntries,
  onCreate,
}: {
  budgets: FinopsBudget[];
  costEntries: FinopsCostEntry[];
  onCreate: (
    budgetId: string,
    input: Parameters<typeof createFinopsBudgetEvent>[1],
  ) => Promise<void>;
}): ReactNode {
  const active = budgets.filter((budget) => budget.status === 'ACTIVE');
  const [type, setType] = useState<'RESERVATION' | 'SETTLEMENT' | 'RELEASE'>('RESERVATION');
  const verifiedCosts = costEntries.filter(
    (entry) => entry.effectiveVerificationStatus === 'VERIFIED',
  );
  const reservationDirectoryAvailable = false;
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    void onCreate(required(data, 'budgetId'), {
      type,
      amount: required(data, 'amount'),
      reservationEventId: type === 'RESERVATION' ? null : optional(data, 'reservationEventId'),
      costEntryId: type === 'SETTLEMENT' ? optional(data, 'costEntryId') : null,
      reason: required(data, 'reason'),
      idempotencyKey: key(`budget-${type.toLowerCase()}`),
    }).then(() => form.reset());
  };
  return (
    <form className="finops-form" onSubmit={submit}>
      <label>
        生效预算
        <select name="budgetId" required>
          <option value="">请选择</option>
          {active.map((budget) => (
            <option key={budget.id} value={budget.id}>
              {budget.code} v{budget.version}
            </option>
          ))}
        </select>
      </label>
      <label>
        事件
        <select
          name="type"
          value={type}
          onChange={(event) =>
            setType(event.target.value as 'RESERVATION' | 'SETTLEMENT' | 'RELEASE')
          }
        >
          <option value="RESERVATION">预留预算</option>
          <option value="SETTLEMENT">结算已验证成本</option>
          <option value="RELEASE">释放预留</option>
        </select>
      </label>
      <label>
        金额
        <input name="amount" required inputMode="decimal" />
      </label>
      {type !== 'RESERVATION' ? (
        <label>
          关联预留
          <select name="reservationEventId" required disabled={!reservationDirectoryAvailable}>
            <option value="">当前 dashboard 未返回可识别的预留事件</option>
          </select>
          <small>当前预算尚无可选择的未结预留记录；目录就绪后才可执行释放操作。</small>
        </label>
      ) : null}
      {type === 'SETTLEMENT' ? (
        <label>
          关联已验证成本
          <select name="costEntryId" required disabled={verifiedCosts.length === 0}>
            <option value="">请选择成本记录</option>
            {verifiedCosts.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {date(entry.incurredAt)} · {entry.subjectType} ·{' '}
                {money(entry.calculatedAmount, entry.currency)}
              </option>
            ))}
          </select>
          {verifiedCosts.length === 0 ? <small>当前没有可结算的已验证成本。</small> : null}
        </label>
      ) : null}
      <label>
        原因
        <input name="reason" required />
      </label>
      <button
        type="submit"
        className="primary-button"
        disabled={
          active.length === 0 ||
          (type !== 'RESERVATION' && !reservationDirectoryAvailable) ||
          (type === 'SETTLEMENT' && verifiedCosts.length === 0)
        }
      >
        写入不可变事件
      </button>
    </form>
  );
}

function RoiForm({
  formulaId,
  currency,
  disabled,
  onSubmit,
}: {
  formulaId: string | null;
  currency: string;
  disabled: boolean;
  onSubmit: (input: Parameters<typeof recomputeFinopsRoi>[0]) => Promise<void>;
}): ReactNode {
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (formulaId === null) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    void onSubmit({
      formulaId,
      currency,
      periodStart: day(required(data, 'periodStart')),
      periodEnd: day(required(data, 'periodEnd')),
      recalculationOfId: null,
      idempotencyKey: key('roi-recompute'),
    });
  };
  return (
    <form className="finops-form" onSubmit={submit}>
      <label>
        开始
        <input name="periodStart" required type="date" />
      </label>
      <label>
        结束
        <input name="periodEnd" required type="date" />
      </label>
      <button type="submit" className="primary-button" disabled={disabled}>
        从账本重新计算
      </button>
      <small>收益和成本不能在此表单中输入。</small>
    </form>
  );
}

function Kpi({
  label,
  value,
  alert = false,
}: {
  label: string;
  value: string;
  alert?: boolean;
}): ReactNode {
  return (
    <div className={alert ? 'finops-kpi alert' : 'finops-kpi'}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function CardTitle({ title, copy }: { title: string; copy: string }): ReactNode {
  return (
    <header className="finops-card-title">
      <h2>{title}</h2>
      <p>{copy}</p>
    </header>
  );
}

function Status({ value }: { value: string }): ReactNode {
  return <span className={`finops-status status-${value.toLowerCase()}`}>{value}</span>;
}

function ReviewButton({
  label,
  onClick,
  disabled = false,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}): ReactNode {
  return (
    <button type="button" className="finops-action" onClick={onClick} disabled={disabled}>
      {label}
    </button>
  );
}

function Empty({ title, copy }: { title: string; copy: string }): ReactNode {
  return (
    <div className="finops-empty">
      <strong>{title}</strong>
      <span>{copy}</span>
    </div>
  );
}

type Mutate = (operation: () => Promise<unknown>) => Promise<void>;

function required(data: FormData, name: string): string {
  const value = data.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function optional(data: FormData, name: string): string | null {
  const value = required(data, name);
  return value === '' ? null : value;
}

export function finopsCode(prefix: string, ...parts: string[]): string {
  return [prefix, ...parts]
    .map((part) =>
      part
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9]+/gu, '.')
        .replace(/^\.+|\.+$/gu, ''),
    )
    .filter(Boolean)
    .join('.')
    .slice(0, 100);
}

function day(value: string): string {
  return new Date(`${value}T00:00:00.000Z`).toISOString();
}

function key(prefix: string): string {
  if (typeof crypto === 'undefined' || typeof crypto.getRandomValues !== 'function') {
    throw new Error('Secure Web Crypto is required to create an idempotency key.');
  }
  const random = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : randomUuid(crypto);
  return `${prefix}-${random}`;
}

function randomUuid(source: Crypto): string {
  const bytes = source.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const value = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return [
    value.slice(0, 8),
    value.slice(8, 12),
    value.slice(12, 16),
    value.slice(16, 20),
    value.slice(20),
  ].join('-');
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function money(value: string, currency: string): string {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return `${currency} ${value}`;
  return new Intl.NumberFormat('zh-CN', {
    style: 'currency',
    currency,
    maximumFractionDigits: 6,
  }).format(amount);
}

function date(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium' }).format(new Date(value));
}

function shortId(value: string): string {
  return value.length > 16 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value;
}
