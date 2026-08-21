import type { AdminMember, RoleAssignmentCandidate } from '@enterprise/contracts';
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderInTestDom } from '@/test/dom-test-utils';

const apiMocks = vi.hoisted(() => ({
  createRoleAssignment: vi.fn(),
  getOrganization: vi.fn(),
  listAgents: vi.fn(),
  listRoleAssignmentCandidates: vi.fn(),
  listRoleAssignments: vi.fn(),
  revokeRoleAssignment: vi.fn(),
}));

vi.mock('@/api/admin-api', () => apiMocks);

import { RoleAssignmentsPage } from './RoleAssignmentsPage';

const MEMBER = {
  id: '00000000-0000-7000-8000-000000000201',
  email: 'lin@example.com',
  displayName: '林晓',
  status: 'ACTIVE',
  role: 'MEMBER',
  source: 'LOCAL',
  employment: {
    id: '00000000-0000-7000-8000-000000000203',
    organizationId: '00000000-0000-7000-8000-000000000204',
    orgUnitId: '00000000-0000-7000-8000-000000000205',
    title: '产品经理',
    status: 'ACTIVE',
  },
} satisfies AdminMember;

const CANDIDATE = {
  id: '00000000-0000-7000-8000-000000000301',
  version: 4,
  blueprintRevision: 7,
  blueprint: {
    id: '00000000-0000-7000-8000-000000000302',
    key: 'project.reviewer',
    name: '项目评审负责人',
  },
  roleDefinitionSnapshot: {
    mission: '确保项目方案质量和边界清晰。',
    responsibilities: [
      {
        key: 'proposal-review',
        name: '方案评审',
        description: '评审项目方案。',
        outcomes: ['风险可控'],
      },
    ],
    valueDefinition: {
      statement: '提高项目决策质量。',
      stakeholderOutcomes: ['项目团队获得明确决策'],
      measures: ['评审周期'],
    },
    capabilities: [],
    processes: [],
    tools: [],
    knowledgeDomains: [],
  },
} satisfies RoleAssignmentCandidate;

describe('RoleAssignmentsPage DOM acceptance', () => {
  beforeEach(() => {
    apiMocks.createRoleAssignment.mockReset();
    apiMocks.getOrganization.mockReset().mockResolvedValue({ members: [MEMBER] });
    apiMocks.listAgents.mockReset();
    apiMocks.listRoleAssignmentCandidates.mockReset().mockResolvedValue({ items: [CANDIDATE] });
    apiMocks.listRoleAssignments.mockReset().mockResolvedValue({ items: [] });
    apiMocks.revokeRoleAssignment.mockReset();
  });

  it('opens a keyboard-dismissible, labeled picker populated only by the governed endpoint', async () => {
    const dom = await renderInTestDom(createElement(RoleAssignmentsPage));

    try {
      await dom.flush();
      expect(apiMocks.listRoleAssignmentCandidates).toHaveBeenCalledTimes(1);
      expect(apiMocks.listAgents).not.toHaveBeenCalled();

      const createButton = [...dom.container.querySelectorAll('button')].find(
        (button) => button.textContent?.trim() === '新建任命',
      ) as HTMLButtonElement | undefined;
      expect(createButton).toBeDefined();
      if (!createButton) return;
      expect(createButton.disabled).toBe(false);
      expect(createButton.getAttribute('aria-haspopup')).toBe('dialog');

      await dom.click(createButton);

      const dialog = dom.container.querySelector('[role="dialog"]') as HTMLElement | null;
      expect(dialog).not.toBeNull();
      if (!dialog) return;
      const titleId = dialog.getAttribute('aria-labelledby');
      expect(titleId ? dom.document.getElementById(titleId)?.textContent : null).toBe(
        '新建角色任命',
      );
      const candidateLabel = [...dialog.querySelectorAll('label')].find((label) =>
        label.textContent?.includes('角色蓝图版本'),
      );
      const candidateSelect = candidateLabel?.querySelector('select') as HTMLSelectElement | null;
      expect(candidateSelect).not.toBeNull();
      if (!candidateSelect) return;
      expect(candidateSelect.hasAttribute('required')).toBe(true);
      expect(candidateSelect.value).toBe(CANDIDATE.id);
      expect([...candidateSelect.options].map((option) => option.textContent)).toEqual([
        '项目评审负责人 · v4',
      ]);
      expect(dialog.textContent).not.toContain('Legacy Personal Agent');

      await dom.keydown(dialog, 'Escape');
      expect(dom.container.querySelector('[role="dialog"]')).toBeNull();
    } finally {
      await dom.cleanup();
    }
  });

  it('announces loading and keeps mutation controls disabled until governed data arrives', async () => {
    const pending = new Promise<never>(() => undefined);
    apiMocks.getOrganization.mockReturnValue(pending);
    apiMocks.listRoleAssignmentCandidates.mockReturnValue(pending);
    apiMocks.listRoleAssignments.mockReturnValue(pending);
    const dom = await renderInTestDom(createElement(RoleAssignmentsPage));

    try {
      expect(dom.container.querySelector('[role="status"]')?.textContent).toContain(
        '正在读取角色任命',
      );
      const buttons = [...dom.container.querySelectorAll('button')];
      expect(
        buttons.find((button) => button.textContent?.includes('刷新'))?.hasAttribute('disabled'),
      ).toBe(true);
      expect(
        buttons
          .find((button) => button.textContent?.includes('新建任命'))
          ?.hasAttribute('disabled'),
      ).toBe(true);
    } finally {
      await dom.cleanup();
    }
  });

  it('exposes empty and error states with labeled filters and a keyboard-operable retry', async () => {
    apiMocks.listRoleAssignmentCandidates.mockResolvedValue({ items: [] });
    const emptyDom = await renderInTestDom(createElement(RoleAssignmentsPage));

    try {
      await emptyDom.flush();
      expect(emptyDom.container.querySelector('[role="status"]')?.textContent).toContain(
        '当前没有可任命的角色蓝图版本',
      );
      const createButton = [...emptyDom.container.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('新建任命'),
      ) as HTMLButtonElement | undefined;
      expect(createButton?.disabled).toBe(true);
      expect(createButton?.title).toContain('已通过审核并发布');
      expect(emptyDom.container.textContent).toContain('还没有角色任命');
      expect(emptyDom.container.querySelector('input[aria-label="搜索角色任命"]')).not.toBeNull();
      expect(
        emptyDom.container.querySelector('select[aria-label="按任命状态筛选"]'),
      ).not.toBeNull();
    } finally {
      await emptyDom.cleanup();
    }

    apiMocks.listRoleAssignmentCandidates.mockRejectedValue(new Error('candidate unavailable'));
    const errorDom = await renderInTestDom(createElement(RoleAssignmentsPage));
    try {
      await errorDom.flush();
      const alert = errorDom.container.querySelector('[role="alert"]');
      expect(alert?.textContent).toContain('数据加载失败');
      expect(alert?.textContent).toContain('candidate unavailable');
      const retry = [...errorDom.container.querySelectorAll('button')].find(
        (button) => button.textContent?.trim() === '重新加载',
      );
      expect(retry?.getAttribute('type')).toBe('button');
      const callsBeforeRetry = apiMocks.listRoleAssignmentCandidates.mock.calls.length;
      if (retry) await errorDom.click(retry);
      expect(apiMocks.listRoleAssignmentCandidates).toHaveBeenCalledTimes(callsBeforeRetry + 1);
    } finally {
      await errorDom.cleanup();
    }
  });
});
