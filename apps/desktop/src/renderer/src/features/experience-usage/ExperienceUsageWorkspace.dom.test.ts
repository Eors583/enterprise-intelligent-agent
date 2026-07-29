import type { EmployeeAiUsageSummary, Task } from '@enterprise/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderInTestDom } from '../../test/dom-test-utils';

const apiMocks = vi.hoisted(() => ({
  listEmployeeExperiences: vi.fn(),
  getEmployeeExperienceSources: vi.fn(),
  createEmployeeExperience: vi.fn(),
  getEmployeeAiUsage: vi.fn(),
}));

vi.mock('./api', () => apiMocks);

import { ExperienceUsageWorkspace } from './ExperienceUsageWorkspace';

const TASK = '00000000-0000-7000-8000-000000000601';
const EVIDENCE = '00000000-0000-7000-8000-000000000602';
const NOW = '2026-07-28T08:00:00.000Z';

beforeEach(() => {
  for (const mock of Object.values(apiMocks)) mock.mockReset();
  apiMocks.listEmployeeExperiences.mockResolvedValue({ items: [], nextCursor: null });
  apiMocks.getEmployeeExperienceSources.mockResolvedValue({
    task: { id: TASK, title: '客户交付复盘' },
    deliverables: [],
    evidence: [
      {
        id: EVIDENCE,
        version: 1,
        code: 'EV-001',
        sourceType: 'DOCUMENT',
        summary: 'Verified task evidence',
        observedAt: NOW,
      },
    ],
  });
  apiMocks.getEmployeeAiUsage.mockResolvedValue(usageFixture());
});

describe('ExperienceUsageWorkspace DOM acceptance', () => {
  it('renders a real empty state instead of fake experience records', async () => {
    const { dom, client } = await renderWorkspace([]);
    try {
      await dom.flush();
      await dom.flush();
      expect(dom.container.textContent).toContain('当前筛选下暂无经验候选');
      expect(dom.container.textContent).toContain('这里不会生成演示记录');
      expect(apiMocks.listEmployeeExperiences).toHaveBeenCalled();
    } finally {
      await dom.cleanup();
      client.clear();
    }
  });

  it('shows trusted, unreported and unknown usage separately', async () => {
    const { dom, client } = await renderWorkspace([]);
    try {
      await dom.flush();
      const usageTab = [...dom.container.querySelectorAll('[role="tab"]')].find((tab) =>
        tab.textContent?.includes('AI 用量'),
      );
      expect(usageTab).toBeDefined();
      await dom.click(usageTab!);
      await dom.flush();
      await dom.flush();

      expect(dom.container.textContent).toContain('未上报的 0/0/0 不会伪装成真实用量');
      expect(dom.container.textContent).toContain('可信 Token 1 次，未上报 1 次');
      expect(dom.container.textContent).toContain('结果未知 1 次');
      expect(dom.container.textContent).toContain('25');
    } finally {
      await dom.cleanup();
      client.clear();
    }
  });

  it('submits only selected server-authorized sources and no actor identity', async () => {
    apiMocks.createEmployeeExperience.mockResolvedValue({
      id: '00000000-0000-7000-8000-000000000603',
      status: 'CANDIDATE',
      revision: 1,
      title: '可复用交付经验',
      source: { taskId: TASK, deliverableIds: [], evidenceIds: [EVIDENCE] },
      sanitized: null,
      review: null,
      validation: null,
      publication: null,
      permissionLabels: [],
      sensitivity: 'INTERNAL',
      metrics: { useCount: 0, adoptionCount: 0, complaintCount: 0 },
      retiredAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    const tasks = [{ id: TASK, title: '客户交付复盘' }] as Task[];
    const { dom, client } = await renderWorkspace(tasks);
    try {
      await dom.flush();
      const open = [...dom.container.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('提交经验候选'),
      );
      expect(open).toBeDefined();
      await dom.click(open!);
      await dom.flush();
      await dom.flush();

      const title = dom.container.querySelector('input[name="title"]') as HTMLInputElement | null;
      const summary = dom.container.querySelector(
        'textarea[name="candidateSummary"]',
      ) as HTMLTextAreaElement | null;
      const evidence = dom.container.querySelector(
        '.experience-source-columns fieldset:last-child input[type="checkbox"]',
      ) as HTMLInputElement | null;
      expect(title).not.toBeNull();
      expect(summary).not.toBeNull();
      expect(evidence).not.toBeNull();
      await dom.change(title!, '可复用交付经验');
      await dom.change(summary!, '这是等待脱敏与独立审核的原始经验候选。');
      evidence!.checked = true;
      await dom.click(evidence!);
      await dom.flush();

      const form = dom.container.querySelector('.experience-dialog form') as HTMLFormElement | null;
      expect(form).not.toBeNull();
      await dom.submit(form!);
      await dom.flush();

      expect(apiMocks.createEmployeeExperience).toHaveBeenCalledWith(
        expect.objectContaining({
          title: '可复用交付经验',
          sourceTaskId: TASK,
          sourceDeliverableIds: [],
          sourceEvidenceIds: [EVIDENCE],
          candidateSummary: '这是等待脱敏与独立审核的原始经验候选。',
        }),
      );
      const submitted = apiMocks.createEmployeeExperience.mock.calls[0]?.[0];
      expect(submitted).not.toHaveProperty('contributorUserId');
      expect(submitted).not.toHaveProperty('rawInputHash');
    } finally {
      await dom.cleanup();
      client.clear();
    }
  });
});

async function renderWorkspace(tasks: readonly Task[]) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  const dom = await renderInTestDom(
    createElement(
      QueryClientProvider,
      { client },
      createElement(ExperienceUsageWorkspace, { tasks }),
    ),
  );
  return { dom, client };
}

function usageFixture(): EmployeeAiUsageSummary {
  return {
    period: {
      from: '2026-07-01T00:00:00.000Z',
      to: NOW,
      defaultedToCurrentMonth: true,
    },
    generatedAt: NOW,
    runs: {
      total: 2,
      succeeded: 1,
      failed: 0,
      unknown: 1,
      cancelled: 0,
      inProgress: 0,
      tokenReported: 1,
      tokenUnreported: 1,
      costReported: 1,
      costUnreported: 1,
    },
    trustedUsage: {
      inputTokens: '20',
      outputTokens: '5',
      totalTokens: '25',
      costMicros: '800',
    },
    latency: { sampleCount: 2, averageMs: 250, p50Ms: 200, p95Ms: 300 },
    byAgent: [],
    byTask: [],
  };
}
