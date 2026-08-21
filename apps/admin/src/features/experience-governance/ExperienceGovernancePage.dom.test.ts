import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderInTestDom } from '@/test/dom-test-utils';

const adminApiMocks = vi.hoisted(() => ({
  createExperienceCandidate: vi.fn(),
  getExperienceKnowledgeProjection: vi.fn(),
  getOrganization: vi.fn(),
  listExperienceCandidates: vi.fn(),
  listKnowledgeBases: vi.fn(),
  listRoleBlueprints: vi.fn(),
  prepareExperienceKnowledgeProjection: vi.fn(),
  transitionExperienceCandidate: vi.fn(),
}));
const businessApiMocks = vi.hoisted(() => ({
  listTasks: vi.fn(),
  listEvidence: vi.fn(),
  listTaskDeliverables: vi.fn(),
}));

vi.mock('@/api/admin-api', () => adminApiMocks);
vi.mock('@/features/business-semantics/api', () => businessApiMocks);

import { ExperienceGovernancePage } from './ExperienceGovernancePage';

const TASK_ID = '00000000-0000-7000-8000-000000000201';
const DELIVERABLE_ID = '00000000-0000-7000-8000-000000000202';
const EVIDENCE_ID = '00000000-0000-7000-8000-000000000203';

beforeEach(() => {
  for (const mock of Object.values(adminApiMocks)) mock.mockReset();
  for (const mock of Object.values(businessApiMocks)) mock.mockReset();
  adminApiMocks.listExperienceCandidates.mockResolvedValue({ items: [] });
  adminApiMocks.getExperienceKnowledgeProjection.mockResolvedValue(null);
  adminApiMocks.getOrganization.mockResolvedValue({ orgUnits: [], members: [], organization: {} });
  adminApiMocks.listKnowledgeBases.mockResolvedValue({ items: [] });
  adminApiMocks.listRoleBlueprints.mockResolvedValue({ items: [] });
  businessApiMocks.listTasks.mockResolvedValue([
    { id: TASK_ID, title: '完成客户交付', code: 'TASK.DELIVERY', status: 'IN_PROGRESS' },
  ]);
  businessApiMocks.listEvidence.mockResolvedValue([
    {
      id: EVIDENCE_ID,
      summary: '客户验收记录',
      code: 'EVIDENCE.ACCEPTANCE',
      trustLevel: 'VERIFIED',
      status: 'ACTIVE',
    },
  ]);
  businessApiMocks.listTaskDeliverables.mockResolvedValue([
    {
      id: DELIVERABLE_ID,
      title: '客户验收报告',
      code: 'DELIVERABLE.REPORT',
      status: 'ACCEPTED',
    },
  ]);
});

describe('ExperienceGovernancePage guided forms', () => {
  it('selects a task and then loads its deliverables instead of accepting raw ids', async () => {
    const dom = await renderInTestDom(createElement(ExperienceGovernancePage));
    try {
      await dom.flush();
      const createButton = [...dom.container.querySelectorAll('button')].find(
        (button) => button.textContent?.trim() === '新建经验候选',
      );
      expect(createButton).not.toBeUndefined();
      if (createButton) await dom.click(createButton);
      await dom.flush();
      await dom.flush();

      expect(dom.container.textContent).toContain('完成客户交付');
      expect(dom.container.textContent).toContain('客户验收记录');
      expect(dom.container.textContent).not.toContain('来源任务 ID');
      expect(dom.container.textContent).not.toContain('证据 ID（至少一条）');

      const sourceTaskLabel = [...dom.container.querySelectorAll('label')].find((label) =>
        label.textContent?.includes('来源任务'),
      );
      const taskSelect = sourceTaskLabel?.querySelector('select');
      expect(taskSelect).not.toBeNull();
      if (taskSelect) await dom.change(taskSelect, TASK_ID);
      await dom.flush();
      await dom.flush();
      expect(dom.container.textContent).toContain('客户验收报告');
      expect(businessApiMocks.listTaskDeliverables).toHaveBeenCalledWith(
        TASK_ID,
        expect.any(AbortSignal),
      );
    } finally {
      await dom.cleanup();
    }
  });

  it('derives the transition payload without exposing a JSON editor', async () => {
    adminApiMocks.listExperienceCandidates.mockResolvedValue({ items: [candidate()] });
    const dom = await renderInTestDom(createElement(ExperienceGovernancePage));
    try {
      await dom.flush();
      await dom.flush();
      const sanitizeButton = [...dom.container.querySelectorAll('.experience-actions button')].find(
        (button) => button.textContent?.includes('脱敏'),
      );
      expect(sanitizeButton).not.toBeUndefined();
      if (sanitizeButton) await dom.click(sanitizeButton);
      expect(dom.container.textContent).toContain('系统会自动生成治理记录');
      const payload = dom.container.querySelector('.experience-json-input');
      expect(payload).toBeNull();
      expect(dom.container.textContent).not.toContain('治理载荷 JSON');
    } finally {
      await dom.cleanup();
    }
  });
});

function candidate() {
  return {
    id: '00000000-0000-7000-8000-000000000211',
    tenantId: '00000000-0000-7000-8000-000000000212',
    status: 'CANDIDATE',
    revision: 1,
    title: '可复用交付经验',
    contributorUserId: '00000000-0000-7000-8000-000000000213',
    contributorRoleAssignmentId: '00000000-0000-7000-8000-000000000214',
    sourceTaskId: TASK_ID,
    sourceDeliverableIds: [DELIVERABLE_ID],
    sourceEvidenceIds: [EVIDENCE_ID],
    rawInputHash: 'a'.repeat(64),
    candidateSummary: '从真实客户交付中提取的候选经验。',
    sanitization: null,
    structuredContent: null,
    structuredHash: null,
    review: null,
    validation: null,
    publication: null,
    permissionLabels: [],
    sensitivity: 'INTERNAL',
    monitoredUseCount: 0,
    monitoredAdoptionCount: 0,
    monitoredComplaintCount: 0,
    expiresAt: null,
    retiredAt: null,
    createdAt: '2026-07-28T00:00:00.000Z',
    updatedAt: '2026-07-28T00:00:00.000Z',
  };
}
