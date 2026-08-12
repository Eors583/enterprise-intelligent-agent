import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderInTestDom } from '@/test/dom-test-utils';
import { KnowledgeDocumentsPanel } from '@/components/knowledge/KnowledgeDocumentsPanel';

const api = vi.hoisted(() => ({
  getOrganization: vi.fn(),
  listKnowledgeBases: vi.fn(),
  createKnowledgeBase: vi.fn(),
  listKnowledgeSourceConnectors: vi.fn(),
}));

const organizationFixture = {
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
      sortOrder: 0,
      status: 'ACTIVE' as const,
      version: 1,
      memberCount: 0,
      source: 'LOCAL' as const,
    },
  ],
  members: [],
};

vi.mock('@/api/admin-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/admin-api')>()),
  ...api,
}));

import { KnowledgePage } from './KnowledgePage';

beforeEach(() => {
  for (const mock of Object.values(api)) mock.mockReset();
  api.getOrganization.mockResolvedValue(organizationFixture);
  api.listKnowledgeBases.mockResolvedValue({ items: [] });
  api.listKnowledgeSourceConnectors.mockResolvedValue({ items: [] });
});

describe('KnowledgePage creation defaults', () => {
  it('prioritizes file upload and hides internal key and initial status from empty-library creation', async () => {
    const dom = await renderInTestDom(
      createElement(KnowledgePage, {
        currentUserId: '00000000-0000-7000-8000-000000000003',
        currentUserName: '当前管理员',
      }),
    );
    try {
      await dom.flush();
      await dom.flush();
      const upload = [...dom.container.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('上传资料'),
      );
      expect(upload?.className).toContain('primary');
      expect(dom.container.querySelector('.page-action-advanced')).toBeNull();
      expect(dom.container.textContent).toContain('公司知识');
      expect(dom.container.textContent).toContain('部门知识');
      expect(dom.container.textContent).toContain('项目知识');
      expect(dom.container.textContent).toContain('成员知识');

      const emptyLibrary = [...dom.container.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('新建空库'),
      );
      expect(emptyLibrary).toBeDefined();
      await dom.click(emptyLibrary!);
      expect(dom.container.textContent).toContain('自动生成内部标识');
      expect(dom.container.textContent).not.toContain('唯一标识');
      expect(dom.container.textContent).not.toContain('初始状态');
      expect(dom.container.textContent).toContain('系统完成解析、切片和索引后');
      expect(dom.container.textContent).toContain('自动对员工可用');
      expect(dom.container.textContent).toContain('知识归属账号固定为当前登录账号');
      expect(dom.container.textContent).toContain('知识存放位置');
      expect(dom.container.textContent).not.toContain('所属成员');
      const memberSpace = [...dom.container.querySelectorAll('label')].find((label) =>
        label.textContent?.includes('成员知识'),
      );
      expect(memberSpace).toBeDefined();
      await dom.click(memberSpace!.querySelector('input')!);
      expect(dom.container.textContent).toContain('成员知识归入当前登录账号：当前管理员');
      expect(dom.container.textContent).not.toContain('暂无可选成员');
    } finally {
      await dom.cleanup();
    }
  });

  it('keeps file upload as the primary document action and text as a secondary source', async () => {
    const dom = await renderInTestDom(
      createElement(KnowledgeDocumentsPanel, {
        item: {
          id: '00000000-0000-7000-8000-000000000010',
          name: '员工制度库',
          status: 'DRAFT',
          version: 1,
          orgUnitScopes: [],
          memberUserIds: [],
          documents: [],
        } as never,
        organization: organizationFixture as never,
        organizationReady: true,
        onCreateDocument: vi.fn(),
        onEditDocument: vi.fn(),
        onChanged: vi.fn(),
      }),
    );
    try {
      const upload = [...dom.container.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('上传文件'),
      );
      const textEntry = [...dom.container.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('粘贴文本'),
      );
      expect(upload?.className).toContain('primary');
      expect(textEntry).toBeDefined();
      expect(textEntry?.closest('details')).toBeNull();
      expect(dom.container.textContent).not.toContain('更多录入方式');
      expect(dom.container.textContent).toContain('PDF、Word、Excel、TXT 或 Markdown');
      expect(dom.container.textContent).not.toContain('手工录入');

      await dom.click(upload!);
      await dom.flush();
      const uploadDialog = dom.container.querySelector('[role="dialog"]');
      expect(uploadDialog?.textContent).toContain('谁可以让智能体使用这些知识');
      expect(uploadDialog?.textContent).toContain('全公司成员可访问');
      expect(uploadDialog?.textContent).toContain('仅指定部门或成员可访问');
      expect(uploadDialog?.textContent).not.toContain('新文件和新版本都会继承');

      const closeUpload = [...(uploadDialog?.querySelectorAll('button') ?? [])].find(
        (button) => button.textContent?.trim() === '取消',
      );
      await dom.click(closeUpload!);

      const otherSources = [...dom.container.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('其他来源接入'),
      );
      expect(otherSources).toBeDefined();
      expect(dom.container.textContent).not.toContain('企业网盘与文档源');
      await dom.click(otherSources!);
      await dom.flush();
      expect(dom.container.querySelector('[role="dialog"]')?.textContent).toContain('其他来源接入');
      expect(dom.container.querySelector('[role="dialog"]')?.textContent).toContain(
        '企业网盘与文档源',
      );
    } finally {
      await dom.cleanup();
    }
  });
});
