import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderInTestDom } from '@/test/dom-test-utils';

const apiMocks = vi.hoisted(() => ({
  listMarketingObservations: vi.fn(),
  listMarketingInsights: vi.fn(),
  listMarketingTargets: vi.fn(),
  listMarketingActionPlans: vi.fn(),
  listMarketingMasterData: vi.fn(),
  createMarketingObservation: vi.fn(),
  createMarketingInsight: vi.fn(),
  transitionMarketingInsight: vi.fn(),
  createMarketingMasterData: vi.fn(),
  createMarketingTarget: vi.fn(),
  transitionMarketingTarget: vi.fn(),
  createMarketingActionPlan: vi.fn(),
  transitionMarketingActionPlan: vi.fn(),
  createMarketingActionItem: vi.fn(),
}));

vi.mock('./api', () => apiMocks);

import { MarketingManagementPage } from './MarketingManagementPage';

const id = (suffix: number): string =>
  `00000000-0000-4000-8000-${suffix.toString().padStart(12, '0')}`;
const now = '2026-07-28T08:00:00.000Z';

beforeEach(() => {
  for (const mock of Object.values(apiMocks)) mock.mockReset();
  apiMocks.listMarketingObservations.mockResolvedValue([
    {
      id: id(1),
      code: 'OBS-CUSTOMER-001',
      version: 1,
      dimension: 'CUSTOMER',
      assertionType: 'FACT',
      statement: '客户需要可以追溯的当日响应。',
      confidence: 0.9,
      origin: 'HUMAN',
      agentRunId: null,
      createdByUserId: id(10),
      createdAt: now,
      evidence: [
        {
          evidenceId: id(2),
          evidenceVersion: 1,
          linkType: 'SUPPORTS',
          sourceSystem: 'CRM',
          sourceRecordId: 'case-1',
          sourceVersion: '7',
          contentHash: 'a'.repeat(64),
        },
      ],
    },
  ]);
  apiMocks.listMarketingInsights.mockResolvedValue([
    {
      id: id(3),
      code: 'INSIGHT-001',
      version: 1,
      revision: 2,
      title: '服务速度是续约驱动因素',
      statement: '当日响应与企业客户续约呈正向关系。',
      origin: 'AI',
      agentRunId: id(4),
      status: 'UNDER_REVIEW',
      createdByUserId: id(10),
      reviewRequestedByUserId: id(10),
      reviewedByUserId: null,
      publishedByUserId: null,
      reviewComment: '请独立复核',
      createdAt: now,
      updatedAt: now,
      observationIds: [id(1)],
    },
  ]);
  apiMocks.listMarketingTargets.mockResolvedValue([
    {
      id: id(5),
      code: 'TARGET-001',
      revision: 1,
      status: 'DRAFT',
      productId: id(20),
      axis: 'REGION',
      regionId: id(21),
      customerSegmentId: null,
      strategyId: id(30),
      strategyVersion: 1,
      objectiveId: id(31),
      objectiveVersion: 1,
      valueDefinitionId: id(32),
      valueVersionId: id(33),
      valueVersionNumber: 1,
      responsibleRoleAssignmentId: id(34),
      metricDefinitionId: id(35),
      metricDefinitionVersion: 1,
      baselineValue: 10,
      targetValue: 25,
      unit: 'COUNT',
      periodStart: now,
      periodEnd: '2026-08-28T08:00:00.000Z',
      budgetAmount: 10000,
      budgetCurrency: 'CNY',
      createdAt: now,
      updatedAt: now,
    },
  ]);
  apiMocks.listMarketingActionPlans.mockResolvedValue([
    {
      id: id(6),
      code: 'PLAN-001',
      version: 1,
      revision: 1,
      targetId: id(5),
      title: '区域客户响应提升',
      description: '通过可验收行动项提升响应速度。',
      status: 'DRAFT',
      responsibleRoleAssignmentId: id(34),
      periodStart: now,
      periodEnd: '2026-08-28T08:00:00.000Z',
      plannedBudgetAmount: 5000,
      plannedBudgetCurrency: 'CNY',
      createdAt: now,
      updatedAt: now,
      items: [
        {
          id: id(7),
          code: 'ITEM-001',
          revision: 1,
          ordinal: 1,
          title: '建立响应看板',
          description: '按日核对响应时长。',
          status: 'PLANNED',
          responsibleRoleAssignmentId: id(34),
          linkedTaskId: id(40),
          linkedTaskVersion: 1,
          contributionType: 'RESPONSIBLE',
          acceptanceCriteria: '看板连续七日产生可信数据',
          acceptanceEvidenceId: null,
          acceptanceEvidenceVersion: null,
          dueAt: '2026-08-10T08:00:00.000Z',
          createdAt: now,
          updatedAt: now,
        },
      ],
    },
  ]);
  apiMocks.listMarketingMasterData.mockImplementation((path: string) =>
    Promise.resolve(
      path === 'products'
        ? [
            {
              id: id(20),
              code: 'PRODUCT-A',
              name: '企业智能协同',
              description: '',
              status: 'ACTIVE',
              revision: 1,
              createdAt: now,
              updatedAt: now,
            },
          ]
        : path === 'regions'
          ? [
              {
                id: id(21),
                code: 'EAST',
                name: '华东',
                description: '',
                status: 'ACTIVE',
                revision: 1,
                createdAt: now,
                updatedAt: now,
              },
            ]
          : [],
    ),
  );
});

describe('MarketingManagementPage DOM acceptance', () => {
  it('renders the five-look evidence model from API data without fake online states', async () => {
    const dom = await renderInTestDom(
      createElement(MarketingManagementPage, { currentUserId: id(10) }),
    );
    try {
      await dom.flush();
      await dom.flush();
      expect(dom.container.textContent).toContain('五看观察');
      expect(dom.container.textContent).toContain('客户需要可以追溯的当日响应');
      expect(dom.container.textContent).toContain('事实');
      expect(dom.container.textContent).not.toContain('ONLINE');
      expect(dom.container.textContent).not.toContain('示例数据');
    } finally {
      await dom.cleanup();
    }
  });

  it('shows maker-checker review and disables self-approval', async () => {
    const dom = await renderInTestDom(
      createElement(MarketingManagementPage, { currentUserId: id(10) }),
    );
    try {
      await dom.flush();
      const tab = [...dom.container.querySelectorAll('button')].find(
        (button) => button.textContent?.trim() === '洞察审核',
      );
      expect(tab).toBeDefined();
      if (tab) await dom.click(tab);
      await dom.flush();
      expect(dom.container.textContent).toContain('服务速度是续约驱动因素');
      expect(dom.container.textContent).toContain('创建人不能审核自己的洞察');
      const approve = [...dom.container.querySelectorAll('button')].find(
        (button) => button.textContent?.trim() === '批准',
      ) as HTMLButtonElement | undefined;
      expect(approve?.disabled).toBe(true);
    } finally {
      await dom.cleanup();
    }
  });

  it('renders real target matrix and Action Plan/Task traceability', async () => {
    const dom = await renderInTestDom(
      createElement(MarketingManagementPage, { currentUserId: id(11) }),
    );
    try {
      await dom.flush();
      const matrixTab = [...dom.container.querySelectorAll('button')].find(
        (button) => button.textContent?.trim() === '目标矩阵',
      );
      if (matrixTab) await dom.click(matrixTab);
      await dom.flush();
      expect(dom.container.textContent).toContain('企业智能协同');
      expect(dom.container.textContent).toContain('华东');
      expect(dom.container.querySelector('[role="table"]')).not.toBeNull();

      const planTab = [...dom.container.querySelectorAll('button')].find(
        (button) => button.textContent?.trim() === '行动计划',
      );
      if (planTab) await dom.click(planTab);
      await dom.flush();
      expect(dom.container.textContent).toContain('区域客户响应提升');
      expect(dom.container.textContent).toContain('建立响应看板');
      expect(dom.container.textContent).toContain('Task 00000000');
      expect(dom.container.textContent).toContain('验收：看板连续七日产生可信数据');
    } finally {
      await dom.cleanup();
    }
  });
});
