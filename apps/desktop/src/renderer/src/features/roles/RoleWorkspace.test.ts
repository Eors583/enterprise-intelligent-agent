import type { RoleAssignment } from '@enterprise/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { RoleSidebar, RoleWorkspace } from './RoleWorkspace';
import {
  agentRuntimeLabel,
  groupRoleAssignments,
  roleAgentAvailability,
} from './role-assignment-view';
import { roleAssignmentFixture } from './test-fixtures';

const NOW = new Date('2026-07-28T00:00:00.000Z');

describe('RoleWorkspace', () => {
  it('renders the immutable role definition snapshot across every structured domain', () => {
    const assignment = roleAssignmentFixture();
    const html = renderToStaticMarkup(
      createElement(RoleWorkspace, {
        assignment,
        isLoading: false,
        operation: null,
        onOpenAgent: vi.fn(),
        onRetryAgent: vi.fn(),
      }),
    );

    expect(html).toContain('销售负责人');
    expect(html).toContain('Agent 配置已启用');
    expect(html).toContain('项目任命');
    expect(html).toContain('建立可预测、可持续的企业销售增长体系');
    expect(html).toContain('销售管道管理');
    expect(html).toContain('预测准确率达到目标');
    expect(html).toContain('以可持续收入增长为客户与企业创造长期价值');
    expect(html).toContain('季度收入达成率');
    expect(html).toContain('商业预测');
    expect(html).toContain('高级');
    expect(html).toContain('季度预测复盘');
    expect(html).toContain('负责');
    expect(html).toContain('客户关系管理系统');
    expect(html).toContain('执行');
    expect(html).toContain('企业定价');
    expect(html).toContain('机密');
    expect(html).toContain('crm.read');
    expect(html).toContain('orgUnitIds');
    expect(html).toContain('v3');
    expect(html).toContain('已发布');
    expect(html).toContain('蓝图修订');
    expect(html).toContain('r6 · 任命时快照');
    expect(html).toContain('进入角色 Agent');
    expect(html).not.toContain('历史版本未结构化');
    expect(html).not.toContain('disabled=""');
  });

  it('marks legacy assignments without a snapshot and never substitutes the current template', () => {
    const legacyAssignment = {
      ...roleAssignmentFixture(),
      roleDefinitionSnapshot: null,
    };
    const html = renderToStaticMarkup(
      createElement(RoleWorkspace, {
        assignment: legacyAssignment,
        isLoading: false,
        operation: null,
        onOpenAgent: vi.fn(),
        onRetryAgent: vi.fn(),
      }),
    );

    expect(html).toContain('历史版本未结构化');
    expect(html).toContain('不会读取当前模板补全内容');
    expect(html).not.toContain('销售管道管理');
    expect(html).not.toContain('季度收入达成率');
  });

  it('never presents a pending or offline assignment as online or enterable', () => {
    const pendingOffline: RoleAssignment = {
      ...roleAssignmentFixture(),
      status: 'PENDING',
      effectiveFrom: '2026-08-01T00:00:00.000Z',
      agent: { ...roleAssignmentFixture().agent, status: 'OFFLINE' },
    };

    expect(agentRuntimeLabel(pendingOffline, NOW)).toBe('Agent 待启用');
    expect(roleAgentAvailability(pendingOffline, NOW)).toMatchObject({ available: false });

    const html = renderToStaticMarkup(
      createElement(RoleWorkspace, {
        assignment: pendingOffline,
        isLoading: false,
        operation: null,
        onOpenAgent: vi.fn(),
        onRetryAgent: vi.fn(),
      }),
    );
    expect(html).toContain('Agent 待启用');
    expect(html).not.toContain('Agent 配置已启用');
    expect(html).toContain('disabled=""');
  });

  it('keeps an active assignment enterable when its immutable version is superseded', () => {
    const superseded: RoleAssignment = {
      ...roleAssignmentFixture(),
      agent: {
        ...roleAssignmentFixture().agent,
        versionStatus: 'RETIRED',
      },
    };

    expect(roleAgentAvailability(superseded, NOW)).toEqual({
      available: true,
      reason: '沿用任命时固定的历史角色版本',
    });

    const html = renderToStaticMarkup(
      createElement(RoleWorkspace, {
        assignment: superseded,
        isLoading: false,
        operation: null,
        onOpenAgent: vi.fn(),
        onRetryAgent: vi.fn(),
      }),
    );
    expect(html).toContain('沿用任命时固定的历史角色版本');
    expect(html).not.toContain('disabled=""');
  });

  it('groups active, pending, and ended assignments in the role sidebar', () => {
    const active = roleAssignmentFixture();
    const pending: RoleAssignment = {
      ...roleAssignmentFixture(),
      id: '10000000-0000-7000-8000-000000000002',
      key: 'assignment-future',
      status: 'PENDING',
      effectiveFrom: '2026-08-01T00:00:00.000Z',
    };
    const revoked: RoleAssignment = {
      ...roleAssignmentFixture(),
      id: '10000000-0000-7000-8000-000000000003',
      key: 'assignment-history',
      status: 'REVOKED',
      revokedAt: '2026-07-20T00:00:00.000Z',
      revokeReason: '岗位调整',
    };

    const groups = groupRoleAssignments([active, pending, revoked], NOW);
    expect(groups.current).toHaveLength(1);
    expect(groups.pending).toHaveLength(1);
    expect(groups.history).toHaveLength(1);

    const html = renderToStaticMarkup(
      createElement(RoleSidebar, {
        assignments: [active, pending, revoked],
        selectedAssignmentId: active.id,
        isLoading: false,
        isError: false,
        error: null,
        onSelect: vi.fn(),
        onRetry: vi.fn(),
      }),
    );
    expect(html).toContain('当前角色');
    expect(html).toContain('待生效');
    expect(html).toContain('历史记录');
  });
});
