import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client';
import { renderInTestDom } from '@/test/dom-test-utils';

const apiMocks = vi.hoisted(() => ({
  listProcessInstances: vi.fn(),
  getProcessInstanceDetail: vi.fn(),
  sendProcessCommand: vi.fn(),
  sendProcessStepCommand: vi.fn(),
  listBusinessEvents: vi.fn(),
  getBusinessEventDetail: vi.fn(),
  replayEventDelivery: vi.fn(),
}));

vi.mock('./api', () => ({
  ...apiMocks,
  runtimeGovernanceApiPaths: {},
}));

import { RuntimeGovernancePage } from './RuntimeGovernancePage';
import {
  businessEventFixture,
  deliveryFixture,
  processInstanceFixture,
  processStepFixture,
} from './test-fixtures';

beforeEach(() => {
  for (const mock of Object.values(apiMocks)) mock.mockReset();
  apiMocks.listProcessInstances.mockResolvedValue(page([]));
  apiMocks.getProcessInstanceDetail.mockResolvedValue({
    instance: processInstanceFixture(),
    steps: [],
  });
  apiMocks.listBusinessEvents.mockResolvedValue(page([]));
  apiMocks.getBusinessEventDetail.mockResolvedValue({
    event: businessEventFixture(),
    deliveries: [],
  });
});

describe('runtime governance DOM acceptance', () => {
  it('keeps loading and unimplemented capability states explicit without fallback data', async () => {
    const pending = deferred<ReturnType<typeof processInstanceFixture>[]>();
    apiMocks.listProcessInstances.mockReset();
    apiMocks.listProcessInstances.mockReturnValue(pending.promise.then((items) => page(items)));
    const loadingDom = await renderInTestDom(createElement(RuntimeGovernancePage));
    try {
      expect(loadingDom.container.querySelector('[role="status"]')?.textContent).toContain(
        '正在读取流程实例',
      );
      expect(loadingDom.container.textContent).not.toContain('示例');
    } finally {
      pending.resolve([]);
      await loadingDom.flush();
      await loadingDom.cleanup();
    }

    apiMocks.listProcessInstances.mockReset();
    apiMocks.listProcessInstances.mockRejectedValue(
      new ApiError('Not implemented', { status: 501 }),
    );
    const unavailableDom = await renderInTestDom(createElement(RuntimeGovernancePage));
    try {
      await unavailableDom.flush();
      const unavailable = unavailableDom.container.querySelector(
        '[data-capability-state="unavailable"]',
      );
      expect(unavailable?.getAttribute('role')).toBe('alert');
      expect(unavailable?.textContent).toContain('流程运行能力未接通');
      expect(unavailable?.textContent).toContain('不会使用模拟数据');
      expect(unavailableDom.container.querySelector('.runtime-record-list')).toBeNull();
    } finally {
      await unavailableDom.cleanup();
    }
  });

  it('renders process correlation and step state, and disables terminal commands', async () => {
    const completed = processInstanceFixture({
      status: 'COMPLETED',
      completedAt: '2026-07-28T09:00:00.000Z',
      updatedAt: '2026-07-28T09:00:00.000Z',
    });
    apiMocks.listProcessInstances.mockResolvedValue(page([completed]));
    apiMocks.getProcessInstanceDetail.mockResolvedValue({
      instance: completed,
      steps: [
        processStepFixture({
          status: 'SKIPPED',
          startedAt: null,
          completedAt: null,
          updatedAt: '2026-07-28T08:04:00.000Z',
        }),
      ],
    });

    const dom = await renderInTestDom(createElement(RuntimeGovernancePage));
    try {
      await dom.flush();
      await dom.flush();
      expect(dom.container.textContent).toContain('Correlation ID');
      expect(dom.container.textContent).toContain('00000000…0008');
      expect(dom.container.textContent).toContain('REVIEW.RISK');

      const instanceCommand = [...dom.container.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('终态不可操作'),
      ) as HTMLButtonElement | undefined;
      const stepCommand = [...dom.container.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('终态'),
      ) as HTMLButtonElement | undefined;
      expect(instanceCommand?.disabled).toBe(true);
      expect(stepCommand?.disabled).toBe(true);
    } finally {
      await dom.cleanup();
    }
  });

  it('surfaces a revision conflict and never emits a success state for the failed command', async () => {
    const instance = processInstanceFixture();
    apiMocks.listProcessInstances.mockResolvedValue(page([instance]));
    apiMocks.sendProcessCommand.mockRejectedValue(
      new ApiError('Revision mismatch', { status: 409 }),
    );
    const dom = await renderInTestDom(createElement(RuntimeGovernancePage));
    try {
      await dom.flush();
      const open = [...dom.container.querySelectorAll('button')].find(
        (button) => button.textContent?.trim() === '执行命令',
      );
      expect(open).not.toBeUndefined();
      if (open) await dom.click(open);

      const form = dom.container.querySelector('.runtime-command-form') as HTMLFormElement | null;
      const submit = form?.querySelector('button[type="submit"]') as HTMLButtonElement | null;
      expect(submit?.disabled).toBe(true);
      const reason = form?.querySelector('textarea') as HTMLTextAreaElement | null;
      if (reason) await dom.change(reason, '暂停并核对最新运行修订');
      expect(submit?.disabled).toBe(false);
      if (form) await dom.submit(form);
      await dom.flush();

      expect(apiMocks.sendProcessCommand).toHaveBeenCalledWith(
        instance.id,
        expect.objectContaining({ expectedRevision: instance.revision, command: 'PAUSE' }),
      );
      expect(dom.container.querySelector('[role="dialog"]')).not.toBeNull();
      expect(dom.container.querySelector('[role="alert"]')?.textContent).toContain('修订冲突');
      expect(dom.container.textContent).not.toContain('流程命令已由服务端确认');
    } finally {
      await dom.cleanup();
    }
  });

  it('shows event trace identities, real empty states, and DLQ replay eligibility', async () => {
    const event = businessEventFixture();
    const processed = deliveryFixture({
      status: 'PROCESSED',
      processedAt: '2026-07-28T08:09:00.000Z',
      deadLetteredAt: null,
      lastErrorCode: null,
      lastErrorDetail: null,
      updatedAt: '2026-07-28T08:09:00.000Z',
    });
    apiMocks.listBusinessEvents.mockResolvedValue(page([event]));
    apiMocks.getBusinessEventDetail.mockResolvedValue({
      event,
      deliveries: [processed],
    });
    const dom = await renderInTestDom(createElement(RuntimeGovernancePage));
    try {
      await dom.flush();
      const eventsTab = [...dom.container.querySelectorAll('[role="tab"]')].find((button) =>
        button.textContent?.includes('业务事件'),
      );
      if (eventsTab) await dom.click(eventsTab);
      await dom.flush();
      expect(dom.container.textContent).toContain('TaskStrategicDeviationDetected');
      expect(dom.container.textContent).toContain('Correlation ID');
      expect(dom.container.textContent).toContain('Causation ID');
      expect(dom.container.textContent).toContain('"thresholdDays": 3');

      const dlqTab = [...dom.container.querySelectorAll('[role="tab"]')].find((button) =>
        button.textContent?.includes('DLQ'),
      );
      if (dlqTab) await dom.click(dlqTab);
      await dom.flush();
      const replay = [...dom.container.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('仅死信可重放'),
      ) as HTMLButtonElement | undefined;
      expect(replay?.disabled).toBe(true);

      apiMocks.getBusinessEventDetail.mockResolvedValue({ event, deliveries: [] });
      const refresh = [...dom.container.querySelectorAll('button')].find(
        (button) => button.textContent?.trim() === '刷新',
      );
      if (refresh) await dom.click(refresh);
      await dom.flush();
      expect(dom.container.textContent).toContain('该事件暂无投递');
    } finally {
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

function page<T>(items: T[]): {
  items: T[];
  pageInfo: { nextCursor: null; hasMore: false };
} {
  return { items, pageInfo: { nextCursor: null, hasMore: false } };
}
