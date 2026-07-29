import type { BrowserAuthSessionResponse } from '@enterprise/contracts';
import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderInTestDom } from '@/test/dom-test-utils';

vi.mock('@/api/admin-api', () => ({ logout: vi.fn() }));
vi.mock('@/features/auth/ChangePasswordModal', () => ({
  ChangePasswordModal: () => null,
}));
vi.mock('@/features/agents/AgentsPage', () => ({ AgentsPage: () => null }));
vi.mock('@/features/knowledge/KnowledgePage', () => ({ KnowledgePage: () => null }));
vi.mock('@/features/members/MembersPage', () => ({ MembersPage: () => null }));
vi.mock('@/features/organization/OrganizationPage', () => ({
  OrganizationPage: () => null,
}));
vi.mock('@/features/role-assignments/RoleAssignmentsPage', () => ({
  RoleAssignmentsPage: () => null,
}));
vi.mock('@/features/role-blueprints/RoleBlueprintsPage', () => ({
  RoleBlueprintsPage: () => null,
}));
vi.mock('@/features/business-semantics/BusinessSemanticsPage', async () => {
  const { createElement: createMockElement } = await import('react');
  return {
    BusinessSemanticsPage: ({ currentUserId }: { currentUserId: string }) =>
      createMockElement(
        'section',
        { 'data-testid': 'business-semantics-page', 'data-current-user': currentUserId },
        '经营主链工作区',
      ),
  };
});
vi.mock('@/features/runtime-governance/RuntimeGovernancePage', async () => {
  const { createElement: createMockElement } = await import('react');
  return {
    RuntimeGovernancePage: () =>
      createMockElement('section', { 'data-testid': 'runtime-governance-page' }, '运行治理工作区'),
  };
});
vi.mock('@/features/ai-evaluation/AiEvaluationPage', async () => {
  const { createElement: createMockElement } = await import('react');
  return {
    AiEvaluationPage: () =>
      createMockElement('section', { 'data-testid': 'ai-evaluation-page' }, 'AI 评测工作区'),
  };
});

import { AdminShell } from './AdminShell';

const SESSION: BrowserAuthSessionResponse = {
  account: {
    sessionId: 'd9428888-122b-4b7f-82cd-34e3f4f622b1',
    tenantId: 'b39eb6b8-d537-4e83-b096-25375c4c6f51',
    tenantSlug: 'future-work',
    tenantName: '未来协作',
    userId: '83ceae87-554e-451d-b411-c336f1d02bf9',
    email: 'admin@example.com',
    displayName: '管理员',
    role: 'ADMIN',
    passwordChangeRequired: false,
    accessExpiresAt: '2026-07-28T10:00:00.000Z',
    refreshExpiresAt: '2026-08-04T10:00:00.000Z',
  },
};

describe('admin business-semantics navigation', () => {
  it('exposes the management entry and switches to the real page slot accessibly', async () => {
    const dom = await renderInTestDom(createElement(AdminShell, { session: SESSION }));
    try {
      const navigation = dom.container.querySelector('nav');
      const entry = [...(navigation?.querySelectorAll('button') ?? [])].find((button) =>
        button.textContent?.includes('经营主链'),
      );

      expect(entry).not.toBeUndefined();
      expect(entry?.getAttribute('aria-current')).toBeNull();
      if (entry) await dom.click(entry);

      expect(entry?.getAttribute('aria-current')).toBe('page');
      const page = dom.container.querySelector('[data-testid="business-semantics-page"]');
      expect(page?.textContent).toContain('经营主链工作区');
      expect(page?.getAttribute('data-current-user')).toBe(SESSION.account.userId);
    } finally {
      await dom.cleanup();
    }
  });

  it('exposes the process, event, and DLQ governance entry', async () => {
    const dom = await renderInTestDom(createElement(AdminShell, { session: SESSION }));
    try {
      const entry = [...dom.container.querySelectorAll('nav button')].find((button) =>
        button.textContent?.includes('运行治理'),
      );
      expect(entry).not.toBeUndefined();
      expect(entry?.textContent).toContain('流程、事件与 DLQ');

      if (entry) await dom.click(entry);

      expect(entry?.getAttribute('aria-current')).toBe('page');
      expect(
        dom.container.querySelector('[data-testid="runtime-governance-page"]')?.textContent,
      ).toBe('运行治理工作区');
    } finally {
      await dom.cleanup();
    }
  });

  it('exposes the governed AI evaluation entry and page slot', async () => {
    const dom = await renderInTestDom(createElement(AdminShell, { session: SESSION }));
    try {
      const entry = [...dom.container.querySelectorAll('nav button')].find((button) =>
        button.textContent?.includes('AI 评测'),
      );
      expect(entry).not.toBeUndefined();
      expect(entry?.textContent).toContain('数据集、Run 与发布门禁');
      if (entry) await dom.click(entry);
      expect(entry?.getAttribute('aria-current')).toBe('page');
      expect(dom.container.querySelector('[data-testid="ai-evaluation-page"]')?.textContent).toBe(
        'AI 评测工作区',
      );
    } finally {
      await dom.cleanup();
    }
  });
});
