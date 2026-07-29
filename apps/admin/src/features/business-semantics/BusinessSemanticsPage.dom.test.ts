import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderInTestDom } from '@/test/dom-test-utils';

const apiMocks = vi.hoisted(() => ({
  listValueDefinitions: vi.fn(),
  listValueVersions: vi.fn(),
  listStrategies: vi.fn(),
  listObjectives: vi.fn(),
  listMetricDefinitions: vi.fn(),
  listProcessDefinitions: vi.fn(),
  listTasks: vi.fn(),
  listEvidence: vi.fn(),
  createValueDefinition: vi.fn(),
}));

vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>();
  return { ...actual, ...apiMocks };
});

import { BusinessSemanticsPage } from './BusinessSemanticsPage';
import { valueDefinitionFixture, valueVersionFixture } from './test-fixtures';

describe('business semantics admin DOM acceptance', () => {
  beforeEach(() => {
    for (const mock of Object.values(apiMocks)) mock.mockReset();
    apiMocks.listValueDefinitions.mockResolvedValue([valueDefinitionFixture()]);
    apiMocks.listValueVersions.mockResolvedValue([valueVersionFixture()]);
    apiMocks.listStrategies.mockResolvedValue([]);
    apiMocks.listObjectives.mockResolvedValue([]);
    apiMocks.listMetricDefinitions.mockResolvedValue([]);
    apiMocks.listProcessDefinitions.mockResolvedValue([]);
    apiMocks.listTasks.mockResolvedValue([]);
    apiMocks.listEvidence.mockResolvedValue([]);
    apiMocks.createValueDefinition.mockResolvedValue(valueDefinitionFixture());
  });

  it('renders governance metadata, permissions, associations, and published versions', async () => {
    const dom = await renderInTestDom(
      createElement(BusinessSemanticsPage, {
        currentUserId: '00000000-0000-7000-8000-000000000001',
      }),
    );
    try {
      await dom.flush();
      await dom.flush();
      expect(dom.container.querySelector('[role="tablist"]')).not.toBeNull();
      expect(
        dom.container.querySelector('[role="tab"][aria-selected="true"]')?.textContent,
      ).toContain('价值');
      expect(dom.container.textContent).toContain('客户成功价值');
      expect(dom.container.textContent).toContain('成员 · 00000000…0001');
      expect(dom.container.textContent).toContain('business.read');
      expect(dom.container.textContent).toContain('customer.success');
      expect(dom.container.textContent).toContain('关联校验');
      expect(dom.container.textContent).toContain('已有发布版本');
      expect(dom.container.textContent).toContain('v2');
      expect(dom.container.textContent).toContain('发布客户成功价值标准');

      const strategyTab = [...dom.container.querySelectorAll('[role="tab"]')].find((tab) =>
        tab.textContent?.includes('战略'),
      );
      if (strategyTab) await dom.click(strategyTab);
      await dom.flush();
      expect(apiMocks.listStrategies).toHaveBeenCalled();
      expect(dom.container.textContent).toContain('还没有战略');
    } finally {
      await dom.cleanup();
    }
  });

  it('keeps loading, error, empty, and retry states explicit', async () => {
    const pending = deferred<ReturnType<typeof valueDefinitionFixture>[]>();
    apiMocks.listValueDefinitions.mockReturnValueOnce(pending.promise);
    const loadingDom = await renderInTestDom(
      createElement(BusinessSemanticsPage, {
        currentUserId: '00000000-0000-7000-8000-000000000001',
      }),
    );
    try {
      expect(loadingDom.container.querySelector('[role="status"]')?.textContent).toContain(
        '正在读取价值',
      );
      pending.resolve([]);
      await loadingDom.flush();
      await loadingDom.flush();
      expect(loadingDom.container.textContent).toContain('还没有价值');
    } finally {
      await loadingDom.cleanup();
    }

    apiMocks.listValueDefinitions.mockRejectedValueOnce(new Error('semantic service unavailable'));
    const errorDom = await renderInTestDom(
      createElement(BusinessSemanticsPage, {
        currentUserId: '00000000-0000-7000-8000-000000000001',
      }),
    );
    try {
      await errorDom.flush();
      await errorDom.flush();
      const alert = errorDom.container.querySelector('[role="alert"]');
      expect(alert?.textContent).toContain('semantic service unavailable');
      const retry = [...errorDom.container.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('重新加载'),
      );
      const callsBeforeRetry = apiMocks.listValueDefinitions.mock.calls.length;
      if (retry) await errorDom.click(retry);
      expect(apiMocks.listValueDefinitions).toHaveBeenCalledTimes(callsBeforeRetry + 1);
    } finally {
      await errorDom.cleanup();
    }
  });

  it('validates editor JSON and shows success only after a resolved backend mutation', async () => {
    const dom = await renderInTestDom(
      createElement(BusinessSemanticsPage, {
        currentUserId: '00000000-0000-7000-8000-000000000001',
      }),
    );
    try {
      await dom.flush();
      const createButton = [...dom.container.querySelectorAll('button')].find(
        (button) => button.textContent?.trim() === '新建价值',
      );
      if (createButton) await dom.click(createButton);
      const dialog = dom.container.querySelector('[role="dialog"]');
      expect(dialog?.getAttribute('aria-modal')).toBe('true');
      const textarea = dialog?.querySelector('textarea') as HTMLTextAreaElement | null;
      const form = dialog?.querySelector('form') as HTMLFormElement | null;
      const submit = [...(dialog?.querySelectorAll('button') ?? [])].find(
        (button) => button.textContent?.trim() === '创建 Value',
      ) as HTMLButtonElement | undefined;
      expect(textarea).not.toBeNull();
      expect(submit?.disabled).toBe(false);

      if (form) await dom.submit(form);
      expect(apiMocks.createValueDefinition).not.toHaveBeenCalled();
      expect(dialog?.textContent).toContain('name');

      const parsed = JSON.parse(textarea!.value) as Record<string, unknown>;
      parsed.name = '新增客户价值';
      if (textarea) await dom.change(textarea, JSON.stringify(parsed, null, 2));
      apiMocks.createValueDefinition.mockRejectedValueOnce(new Error('关联权限校验失败'));
      if (form) await dom.submit(form);
      await dom.flush();
      expect(dom.container.querySelector('[role="dialog"]')?.textContent).toContain(
        '关联权限校验失败',
      );
      expect(dom.container.textContent).not.toContain('操作已由服务端确认');

      if (form) await dom.submit(form);
      await dom.flush();
      await dom.flush();
      expect(dom.container.querySelector('[role="dialog"]')).toBeNull();
      expect(dom.container.textContent).toContain('操作已由服务端确认');
      expect(apiMocks.listValueDefinitions.mock.calls.length).toBeGreaterThanOrEqual(2);
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
