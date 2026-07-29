import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiClientError } from '../../shared/api/client';
import { renderInTestDom } from '../../test/dom-test-utils';
import {
  collaborationDetailFixture,
  collaborationFixture,
  correctionFixture,
  runtimePage,
} from './interaction-test-fixtures';

const apiMocks = vi.hoisted(() => ({
  getWorkbenchTaskTrace: vi.fn(),
  listWorkbenchObjectives: vi.fn(),
  listWorkbenchTasks: vi.fn(),
  listTaskCollaborations: vi.fn(),
  listTaskCollaborationCandidates: vi.fn(),
  createTaskCollaboration: vi.fn(),
  getTaskCollaborationDetail: vi.fn(),
  submitTaskCollaborationCommand: vi.fn(),
  listTaskCorrections: vi.fn(),
  submitTaskCorrectionFeedback: vi.fn(),
  getEmployeeTaskExecution: vi.fn(),
  transitionEmployeeTask: vi.fn(),
  contributeEmployeeEvidence: vi.fn(),
  submitEmployeeDeliverable: vi.fn(),
  requestEmployeeAcceptance: vi.fn(),
}));

vi.mock('./api', () => apiMocks);

import {
  TaskCollaborationPanel,
  TaskCorrectionPanel,
  WorkbenchTaskModeTabs,
} from './TaskInteractionPanels';
import { taskFixture } from './test-fixtures';

beforeEach(() => {
  for (const mock of Object.values(apiMocks)) mock.mockReset();
  apiMocks.listTaskCollaborations.mockResolvedValue(runtimePage([]));
  apiMocks.listTaskCollaborationCandidates.mockResolvedValue({ items: [] });
  apiMocks.listTaskCorrections.mockResolvedValue(runtimePage([]));
});

describe('task collaboration and correction DOM acceptance', () => {
  it('exposes accessible overview, execution, collaboration, correction, and governed Tool tabs', async () => {
    const onChange = vi.fn();
    const dom = await renderInTestDom(
      createElement(WorkbenchTaskModeTabs, { active: 'overview', onChange }),
    );
    try {
      const tabs = [...dom.container.querySelectorAll('[role="tab"]')];
      expect(tabs.map((tab) => tab.textContent)).toEqual([
        '任务总览经营语义与 trace',
        '任务执行状态、证据与验收',
        '协同结构化协议消息',
        '纠偏依据、影响与反馈',
        '工具受控查询与执行',
      ]);
      expect(tabs[0]?.getAttribute('aria-selected')).toBe('true');
      if (tabs[1]) await dom.click(tabs[1]);
      expect(onChange).toHaveBeenCalledWith('execution');
      if (tabs[2]) await dom.click(tabs[2]);
      expect(onChange).toHaveBeenCalledWith('collaboration');
      if (tabs[4]) await dom.click(tabs[4]);
      expect(onChange).toHaveBeenCalledWith('tools');
    } finally {
      await dom.cleanup();
    }
  });

  it('shows an unconnected collaboration capability instead of fallback content', async () => {
    apiMocks.listTaskCollaborations.mockRejectedValue(
      new ApiClientError('http', 'Not implemented', { status: 501 }),
    );
    const { dom, queryClient } = await renderWithClient(
      createElement(TaskCollaborationPanel, { taskId: taskFixture().id }),
    );
    try {
      await dom.flush();
      const unavailable = dom.container.querySelector('[data-capability-state="unavailable"]');
      expect(unavailable?.getAttribute('role')).toBe('alert');
      expect(unavailable?.textContent).toContain('协同能力未接通');
      expect(unavailable?.textContent).toContain('不会展示模拟协同');
      expect(dom.container.querySelector('.interaction-detail-card')).toBeNull();
    } finally {
      queryClient.clear();
      await dom.flush();
      await dom.cleanup();
    }
  });

  it('keeps collaboration loading and real empty states distinct', async () => {
    const pending = deferred<ReturnType<typeof runtimePage<never>>>();
    apiMocks.listTaskCollaborations.mockReturnValue(pending.promise);
    const { dom, queryClient } = await renderWithClient(
      createElement(TaskCollaborationPanel, { taskId: taskFixture().id }),
    );
    try {
      expect(dom.container.querySelector('[role="status"]')?.textContent).toContain('正在读取协同');
      pending.resolve(runtimePage([]));
      await dom.flush();
      await dom.flush();
      expect(dom.container.textContent).toContain('暂无协同');
      expect(dom.container.textContent).toContain('不会创建示例记录');
      expect(dom.container.querySelector('.interaction-record-list')).toBeNull();
    } finally {
      queryClient.clear();
      await dom.flush();
      await dom.cleanup();
    }
  });

  it('renders a contract-validated collaboration correlation trace and disables terminal actions', async () => {
    const collaboration = collaborationFixture({ status: 'ACCEPTED', revision: 4 });
    apiMocks.listTaskCollaborations.mockResolvedValue(runtimePage([collaboration]));
    apiMocks.getTaskCollaborationDetail.mockResolvedValue(
      collaborationDetailFixture(collaboration),
    );
    const { dom, queryClient } = await renderWithClient(
      createElement(TaskCollaborationPanel, { taskId: taskFixture().id }),
    );
    try {
      await dom.flush();
      await dom.flush();
      expect(dom.container.textContent).toContain('Correlation ID');
      expect(dom.container.textContent).toContain('Causation ID');
      expect(dom.container.textContent).toContain('客户留存指标偏离目标');
      const terminal = [...dom.container.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('协同已终态'),
      ) as HTMLButtonElement | undefined;
      expect(terminal?.disabled).toBe(true);
    } finally {
      queryClient.clear();
      await dom.flush();
      await dom.cleanup();
    }
  });

  it('submits a revision-bound collaboration command and waits for server confirmation', async () => {
    const requested = collaborationFixture();
    const committed = collaborationFixture({
      status: 'COMMITTED',
      revision: requested.revision + 1,
      updatedAt: '2026-07-28T09:01:00.000Z',
    });
    apiMocks.listTaskCollaborations.mockResolvedValue(runtimePage([requested]));
    apiMocks.getTaskCollaborationDetail.mockResolvedValue(collaborationDetailFixture(requested));
    const confirmed = deferred<ReturnType<typeof collaborationDetailFixture>>();
    apiMocks.submitTaskCollaborationCommand.mockReturnValue(confirmed.promise);
    const { dom, queryClient } = await renderWithClient(
      createElement(TaskCollaborationPanel, { taskId: taskFixture().id }),
    );
    try {
      await dom.flush();
      await dom.flush();
      const action = [...dom.container.querySelectorAll('button')].find(
        (button) => button.textContent?.trim() === '承诺交付',
      );
      if (action) await dom.click(action);
      const form = dom.container.querySelector(
        '.collaboration-dialog form',
      ) as HTMLFormElement | null;
      expect(form).not.toBeNull();
      if (form) await dom.submit(form);
      await dom.flush();
      expect(apiMocks.submitTaskCollaborationCommand).toHaveBeenCalledWith(
        taskFixture().id,
        requested.id,
        expect.objectContaining({
          type: 'COMMIT',
          expectedRevision: requested.revision,
        }),
      );
      expect(dom.container.textContent).toContain('等待服务端确认');
      confirmed.resolve(collaborationDetailFixture(committed));
      await dom.flush();
      await dom.flush();
      expect(dom.container.querySelector('.collaboration-dialog')).toBeNull();
    } finally {
      queryClient.clear();
      await dom.flush();
      await dom.cleanup();
    }
  });

  it('keeps revision conflict visible and reports success only after server confirmation', async () => {
    const correction = correctionFixture();
    const updated = correctionFixture({
      status: 'ACKNOWLEDGED',
      revision: correction.revision + 1,
      updatedAt: '2026-07-28T09:07:00.000Z',
    });
    apiMocks.listTaskCorrections.mockResolvedValue(runtimePage([correction]));
    apiMocks.submitTaskCorrectionFeedback.mockRejectedValueOnce(
      new ApiClientError('http', 'Revision mismatch', { status: 409 }),
    );
    const { dom, queryClient } = await renderWithClient(
      createElement(TaskCorrectionPanel, { taskId: taskFixture().id }),
    );
    try {
      await dom.flush();
      const action = [...dom.container.querySelectorAll('button')].find(
        (button) => button.textContent?.trim() === '确认收到',
      );
      if (action) await dom.click(action);
      const form = dom.container.querySelector('.correction-dialog form') as HTMLFormElement | null;
      const comment = form?.querySelector('textarea') as HTMLTextAreaElement | null;
      const submit = form?.querySelector('button[type="submit"]') as HTMLButtonElement | null;
      expect(submit?.disabled).toBe(true);
      if (comment) await dom.change(comment, '已收到纠偏并核对最新修订。');
      expect(submit?.disabled).toBe(false);
      if (form) await dom.submit(form);
      await dom.flush();

      expect(apiMocks.submitTaskCorrectionFeedback).toHaveBeenCalledWith(
        taskFixture().id,
        correction.id,
        expect.objectContaining({ expectedRevision: correction.revision }),
      );
      expect(dom.container.querySelector('[role="alert"]')?.textContent).toContain('修订冲突');
      expect(dom.container.textContent).not.toContain('纠偏反馈已由服务端确认');

      const confirmed = deferred<typeof updated>();
      apiMocks.submitTaskCorrectionFeedback.mockReturnValueOnce(confirmed.promise);
      if (form) await dom.submit(form);
      expect(dom.container.textContent).not.toContain('纠偏反馈已由服务端确认');
      expect(
        (form?.querySelector('button[type="submit"]') as HTMLButtonElement | null)?.disabled,
      ).toBe(true);
      confirmed.resolve(updated);
      await dom.flush();
      await dom.flush();
      expect(dom.container.querySelector('[role="status"]')?.textContent).toContain(
        '纠偏反馈已由服务端确认',
      );
    } finally {
      queryClient.clear();
      await dom.flush();
      await dom.cleanup();
    }
  });

  it('disables feedback for terminal correction states', async () => {
    const resolved = correctionFixture({
      status: 'RESOLVED',
      revision: 4,
      updatedAt: '2026-07-28T09:08:00.000Z',
    });
    apiMocks.listTaskCorrections.mockResolvedValue(runtimePage([resolved]));
    const { dom, queryClient } = await renderWithClient(
      createElement(TaskCorrectionPanel, { taskId: taskFixture().id }),
    );
    try {
      await dom.flush();
      const terminal = [...dom.container.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('纠偏已终态'),
      ) as HTMLButtonElement | undefined;
      expect(terminal?.disabled).toBe(true);
      expect(apiMocks.submitTaskCorrectionFeedback).not.toHaveBeenCalled();
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
