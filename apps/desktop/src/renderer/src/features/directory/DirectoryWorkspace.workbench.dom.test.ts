import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderInTestDom } from '../../test/dom-test-utils';
import { objectiveFixture, taskFixture } from '../workbench/test-fixtures';
import type { BootstrapPayload } from './bootstrap';

const hookSpies = vi.hoisted(() => ({
  objectives: vi.fn(),
  tasks: vi.fn(),
  createConversation: vi.fn(),
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
    mutate: hookSpies.createConversation,
    mutateAsync: vi.fn(),
  }),
}));
vi.mock('../messaging/MessagingWorkspace', async () => {
  const { createElement: createMockElement } = await import('react');
  return {
    ConversationWorkspace: () => null,
    MessagingSidebar: ({ onStartConversation }: { onStartConversation?: () => void }) =>
      createMockElement(
        'aside',
        { 'data-testid': 'messaging-sidebar' },
        onStartConversation
          ? createMockElement(
              'button',
              { type: 'button', onClick: onStartConversation },
              '新建会话',
            )
          : null,
      ),
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
  departmentAgents: [],
};

describe('desktop workbench navigation integration', () => {
  it('shows only the four employee entries and opens on the real workbench overview', async () => {
    const dom = await renderInTestDom(createElement(DirectoryWorkspace, { payload: PAYLOAD }));
    try {
      expect(dom.container.querySelector('.primary-rail')).toBeNull();
      expect(hookSpies.objectives).toHaveBeenCalledWith(true);
      expect(hookSpies.tasks).toHaveBeenCalledWith(true);
      expect(dom.container.querySelector('.workspace.workbench-active')).not.toBeNull();
      expect(dom.container.querySelector('[data-testid="workbench-sidebar"]')).toBeNull();
      expect(dom.container.querySelector('[data-testid="messaging-sidebar"]')).not.toBeNull();
      expect(dom.container.querySelector('.employee-workbench-overview')?.textContent).toContain(
        '询问智能体',
      );
      expect(dom.container.querySelector('.assistant-launcher')).toBeNull();
      expect(dom.container.textContent).not.toContain('安全连接');
      expect(dom.container.textContent).not.toContain('桌面安全模式');
    } finally {
      await dom.cleanup();
    }
  });

  it('keeps search and opens one shared member and Agent conversation entry', async () => {
    const dom = await renderInTestDom(
      createElement(DirectoryWorkspace, {
        payload: PAYLOAD,
        navigationRequest: { destination: 'messages', requestId: 1 },
      }),
    );
    try {
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

      const start = [...dom.container.querySelectorAll('button')].find(
        (button) => button.textContent === '新建会话',
      );
      expect(start).not.toBeUndefined();
      if (start) await dom.click(start);
      await dom.flush();
      expect(dom.container.querySelector('[role="dialog"]')?.textContent).toContain('新建会话');
      expect(dom.container.querySelector('[role="dialog"]')?.textContent).toContain('联系本人');
      expect(dom.container.querySelector('[role="dialog"]')?.textContent).toContain('询问智能体');
      const dialog = dom.container.querySelector('[role="dialog"]');
      const sharedAction = [...(dialog?.querySelectorAll('button') ?? [])].find((button) =>
        button.textContent?.includes('联系本人'),
      );
      if (sharedAction) await dom.click(sharedAction);
      expect(hookSpies.createConversation).toHaveBeenCalledWith(
        { type: 'direct', target: { type: 'human', userId: 'member-1' } },
        expect.any(Object),
      );
      expect(dialog?.querySelectorAll('article button')).toHaveLength(2);
      expect(dom.container.textContent).not.toContain('智能体协作');
    } finally {
      await dom.cleanup();
    }
  });

  it('keeps the shared human conversation available when only the Agent model is not ready', async () => {
    const payload: BootstrapPayload = structuredClone(PAYLOAD);
    payload.members[0]!.capabilities.canContactAgent = true;
    payload.members[0]!.agent!.operationalAvailability = {
      status: 'NOT_READY',
      evidenceStatus: 'INSUFFICIENT_EVIDENCE',
      reasonCodes: ['NO_RECENT_SUCCESSFUL_PROVIDER_EVIDENCE'],
      checkedAt: '2026-07-28T01:00:00.000Z',
    };
    const dom = await renderInTestDom(
      createElement(DirectoryWorkspace, {
        payload,
        navigationRequest: { destination: 'directory', requestId: 1 },
      }),
    );
    try {
      await dom.flush();

      const contactAgent = dom.container.querySelector<HTMLButtonElement>(
        '.contact-actions .primary-button',
      );
      expect(contactAgent?.disabled).toBe(false);
      expect(contactAgent?.textContent).toContain('打开共享会话');
      expect(contactAgent?.title).toContain('共用同一个会话窗口');
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

  it('moves roles and account security into My and hides legacy self-service entries', async () => {
    const dom = await renderInTestDom(
      createElement(DirectoryWorkspace, {
        payload: PAYLOAD,
        navigationRequest: { destination: 'my', requestId: 1 },
      }),
    );
    try {
      await dom.flush();

      expect(dom.container.querySelector('.workspace.my-active')).not.toBeNull();
      expect(dom.container.textContent).toContain('角色与权限');
      expect(dom.container.textContent).toContain('账号切换');
      expect(dom.container.textContent).toContain('修改密码');
      expect(dom.container.textContent).toContain('账号安全');
      expect(dom.container.textContent).toContain('关于');
      expect(dom.container.querySelector('[aria-label="经验与用量"]')).toBeNull();
      expect(dom.container.querySelector('[aria-label="我的成长"]')).toBeNull();
      expect(dom.container.querySelector('.assistant-launcher')).toBeNull();
    } finally {
      await dom.cleanup();
    }
  });
});
