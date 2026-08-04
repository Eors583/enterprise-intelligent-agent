import type {
  AdminMember,
  RoleAssignment,
  RoleAssignmentSource,
  RoleAssignmentStatus,
} from '@enterprise/contracts';

export type EligibleAssignmentMember = AdminMember & {
  status: 'ACTIVE';
  employment: NonNullable<AdminMember['employment']> & { status: 'ACTIVE' };
};

export type OrganizationScopeMode = 'MEMBER_UNIT' | 'SELECTED_UNIT' | 'UNRESTRICTED';
export type MemoryPolicyPreset = 'BLUEPRINT_DEFAULT' | 'ROLE_ONLY_30' | 'SHARED_90';

export function eligibleAssignmentMembers(
  members: ReadonlyArray<AdminMember>,
): ReadonlyArray<EligibleAssignmentMember> {
  return members
    .filter(
      (member): member is EligibleAssignmentMember =>
        member.status === 'ACTIVE' && member.employment?.status === 'ACTIVE',
    )
    .toSorted((left, right) => left.displayName.localeCompare(right.displayName, 'zh-CN'));
}

export function roleAssignmentStatusLabel(status: RoleAssignmentStatus): string {
  return {
    PENDING: '待生效',
    ACTIVE: '生效中',
    SUSPENDED: '已暂停',
    REVOKED: '已撤销',
    EXPIRED: '已到期',
  }[status];
}

export function roleAssignmentSourceLabel(source: RoleAssignmentSource): string {
  return {
    LOCAL: '本地任命',
    DIRECTORY: '目录同步',
    PROJECT: '项目任命',
    TEMPORARY: '临时任命',
    DELEGATION: '委派',
    HANDOVER: '交接',
  }[source];
}

export function canRevokeRoleAssignment(assignment: RoleAssignment): boolean {
  return assignment.status !== 'REVOKED' && assignment.status !== 'EXPIRED';
}

export function parseScopeJson(value: string, label: string): Record<string, unknown> {
  const normalized = value.trim();
  if (!normalized) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(normalized);
  } catch {
    throw new Error(`${label}必须是有效的 JSON 对象。`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${label}必须是 JSON 对象，不能是数组或基础值。`);
  }
  return parsed as Record<string, unknown>;
}

export function controlledOrganizationScope(
  mode: OrganizationScopeMode,
  memberOrgUnitId: string,
  selectedOrgUnitId: string,
  includeDescendants: boolean,
): Record<string, unknown> {
  if (mode === 'UNRESTRICTED') return {};
  const orgUnitId = mode === 'MEMBER_UNIT' ? memberOrgUnitId : selectedOrgUnitId;
  if (!orgUnitId) throw new Error('请选择有效的组织范围。');
  return {
    organizationIds: [orgUnitId],
    includeDescendants: mode === 'SELECTED_UNIT' && includeDescendants,
  };
}

export function controlledMemoryPolicy(preset: MemoryPolicyPreset): Record<string, unknown> {
  if (preset === 'ROLE_ONLY_30') return { roleOnly: true, retentionDays: 30 };
  if (preset === 'SHARED_90') return { roleOnly: false, retentionDays: 90 };
  return {};
}

export function assignmentEffectiveFrom(
  startsImmediately: boolean,
  scheduledValue: string,
  now = new Date(),
): string {
  return startsImmediately ? now.toISOString() : localDateTimeToIso(scheduledValue, '生效时间');
}

export function localDateTimeToIso(value: string, label: string): string {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) throw new Error(`${label}不是有效的日期时间。`);
  return date.toISOString();
}

export function localDateTimeValue(date = new Date()): string {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

export function formatRoleAssignmentDate(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

export function formatRoleAssignmentPeriod(assignment: RoleAssignment): string {
  const start = formatRoleAssignmentDate(assignment.effectiveFrom);
  const end =
    assignment.effectiveTo === null
      ? '长期有效'
      : `至 ${formatRoleAssignmentDate(assignment.effectiveTo)}`;
  return `${start} ${end}`;
}
