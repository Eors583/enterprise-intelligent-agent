import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderInTestDom } from '../../test/dom-test-utils';
import { availableToolFixture, toolFixtureIds, toolInvocationFixture } from './test-fixtures';

const apiMocks = vi.hoisted(() => ({
  listAvailableTaskTools: vi.fn(),
  listTaskToolInvocations: vi.fn(),
  listTaskToolApprovals: vi.fn(),
  createTaskToolInvocation: vi.fn(),
  decideTaskToolInvocation: vi.fn(),
}));

vi.mock('./api', () => apiMocks);

import { TaskToolPanel } from './TaskToolPanel';

beforeEach(() => {
  for (const mock of Object.values(apiMocks)) mock.mockReset();
  apiMocks.listAvailableTaskTools.mockResolvedValue([availableToolFixture()]);
  apiMocks.listTaskToolInvocations.mockResolvedValue([]);
  apiMocks.listTaskToolApprovals.mockResolvedValue([]);
});

describe('Task Tool panel DOM acceptance', () => {
  it('renders only the safe task-authorized Tool projection and its policy gates', async () => {
    const { dom, queryClient } = await renderWithClient(
      createElement(TaskToolPanel, { taskId: toolFixtureIds.task }),
    );
    try {
      await dom.flush();
      await dom.flush();
      expect(dom.container.textContent).toContain('查询客户档案');
      expect(dom.container.textContent).toContain('确认后执行');
      expect(dom.container.textContent).toContain('敏感连接配置不会下发桌面端');
      expect(dom.container.textContent).not.toContain('secret://');
      expect(dom.container.querySelector('form.tool-invocation-form')).not.toBeNull();
    } finally {
      queryClient.clear();
      await dom.flush();
      await dom.cleanup();
    }
  });

  it('requires a reason and accepts success only after the server advances revision', async () => {
    const current = toolInvocationFixture();
    const confirmed = toolInvocationFixture({
      status: 'APPROVED',
      revision: 3,
      confirmation: {
        confirmedByUserId: current.requesterUserId,
        confirmedAt: '2026-07-28T06:01:00.000Z',
        reason: 'I confirmed this exact input.',
      },
      updatedAt: '2026-07-28T06:01:00.000Z',
    });
    apiMocks.listTaskToolInvocations.mockResolvedValue([current]);
    apiMocks.decideTaskToolInvocation.mockResolvedValue(confirmed);
    const { dom, queryClient } = await renderWithClient(
      createElement(TaskToolPanel, { taskId: toolFixtureIds.task }),
    );
    try {
      await dom.flush();
      await dom.flush();
      const invocationButton = [...dom.container.querySelectorAll('[role="listitem"]')].find(
        (element) => element.textContent?.includes('待本人确认'),
      );
      expect(invocationButton).toBeTruthy();
      if (invocationButton) await dom.click(invocationButton);
      const confirm = [...dom.container.querySelectorAll('button')].find(
        (button) => button.textContent?.trim() === '确认执行',
      ) as HTMLButtonElement | undefined;
      expect(confirm?.disabled).toBe(true);
      const reason = dom.container.querySelector('.tool-action-zone textarea');
      if (reason instanceof HTMLTextAreaElement) {
        await dom.change(reason, 'I confirmed this exact input.');
      }
      expect(confirm?.disabled).toBe(false);
      if (confirm) await dom.click(confirm);
      await dom.flush();
      expect(apiMocks.decideTaskToolInvocation).toHaveBeenCalledWith(
        toolFixtureIds.task,
        expect.objectContaining({ id: current.id, revision: current.revision }),
        expect.objectContaining({ action: 'CONFIRM', expectedRevision: current.revision }),
      );
      expect(dom.container.querySelector('[role="status"]')?.textContent).toContain(
        '状态已由服务端确认更新',
      );
    } finally {
      queryClient.clear();
      await dom.flush();
      await dom.cleanup();
    }
  });

  it('exposes an independent maker-checker approval queue without requester self-approval', async () => {
    const pending = toolInvocationFixture({
      requesterUserId: '20000000-0000-7000-8000-000000000001',
      roleAssignmentId: '20000000-0000-7000-8000-000000000002',
      riskClass: 'HIGH_RISK_APPROVAL',
      status: 'PENDING_APPROVAL',
      revision: 3,
      confirmation: {
        confirmedByUserId: '20000000-0000-7000-8000-000000000001',
        confirmedAt: '2026-07-28T06:01:00.000Z',
        reason: 'Requester confirmed.',
      },
      updatedAt: '2026-07-28T06:01:00.000Z',
    });
    apiMocks.listTaskToolApprovals.mockResolvedValue([pending]);
    apiMocks.decideTaskToolInvocation.mockResolvedValue({
      ...pending,
      status: 'APPROVED',
      revision: 4,
      approval: {
        approverUserId: toolFixtureIds.user,
        approverRoleAssignmentId: toolFixtureIds.assignment,
        decision: 'APPROVED',
        decidedAt: '2026-07-28T06:02:00.000Z',
        reason: 'Scope and input verified.',
      },
      updatedAt: '2026-07-28T06:02:00.000Z',
    });
    const { dom, queryClient } = await renderWithClient(
      createElement(TaskToolPanel, { taskId: toolFixtureIds.task }),
    );
    try {
      await dom.flush();
      await dom.flush();
      const reviewItem = [...dom.container.querySelectorAll('[role="listitem"]')].find((element) =>
        element.textContent?.includes('高风险工具审批'),
      );
      if (reviewItem) await dom.click(reviewItem);
      expect(dom.container.textContent).toContain('Maker-checker approval');
      expect(dom.container.textContent).toContain('职责分离');
      const reason = dom.container.querySelector('.tool-approval-detail textarea');
      if (reason instanceof HTMLTextAreaElement) {
        await dom.change(reason, 'Scope and input verified.');
      }
      const approve = [...dom.container.querySelectorAll('button')].find(
        (button) => button.textContent?.trim() === '批准执行',
      );
      if (approve) await dom.click(approve);
      await dom.flush();
      expect(apiMocks.decideTaskToolInvocation).toHaveBeenCalledWith(
        toolFixtureIds.task,
        expect.objectContaining({ id: pending.id, revision: pending.revision }),
        expect.objectContaining({ action: 'APPROVE', expectedRevision: pending.revision }),
      );
      expect(dom.container.querySelector('[role="status"]')?.textContent).toContain(
        '独立审批已通过',
      );
    } finally {
      queryClient.clear();
      await dom.flush();
      await dom.cleanup();
    }
  });
});

async function renderWithClient(element: React.ReactNode): Promise<{
  dom: Awaited<ReturnType<typeof renderInTestDom>>;
  queryClient: QueryClient;
}> {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const dom = await renderInTestDom(
    createElement(QueryClientProvider, { client: queryClient }, element),
  );
  return { dom, queryClient };
}
