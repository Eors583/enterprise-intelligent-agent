import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderInTestDom } from '@/test/dom-test-utils';

const apiMocks = vi.hoisted(() => ({
  getPeopleOrganizationOverview: vi.fn(),
  createCompetencyDefinition: vi.fn(),
  createTriangleTeam: vi.fn(),
  proposeOrganizationChange: vi.fn(),
}));
const referenceMocks = vi.hoisted(() => ({
  listObjectives: vi.fn(),
  listMetricDefinitions: vi.fn(),
  listRoleAssignments: vi.fn(),
}));

vi.mock('./api', () => apiMocks);
vi.mock('@/features/business-semantics/api', () => ({
  listObjectives: referenceMocks.listObjectives,
  listMetricDefinitions: referenceMocks.listMetricDefinitions,
}));
vi.mock('@/api/admin-api', () => ({
  listRoleAssignments: referenceMocks.listRoleAssignments,
}));

import { PeopleOrganizationPage, peopleBusinessCode } from './PeopleOrganizationPage';

beforeEach(() => {
  for (const mock of Object.values(apiMocks)) mock.mockReset();
  for (const mock of Object.values(referenceMocks)) mock.mockReset();
  apiMocks.getPeopleOrganizationOverview.mockResolvedValue({
    competencyDefinitions: 4,
    activeCompetencyVersions: 3,
    assessmentsAwaitingConfirmation: 2,
    openAppeals: 1,
    activeTriangleTeams: 2,
    organizationChangesAwaitingConfirmation: 1,
  });
  referenceMocks.listObjectives.mockResolvedValue([
    {
      id: '00000000-0000-7000-8000-000000000101',
      code: 'OBJ.CUSTOMER',
      name: '客户共同目标',
      version: 3,
      status: 'ACTIVE',
    },
  ]);
  referenceMocks.listMetricDefinitions.mockResolvedValue([
    {
      id: '00000000-0000-7000-8000-000000000102',
      code: 'METRIC.CLOSURE',
      name: '客户闭环率',
      unit: '%',
      status: 'ACTIVE',
    },
  ]);
  referenceMocks.listRoleAssignments.mockResolvedValue({
    items: [
      {
        id: '00000000-0000-7000-8000-000000000103',
        key: 'customer.owner',
        status: 'ACTIVE',
        assignee: { displayName: '张晨' },
        agent: { template: { name: '客户负责人' } },
      },
    ],
  });
});

describe('PeopleOrganizationPage DOM acceptance', () => {
  it('renders HR and organization governance without presenting an AI candidate as a decision', async () => {
    const dom = await renderInTestDom(createElement(PeopleOrganizationPage));
    try {
      await dom.flush();
      await dom.flush();
      expect(dom.container.textContent).toContain('人才与组织治理');
      expect(dom.container.textContent).toContain('待人工确认评价');
      expect(dom.container.textContent).toContain('AI 只生成能力归因候选');
      expect(dom.container.textContent).toContain('禁止自动高风险变更');
      expect(dom.container.textContent).toContain('不使用消息数');
      expect(dom.container.textContent).not.toContain('AI 自动决定晋升');
      expect(dom.container.textContent).toContain('客户共同目标');
      expect(dom.container.textContent).toContain('张晨 · 客户负责人');
      expect(dom.container.textContent).toContain('客户闭环率');
      expect(dom.container.textContent).not.toContain('共同客户目标 ID');
      expect(dom.container.textContent).not.toContain('共享指标 ID');
      expect(dom.container.textContent).toContain('调整后的角色任命');
      expect(dom.container.textContent).not.toContain('变更内容 JSON');
      expect(dom.container.textContent).toContain('系统将自动生成能力编码');
      expect(dom.container.textContent).toContain('系统将自动生成团队编码');
      expect(dom.container.querySelectorAll('details input[pattern]').length).toBe(0);
    } finally {
      await dom.cleanup();
    }
  });

  it('generates stable readable or code-point business identifiers', () => {
    expect(peopleBusinessCode('COMPETENCY', 'Solution Design')).toBe('COMPETENCY.SOLUTION.DESIGN');
    expect(peopleBusinessCode('TEAM', '客户成功')).toMatch(/^TEAM\.[A-Z0-9.]+$/u);
  });
});
