import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderInTestDom } from '@/test/dom-test-utils';
import { KnowledgeDocumentsPanel } from '@/components/knowledge/KnowledgeDocumentsPanel';

const api = vi.hoisted(() => ({
  getOrganization: vi.fn(),
  listKnowledgeBases: vi.fn(),
  createKnowledgeBase: vi.fn(),
}));

vi.mock('@/api/admin-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/admin-api')>()),
  ...api,
}));

import { KnowledgePage } from './KnowledgePage';

beforeEach(() => {
  for (const mock of Object.values(api)) mock.mockReset();
  api.getOrganization.mockResolvedValue({
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
        status: 'ACTIVE',
        version: 1,
        memberCount: 0,
        source: 'LOCAL',
      },
    ],
    members: [],
  });
  api.listKnowledgeBases.mockResolvedValue({ items: [] });
});

describe('KnowledgePage creation defaults', () => {
  it('prioritizes file upload and hides internal key and initial status from empty-library creation', async () => {
    const dom = await renderInTestDom(createElement(KnowledgePage));
    try {
      await dom.flush();
      await dom.flush();
      const upload = [...dom.container.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('上传资料'),
      );
      expect(upload?.className).toContain('primary');
      expect(dom.container.textContent).toContain('高级');

      const emptyLibrary = [...dom.container.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('新建空库'),
      );
      expect(emptyLibrary).toBeDefined();
      await dom.click(emptyLibrary!);
      expect(dom.container.textContent).toContain('自动生成内部标识');
      expect(dom.container.textContent).not.toContain('唯一标识');
      expect(dom.container.textContent).not.toContain('初始状态');
      expect(dom.container.textContent).toContain('先上传资料并完成解析');
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
          documents: [],
        } as never,
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
      expect(textEntry?.closest('details')).not.toBeNull();
      expect(textEntry?.closest('details')?.hasAttribute('open')).toBe(false);
      expect(dom.container.textContent).toContain('PDF、Word、Excel、TXT 或 Markdown');
      expect(dom.container.textContent).not.toContain('手工录入');
    } finally {
      await dom.cleanup();
    }
  });
});
