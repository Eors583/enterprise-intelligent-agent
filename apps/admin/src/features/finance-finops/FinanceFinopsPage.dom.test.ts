import type { FinopsDashboard } from '@enterprise/contracts';
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderInTestDom } from '@/test/dom-test-utils';

const { loadFinopsDashboard, createFinopsBudget } = vi.hoisted(() => ({
  loadFinopsDashboard: vi.fn(),
  createFinopsBudget: vi.fn(),
}));

const { listEvidence } = vi.hoisted(() => ({ listEvidence: vi.fn() }));

vi.mock('./api', () => ({
  loadFinopsDashboard,
  acknowledgeFinopsAlert: vi.fn(),
  createFinopsBudget,
  createFinopsBudgetEvent: vi.fn(),
  createFinopsPriceSnapshot: vi.fn(),
  recordFinopsCost: vi.fn(),
  decideFinopsRoutingSuggestion: vi.fn(),
  recomputeFinopsRoi: vi.fn(),
  reviewFinopsAllocationSet: vi.fn(),
  reviewFinopsBenefitClaim: vi.fn(),
  reviewFinopsBudget: vi.fn(),
  reviewFinopsCost: vi.fn(),
  reviewFinopsPriceSnapshot: vi.fn(),
  reviewFinopsRoiFormula: vi.fn(),
}));

vi.mock('@/features/business-semantics/api', () => ({ listEvidence }));

import { FinanceFinopsPage, finopsCode } from './FinanceFinopsPage';

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const USER_ID = '00000000-0000-4000-8000-000000000002';
const NOW = '2026-07-28T08:00:00.000Z';

const DASHBOARD: FinopsDashboard = {
  generatedAt: NOW,
  currency: 'CNY',
  totals: {
    verifiedCost: '125.5',
    pendingCost: '8',
    confirmedBenefit: '900',
    activeBudgetLimit: '2000',
    activeBudgetReserved: '100',
    activeBudgetSettled: '125.5',
    openAlerts: 1,
    openProjectionDiagnostics: 1,
  },
  priceSnapshots: [],
  allocationRules: [],
  dimensionMembers: [],
  roiFormulas: [],
  costEntries: [],
  allocationSets: [],
  benefitClaims: [],
  roiSnapshots: [],
  budgets: [
    {
      id: '00000000-0000-4000-8000-000000000010',
      tenantId: TENANT_ID,
      code: 'BUDGET.TENANT.MONTHLY',
      version: 1,
      revision: 2,
      scopeType: 'TENANT',
      scopeId: TENANT_ID,
      scopeVersion: null,
      currency: 'CNY',
      limitAmount: '2000',
      alertThresholdRatio: '0.8',
      periodStart: '2026-07-01T00:00:00.000Z',
      periodEnd: '2026-08-01T00:00:00.000Z',
      status: 'ACTIVE',
      reservedAmount: '100',
      settledAmount: '125.5',
      availableAmount: '1774.5',
      createdByUserId: '00000000-0000-4000-8000-000000000003',
      approvedByUserId: USER_ID,
      createdAt: NOW,
    },
  ],
  alerts: [
    {
      id: '00000000-0000-4000-8000-000000000020',
      tenantId: TENANT_ID,
      budgetId: '00000000-0000-4000-8000-000000000010',
      budgetVersion: 1,
      type: 'THRESHOLD_REACHED',
      status: 'OPEN',
      observedAmount: '1600',
      thresholdAmount: '1600',
      revision: 1,
      message: 'Budget alert threshold reached.',
      createdAt: NOW,
    },
  ],
  projectionDiagnostics: [
    {
      id: '00000000-0000-4000-8000-000000000030',
      tenantId: TENANT_ID,
      sourceKind: 'AGENT_RUN',
      sourceId: '00000000-0000-4000-8000-000000000031',
      sourceVersion: '4',
      code: 'PRICE_MISSING',
      detail: 'No approved price matches the runtime provider and model.',
      metadata: { provider: 'openai', sku: 'gpt-enterprise' },
      status: 'OPEN',
      openedAt: NOW,
      resolvedAt: null,
    },
  ],
  routingSuggestions: [],
};

describe('FinanceFinopsPage', () => {
  beforeEach(() => {
    loadFinopsDashboard.mockReset();
    loadFinopsDashboard.mockResolvedValue(DASHBOARD);
    listEvidence.mockReset();
    listEvidence.mockResolvedValue([]);
    createFinopsBudget.mockReset();
    createFinopsBudget.mockResolvedValue(DASHBOARD.budgets[0]);
  });

  it('loads real backend state and exposes all six FIN-001 views', async () => {
    const dom = await renderInTestDom(
      createElement(FinanceFinopsPage, {
        currentUserId: USER_ID,
        tenantId: TENANT_ID,
      }),
    );
    try {
      await dom.flush();
      expect(loadFinopsDashboard).toHaveBeenCalledWith('CNY', expect.any(AbortSignal));
      expect(dom.container.textContent).toContain('已验证成本');
      expect(dom.container.textContent).toContain('125.50');
      expect(dom.container.textContent).toContain('登记待复核成本');
      expect(dom.container.textContent).toContain('表单不接受金额');

      const tabs = [...dom.container.querySelectorAll('.finops-tabs button')];
      expect(tabs.map((button) => button.textContent)).toEqual([
        '成本与价格',
        '预算',
        '归集',
        '价值收益',
        'ROI',
        '异常',
      ]);

      const budgetTab = tabs.find((button) => button.textContent === '预算');
      if (budgetTab) await dom.click(budgetTab);
      expect(dom.container.textContent).toContain('BUDGET.TENANT.MONTHLY');
      expect(dom.container.textContent).toContain('1,774.50');
    } finally {
      await dom.cleanup();
    }
  });

  it('shows backend alerts and explicitly keeps routing advisory', async () => {
    const dom = await renderInTestDom(
      createElement(FinanceFinopsPage, {
        currentUserId: USER_ID,
        tenantId: TENANT_ID,
      }),
    );
    try {
      await dom.flush();
      const exceptions = [...dom.container.querySelectorAll('.finops-tabs button')].find(
        (button) => button.textContent === '异常',
      );
      if (exceptions) await dom.click(exceptions);
      expect(dom.container.textContent).toContain('THRESHOLD_REACHED');
      expect(dom.container.textContent).toContain('PRICE_MISSING');
      expect(dom.container.textContent).toContain('系统不会自动改路由');
    } finally {
      await dom.cleanup();
    }
  });

  it('generates technical price and cost provenance without editable technical fields', async () => {
    const dom = await renderInTestDom(
      createElement(FinanceFinopsPage, {
        currentUserId: USER_ID,
        tenantId: TENANT_ID,
      }),
    );
    try {
      await dom.flush();
      const advancedImports = [
        ...dom.container.querySelectorAll('details.finops-advanced-import'),
      ] as HTMLDetailsElement[];
      expect(advancedImports).toHaveLength(0);
      for (const name of [
        'sourceSystem',
        'sourceRecordId',
        'sourceRecordVersion',
        'sourceContentHash',
        'evidenceId',
        'evidenceVersion',
      ]) {
        const fields = [...dom.container.querySelectorAll(`[name="${name}"]`)];
        expect(fields).toHaveLength(0);
      }
      expect(dom.container.querySelector('input[name="code"]')).toBeNull();
      expect(dom.container.querySelector('input[name="codeOverride"]')).toBeNull();
      expect(dom.container.textContent).toContain('系统将自动生成价格代码');
      expect(dom.container.textContent).toContain('系统生成');
    } finally {
      await dom.cleanup();
    }
  });

  it('inherits tenant scope and uses governed selectors for budget settlement references', async () => {
    const dom = await renderInTestDom(
      createElement(FinanceFinopsPage, {
        currentUserId: USER_ID,
        tenantId: TENANT_ID,
      }),
    );
    try {
      await dom.flush();
      const budgetTab = [...dom.container.querySelectorAll('.finops-tabs button')].find(
        (button) => button.textContent === '预算',
      );
      await dom.click(budgetTab!);
      expect(dom.container.textContent).toContain('预算范围自动继承当前企业');
      expect(dom.container.querySelector('input[name="scopeId"]')).toBeNull();
      expect(dom.container.querySelector('input[name="code"]')).toBeNull();
      expect(dom.container.textContent).toContain('其他业务范围需先接入受治理对象目录');

      const eventType = dom.container.querySelector(
        'select[name="type"]',
      ) as HTMLSelectElement | null;
      await dom.change(eventType!, 'SETTLEMENT');
      expect(dom.container.querySelector('input[name="reservationEventId"]')).toBeNull();
      expect(dom.container.querySelector('input[name="costEntryId"]')).toBeNull();
      expect(dom.container.querySelector('select[name="reservationEventId"]')).not.toBeNull();
      expect(dom.container.querySelector('select[name="costEntryId"]')).not.toBeNull();
      expect(dom.container.textContent).toContain('当前 dashboard 未返回可识别的预留事件');
    } finally {
      await dom.cleanup();
    }
  });

  it('keeps the budget wire compatible while deriving tenant scope and code', async () => {
    const dom = await renderInTestDom(
      createElement(FinanceFinopsPage, {
        currentUserId: USER_ID,
        tenantId: TENANT_ID,
      }),
    );
    try {
      await dom.flush();
      const budgetTab = [...dom.container.querySelectorAll('.finops-tabs button')].find(
        (button) => button.textContent === '预算',
      );
      await dom.click(budgetTab!);
      const budgetForm = dom.container.querySelector('.finops-card .finops-form');
      const limit = budgetForm?.querySelector('input[name="limitAmount"]');
      const threshold = budgetForm?.querySelector('input[name="alertThresholdRatio"]');
      const start = budgetForm?.querySelector('input[name="periodStart"]');
      const end = budgetForm?.querySelector('input[name="periodEnd"]');
      (budgetForm as HTMLFormElement).reset = vi.fn();
      await dom.change(limit as HTMLInputElement, '3000');
      await dom.change(threshold as HTMLInputElement, '0.8');
      await dom.change(start as HTMLInputElement, '2026-08-01');
      await dom.change(end as HTMLInputElement, '2026-09-01');
      await dom.submit(budgetForm as HTMLFormElement);
      await dom.flush();
      expect(createFinopsBudget).toHaveBeenCalledWith(
        expect.objectContaining({
          code: 'BUDGET.TENANT.CNY.2026.08',
          scopeType: 'TENANT',
          scopeId: TENANT_ID,
          scopeVersion: null,
          limitAmount: '3000',
        }),
      );
    } finally {
      await dom.cleanup();
    }
  });

  it('generates stable business codes without exposing raw identifiers', () => {
    expect(finopsCode('price', 'MODEL', 'Open AI', 'gpt-5.4 enterprise')).toBe(
      'PRICE.MODEL.OPEN.AI.GPT.5.4.ENTERPRISE',
    );
    expect(finopsCode('budget', 'tenant', 'CNY', '2026-07')).toBe('BUDGET.TENANT.CNY.2026.07');
  });
});
