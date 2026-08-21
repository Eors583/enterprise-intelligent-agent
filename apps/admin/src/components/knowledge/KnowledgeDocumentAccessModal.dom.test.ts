import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderInTestDom } from '@/test/dom-test-utils';
import { testKnowledgeGovernance } from '@/test/knowledge-fixtures';

const api = vi.hoisted(() => ({ updateKnowledgeDocumentAccess: vi.fn() }));
vi.mock('@/api/admin-api', () => api);

import { KnowledgeDocumentAccessModal } from './KnowledgeDocumentAccessModal';

const knowledgeBaseId = '00000000-0000-7000-8000-000000000601';
const documentId = '00000000-0000-7000-8000-000000000602';
const versionId = '00000000-0000-7000-8000-000000000603';
const orgUnitId = '00000000-0000-7000-8000-000000000604';
const memberId = '00000000-0000-7000-8000-000000000605';

beforeEach(() => {
  api.updateKnowledgeDocumentAccess.mockReset();
  api.updateKnowledgeDocumentAccess.mockResolvedValue({});
});

describe('KnowledgeDocumentAccessModal', () => {
  it('saves a server-enforced document restriction for selected departments and members', async () => {
    const onChanged = vi.fn();
    const dom = await renderInTestDom(
      createElement(KnowledgeDocumentAccessModal, {
        knowledgeBase: {
          id: knowledgeBaseId,
          name: '公司制度库',
          orgUnitScopes: [],
          memberUserIds: [],
        },
        document: { id: documentId, title: '差旅制度' } as never,
        version: {
          id: versionId,
          governance: testKnowledgeGovernance({ revision: 4 }),
        } as never,
        organization: {
          organization: {
            id: '00000000-0000-7000-8000-000000000606',
            name: '示例企业',
            legalName: null,
            timezone: 'Asia/Shanghai',
            version: 1,
          },
          orgUnits: [
            {
              id: orgUnitId,
              organizationId: '00000000-0000-7000-8000-000000000606',
              parentId: null,
              name: '财务部',
              sortOrder: 0,
              status: 'ACTIVE',
              version: 1,
              memberCount: 1,
              source: 'LOCAL',
            },
          ],
          members: [
            {
              id: memberId,
              email: 'member@example.com',
              displayName: '张三',
              status: 'ACTIVE',
              role: 'MEMBER',
              source: 'LOCAL',
              employment: {
                id: '00000000-0000-7000-8000-000000000607',
                organizationId: '00000000-0000-7000-8000-000000000606',
                orgUnitId,
                title: '会计',
                status: 'ACTIVE',
              },
            },
          ],
        },
        onClose: vi.fn(),
        onChanged,
      }),
    );
    try {
      expect(dom.container.textContent).toContain('权限变更');
      expect(dom.container.textContent).toContain('不能扩大知识库权限');
      expect(dom.container.textContent).toContain('这篇文档允许谁使用');
      expect(dom.container.textContent).toContain('继承知识库访问范围');
      expect(dom.container.textContent).not.toContain('全公司成员可访问');
      const restricted = [...dom.container.querySelectorAll('label')].find((label) =>
        label.textContent?.includes('进一步限制到指定部门或成员'),
      )!;
      await dom.click(restricted.querySelector('input')!);
      const department = [...dom.container.querySelectorAll('label')].find(
        (label) => label.textContent?.trim() === '财务部',
      )!;
      await dom.click(department.querySelector('input')!);
      const member = [...dom.container.querySelectorAll('label')].find((label) =>
        label.textContent?.includes('张三'),
      )!;
      await dom.click(member.querySelector('input')!);
      await dom.submit(dom.container.querySelector('form')!);
      await dom.flush();

      expect(api.updateKnowledgeDocumentAccess).toHaveBeenCalledWith(knowledgeBaseId, documentId, {
        mode: 'RESTRICTED',
        orgUnitIds: [orgUnitId],
        memberUserIds: [memberId],
        expectedGovernanceRevision: 4,
      });
      expect(onChanged).toHaveBeenCalledWith('“差旅制度”的访问范围已收紧。');
    } finally {
      await dom.cleanup();
    }
  });
});
