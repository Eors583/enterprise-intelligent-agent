import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderInTestDom } from '@/test/dom-test-utils';

const apiMocks = vi.hoisted(() => ({
  getPeopleOrganizationOverview: vi.fn(),
  createCompetencyDefinition: vi.fn(),
  createTriangleTeam: vi.fn(),
  proposeOrganizationChange: vi.fn(),
}));

vi.mock('./api', () => apiMocks);

import { PeopleOrganizationPage } from './PeopleOrganizationPage';

beforeEach(() => {
  for (const mock of Object.values(apiMocks)) mock.mockReset();
  apiMocks.getPeopleOrganizationOverview.mockResolvedValue({
    competencyDefinitions: 4,
    activeCompetencyVersions: 3,
    assessmentsAwaitingConfirmation: 2,
    openAppeals: 1,
    activeTriangleTeams: 2,
    organizationChangesAwaitingConfirmation: 1,
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
    } finally {
      await dom.cleanup();
    }
  });
});
