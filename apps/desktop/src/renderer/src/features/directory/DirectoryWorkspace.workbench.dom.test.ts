import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderInTestDom } from '../../test/dom-test-utils';
import { objectiveFixture, taskFixture } from '../workbench/test-fixtures';
import type { BootstrapPayload } from './bootstrap';

const hookSpies = vi.hoisted(() => ({
  objectives: vi.fn(),
  tasks: vi.fn(),
}));

vi.mock('../messaging/agent-collaboration', () => ({
  listAgentCollaborationCandidates: () => [],
}));
vi.mock('../messaging/hooks', () => ({
  useConversations: () => ({
    data: [],
    isPending: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  }),
  useCreateDirectConversation: () => ({
    isPending: false,
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
  }),
}));
vi.mock('../messaging/MessagingWorkspace', async () => {
  const { createElement: createMockElement } = await import('react');
  return {
    ConversationWorkspace: () => null,
    MessagingSidebar: () => createMockElement('aside', { 'data-testid': 'messaging-sidebar' }),
  };
});
vi.mock('../roles/hooks', () => ({
  useMyRoleAssignments: () => ({
    data: [],
    isPending: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  }),
}));
vi.mock('../roles/role-assignment-view', () => ({
  defaultRoleAssignmentId: () => null,
  roleAgentAvailability: () => ({ available: false }),
}));
vi.mock('../roles/RoleWorkspace', () => ({
  RoleSidebar: () => null,
  RoleWorkspace: () => null,
}));
vi.mock('../workbench/hooks', () => ({
  useWorkbenchObjectives: (enabled: boolean) => {
    hookSpies.objectives(enabled);
    return {
      data: [objectiveFixture()],
      isPending: false,
      isError: false,
      error: null,
      isFetching: false,
      refetch: vi.fn(),
    };
  },
  useWorkbenchTasks: (enabled: boolean) => {
    hookSpies.tasks(enabled);
    return {
      data: [taskFixture()],
      isPending: false,
      isError: false,
      error: null,
      isFetching: false,
      refetch: vi.fn(),
    };
  },
}));
vi.mock('../workbench/WorkbenchWorkspace', async () => {
  const { createElement: createMockElement } = await import('react');
  return {
    WorkbenchSidebar: ({
      selectedObjectiveId,
      selectedTaskId,
    }: {
      selectedObjectiveId: string | null;
      selectedTaskId: string | null;
    }) =>
      createMockElement('aside', {
        'data-testid': 'workbench-sidebar',
        'data-objective-id': selectedObjectiveId,
        'data-task-id': selectedTaskId,
      }),
    WorkbenchTaskWorkspace: ({ task }: { task: { id: string } | null }) =>
      createMockElement(
        'article',
        { 'data-testid': 'workbench-workspace', 'data-task-id': task?.id },
        '目标与任务工作区',
      ),
  };
});
vi.mock('../experience-usage/ExperienceUsageWorkspace', async () => {
  const { createElement: createMockElement } = await import('react');
  return {
    ExperienceUsageWorkspace: ({ tasks }: { tasks: readonly { id: string }[] }) =>
      createMockElement(
        'article',
        {
          'data-testid': 'experience-usage-workspace',
          'data-task-count': tasks.length,
        },
        '经验与 AI 用量工作区',
      ),
  };
});

import { DirectoryWorkspace } from './DirectoryWorkspace';

const PAYLOAD: BootstrapPayload = {
  tenant: { id: 'tenant-1', name: '未来协作' },
  currentUser: { id: 'member-current', name: '当前用户', title: '产品经理' },
  navigation: [
    { id: 'home', label: '首页' },
    { id: 'directory', label: '通讯录' },
    { id: 'agents', label: '智能体' },
    { id: 'workbench', label: '目标与任务' },
    { id: 'experience-usage', label: '经验与用量' },
  ],
  departments: [{ id: 'department-1', name: '产品部', parentId: null, memberCount: 1 }],
  members: [
    {
      id: 'member-1',
      name: '林晓',
      title: '产品负责人',
      departmentIds: ['department-1'],
      status: 'active',
      agent: {
        id: 'agent-1',
        name: '产品决策智能体',
        status: 'online',
        summary: '协助完成产品决策',
        operationalAvailability: {
          status: 'AVAILABLE',
          evidenceStatus: 'VERIFIED',
          reasonCodes: [],
          checkedAt: '2026-07-28T01:00:00.000Z',
        },
      },
      capabilities: {
        canContactHuman: true,
        canContactAgent: true,
      },
    },
  ],
};

describe('desktop workbench navigation integration', () => {
  it('activates the authorized workbench entry without claiming an online state', async () => {
    const dom = await renderInTestDom(createElement(DirectoryWorkspace, { payload: PAYLOAD }));
    try {
      const entry = [...dom.container.querySelectorAll('.rail-navigation button')].find(
        (button) => button.getAttribute('aria-label') === '目标与任务',
      );
      expect(entry).not.toBeUndefined();
      expect(entry?.getAttribute('aria-current')).toBeNull();
      expect(hookSpies.objectives).toHaveBeenCalledWith(false);
      expect(hookSpies.tasks).toHaveBeenCalledWith(false);
      expect(dom.container.querySelector('[aria-label="当前账号"]')?.textContent).toBe('我');

      if (entry) await dom.click(entry);
      await dom.flush();

      expect(entry?.getAttribute('aria-current')).toBe('page');
      expect(hookSpies.objectives).toHaveBeenLastCalledWith(true);
      expect(hookSpies.tasks).toHaveBeenLastCalledWith(true);
      expect(dom.container.querySelector('.workspace.workbench-active')).not.toBeNull();
      expect(dom.container.querySelector('[data-testid="workbench-sidebar"]')).not.toBeNull();
      expect(dom.container.querySelector('[data-testid="workbench-workspace"]')?.textContent).toBe(
        '目标与任务工作区',
      );
      expect(
        dom.container.querySelector('[data-testid="workbench-workspace"]')?.textContent,
      ).not.toContain('在线');
      expect(dom.container.querySelector('.assistant-launcher')).toBeNull();
    } finally {
      await dom.cleanup();
    }
  });

  it('renders real home and agent-center workspaces and exposes the unified search control', async () => {
    const dom = await renderInTestDom(createElement(DirectoryWorkspace, { payload: PAYLOAD }));
    try {
      const homeEntry = [...dom.container.querySelectorAll('.rail-navigation button')].find(
        (button) => button.getAttribute('aria-label') === '首页',
      );
      const agentEntry = [...dom.container.querySelectorAll('.rail-navigation button')].find(
        (button) => button.getAttribute('aria-label') === '智能体',
      );
      expect(homeEntry).not.toBeUndefined();
      expect(agentEntry).not.toBeUndefined();

      if (homeEntry) await dom.click(homeEntry);
      await dom.flush();
      expect(dom.container.querySelector('.home-workspace')).not.toBeNull();
      expect(dom.container.textContent).toContain('欢迎回来');
      expect(dom.container.textContent).not.toContain('该模块尚未接入');

      const search = dom.container.querySelector<HTMLInputElement>(
        '.desktop-search-dock input[aria-label="统一搜索"]',
      );
      expect(search).not.toBeNull();
      if (search) {
        await dom.focus(search);
        await dom.change(search, '林晓');
      }
      expect(dom.container.querySelector('[role="listbox"]')?.textContent).toContain('林晓');
      expect(dom.container.querySelector('[role="listbox"]')?.textContent).toContain(
        '产品决策智能体',
      );

      if (agentEntry) await dom.click(agentEntry);
      await dom.flush();
      expect(dom.container.querySelector('.agent-center-workspace')).not.toBeNull();
      expect(dom.container.textContent).toContain('智能体中心');
      expect(dom.container.textContent).not.toContain('该模块尚未接入');
    } finally {
      await dom.cleanup();
    }
  });

  it('shows model evidence honestly and disables contact when an online configuration is not ready', async () => {
    const payload: BootstrapPayload = structuredClone(PAYLOAD);
    payload.members[0]!.capabilities.canContactAgent = true;
    payload.members[0]!.agent!.operationalAvailability = {
      status: 'NOT_READY',
      evidenceStatus: 'INSUFFICIENT_EVIDENCE',
      reasonCodes: ['NO_RECENT_SUCCESSFUL_PROVIDER_EVIDENCE'],
      checkedAt: '2026-07-28T01:00:00.000Z',
    };
    const dom = await renderInTestDom(createElement(DirectoryWorkspace, { payload }));
    try {
      const directoryEntry = [...dom.container.querySelectorAll('.rail-navigation button')].find(
        (button) => button.getAttribute('aria-label') === '通讯录',
      );
      if (directoryEntry) await dom.click(directoryEntry);
      await dom.flush();

      const contactAgent = dom.container.querySelector<HTMLButtonElement>(
        '.contact-actions .primary-button',
      );
      expect(contactAgent?.disabled).toBe(true);
      expect(dom.container.querySelector('.agent-operational-status')?.textContent).toContain(
        '配置已启用，但模型未就绪',
      );
      expect(dom.container.querySelector('.agent-operational-status')?.textContent).toContain(
        '缺少近期真实成功调用凭据',
      );
    } finally {
      await dom.cleanup();
    }
  });

  it('integrates the employee experience and trusted usage feature into authorized navigation', async () => {
    const dom = await renderInTestDom(createElement(DirectoryWorkspace, { payload: PAYLOAD }));
    try {
      const entry = [...dom.container.querySelectorAll('.rail-navigation button')].find(
        (button) => button.getAttribute('aria-label') === '经验与用量',
      );
      expect(entry).not.toBeUndefined();

      if (entry) await dom.click(entry);
      await dom.flush();

      expect(entry?.getAttribute('aria-current')).toBe('page');
      expect(hookSpies.tasks).toHaveBeenLastCalledWith(true);
      expect(dom.container.querySelector('.workspace.experience-usage-active')).not.toBeNull();
      expect(
        dom.container.querySelector('[data-testid="experience-usage-workspace"]')?.textContent,
      ).toBe('经验与 AI 用量工作区');
      expect(
        dom.container
          .querySelector('[data-testid="experience-usage-workspace"]')
          ?.getAttribute('data-task-count'),
      ).toBe('1');
      expect(dom.container.querySelector('.assistant-launcher')).toBeNull();
      expect(dom.container.textContent).not.toContain('该模块尚未接入');
    } finally {
      await dom.cleanup();
    }
  });
});
