import { describe, expect, it } from 'vitest';

import {
  ADMIN_PRIMARY_NAVIGATION,
  ADMIN_SECONDARY_NAVIGATION,
  adminNavigationForRole,
  isAdminRouteAllowed,
  normalizeAdminRoute,
  parseAdminRoute,
  primaryNavigationForRoute,
} from './admin-navigation';

describe('admin information architecture', () => {
  it('limits owner and administrator navigation to five business-oriented entries', () => {
    expect(ADMIN_PRIMARY_NAVIGATION.map((item) => item.label)).toEqual([
      '业务概览',
      '组织与成员',
      '智能体中心',
      '知识中心',
      '业务管理',
    ]);
    expect(adminNavigationForRole('OWNER')).toHaveLength(5);
    expect(adminNavigationForRole('ADMIN')).toHaveLength(5);
    expect(ADMIN_PRIMARY_NAVIGATION.some((item) => item.label.includes('营销'))).toBe(false);
  });

  it('keeps removed governance modules hidden and redirects legacy routes', () => {
    expect(adminNavigationForRole('KNOWLEDGE_ADMIN').map((item) => item.id)).toEqual([
      'knowledge-center',
    ]);
    expect(adminNavigationForRole('MEMBER').map((item) => item.id)).toEqual(['knowledge-center']);
    expect(isAdminRouteAllowed('advanced-settings', 'KNOWLEDGE_ADMIN')).toBe(false);
    expect(isAdminRouteAllowed('audit-governance', 'MEMBER')).toBe(false);
    expect(parseAdminRoute('#audit-governance', 'MEMBER')).toBe('knowledge-center');
    expect(parseAdminRoute('#audit-governance', 'ADMIN')).toBe('overview');
    expect(parseAdminRoute('#runtime-governance', 'OWNER')).toBe('overview');
    expect(parseAdminRoute('#finance-finops', 'ADMIN')).toBe('overview');
    expect(parseAdminRoute('#advanced-settings', 'ADMIN')).toBe('ai-model-routing');
  });

  it('maps new group routes and preserves authorized legacy hash routes', () => {
    expect(normalizeAdminRoute('organization-members')).toBe('organization');
    expect(normalizeAdminRoute('agent-center')).toBe('agents');
    expect(parseAdminRoute('#/members', 'ADMIN')).toBe('members');
    expect(primaryNavigationForRoute('members')).toBe('organization-members');
    expect(parseAdminRoute('#role-blueprints', 'OWNER')).toBe('role-blueprints');
    expect(primaryNavigationForRoute('role-blueprints')).toBe('agent-center');
    expect(primaryNavigationForRoute('ai-model-routing')).toBe('agent-center');
    expect(parseAdminRoute('#knowledge-integrations', 'ADMIN')).toBe('knowledge-integrations');
    expect(primaryNavigationForRoute('knowledge-integrations')).toBe('knowledge-center');
    expect(isAdminRouteAllowed('knowledge-integrations', 'KNOWLEDGE_ADMIN')).toBe(false);
  });

  it('hides marketing by default while preserving its administrator compatibility route', () => {
    const businessTabs = ADMIN_SECONDARY_NAVIGATION['business-management'] ?? [];
    expect(businessTabs.some((item) => item.id === 'marketing-management')).toBe(false);
    expect(parseAdminRoute('#marketing-management', 'ADMIN')).toBe('marketing-management');
    expect(primaryNavigationForRoute('marketing-management')).toBe('business-management');
  });

  it('keeps personal account security outside primary navigation but directly reachable', () => {
    expect(ADMIN_PRIMARY_NAVIGATION.map((item) => String(item.id))).not.toContain(
      'identity-security',
    );
    expect(parseAdminRoute('#identity-security', 'MEMBER')).toBe('identity-security');
    expect(primaryNavigationForRoute('identity-security')).toBeNull();
  });
});
