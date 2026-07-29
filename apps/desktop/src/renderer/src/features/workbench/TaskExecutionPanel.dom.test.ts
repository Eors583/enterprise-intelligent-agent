import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiClientError } from '../../shared/api/client';
import { renderInTestDom } from '../../test/dom-test-utils';
import {
  employeeTaskExecutionFixture,
  executionAssignmentId,
} from './employee-task-execution-test-fixtures';

const apiMocks = vi.hoisted(() => ({
  getWorkbenchTaskTrace: vi.fn(),
  listWorkbenchObjectives: vi.fn(),
  listWorkbenchTasks: vi.fn(),
  listTaskCollaborations: vi.fn(),
  getTaskCollaborationDetail: vi.fn(),
  listTaskCorrections: vi.fn(),
  submitTaskCorrectionFeedback: vi.fn(),
  getEmployeeTaskExecution: vi.fn(),
  transitionEmployeeTask: vi.fn(),
  contributeEmployeeEvidence: vi.fn(),
  submitEmployeeDeliverable: vi.fn(),
  requestEmployeeAcceptance: vi.fn(),
}));

vi.mock('./api', () => apiMocks);

import { TaskExecutionPanel } from './TaskExecutionPanel';

beforeEach(() => {
  for (const mock of Object.values(apiMocks)) mock.mockReset();
});

describe('employee task execution DOM acceptance', () => {
  it('keeps every mutation disabled when the server returns no matching capability', async () => {
    const snapshot = employeeTaskExecutionFixture({ capabilities: [] });
    apiMocks.getEmployeeTaskExecution.mockResolvedValue(snapshot);
    const { dom, queryClient } = await renderWithClient(
      createElement(TaskExecutionPanel, { taskId: snapshot.task.id }),
    );

    try {
      await dom.flush();
      await dom.flush();
      expect(dom.container.textContent).toContain('没有匹配此动作和任务范围的有效角色授权');
      const start = buttonByText(dom.container, '开始任务');
      const evidence = buttonByText(dom.container, '提交待核验证据');
      const deliverable = buttonByText(dom.container, '提交交付物');
      expect(start?.disabled).toBe(true);
      expect(evidence?.disabled).toBe(true);
      expect(deliverable?.disabled).toBe(true);
      expect(apiMocks.transitionEmployeeTask).not.toHaveBeenCalled();
    } finally {
      queryClient.clear();
      await dom.flush();
      await dom.cleanup();
    }
  });

  it('keeps a revision conflict visible and offers an explicit server refresh', async () => {
    const snapshot = employeeTaskExecutionFixture({
      capabilities: [{ action: 'business.task.execute', roleAssignmentId: executionAssignmentId }],
    });
    apiMocks.getEmployeeTaskExecution.mockResolvedValue(snapshot);
    apiMocks.transitionEmployeeTask.mockRejectedValue(
      new ApiClientError('http', 'Revision mismatch', { status: 409 }),
    );
    const { dom, queryClient } = await renderWithClient(
      createElement(TaskExecutionPanel, { taskId: snapshot.task.id }),
    );

    try {
      await dom.flush();
      await dom.flush();
      const transition = dom.container.querySelector(
        '.task-execution-section textarea',
      ) as HTMLTextAreaElement | null;
      if (transition) await dom.change(transition, '开始处理已分配任务。');
      const start = buttonByText(dom.container, '开始任务');
      if (start) await dom.click(start);
      await dom.flush();

      expect(apiMocks.transitionEmployeeTask).toHaveBeenCalledWith(
        snapshot.task.id,
        expect.objectContaining({
          expectedRevision: snapshot.task.revision,
          roleAssignmentId: executionAssignmentId,
          action: 'START',
        }),
      );
      const conflict = dom.container.querySelector('[role="alert"][data-conflict="true"]');
      expect(conflict?.textContent).toContain('已被其他人更新');
      expect(dom.container.querySelector('[role="status"]')).toBeNull();

      const refresh = buttonByText(dom.container, '刷新任务状态');
      if (refresh) await dom.click(refresh);
      await dom.flush();
      expect(apiMocks.getEmployeeTaskExecution).toHaveBeenCalledTimes(2);
    } finally {
      queryClient.clear();
      await dom.flush();
      await dom.cleanup();
    }
  });

  it('does not render success until the transition response is contract-confirmed', async () => {
    const snapshot = employeeTaskExecutionFixture({
      capabilities: [{ action: 'business.task.execute', roleAssignmentId: executionAssignmentId }],
    });
    const confirmed = deferred({
      ...snapshot.task,
      status: 'IN_PROGRESS' as const,
      revision: snapshot.task.revision + 1,
    });
    apiMocks.getEmployeeTaskExecution.mockResolvedValue(snapshot);
    apiMocks.transitionEmployeeTask.mockReturnValue(confirmed.promise);
    const { dom, queryClient } = await renderWithClient(
      createElement(TaskExecutionPanel, { taskId: snapshot.task.id }),
    );

    try {
      await dom.flush();
      await dom.flush();
      const transition = dom.container.querySelector(
        '.task-execution-section textarea',
      ) as HTMLTextAreaElement | null;
      if (transition) await dom.change(transition, '开始处理已分配任务。');
      const start = buttonByText(dom.container, '开始任务');
      if (start) await dom.click(start);
      await dom.flush();

      expect(dom.container.querySelector('[role="status"]')).toBeNull();
      expect(buttonByText(dom.container, '等待服务端确认…')?.disabled).toBe(true);

      confirmed.resolve();
      await dom.flush();
      await dom.flush();
      expect(dom.container.querySelector('[role="status"]')?.textContent).toContain(
        '服务端已确认任务状态',
      );
    } finally {
      queryClient.clear();
      await dom.flush();
      await dom.cleanup();
    }
  });
});

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === text,
  ) as HTMLButtonElement | undefined;
}

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

function deferred<T>(value: T): {
  promise: Promise<T>;
  resolve: () => void;
} {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: () => resolvePromise(value),
  };
}
