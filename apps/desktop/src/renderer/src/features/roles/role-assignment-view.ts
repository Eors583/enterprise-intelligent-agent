import type {
  RoleAssignment,
  RoleAssignmentSource,
  RoleAssignmentStatus,
} from '@enterprise/contracts';

export type RoleAssignmentGroup = 'current' | 'pending' | 'history';

export function roleAssignmentGroup(
  assignment: RoleAssignment,
  now = new Date(),
): RoleAssignmentGroup {
  const nowMs = now.getTime();
  if (
    assignment.status === 'REVOKED' ||
    assignment.status === 'EXPIRED' ||
    assignment.status === 'SUSPENDED' ||
    (assignment.effectiveTo !== null && Date.parse(assignment.effectiveTo) <= nowMs)
  ) {
    return 'history';
  }
  if (assignment.status === 'PENDING' || Date.parse(assignment.effectiveFrom) > nowMs) {
    return 'pending';
  }
  return 'current';
}

export function groupRoleAssignments(
  assignments: readonly RoleAssignment[],
  now = new Date(),
): Record<RoleAssignmentGroup, RoleAssignment[]> {
  const groups: Record<RoleAssignmentGroup, RoleAssignment[]> = {
    current: [],
    pending: [],
    history: [],
  };
  for (const assignment of assignments) {
    groups[roleAssignmentGroup(assignment, now)].push(assignment);
  }
  return groups;
}

export function defaultRoleAssignmentId(
  assignments: readonly RoleAssignment[],
  now = new Date(),
): string | null {
  const groups = groupRoleAssignments(assignments, now);
  return groups.current[0]?.id ?? groups.pending[0]?.id ?? groups.history[0]?.id ?? null;
}

export function roleStatusLabel(assignment: RoleAssignment, now = new Date()): string {
  const effectiveGroup = roleAssignmentGroup(assignment, now);
  if (effectiveGroup === 'pending') return '待生效';
  if (
    effectiveGroup === 'history' &&
    assignment.status === 'ACTIVE' &&
    assignment.effectiveTo !== null
  ) {
    return '已到期';
  }
  const labels: Record<RoleAssignmentStatus, string> = {
    PENDING: '待生效',
    ACTIVE: '生效中',
    SUSPENDED: '已暂停',
    REVOKED: '已撤销',
    EXPIRED: '已到期',
  };
  return labels[assignment.status];
}

export function roleSourceLabel(source: RoleAssignmentSource): string {
  const labels: Record<RoleAssignmentSource, string> = {
    LOCAL: '企业本地任命',
    DIRECTORY: '企业目录同步',
    PROJECT: '项目任命',
    TEMPORARY: '临时任命',
    DELEGATION: '职责委派',
    HANDOVER: '工作交接',
  };
  return labels[source];
}

export function agentRuntimeLabel(assignment: RoleAssignment, now = new Date()): string {
  const group = roleAssignmentGroup(assignment, now);
  if (group === 'pending') return 'Agent 待启用';
  if (group === 'history') return 'Agent 不可用';
  if (assignment.agent.status === 'OFFLINE') return 'Agent 配置离线';
  if (assignment.agent.status === 'DISABLED') return 'Agent 配置已停用';
  return 'Agent 配置已启用';
}

export function roleAgentAvailability(
  assignment: RoleAssignment,
  now = new Date(),
): { available: boolean; reason: string } {
  if (assignment.status !== 'ACTIVE') {
    return { available: false, reason: `任命${roleStatusLabel(assignment, now)}` };
  }
  if (Date.parse(assignment.effectiveFrom) > now.getTime()) {
    return { available: false, reason: '任命尚未生效' };
  }
  if (assignment.effectiveTo !== null && Date.parse(assignment.effectiveTo) <= now.getTime()) {
    return { available: false, reason: '任命已到期' };
  }
  if (assignment.assignee.status !== 'ACTIVE') {
    return { available: false, reason: '员工账号当前不可用' };
  }
  if (assignment.employment?.status !== 'ACTIVE') {
    return { available: false, reason: '任职关系当前不可用' };
  }
  if (assignment.agent.versionStatus === 'DRAFT' || assignment.agent.versionStatus === 'TESTING') {
    return { available: false, reason: '角色版本尚未发布' };
  }
  if (assignment.agent.status === 'OFFLINE') {
    return { available: false, reason: 'Agent 配置当前离线' };
  }
  if (assignment.agent.status === 'DISABLED') {
    return { available: false, reason: 'Agent 配置已停用' };
  }
  return {
    available: true,
    reason:
      assignment.agent.versionStatus === 'RETIRED'
        ? '沿用任命时固定的历史角色版本'
        : '可发起角色 Agent 对话；服务端仍会复核运行就绪状态',
  };
}

export function versionStatusLabel(status: RoleAssignment['agent']['versionStatus']): string {
  return {
    DRAFT: '草稿',
    TESTING: '测试中',
    PUBLISHED: '已发布',
    RETIRED: '已退役',
  }[status];
}

export function formatRoleTerm(assignment: RoleAssignment): string {
  const start = formatDateTime(assignment.effectiveFrom);
  const end = assignment.effectiveTo === null ? '长期有效' : formatDateTime(assignment.effectiveTo);
  return `${start} — ${end}`;
}

export function formatScope(value: Readonly<Record<string, unknown>>, emptyLabel: string): string {
  if (Object.keys(value).length === 0) return emptyLabel;
  return JSON.stringify(value, null, 2);
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value));
}
