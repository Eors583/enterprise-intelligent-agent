import type {
  MarketingActionPlan,
  MarketingInsight,
  MarketingObservation,
  MarketingTarget,
} from '@enterprise/contracts';
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';

import {
  createMarketingActionItem,
  createMarketingActionPlan,
  createMarketingInsight,
  createMarketingMasterData,
  createMarketingObservation,
  createMarketingTarget,
  listMarketingActionPlans,
  listMarketingInsights,
  listMarketingMasterData,
  listMarketingObservations,
  listMarketingTargets,
  transitionMarketingActionPlan,
  transitionMarketingInsight,
  transitionMarketingTarget,
  type MarketingMasterPath,
} from './api';
import { messageFromError } from '@/api/client';
import { Icon } from '@/components/Icons';

import './marketing-management.css';

type MarketingTab = 'FIVE_LOOKS' | 'INSIGHTS' | 'MATRIX' | 'PLANS' | 'MASTER';

const DIMENSION_LABELS: Record<MarketingObservation['dimension'], string> = {
  INDUSTRY: '行业',
  MARKET: '市场',
  CUSTOMER: '客户',
  COMPETITION: '竞争',
  SELF: '自身',
};

const STATUS_LABELS: Record<MarketingInsight['status'], string> = {
  CANDIDATE: '候选',
  UNDER_REVIEW: '待审核',
  APPROVED: '已批准',
  REJECTED: '已驳回',
  PUBLISHED: '已发布',
  RETIRED: '已退役',
};

const ASSERTION_LABELS: Record<MarketingObservation['assertionType'], string> = {
  FACT: '事实',
  HYPOTHESIS: '假设',
  INFERENCE: '推断',
};

interface MarketingData {
  observations: MarketingObservation[];
  insights: MarketingInsight[];
  targets: MarketingTarget[];
  plans: MarketingActionPlan[];
  products: Awaited<ReturnType<typeof listMarketingMasterData>>;
  regions: Awaited<ReturnType<typeof listMarketingMasterData>>;
  segments: Awaited<ReturnType<typeof listMarketingMasterData>>;
}

const EMPTY_DATA: MarketingData = {
  observations: [],
  insights: [],
  targets: [],
  plans: [],
  products: [],
  regions: [],
  segments: [],
};

export function MarketingManagementPage({ currentUserId }: { currentUserId: string }): ReactNode {
  const [tab, setTab] = useState<MarketingTab>('FIVE_LOOKS');
  const [data, setData] = useState<MarketingData>(EMPTY_DATA);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async (signal?: AbortSignal): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const [observations, insights, targets, plans, products, regions, segments] =
        await Promise.all([
          listMarketingObservations(signal),
          listMarketingInsights(signal),
          listMarketingTargets(signal),
          listMarketingActionPlans(signal),
          listMarketingMasterData('products', signal),
          listMarketingMasterData('regions', signal),
          listMarketingMasterData('customer-segments', signal),
        ]);
      setData({ observations, insights, targets, plans, products, regions, segments });
    } catch (caught) {
      if (!(caught instanceof DOMException && caught.name === 'AbortError')) {
        setError(messageFromError(caught));
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void reload(controller.signal);
    return () => controller.abort();
  }, [reload]);

  const mutation = async (work: () => Promise<unknown>): Promise<void> => {
    setError(null);
    try {
      await work();
      await reload();
    } catch (caught) {
      setError(messageFromError(caught));
    }
  };

  return (
    <section className="marketing-page" aria-labelledby="marketing-title">
      <header className="marketing-hero">
        <div>
          <span className="eyebrow">MKT-001 · MKT-002</span>
          <h1 id="marketing-title">营销洞察与目标作战</h1>
          <p>
            用五看证据形成可审核洞察，再把产品与区域/客户群目标连接到战略、价值、角色任命和行动计划。
          </p>
        </div>
        <button type="button" className="secondary-button" onClick={() => void reload()}>
          <Icon name="refresh" size={17} /> 刷新
        </button>
      </header>

      <div className="marketing-kpis" aria-label="营销治理概览">
        <Summary label="证据观察" value={data.observations.length} />
        <Summary
          label="已发布洞察"
          value={data.insights.filter((item) => item.status === 'PUBLISHED').length}
        />
        <Summary
          label="有效目标"
          value={data.targets.filter((item) => item.status === 'ACTIVE').length}
        />
        <Summary
          label="执行中计划"
          value={data.plans.filter((item) => item.status === 'ACTIVE').length}
        />
      </div>

      <nav className="marketing-tabs" aria-label="营销管理视图">
        {(
          [
            ['FIVE_LOOKS', '五看观察'],
            ['INSIGHTS', '洞察审核'],
            ['MATRIX', '目标矩阵'],
            ['PLANS', '行动计划'],
            ['MASTER', '主数据'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            aria-current={tab === id ? 'page' : undefined}
            className={tab === id ? 'active' : ''}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </nav>

      {error ? (
        <div className="marketing-error" role="alert">
          {error}
        </div>
      ) : null}
      {loading ? <p className="marketing-loading">正在读取租户内营销治理数据…</p> : null}

      {!loading && tab === 'FIVE_LOOKS' ? (
        <FiveLooksPanel
          observations={data.observations}
          onCreate={(input) => mutation(() => createMarketingObservation(input))}
        />
      ) : null}
      {!loading && tab === 'INSIGHTS' ? (
        <InsightsPanel
          insights={data.insights}
          observations={data.observations}
          currentUserId={currentUserId}
          onCreate={(input) => mutation(() => createMarketingInsight(input))}
          onTransition={(id, input) => mutation(() => transitionMarketingInsight(id, input))}
        />
      ) : null}
      {!loading && tab === 'MATRIX' ? (
        <TargetMatrixPanel
          targets={data.targets}
          products={data.products}
          regions={data.regions}
          segments={data.segments}
          onCreate={(input) => mutation(() => createMarketingTarget(input))}
          onTransition={(id, input) => mutation(() => transitionMarketingTarget(id, input))}
        />
      ) : null}
      {!loading && tab === 'PLANS' ? (
        <ActionPlansPanel
          plans={data.plans}
          targets={data.targets}
          onCreate={(input) => mutation(() => createMarketingActionPlan(input))}
          onCreateItem={(planId, input) => mutation(() => createMarketingActionItem(planId, input))}
          onTransition={(id, input) => mutation(() => transitionMarketingActionPlan(id, input))}
        />
      ) : null}
      {!loading && tab === 'MASTER' ? (
        <MasterDataPanel
          records={{
            products: data.products,
            regions: data.regions,
            'customer-segments': data.segments,
          }}
          onCreate={(path, input) => mutation(() => createMarketingMasterData(path, input))}
        />
      ) : null}
    </section>
  );
}

function Summary({ label, value }: { label: string; value: number }): ReactNode {
  return (
    <article>
      <strong>{value}</strong>
      <span>{label}</span>
    </article>
  );
}

function FiveLooksPanel({
  observations,
  onCreate,
}: {
  observations: MarketingObservation[];
  onCreate: (input: Parameters<typeof createMarketingObservation>[0]) => Promise<void>;
}): ReactNode {
  return (
    <div className="marketing-stack">
      <ObservationForm onSubmit={onCreate} />
      <div className="five-look-grid">
        {Object.entries(DIMENSION_LABELS).map(([dimension, label]) => {
          const items = observations.filter((item) => item.dimension === dimension);
          return (
            <article key={dimension} className="marketing-card">
              <header>
                <h2>{label}</h2>
                <span>{items.length} 条</span>
              </header>
              {items.length === 0 ? (
                <p className="marketing-empty">尚无经证据绑定的观察。</p>
              ) : (
                <ul className="observation-list">
                  {items.map((item) => (
                    <li key={item.id}>
                      <div>
                        <span className={`assertion assertion-${item.assertionType.toLowerCase()}`}>
                          {ASSERTION_LABELS[item.assertionType]}
                        </span>
                        {item.origin === 'AI' ? (
                          <span className="ai-candidate">AI 候选</span>
                        ) : null}
                      </div>
                      <strong>{item.statement}</strong>
                      <small>
                        置信度 {(item.confidence * 100).toFixed(0)}% · {item.evidence.length} 份证据
                        · v{item.version}
                      </small>
                    </li>
                  ))}
                </ul>
              )}
            </article>
          );
        })}
      </div>
    </div>
  );
}

function ObservationForm({
  onSubmit,
}: {
  onSubmit: (input: Parameters<typeof createMarketingObservation>[0]) => Promise<void>;
}): ReactNode {
  const [open, setOpen] = useState(false);
  return (
    <GovernedForm
      title="新增五看观察"
      open={open}
      onToggle={() => setOpen((value) => !value)}
      onSubmit={async (form) => {
        const origin = String(form.get('origin')) as 'HUMAN' | 'AI';
        await onSubmit({
          code: String(form.get('code')).trim().toUpperCase(),
          dimension: String(form.get('dimension')) as MarketingObservation['dimension'],
          assertionType: String(form.get('assertionType')) as MarketingObservation['assertionType'],
          statement: String(form.get('statement')),
          confidence: Number(form.get('confidence')),
          origin,
          agentRunId: origin === 'AI' ? String(form.get('agentRunId')) : null,
          evidence: [
            {
              evidenceId: String(form.get('evidenceId')),
              evidenceVersion: Number(form.get('evidenceVersion')),
              linkType: 'SUPPORTS',
              expectedContentHash: String(form.get('contentHash')).toLowerCase(),
            },
          ],
          idempotencyKey: crypto.randomUUID(),
        });
        setOpen(false);
      }}
    >
      <Field name="code" label="观察编码" required />
      <SelectField name="dimension" label="五看维度" options={Object.entries(DIMENSION_LABELS)} />
      <SelectField
        name="assertionType"
        label="判断类型"
        options={[
          ['FACT', '事实'],
          ['HYPOTHESIS', '假设'],
          ['INFERENCE', '推断'],
        ]}
      />
      <Field name="confidence" label="置信度（0-1）" type="number" step="0.01" required />
      <SelectField
        name="origin"
        label="来源"
        options={[
          ['HUMAN', '人工'],
          ['AI', 'AI 候选'],
        ]}
      />
      <Field name="agentRunId" label="Agent Run ID（AI 候选必填）" />
      <Field name="evidenceId" label="证据 ID" required />
      <Field name="evidenceVersion" label="证据版本" type="number" required />
      <Field name="contentHash" label="证据 SHA-256" required />
      <TextField name="statement" label="观察陈述" required />
    </GovernedForm>
  );
}

function InsightsPanel({
  insights,
  observations,
  currentUserId,
  onCreate,
  onTransition,
}: {
  insights: MarketingInsight[];
  observations: MarketingObservation[];
  currentUserId: string;
  onCreate: (input: Parameters<typeof createMarketingInsight>[0]) => Promise<void>;
  onTransition: (
    id: string,
    input: Parameters<typeof transitionMarketingInsight>[1],
  ) => Promise<void>;
}): ReactNode {
  return (
    <div className="marketing-stack">
      <GovernedForm
        title="创建洞察候选"
        onSubmit={async (form) => {
          const origin = String(form.get('origin')) as 'HUMAN' | 'AI';
          await onCreate({
            code: String(form.get('code')).trim().toUpperCase(),
            title: String(form.get('title')),
            statement: String(form.get('statement')),
            origin,
            agentRunId: origin === 'AI' ? String(form.get('agentRunId')) : null,
            observationIds: String(form.get('observationIds'))
              .split(',')
              .map((value) => value.trim())
              .filter(Boolean),
            idempotencyKey: crypto.randomUUID(),
          });
        }}
      >
        <Field name="code" label="洞察编码" required />
        <Field name="title" label="洞察标题" required />
        <SelectField
          name="origin"
          label="来源"
          options={[
            ['HUMAN', '人工'],
            ['AI', 'AI 候选'],
          ]}
        />
        <Field name="agentRunId" label="Agent Run ID（AI 候选必填）" />
        <Field
          name="observationIds"
          label={`观察 ID（逗号分隔，当前 ${observations.length} 条）`}
          required
        />
        <TextField name="statement" label="洞察陈述" required />
      </GovernedForm>

      <div className="insight-list">
        {insights.length === 0 ? <p className="marketing-empty">尚无洞察候选。</p> : null}
        {insights.map((insight) => (
          <InsightCard
            key={insight.id}
            insight={insight}
            canReview={insight.createdByUserId !== currentUserId}
            onTransition={onTransition}
          />
        ))}
      </div>
    </div>
  );
}

function InsightCard({
  insight,
  canReview,
  onTransition,
}: {
  insight: MarketingInsight;
  canReview: boolean;
  onTransition: (
    id: string,
    input: Parameters<typeof transitionMarketingInsight>[1],
  ) => Promise<void>;
}): ReactNode {
  const [comment, setComment] = useState('');
  const actions =
    insight.status === 'CANDIDATE'
      ? (['SUBMIT'] as const)
      : insight.status === 'UNDER_REVIEW'
        ? (['APPROVE', 'REJECT'] as const)
        : insight.status === 'APPROVED'
          ? (['PUBLISH'] as const)
          : insight.status === 'PUBLISHED'
            ? (['RETIRE'] as const)
            : ([] as const);
  return (
    <article className="marketing-card insight-card">
      <header>
        <div>
          <span className="marketing-code">
            {insight.code} · v{insight.version}
          </span>
          <h2>{insight.title}</h2>
        </div>
        <span className={`status status-${insight.status.toLowerCase()}`}>
          {STATUS_LABELS[insight.status]}
        </span>
      </header>
      <p>{insight.statement}</p>
      <small>
        {insight.origin === 'AI' ? 'AI 候选（不可自动发布）' : '人工候选'} ·{' '}
        {insight.observationIds.length} 条来源观察 · revision {insight.revision}
      </small>
      {actions.length > 0 ? (
        <div className="review-actions">
          <input
            aria-label={`${insight.title} 审核意见`}
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            placeholder="填写审核或发布意见"
          />
          {actions.map((action) => {
            const independentAction =
              action === 'APPROVE' || action === 'REJECT' || action === 'PUBLISH';
            return (
              <button
                key={action}
                type="button"
                disabled={comment.trim().length < 3 || (independentAction && !canReview)}
                onClick={() =>
                  void onTransition(insight.id, {
                    action,
                    expectedRevision: insight.revision,
                    comment,
                  })
                }
              >
                {actionLabel(action)}
              </button>
            );
          })}
          {!canReview && insight.status === 'UNDER_REVIEW' ? (
            <em>创建人不能审核自己的洞察。</em>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

function TargetMatrixPanel({
  targets,
  products,
  regions,
  segments,
  onCreate,
  onTransition,
}: {
  targets: MarketingTarget[];
  products: MarketingData['products'];
  regions: MarketingData['regions'];
  segments: MarketingData['segments'];
  onCreate: (input: Parameters<typeof createMarketingTarget>[0]) => Promise<void>;
  onTransition: (
    id: string,
    input: Parameters<typeof transitionMarketingTarget>[1],
  ) => Promise<void>;
}): ReactNode {
  const masterName = useMemo(
    () =>
      new Map(
        [...products, ...regions, ...segments].map((record) => [record.id, record.name] as const),
      ),
    [products, regions, segments],
  );
  return (
    <div className="marketing-stack">
      <GovernedForm
        title="创建产品目标矩阵项"
        onSubmit={async (form) => {
          const axis = String(form.get('axis')) as MarketingTarget['axis'];
          await onCreate({
            code: String(form.get('code')).trim().toUpperCase(),
            productId: String(form.get('productId')),
            axis,
            regionId: axis === 'REGION' ? String(form.get('axisEntityId')) : null,
            customerSegmentId:
              axis === 'CUSTOMER_SEGMENT' ? String(form.get('axisEntityId')) : null,
            strategyId: String(form.get('strategyId')),
            strategyVersion: Number(form.get('strategyVersion')),
            objectiveId: String(form.get('objectiveId')),
            objectiveVersion: Number(form.get('objectiveVersion')),
            valueDefinitionId: String(form.get('valueDefinitionId')),
            valueVersionId: String(form.get('valueVersionId')),
            valueVersionNumber: Number(form.get('valueVersionNumber')),
            responsibleRoleAssignmentId: String(form.get('roleAssignmentId')),
            metricDefinitionId: String(form.get('metricDefinitionId')),
            metricDefinitionVersion: Number(form.get('metricDefinitionVersion')),
            baselineValue: nullableNumber(form.get('baselineValue')),
            targetValue: Number(form.get('targetValue')),
            unit: String(form.get('unit')),
            periodStart: toIso(form.get('periodStart')),
            periodEnd: toIso(form.get('periodEnd')),
            budgetAmount: nullableNumber(form.get('budgetAmount')),
            budgetCurrency: nullableString(form.get('budgetCurrency')),
            idempotencyKey: crypto.randomUUID(),
          });
        }}
      >
        <Field name="code" label="目标编码" required />
        <DatalistField name="productId" label="产品 ID" records={products} required />
        <SelectField
          name="axis"
          label="目标轴"
          options={[
            ['REGION', '区域'],
            ['CUSTOMER_SEGMENT', '客户群'],
          ]}
        />
        <DatalistField
          name="axisEntityId"
          label="区域/客户群 ID"
          records={[...regions, ...segments]}
          required
        />
        <Field name="strategyId" label="Strategy ID" required />
        <Field name="strategyVersion" label="Strategy 版本" type="number" required />
        <Field name="objectiveId" label="Objective ID" required />
        <Field name="objectiveVersion" label="Objective 版本" type="number" required />
        <Field name="valueDefinitionId" label="Value Definition ID" required />
        <Field name="valueVersionId" label="Value Version ID" required />
        <Field name="valueVersionNumber" label="Value 版本" type="number" required />
        <Field name="roleAssignmentId" label="责任 RoleAssignment ID" required />
        <Field name="metricDefinitionId" label="Metric Definition ID" required />
        <Field name="metricDefinitionVersion" label="Metric 版本" type="number" required />
        <Field name="baselineValue" label="基线值" type="number" step="any" />
        <Field name="targetValue" label="目标值" type="number" step="any" required />
        <Field name="unit" label="单位" required />
        <Field name="periodStart" label="开始时间" type="datetime-local" required />
        <Field name="periodEnd" label="结束时间" type="datetime-local" required />
        <Field name="budgetAmount" label="预算金额" type="number" step="any" />
        <Field name="budgetCurrency" label="预算币种（如 CNY）" />
      </GovernedForm>

      <div className="target-matrix" role="table" aria-label="产品目标矩阵">
        <div className="target-row target-head" role="row">
          <span>产品</span>
          <span>区域/客户群</span>
          <span>目标</span>
          <span>周期</span>
          <span>状态</span>
        </div>
        {targets.map((target) => (
          <div className="target-row" role="row" key={target.id}>
            <span>{masterName.get(target.productId) ?? shortId(target.productId)}</span>
            <span>
              {target.axis === 'REGION' ? '区域' : '客户群'} ·{' '}
              {masterName.get(target.regionId ?? target.customerSegmentId ?? '') ??
                shortId(target.regionId ?? target.customerSegmentId ?? '')}
            </span>
            <span>
              <span>
                {target.targetValue} {target.unit}
                <small>
                  Objective {shortId(target.objectiveId)} · Role{' '}
                  {shortId(target.responsibleRoleAssignmentId)}
                </small>
              </span>
            </span>
            <span>
              {formatDate(target.periodStart)} – {formatDate(target.periodEnd)}
            </span>
            <span>
              <strong>{target.status}</strong>
              {target.status === 'DRAFT' ? (
                <button
                  type="button"
                  onClick={() =>
                    void onTransition(target.id, {
                      action: 'ACTIVATE',
                      expectedRevision: target.revision,
                      comment: '管理员确认激活目标',
                    })
                  }
                >
                  激活
                </button>
              ) : null}
            </span>
          </div>
        ))}
        {targets.length === 0 ? <p className="marketing-empty">尚无目标矩阵项。</p> : null}
      </div>
    </div>
  );
}

function ActionPlansPanel({
  plans,
  targets,
  onCreate,
  onCreateItem,
  onTransition,
}: {
  plans: MarketingActionPlan[];
  targets: MarketingTarget[];
  onCreate: (input: Parameters<typeof createMarketingActionPlan>[0]) => Promise<void>;
  onCreateItem: (
    planId: string,
    input: Parameters<typeof createMarketingActionItem>[1],
  ) => Promise<void>;
  onTransition: (
    id: string,
    input: Parameters<typeof transitionMarketingActionPlan>[1],
  ) => Promise<void>;
}): ReactNode {
  return (
    <div className="marketing-stack">
      <GovernedForm
        title="创建行动计划"
        onSubmit={async (form) => {
          await onCreate({
            code: String(form.get('code')).trim().toUpperCase(),
            targetId: String(form.get('targetId')),
            title: String(form.get('title')),
            description: String(form.get('description')),
            responsibleRoleAssignmentId: String(form.get('roleAssignmentId')),
            periodStart: toIso(form.get('periodStart')),
            periodEnd: toIso(form.get('periodEnd')),
            plannedBudgetAmount: nullableNumber(form.get('budgetAmount')),
            plannedBudgetCurrency: nullableString(form.get('budgetCurrency')),
            idempotencyKey: crypto.randomUUID(),
          });
        }}
      >
        <Field name="code" label="计划编码" required />
        <DatalistField
          name="targetId"
          label="目标 ID"
          records={targets.map(targetRecord)}
          required
        />
        <Field name="title" label="计划名称" required />
        <Field name="roleAssignmentId" label="责任 RoleAssignment ID" required />
        <Field name="periodStart" label="开始时间" type="datetime-local" required />
        <Field name="periodEnd" label="结束时间" type="datetime-local" required />
        <Field name="budgetAmount" label="计划预算" type="number" step="any" />
        <Field name="budgetCurrency" label="预算币种" />
        <TextField name="description" label="计划说明" required />
      </GovernedForm>

      <div className="plan-list">
        {plans.length === 0 ? <p className="marketing-empty">尚无行动计划。</p> : null}
        {plans.map((plan) => (
          <article className="marketing-card plan-card" key={plan.id}>
            <header>
              <div>
                <span className="marketing-code">
                  {plan.code} · v{plan.version}
                </span>
                <h2>{plan.title}</h2>
              </div>
              <span className="status">{plan.status}</span>
            </header>
            <p>{plan.description}</p>
            <small>
              责任任命 {shortId(plan.responsibleRoleAssignmentId)} · {plan.items.length} 个行动项 ·
              revision {plan.revision}
            </small>
            <ol className="action-items">
              {plan.items.map((item) => (
                <li key={item.id}>
                  <span>{item.ordinal}</span>
                  <div>
                    <strong>{item.title}</strong>
                    <small>
                      {item.status} · {item.contributionType} · 验收：{item.acceptanceCriteria}
                      {item.linkedTaskId ? ` · Task ${shortId(item.linkedTaskId)}` : ''}
                    </small>
                  </div>
                </li>
              ))}
            </ol>
            <GovernedForm
              compact
              title="添加行动项"
              onSubmit={async (form) => {
                await onCreateItem(plan.id, {
                  code: String(form.get('code')).trim().toUpperCase(),
                  ordinal: Number(form.get('ordinal')),
                  title: String(form.get('title')),
                  description: String(form.get('description')),
                  responsibleRoleAssignmentId: String(form.get('roleAssignmentId')),
                  linkedTaskId: nullableString(form.get('taskId')),
                  linkedTaskVersion: nullableNumber(form.get('taskVersion')),
                  contributionType: String(form.get('contributionType')) as
                    'RESPONSIBLE' | 'ACCOUNTABLE' | 'CONSULTED' | 'INFORMED',
                  acceptanceCriteria: String(form.get('acceptanceCriteria')),
                  dueAt: toIso(form.get('dueAt')),
                  idempotencyKey: crypto.randomUUID(),
                });
              }}
            >
              <Field name="code" label="行动项编码" required />
              <Field name="ordinal" label="顺序" type="number" required />
              <Field name="title" label="行动项名称" required />
              <Field name="roleAssignmentId" label="责任 RoleAssignment ID" required />
              <SelectField
                name="contributionType"
                label="贡献类型"
                options={[
                  ['RESPONSIBLE', '负责'],
                  ['ACCOUNTABLE', '问责'],
                  ['CONSULTED', '会签'],
                  ['INFORMED', '知会'],
                ]}
              />
              <Field name="taskId" label="关联 Task ID（可选）" />
              <Field name="taskVersion" label="Task 版本" type="number" />
              <Field name="dueAt" label="到期时间" type="datetime-local" required />
              <TextField name="description" label="执行说明" required />
              <TextField name="acceptanceCriteria" label="验收标准" required />
            </GovernedForm>
            {plan.status === 'DRAFT' ? (
              <button
                type="button"
                className="primary-button"
                onClick={() =>
                  void onTransition(plan.id, {
                    action: 'ACTIVATE',
                    expectedRevision: plan.revision,
                    comment: '管理员确认行动计划进入执行',
                  })
                }
              >
                激活计划
              </button>
            ) : null}
          </article>
        ))}
      </div>
    </div>
  );
}

function MasterDataPanel({
  records,
  onCreate,
}: {
  records: Record<MarketingMasterPath, MarketingData['products']>;
  onCreate: (
    path: MarketingMasterPath,
    input: Parameters<typeof createMarketingMasterData>[1],
  ) => Promise<void>;
}): ReactNode {
  const labels: Record<MarketingMasterPath, string> = {
    products: '产品',
    regions: '区域',
    'customer-segments': '客户群',
  };
  return (
    <div className="master-grid">
      {(Object.keys(labels) as MarketingMasterPath[]).map((path) => (
        <article className="marketing-card" key={path}>
          <header>
            <h2>{labels[path]}主数据</h2>
            <span>{records[path].length} 项</span>
          </header>
          <GovernedForm
            compact
            title={`新增${labels[path]}`}
            onSubmit={async (form) => {
              await onCreate(path, {
                code: String(form.get('code')).trim().toUpperCase(),
                name: String(form.get('name')),
                description: String(form.get('description')),
                idempotencyKey: crypto.randomUUID(),
              });
            }}
          >
            <Field name="code" label="唯一编码" required />
            <Field name="name" label="名称" required />
            <TextField name="description" label="说明" />
          </GovernedForm>
          <ul className="master-list">
            {records[path].map((record) => (
              <li key={record.id}>
                <strong>{record.name}</strong>
                <small>
                  {record.code} · {record.status} · r{record.revision}
                </small>
              </li>
            ))}
          </ul>
        </article>
      ))}
    </div>
  );
}

function GovernedForm({
  title,
  children,
  onSubmit,
  open: controlledOpen,
  onToggle,
  compact = false,
}: {
  title: string;
  children: ReactNode;
  onSubmit: (form: FormData) => Promise<void>;
  open?: boolean;
  onToggle?: () => void;
  compact?: boolean;
}): ReactNode {
  const [localOpen, setLocalOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const open = controlledOpen ?? localOpen;
  const toggle = onToggle ?? (() => setLocalOpen((value) => !value));
  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setSubmitting(true);
    try {
      await onSubmit(data);
      form.reset();
      if (controlledOpen === undefined) setLocalOpen(false);
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <div className={`governed-form ${compact ? 'compact' : ''}`}>
      <button type="button" className="form-toggle" aria-expanded={open} onClick={toggle}>
        <Icon name="plus" size={16} /> {title}
      </button>
      {open ? (
        <form onSubmit={(event) => void submit(event)}>
          <div className="form-grid">{children}</div>
          <button type="submit" className="primary-button" disabled={submitting}>
            {submitting ? '正在提交…' : '提交受治理记录'}
          </button>
        </form>
      ) : null}
    </div>
  );
}

function Field({
  name,
  label,
  type = 'text',
  required = false,
  step,
}: {
  name: string;
  label: string;
  type?: string;
  required?: boolean;
  step?: string;
}): ReactNode {
  return (
    <label>
      <span>{label}</span>
      <input name={name} type={type} required={required} step={step} />
    </label>
  );
}

function TextField({
  name,
  label,
  required = false,
}: {
  name: string;
  label: string;
  required?: boolean;
}): ReactNode {
  return (
    <label className="wide">
      <span>{label}</span>
      <textarea name={name} required={required} rows={3} />
    </label>
  );
}

function SelectField({
  name,
  label,
  options,
}: {
  name: string;
  label: string;
  options: ReadonlyArray<readonly [string, string]>;
}): ReactNode {
  return (
    <label>
      <span>{label}</span>
      <select name={name}>
        {options.map(([value, copy]) => (
          <option value={value} key={value}>
            {copy}
          </option>
        ))}
      </select>
    </label>
  );
}

function DatalistField({
  name,
  label,
  records,
  required = false,
}: {
  name: string;
  label: string;
  records: ReadonlyArray<{ readonly id: string; readonly code: string; readonly name: string }>;
  required?: boolean;
}): ReactNode {
  const listId = `${name}-options`;
  return (
    <label>
      <span>{label}</span>
      <input name={name} list={listId} required={required} />
      <datalist id={listId}>
        {records.map((record) => (
          <option value={record.id} key={record.id}>
            {record.code} · {record.name}
          </option>
        ))}
      </datalist>
    </label>
  );
}

function targetRecord(target: MarketingTarget): { id: string; code: string; name: string } {
  return { id: target.id, code: target.code, name: `${target.targetValue} ${target.unit}` };
}

function actionLabel(action: string): string {
  return (
    {
      SUBMIT: '提交审核',
      APPROVE: '批准',
      REJECT: '驳回',
      PUBLISH: '发布',
      RETIRE: '退役',
    }[action] ?? action
  );
}

function shortId(value: string): string {
  return value.length > 8 ? value.slice(0, 8) : value;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium' }).format(new Date(value));
}

function toIso(value: FormDataEntryValue | null): string {
  return new Date(String(value)).toISOString();
}

function nullableString(value: FormDataEntryValue | null): string | null {
  const normalized = String(value ?? '').trim();
  return normalized.length === 0 ? null : normalized.toUpperCase();
}

function nullableNumber(value: FormDataEntryValue | null): number | null {
  const normalized = String(value ?? '').trim();
  return normalized.length === 0 ? null : Number(normalized);
}
