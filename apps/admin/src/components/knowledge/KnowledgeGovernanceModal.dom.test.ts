import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderInTestDom } from '@/test/dom-test-utils';
import { testKnowledgeGovernance } from '@/test/knowledge-fixtures';

const adminApiMocks = vi.hoisted(() => ({
  getOrganization: vi.fn(),
  listRoleBlueprints: vi.fn(),
  updateKnowledgeDocumentVersionGovernance: vi.fn(),
  reviewKnowledgeDocumentGovernance: vi.fn(),
}));
const listTasksMock = vi.hoisted(() => vi.fn());

vi.mock('@/api/admin-api', () => adminApiMocks);
vi.mock('@/features/business-semantics/api', () => ({ listTasks: listTasksMock }));

import { KnowledgeGovernanceModal } from './KnowledgeGovernanceModal';

const VERSION_ID = '00000000-0000-7000-8000-000000000011';
const OWNER_ID = '00000000-0000-7000-8000-000000000012';
const UNIT_ID = '00000000-0000-7000-8000-000000000013';
const TASK_ID = '00000000-0000-7000-8000-000000000014';
const ROLE_ID = '00000000-0000-7000-8000-000000000015';
const PREVIOUS_VERSION_ID = '00000000-0000-7000-8000-000000000016';

beforeEach(() => {
  for (const mock of Object.values(adminApiMocks)) mock.mockReset();
  listTasksMock.mockReset();
  adminApiMocks.getOrganization.mockResolvedValue({
    organization: {},
    members: [
      {
        id: OWNER_ID,
        displayName: '知识负责人',
        email: 'owner@example.com',
        status: 'ACTIVE',
      },
    ],
    orgUnits: [{ id: UNIT_ID, name: '产品研发中心', status: 'ACTIVE' }],
  });
  adminApiMocks.listRoleBlueprints.mockResolvedValue({
    items: [{ id: ROLE_ID, name: '产品专家', key: 'product.expert', revision: 3 }],
  });
  listTasksMock.mockResolvedValue([
    { id: TASK_ID, title: '发布产品手册', code: 'TASK.MANUAL', status: 'IN_PROGRESS' },
  ]);
});

describe('KnowledgeGovernanceModal entity selection', () => {
  it('uses catalog-backed selectors while keeping project ids in an advanced fallback', async () => {
    const version = {
      id: VERSION_ID,
      versionNumber: 2,
      status: 'READY',
      publishedAt: null,
      governance: testKnowledgeGovernance({
        ownerUserId: OWNER_ID,
        scopeMode: 'RESTRICTED',
        organizationScopeIds: [UNIT_ID],
        taskScopeIds: [TASK_ID],
        roleTemplateScopeIds: [ROLE_ID],
        dataLabels: ['CLASSIFICATION:INTERNAL'],
        reviewStatus: 'APPROVED',
      }),
    };
    const document = {
      id: '00000000-0000-7000-8000-000000000017',
      title: '产品手册',
      versions: [
        version,
        {
          id: PREVIOUS_VERSION_ID,
          versionNumber: 1,
          status: 'ARCHIVED',
          publishedAt: '2026-07-01T00:00:00.000Z',
        },
      ],
    };
    const dom = await renderInTestDom(
      createElement(KnowledgeGovernanceModal, {
        knowledgeBaseId: '00000000-0000-7000-8000-000000000018',
        document: document as never,
        version: version as never,
        onClose: vi.fn(),
        onChanged: vi.fn(),
      }),
    );
    try {
      await dom.flush();
      await dom.flush();
      expect(dom.container.textContent).toContain('知识归属账号');
      expect(
        [...dom.container.querySelectorAll('input')].some(
          (input) => input.value === '当前登录账号' && input.disabled,
        ),
      ).toBe(true);
      expect(dom.container.textContent).not.toContain('知识负责人');
      expect(dom.container.textContent).toContain('产品研发中心');
      expect(dom.container.textContent).toContain('发布产品手册');
      expect(dom.container.textContent).toContain('产品专家');
      expect(dom.container.textContent).toContain('v1 · ARCHIVED');
      expect(dom.container.textContent).toContain('CLASSIFICATION:INTERNAL');
      expect(dom.container.textContent).not.toContain('项目范围 ID');
      expect(dom.container.textContent).not.toContain('数据所有者用户 ID');
      expect(dom.container.textContent).not.toContain('组织 / 部门 ID（每行一个）');
      expect(dom.container.textContent).not.toContain('任务 ID（每行一个）');
      expect(dom.container.textContent).not.toContain('角色模板 ID（每行一个）');
      expect(dom.container.textContent).not.toContain('替代版本 ID（可选）');
    } finally {
      await dom.cleanup();
    }
  });
});
