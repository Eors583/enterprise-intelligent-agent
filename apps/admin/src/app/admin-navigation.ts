import { canAccessAdvancedSettings, type AuthAccount } from '@enterprise/contracts/auth-session';

import type { IconName } from '@/components/Icons';

export type AdminPrimaryId =
  'overview' | 'organization-members' | 'agent-center' | 'knowledge-center' | 'business-management';

export type AdminPageId =
  | 'overview'
  | 'organization'
  | 'members'
  | 'agents'
  | 'role-blueprints'
  | 'role-assignments'
  | 'business-semantics'
  | 'marketing-management'
  | 'people-organization'
  | 'experience-governance'
  | 'identity-security'
  | 'ai-model-routing'
  | 'ai-evaluation'
  | 'knowledge-integrations'
  | 'knowledge';

export type LegacyAdminRouteId =
  | 'advanced-settings'
  | 'finance-finops'
  | 'runtime-governance'
  | 'tool-governance'
  | 'audit-governance'
  | 'identity-governance';

export type AdminRouteId = AdminPrimaryId | AdminPageId | LegacyAdminRouteId;

export interface AdminNavigationItem {
  id: AdminPrimaryId;
  label: string;
  description: string;
  icon: IconName;
}

export interface AdminSecondaryNavigationItem {
  id: AdminPageId;
  label: string;
  description: string;
}

export const ADMIN_PRIMARY_NAVIGATION: ReadonlyArray<AdminNavigationItem> = [
  {
    id: 'overview',
    label: '业务概览',
    description: '关键业务与运行状态',
    icon: 'business',
  },
  {
    id: 'organization-members',
    label: '组织与成员',
    description: '架构、成员与角色',
    icon: 'organization',
  },
  {
    id: 'agent-center',
    label: '智能体中心',
    description: '配置、测试与发布',
    icon: 'agent',
  },
  {
    id: 'knowledge-center',
    label: '知识中心',
    description: '知识、文档与检索',
    icon: 'knowledge',
  },
  {
    id: 'business-management',
    label: '业务管理',
    description: '目标、任务与交付',
    icon: 'blueprint',
  },
];

export const ADMIN_SECONDARY_NAVIGATION: Readonly<
  Partial<Record<AdminPrimaryId, ReadonlyArray<AdminSecondaryNavigationItem>>>
> = {
  'organization-members': [
    { id: 'organization', label: '组织架构', description: '部门与层级' },
    { id: 'members', label: '成员', description: '账号与权限' },
    { id: 'role-assignments', label: '角色分配', description: '成员与智能体任命' },
    { id: 'people-organization', label: '人才治理', description: '能力与组织证据' },
  ],
  'agent-center': [
    { id: 'agents', label: '智能体', description: '配置、知识绑定与运行状态' },
    { id: 'role-blueprints', label: '角色蓝图', description: '角色定义与版本' },
    { id: 'ai-evaluation', label: '质量评测', description: '可选评测集、Run 与质量检查' },
    { id: 'ai-model-routing', label: '模型服务', description: '智能体使用的模型与路由' },
  ],
  'knowledge-center': [
    { id: 'knowledge', label: '知识库与文档', description: '导入、自动处理与检索' },
    { id: 'knowledge-integrations', label: '知识来源', description: '外部知识服务连接与检测' },
    {
      id: 'experience-governance',
      label: '经验候选',
      description: '脱敏、审核、验证与发布',
    },
  ],
  'business-management': [
    {
      id: 'business-semantics',
      label: '目标、任务与交付',
      description: '从业务目标到交付证据',
    },
  ],
};

const PRIMARY_DEFAULT_PAGE: Readonly<Record<AdminPrimaryId, AdminPageId>> = {
  overview: 'overview',
  'organization-members': 'organization',
  'agent-center': 'agents',
  'knowledge-center': 'knowledge',
  'business-management': 'business-semantics',
};

const PAGE_PRIMARY: Readonly<Record<Exclude<AdminPageId, 'identity-security'>, AdminPrimaryId>> = {
  overview: 'overview',
  organization: 'organization-members',
  members: 'organization-members',
  'role-assignments': 'organization-members',
  'people-organization': 'organization-members',
  agents: 'agent-center',
  'role-blueprints': 'agent-center',
  'ai-evaluation': 'agent-center',
  knowledge: 'knowledge-center',
  'knowledge-integrations': 'knowledge-center',
  'experience-governance': 'knowledge-center',
  'business-semantics': 'business-management',
  'marketing-management': 'business-management',
  'ai-model-routing': 'agent-center',
};

const LEGACY_ROUTE_REDIRECTS: Readonly<Record<LegacyAdminRouteId, AdminPageId>> = {
  'advanced-settings': 'ai-model-routing',
  'identity-governance': 'overview',
  'tool-governance': 'overview',
  'audit-governance': 'overview',
  'runtime-governance': 'overview',
  'finance-finops': 'overview',
};

const ROUTE_IDS = new Set<AdminRouteId>([
  ...ADMIN_PRIMARY_NAVIGATION.map((item) => item.id),
  ...Object.keys(PAGE_PRIMARY).map((id) => id as AdminPageId),
  ...Object.keys(LEGACY_ROUTE_REDIRECTS).map((id) => id as LegacyAdminRouteId),
  'identity-security',
]);

type AdminRole = AuthAccount['role'];

export function canManageAdminSettings(role: AdminRole): boolean {
  return canAccessAdvancedSettings(role);
}

export function adminNavigationForRole(role: AdminRole): ReadonlyArray<AdminNavigationItem> {
  if (canManageAdminSettings(role)) return ADMIN_PRIMARY_NAVIGATION;
  return ADMIN_PRIMARY_NAVIGATION.filter((item) => item.id === 'knowledge-center');
}

export function normalizeAdminRoute(route: AdminRouteId): AdminPageId {
  const compatibleRoute =
    route in LEGACY_ROUTE_REDIRECTS ? LEGACY_ROUTE_REDIRECTS[route as LegacyAdminRouteId] : route;
  return compatibleRoute in PRIMARY_DEFAULT_PAGE
    ? PRIMARY_DEFAULT_PAGE[compatibleRoute as AdminPrimaryId]
    : (compatibleRoute as AdminPageId);
}

export function primaryNavigationForRoute(route: AdminRouteId): AdminPrimaryId | null {
  const page = normalizeAdminRoute(route);
  return page === 'identity-security' ? null : PAGE_PRIMARY[page];
}

export function isAdminRouteAllowed(route: AdminRouteId, role: AdminRole): boolean {
  if (route === 'identity-security') return true;
  if (canManageAdminSettings(role)) return true;

  const page = normalizeAdminRoute(route);
  if (role === 'KNOWLEDGE_ADMIN') {
    return page === 'knowledge' || page === 'experience-governance';
  }
  return page === 'knowledge';
}

export function parseAdminRoute(hash: string, role: AdminRole): AdminRouteId {
  const candidate = hash.replace(/^#\/?/, '').split(/[?&]/, 1)[0] ?? '';
  if (ROUTE_IDS.has(candidate as AdminRouteId)) {
    const route = candidate as AdminRouteId;
    if (isAdminRouteAllowed(route, role)) {
      return route in LEGACY_ROUTE_REDIRECTS
        ? LEGACY_ROUTE_REDIRECTS[route as LegacyAdminRouteId]
        : route;
    }
  }
  return canManageAdminSettings(role) ? 'overview' : 'knowledge-center';
}
