import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderInTestDom } from '../../test/dom-test-utils';
import { objectiveFixture, taskFixture, workbenchTraceFixture } from './test-fixtures';

const { traceMock } = vi.hoisted(() => ({
  traceMock: vi.fn(),
}));

vi.mock('./api', () => ({
  getWorkbenchTaskTrace: traceMock,
  getTaskCollaborationDetail: vi.fn(),
  listWorkbenchObjectives: vi.fn(),
  listWorkbenchTasks: vi.fn(),
  listTaskCollaborations: vi.fn(),
  listTaskCorrections: vi.fn(),
  submitTaskCorrectionFeedback: vi.fn(),
  getEmployeeTaskExecution: vi.fn(),
  transitionEmployeeTask: vi.fn(),
  contributeEmployeeEvidence: vi.fn(),
  submitEmployeeDeliverable: vi.fn(),
  requestEmployeeAcceptance: vi.fn(),
}));

import { WorkbenchSidebar, WorkbenchTaskWorkspace } from './WorkbenchWorkspace';

describe('employee objective and task workbench DOM acceptance', () => {
  it('keeps loading, error, empty, refresh-disabled, and selection states perceivable', async () => {
    const retry = vi.fn();
    const loadingDom = await renderInTestDom(
      createElement(WorkbenchSidebar, {
        objectives: undefined,
        tasks: undefined,
        selectedObjectiveId: null,
        selectedTaskId: null,
        isLoading: true,
        isError: true,
        error: new Error('workbench unavailable'),
        isRefreshing: true,
        onSelectObjective: vi.fn(),
        onSelectTask: vi.fn(),
        onRetry: retry,
      }),
    );
    try {
      expect(loadingDom.container.querySelector('aside[aria-label="目标与任务"]')).not.toBeNull();
      expect(loadingDom.container.querySelector('[role="status"]')?.textContent).toContain(
        '正在读取目标与任务',
      );
      expect(loadingDom.container.querySelector('[role="alert"]')?.textContent).toContain(
        'workbench unavailable',
      );
      const refresh = [...loadingDom.container.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('刷新中'),
      ) as HTMLButtonElement | undefined;
      expect(refresh?.disabled).toBe(true);
    } finally {
      await loadingDom.cleanup();
    }

    const objective = objectiveFixture();
    const task = taskFixture();
    const onSelectObjective = vi.fn();
    const onSelectTask = vi.fn();
    const readyDom = await renderInTestDom(
      createElement(WorkbenchSidebar, {
        objectives: [objective],
        tasks: [task],
        selectedObjectiveId: objective.id,
        selectedTaskId: task.id,
        isLoading: false,
        isError: false,
        error: null,
        isRefreshing: false,
        onSelectObjective,
        onSelectTask,
        onRetry: retry,
      }),
    );
    try {
      const objectiveButton = [...readyDom.container.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('提升客户留存'),
      );
      const taskButton = [...readyDom.container.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('复盘高风险客户'),
      );
      expect(objectiveButton?.getAttribute('aria-current')).toBe('true');
      expect(taskButton?.getAttribute('aria-current')).toBe('true');
      if (objectiveButton) await readyDom.click(objectiveButton);
      if (taskButton) await readyDom.click(taskButton);
      expect(onSelectObjective).toHaveBeenCalledWith(objective.id);
      expect(onSelectTask).toHaveBeenCalledWith(task.id);
      expect(readyDom.container.textContent).not.toContain('在线');
    } finally {
      await readyDom.cleanup();
    }

    const emptyDom = await renderInTestDom(
      createElement(WorkbenchSidebar, {
        objectives: [],
        tasks: [],
        selectedObjectiveId: null,
        selectedTaskId: null,
        isLoading: false,
        isError: false,
        error: null,
        isRefreshing: false,
        onSelectObjective: vi.fn(),
        onSelectTask: vi.fn(),
        onRetry: vi.fn(),
      }),
    );
    try {
      expect(emptyDom.container.textContent).toContain('当前账号暂无可见目标');
      expect(emptyDom.container.textContent).toContain('当前账号暂无可见任务');
    } finally {
      await emptyDom.cleanup();
    }
  });

  it('fetches trace only after expansion and renders the contract-backed full chain', async () => {
    const deferredTrace = deferred<ReturnType<typeof workbenchTraceFixture>>();
    traceMock.mockReset();
    traceMock.mockReturnValueOnce(deferredTrace.promise);
    const task = taskFixture();
    const objective = objectiveFixture();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const dom = await renderInTestDom(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(WorkbenchTaskWorkspace, {
          task,
          objective,
          isLoading: false,
        }),
      ),
    );

    try {
      expect(traceMock).not.toHaveBeenCalled();
      const expand = [...dom.container.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('展开全链 trace'),
      ) as HTMLButtonElement | undefined;
      expect(expand?.getAttribute('aria-expanded')).toBe('false');
      if (expand) await dom.click(expand);
      expect(traceMock).toHaveBeenCalledWith(task.id, expect.anything());
      expect(
        [...dom.container.querySelectorAll('button')]
          .find((button) => button.textContent?.includes('加载全链 trace'))
          ?.hasAttribute('disabled'),
      ).toBe(true);
      expect(dom.container.querySelector('[role="status"]')?.textContent).toContain(
        '正在读取全链 trace',
      );

      deferredTrace.resolve(workbenchTraceFixture());
      await dom.flush();
      await dom.flush();

      expect(dom.container.querySelector('#task-semantic-trace')).not.toBeNull();
      expect(dom.container.textContent).toContain('客户成功价值');
      expect(dom.container.textContent).toContain('客户留存战略');
      expect(dom.container.textContent).toContain('客户留存流程');
      expect(dom.container.textContent).toContain('高风险客户干预清单');
      expect(dom.container.textContent).toContain('验收通过，进入客户干预阶段');
      expect(dom.container.textContent).toContain('高风险客户干预清单证据');
      expect(dom.container.textContent).toContain('FINISH_TO_START');
    } finally {
      queryClient.clear();
      await dom.flush();
      await dom.cleanup();
    }
  });

  it('fails closed when trace loading errors and exposes an explicit retry', async () => {
    traceMock.mockReset();
    traceMock.mockRejectedValue(new Error('trace contract rejected'));
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const dom = await renderInTestDom(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(WorkbenchTaskWorkspace, {
          task: taskFixture(),
          objective: objectiveFixture(),
          isLoading: false,
        }),
      ),
    );
    try {
      const expand = [...dom.container.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('展开全链 trace'),
      );
      if (expand) await dom.click(expand);
      await dom.flush();
      await dom.flush();
      const alert = dom.container.querySelector('#task-semantic-trace [role="alert"]');
      expect(alert?.textContent).toContain('trace contract rejected');
      expect(dom.container.textContent).not.toContain('高风险客户干预清单');
      const retry = alert?.querySelector('button');
      if (retry) await dom.click(retry);
      expect(traceMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      queryClient.clear();
      await dom.flush();
      await dom.cleanup();
    }
  });
});

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}
