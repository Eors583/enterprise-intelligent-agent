import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderInTestDom } from '@/test/dom-test-utils';

const api = vi.hoisted(() => ({
  getOrganization: vi.fn(),
  getFeishuOrganizationSyncStatus: vi.fn(),
  getFeishuDirectoryPreview: vi.fn(),
  listFeishuDirectorySyncRuns: vi.fn(),
  createOrgUnit: vi.fn(),
}));

vi.mock('@/api/admin-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/admin-api')>()),
  ...api,
}));

import { OrganizationPage } from './OrganizationPage';

const ORGANIZATION = {
  organization: {
    id: '00000000-0000-7000-8000-000000000001',
    name: '示例企业',
    legalName: null,
    timezone: 'Asia/Shanghai',
    version: 1,
  },
  orgUnits: [
    {
      id: '00000000-0000-7000-8000-000000000002',
      organizationId: '00000000-0000-7000-8000-000000000001',
      parentId: null,
      name: '产品部',
      sortOrder: 8,
      status: 'ACTIVE',
      version: 1,
      memberCount: 0,
      source: 'LOCAL',
    },
  ],
  members: [],
} as const;

beforeEach(() => {
  for (const mock of Object.values(api)) mock.mockReset();
  api.getOrganization.mockResolvedValue(ORGANIZATION);
  api.getFeishuOrganizationSyncStatus.mockResolvedValue({
    status: 'NOT_CONFIGURED',
    tenantName: '示例企业',
    lastSuccessfulAt: null,
    run: null,
    connectionSource: null,
    appIdMasked: null,
  });
  api.getFeishuDirectoryPreview.mockResolvedValue(null);
  api.listFeishuDirectorySyncRuns.mockResolvedValue({ items: [] });
});

describe('OrganizationPage business defaults', () => {
  it('auto-orders new departments, uses IANA timezones, and keeps Feishu credentials advanced', async () => {
    const dom = await renderInTestDom(createElement(OrganizationPage));
    try {
      await dom.flush();
      await dom.flush();
      expect(dom.container.textContent).toContain('绑定飞书应用');
      expect(dom.container.querySelector('.feishu-binding-form')).toBeNull();
      expect(dom.container.querySelector('input[type="password"]')).toBeNull();

      const create = [...dom.container.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('新建部门'),
      );
      await dom.click(create!);
      const createDialog = dom.container.querySelector('[role="dialog"]');
      expect(createDialog?.textContent).toContain('自动排在所选上级部门的同级列表末尾');
      expect(createDialog?.textContent).not.toContain('排序值');

      const close = [...dom.container.querySelectorAll('button')].find(
        (button) => button.textContent?.trim() === '取消',
      );
      await dom.click(close!);
      const edit = [...dom.container.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('编辑组织信息'),
      );
      await dom.click(edit!);
      const timezone = [...dom.container.querySelectorAll('select')].find((select) =>
        [...select.options].some((option) => option.value === 'Asia/Shanghai'),
      );
      expect(timezone?.value).toBe('Asia/Shanghai');
      expect(dom.container.textContent).toContain('标准 IANA 时区');
    } finally {
      await dom.cleanup();
    }
  });
});
