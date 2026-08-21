import type { RoleAssignment } from '@enterprise/contracts';
import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderInTestDom } from '../../test/dom-test-utils';
import { RoleSidebar, RoleWorkspace } from './RoleWorkspace';
import { roleAssignmentFixture } from './test-fixtures';

describe('employee role workspace DOM acceptance', () => {
  it('renders the null-snapshot legacy warning without substituting structured details', async () => {
    const legacyAssignment: RoleAssignment = {
      ...roleAssignmentFixture(),
      roleDefinitionSnapshot: null,
    };
    const onOpenAgent = vi.fn();
    const dom = await renderInTestDom(
      createElement(RoleWorkspace, {
        assignment: legacyAssignment,
        isLoading: false,
        operation: null,
        onOpenAgent,
        onRetryAgent: vi.fn(),
      }),
    );

    try {
      const note = dom.container.querySelector('[role="note"]');
      expect(note?.querySelector('h2')?.textContent).toBe('历史版本未结构化');
      expect(note?.textContent).toContain('不会读取当前模板补全内容');
      expect(dom.container.textContent).not.toContain('职责与成果');
      expect(dom.container.textContent).not.toContain('销售管道管理');

      const openButton = [...dom.container.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('进入角色 Agent'),
      ) as HTMLButtonElement | undefined;
      expect(openButton?.disabled).toBe(false);
      expect(openButton?.getAttribute('type')).toBe('button');
      if (openButton) await dom.click(openButton);
      expect(onOpenAgent).toHaveBeenCalledWith(legacyAssignment);
    } finally {
      await dom.cleanup();
    }
  });

  it('keeps loading, empty, error, and unavailable states perceivable and disabled', async () => {
    const loadingDom = await renderInTestDom(
      createElement(RoleSidebar, {
        assignments: undefined,
        selectedAssignmentId: null,
        isLoading: true,
        isError: false,
        error: null,
        onSelect: vi.fn(),
        onRetry: vi.fn(),
      }),
    );
    try {
      expect(loadingDom.container.querySelector('aside[aria-label="我的角色"]')).not.toBeNull();
      expect(loadingDom.container.querySelector('[role="status"]')?.textContent).toContain(
        '正在读取角色任命',
      );
      const refresh = [...loadingDom.container.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('刷新中'),
      ) as HTMLButtonElement | undefined;
      expect(refresh?.disabled).toBe(true);
    } finally {
      await loadingDom.cleanup();
    }

    const emptyDom = await renderInTestDom(
      createElement(RoleWorkspace, {
        assignment: null,
        isLoading: false,
        operation: null,
        onOpenAgent: vi.fn(),
        onRetryAgent: vi.fn(),
      }),
    );
    try {
      expect(emptyDom.container.querySelector('h1')?.textContent).toBe('暂无角色任命');
      expect(emptyDom.container.querySelector('button')).toBeNull();
    } finally {
      await emptyDom.cleanup();
    }

    const pendingOffline: RoleAssignment = {
      ...roleAssignmentFixture(),
      status: 'PENDING',
      effectiveFrom: '2026-08-01T00:00:00.000Z',
      agent: { ...roleAssignmentFixture().agent, status: 'OFFLINE' },
    };
    const unavailableDom = await renderInTestDom(
      createElement(RoleWorkspace, {
        assignment: pendingOffline,
        isLoading: false,
        operation: null,
        onOpenAgent: vi.fn(),
        onRetryAgent: vi.fn(),
      }),
    );
    try {
      const openButton = [...unavailableDom.container.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('进入角色 Agent'),
      ) as HTMLButtonElement | undefined;
      expect(openButton?.disabled).toBe(true);
      expect(openButton?.title).toContain('任命待生效');
    } finally {
      await unavailableDom.cleanup();
    }
  });

  it('exposes sidebar errors and selection through semantic buttons', async () => {
    const assignment = roleAssignmentFixture();
    const onRetry = vi.fn();
    const onSelect = vi.fn();
    const dom = await renderInTestDom(
      createElement(RoleSidebar, {
        assignments: [assignment],
        selectedAssignmentId: assignment.id,
        isLoading: false,
        isError: true,
        error: new Error('network unavailable'),
        onSelect,
        onRetry,
      }),
    );

    try {
      const alert = dom.container.querySelector('[role="alert"]');
      expect(alert?.textContent).toContain('角色列表刷新失败');
      expect(alert?.textContent).toContain('network unavailable');
      const refresh = [...dom.container.querySelectorAll('button')].find(
        (button) => button.textContent?.trim() === '刷新',
      );
      if (refresh) await dom.click(refresh);
      expect(onRetry).toHaveBeenCalledTimes(1);

      const assignmentButton = dom.container.querySelector(
        `button[aria-current="true"]`,
      ) as HTMLButtonElement | null;
      expect(assignmentButton?.textContent).toContain('销售负责人');
      if (assignmentButton) await dom.click(assignmentButton);
      expect(onSelect).toHaveBeenCalledWith(assignment.id);
    } finally {
      await dom.cleanup();
    }
  });
});
