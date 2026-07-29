import type { FinopsDashboard } from '@enterprise/contracts';
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderInTestDom } from '@/test/dom-test-utils';

const { loadFinopsDashboard } = vi.hoisted(() => ({
  loadFinopsDashboard: vi.fn(),
}));

vi.mock('./api', () => ({
  loadFinopsDashboard,
  acknowledgeFinopsAlert: vi.fn(),
  createFinopsBudget: vi.fn(),
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

import { FinanceFinopsPage } from './FinanceFinopsPage';

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
});
