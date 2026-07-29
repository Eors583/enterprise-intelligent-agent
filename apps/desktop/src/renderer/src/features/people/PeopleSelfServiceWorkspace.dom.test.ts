import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderInTestDom } from '../../test/dom-test-utils';

const apiMocks = vi.hoisted(() => ({
  getMyPeopleProfile: vi.fn(),
  appealMyAssessment: vi.fn(),
}));

vi.mock('./api', () => apiMocks);

import { PeopleSelfServiceWorkspace } from './PeopleSelfServiceWorkspace';

const id = (suffix: number): string =>
  `00000000-0000-4000-8000-${suffix.toString().padStart(12, '0')}`;

beforeEach(() => {
  for (const mock of Object.values(apiMocks)) mock.mockReset();
  apiMocks.getMyPeopleProfile.mockResolvedValue({
    userId: id(1),
    evidence: [
      {
        id: id(2),
        subjectUserId: id(1),
        competencyVersionId: id(3),
        demonstratedLevel: 2,
        evidenceId: id(4),
        evidenceVersion: 1,
        taskId: id(5),
        taskVersion: 1,
        deliverableId: null,
        deliverableVersion: null,
        metricObservationId: null,
        metricObservationVersion: null,
        reviewReference: null,
        validFrom: '2026-07-01T00:00:00.000Z',
        validUntil: null,
        createdAt: '2026-07-02T00:00:00.000Z',
      },
    ],
    assessments: [
      {
        id: id(6),
        subjectUserId: id(1),
        competencyVersionId: id(3),
        proposedLevel: 2,
        effectiveLevel: null,
        confidence: 0.72,
        status: 'UNDER_REVIEW',
        agentRunId: id(7),
        supersedesAssessmentId: null,
        summary: '资源和流程因素仍需人工复核。',
        attribution: [
          {
            factor: 'RESOURCE',
            contribution: 0.5,
            statement: '测试环境资源未按计划到位。',
            evidenceIds: [id(4)],
          },
          {
            factor: 'CAPABILITY',
            contribution: 0.5,
            statement: '能力等级仅为候选。',
            evidenceIds: [id(4)],
          },
        ],
        requiredConfirmationRoles: ['EMPLOYEE', 'MANAGER', 'HR'],
        confirmedRoles: ['EMPLOYEE'],
        revision: 2,
        createdAt: '2026-07-02T00:00:00.000Z',
        updatedAt: '2026-07-03T00:00:00.000Z',
      },
    ],
    appeals: [],
    gaps: [],
    developmentPlans: [],
  });
});

describe('PeopleSelfServiceWorkspace DOM acceptance', () => {
  it('shows the employee their evidence, attribution and dispute entry', async () => {
    const dom = await renderInTestDom(createElement(PeopleSelfServiceWorkspace));
    try {
      await dom.flush();
      await dom.flush();
      expect(dom.container.textContent).toContain('我的成长档案');
      expect(dom.container.textContent).toContain('AI 候选不等于有效结论');
      expect(dom.container.textContent).toContain('测试环境资源未按计划到位');
      expect(dom.container.textContent).toContain('补充说明或提出异议');
      expect(dom.container.textContent).toContain('不会自动触发晋升、调薪或淘汰');
    } finally {
      await dom.cleanup();
    }
  });
});
