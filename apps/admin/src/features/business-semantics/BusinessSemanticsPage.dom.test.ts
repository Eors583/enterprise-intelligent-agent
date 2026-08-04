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
  createGuidedEvidence: vi.fn(),
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
    apiMocks.createGuidedEvidence.mockResolvedValue({});
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

  it('validates the business form and shows success only after a resolved backend mutation', async () => {
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
      const nameInput = dialog?.querySelector('input[type="text"]') as HTMLInputElement | null;
      const form = dialog?.querySelector('form') as HTMLFormElement | null;
      const submit = [...(dialog?.querySelectorAll('button') ?? [])].find(
        (button) => button.textContent?.trim() === '创建 Value',
      ) as HTMLButtonElement | undefined;
      expect(nameInput).not.toBeNull();
      expect(dialog?.textContent).not.toContain('结构化请求 JSON');
      expect(submit?.disabled).toBe(false);

      if (form) await dom.submit(form);
      expect(apiMocks.createValueDefinition).not.toHaveBeenCalled();
      expect(dialog?.textContent).toContain('名称');

      if (nameInput) await dom.change(nameInput, '新增客户价值');
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

  it('registers Evidence through business fields without exposing JSON, UUID or hash inputs', async () => {
    const dom = await renderInTestDom(
      createElement(BusinessSemanticsPage, {
        currentUserId: '00000000-0000-7000-8000-000000000001',
      }),
    );
    try {
      await dom.flush();
      const evidenceTab = [...dom.container.querySelectorAll('[role="tab"]')].find((tab) =>
        tab.textContent?.includes('证据'),
      );
      expect(evidenceTab).toBeDefined();
      if (evidenceTab) await dom.click(evidenceTab);
      await dom.flush();
      await dom.flush();

      const createButton = [...dom.container.querySelectorAll('button')].find(
        (button) => button.textContent?.trim() === '新建证据',
      );
      expect(createButton).toBeDefined();
      if (createButton) await dom.click(createButton);

      const dialog = dom.container.querySelector('[role="dialog"]');
      expect(dialog?.textContent).toContain('技术标识与校验信息由系统生成');
      expect(dialog?.textContent).not.toContain('结构化请求 JSON');
      expect(dialog?.textContent).not.toContain('sourceRecordId');
      expect(dialog?.textContent).not.toContain('contentHash');
      expect(dialog?.querySelector('textarea[aria-label="证据摘要"]')).not.toBeNull();
      expect(dialog?.querySelector('input[aria-label="来源名称"]')).not.toBeNull();
      expect(dialog?.querySelector('select[aria-label="来源类别"]')).not.toBeNull();

      const sourceName = dialog?.querySelector(
        'input[aria-label="来源名称"]',
      ) as HTMLInputElement | null;
      const summary = dialog?.querySelector(
        'textarea[aria-label="证据摘要"]',
      ) as HTMLTextAreaElement | null;
      const form = dialog?.querySelector('form') as HTMLFormElement | null;
      expect(form).not.toBeNull();
      if (sourceName) await dom.change(sourceName, '2026 年客户服务复盘');
      if (summary) {
        await dom.change(summary, '复盘确认客户响应时间缩短，并保留可追溯的原始记录。');
      }
      expect(sourceName?.value).toBe('2026 年客户服务复盘');
      expect(summary?.value).toBe('复盘确认客户响应时间缩短，并保留可追溯的原始记录。');
      if (form) await dom.submit(form);
      await dom.flush();
      await dom.flush();

      expect(dialog?.querySelector('[role="alert"]')?.textContent).toBeUndefined();
      expect(apiMocks.createGuidedEvidence).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceType: 'DOCUMENT',
          sourceName: '2026 年客户服务复盘',
          summary: '复盘确认客户响应时间缩短，并保留可追溯的原始记录。',
          trustLevel: 'UNVERIFIED',
        }),
      );
      const submitted = apiMocks.createGuidedEvidence.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(submitted).not.toHaveProperty('code');
      expect(submitted).not.toHaveProperty('sourceRecordId');
      expect(submitted).not.toHaveProperty('contentHash');
      expect(submitted).not.toHaveProperty('owner');
      expect(submitted).not.toHaveProperty('permissionLabels');
      expect(dom.container.querySelector('[role="dialog"]')).toBeNull();
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
