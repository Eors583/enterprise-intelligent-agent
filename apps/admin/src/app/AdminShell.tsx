import type { AuthAccount, BrowserAuthSessionResponse } from '@enterprise/contracts/auth-session';
import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';

import { logout } from '@/api/session-api';
import { writeSession } from '@/auth/session';
import { Icon } from '@/components/Icons';
import { LoadingPanel, roleLabel } from '@/components/ui';
import {
  ADMIN_SECONDARY_NAVIGATION,
  adminNavigationForRole,
  normalizeAdminRoute,
  parseAdminRoute,
  primaryNavigationForRoute,
  isAdminRouteAllowed,
  type AdminPageId,
  type AdminPrimaryId,
  type AdminRouteId,
} from './admin-navigation';

const AdminOverviewPage = lazy(() =>
  import('@/features/admin-overview/AdminOverviewPage').then((module) => ({
    default: module.AdminOverviewPage,
  })),
);
const ChangePasswordModal = lazy(() =>
  import('@/features/auth/ChangePasswordModal').then((module) => ({
    default: module.ChangePasswordModal,
  })),
);
const OrganizationPage = lazy(() =>
  import('@/features/organization/OrganizationPage').then((module) => ({
    default: module.OrganizationPage,
  })),
);
const MembersPage = lazy(() =>
  import('@/features/members/MembersPage').then((module) => ({ default: module.MembersPage })),
);
const AgentsPage = lazy(() =>
  import('@/features/agents/AgentsPage').then((module) => ({ default: module.AgentsPage })),
);
const RoleBlueprintsPage = lazy(() =>
  import('@/features/role-blueprints/RoleBlueprintsPage').then((module) => ({
    default: module.RoleBlueprintsPage,
  })),
);
const RoleAssignmentsPage = lazy(() =>
  import('@/features/role-assignments/RoleAssignmentsPage').then((module) => ({
    default: module.RoleAssignmentsPage,
  })),
);
const BusinessSemanticsPage = lazy(() =>
  import('@/features/business-semantics/BusinessSemanticsPage').then((module) => ({
    default: module.BusinessSemanticsPage,
  })),
);
const MarketingManagementPage = lazy(() =>
  import('@/features/marketing-management/MarketingManagementPage').then((module) => ({
    default: module.MarketingManagementPage,
  })),
);
const PeopleOrganizationPage = lazy(() =>
  import('@/features/people-organization/PeopleOrganizationPage').then((module) => ({
    default: module.PeopleOrganizationPage,
  })),
);
const ExperienceGovernancePage = lazy(() =>
  import('@/features/experience-governance/ExperienceGovernancePage').then((module) => ({
    default: module.ExperienceGovernancePage,
  })),
);
const IdentitySecurityPage = lazy(() =>
  import('@/features/identity-governance/IdentitySecurityPage').then((module) => ({
    default: module.IdentitySecurityPage,
  })),
);
const AiModelRoutingPage = lazy(() =>
  import('@/features/ai-model-routing/AiModelRoutingPage').then((module) => ({
    default: module.AiModelRoutingPage,
  })),
);
const AiEvaluationPage = lazy(() =>
  import('@/features/ai-evaluation/AiEvaluationPage').then((module) => ({
    default: module.AiEvaluationPage,
  })),
);
const KnowledgePage = lazy(() =>
  import('@/features/knowledge/KnowledgePage').then((module) => ({
    default: module.KnowledgePage,
  })),
);
const KnowledgeIntegrationsPage = lazy(() =>
  import('@/features/knowledge-integrations/KnowledgeIntegrationsPage').then((module) => ({
    default: module.KnowledgeIntegrationsPage,
  })),
);

export function AdminShell({ session }: { session: BrowserAuthSessionResponse }): ReactNode {
  const [route, setRoute] = useState<AdminRouteId>(() =>
    parseAdminRoute(window.location.hash, session.account.role),
  );
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [passwordModalOpen, setPasswordModalOpen] = useState(
    session.account.passwordChangeRequired,
  );

  const navigation = adminNavigationForRole(session.account.role);
  const page = normalizeAdminRoute(route);
  const activePrimary = primaryNavigationForRoute(route);
  const secondaryNavigation =
    activePrimary === null
      ? []
      : (ADMIN_SECONDARY_NAVIGATION[activePrimary] ?? []).filter((item) =>
          isAdminRouteAllowed(item.id, session.account.role),
        );

  useEffect(() => {
    const nextHash = `#${route}`;
    if (window.location.hash !== nextHash) window.location.hash = route;
    setSidebarOpen(false);
  }, [route]);

  useEffect(() => {
    const selectHashPage = (): void =>
      setRoute(parseAdminRoute(window.location.hash, session.account.role));
    window.addEventListener('hashchange', selectHashPage);
    return () => window.removeEventListener('hashchange', selectHashPage);
  }, [session.account.role]);

  useEffect(() => {
    if (session.account.passwordChangeRequired) setPasswordModalOpen(true);
  }, [session.account.passwordChangeRequired]);

  const acceptChangedAccount = (account: AuthAccount): void => {
    setPasswordModalOpen(false);
    writeSession({ account });
  };

  const signOut = async (): Promise<void> => {
    try {
      await logout();
    } catch {
      // Local logout must still succeed when the server is unavailable.
    } finally {
      writeSession(null);
    }
  };

  return (
    <div className="admin-app">
      <aside className={`sidebar ${sidebarOpen ? 'open' : ''}`}>
        <div className="sidebar-brand">
          <span className="brand-mark" aria-hidden="true">
            E
          </span>
          <span>
            <strong>企业 AI 协同</strong>
            <small>管理控制台</small>
          </span>
        </div>
        <nav className="sidebar-nav" aria-label="管理后台主导航">
          <span className="nav-group-label">业务工作台</span>
          {navigation.map((item) => (
            <button
              type="button"
              key={item.id}
              className={activePrimary === item.id ? 'active' : ''}
              aria-current={activePrimary === item.id ? 'page' : undefined}
              onClick={() => setRoute(item.id)}
            >
              <Icon name={item.icon} />
              <span>
                <strong>{item.label}</strong>
                <small>{item.description}</small>
              </span>
            </button>
          ))}
        </nav>
        <details className="sidebar-account-menu">
          <summary className="sidebar-account">
            <span className="avatar">{session.account.displayName.slice(0, 1).toUpperCase()}</span>
            <span className="account-copy">
              <strong>{session.account.displayName}</strong>
              <small>{roleLabel(session.account.role)}</small>
            </span>
            <span className="account-menu-indicator" aria-hidden="true">
              ···
            </span>
          </summary>
          <div className="sidebar-account-popover" aria-label="账号菜单">
            <button type="button" onClick={() => setRoute('identity-security')}>
              <Icon name="settings" size={17} />
              账号与安全
            </button>
            <button type="button" onClick={() => setPasswordModalOpen(true)}>
              <Icon name="password" size={18} />
              修改密码
            </button>
            <button type="button" onClick={() => void signOut()}>
              <Icon name="logout" size={18} />
              退出登录
            </button>
          </div>
        </details>
      </aside>
      {sidebarOpen ? (
        <button
          className="sidebar-scrim"
          aria-label="关闭导航"
          type="button"
          onClick={() => setSidebarOpen(false)}
        />
      ) : null}
      <main className="main-area">
        <header className="topbar">
          <button
            type="button"
            className="icon-button mobile-menu"
            aria-label="打开导航"
            onClick={() => setSidebarOpen(true)}
          >
            <Icon name="menu" />
          </button>
          <div className="tenant-identity">
            <span className="tenant-logo">
              {session.account.tenantName.slice(0, 1).toUpperCase()}
            </span>
            <span>
              <strong>{session.account.tenantName}</strong>
              <small>{session.account.tenantSlug}</small>
            </span>
          </div>
        </header>
        <div className="page-container">
          {activePrimary !== null && secondaryNavigation.length > 1 ? (
            <SecondaryNavigation primary={activePrimary} page={page} onNavigate={setRoute} />
          ) : null}
          <Suspense fallback={<LoadingPanel label="正在加载当前页面…" />}>
            {page === 'overview' ? <AdminOverviewPage /> : null}
            {page === 'organization' ? <OrganizationPage /> : null}
            {page === 'members' ? <MembersPage currentUserId={session.account.userId} /> : null}
            {page === 'agents' ? <AgentsPage /> : null}
            {page === 'role-blueprints' ? (
              <RoleBlueprintsPage currentUserId={session.account.userId} />
            ) : null}
            {page === 'role-assignments' ? <RoleAssignmentsPage /> : null}
            {page === 'business-semantics' ? (
              <BusinessSemanticsPage currentUserId={session.account.userId} />
            ) : null}
            {page === 'marketing-management' ? (
              <MarketingManagementPage currentUserId={session.account.userId} />
            ) : null}
            {page === 'people-organization' ? <PeopleOrganizationPage /> : null}
            {page === 'experience-governance' ? <ExperienceGovernancePage /> : null}
            {page === 'identity-security' ? <IdentitySecurityPage /> : null}
            {page === 'ai-model-routing' ? <AiModelRoutingPage /> : null}
            {page === 'ai-evaluation' ? <AiEvaluationPage /> : null}
            {page === 'knowledge' ? (
              <KnowledgePage
                currentUserId={session.account.userId}
                currentUserName={session.account.displayName}
              />
            ) : null}
            {page === 'knowledge-integrations' ? <KnowledgeIntegrationsPage /> : null}
          </Suspense>
        </div>
      </main>
      {passwordModalOpen || session.account.passwordChangeRequired ? (
        <Suspense fallback={null}>
          <ChangePasswordModal
            required={session.account.passwordChangeRequired}
            onClose={() => {
              if (!session.account.passwordChangeRequired) setPasswordModalOpen(false);
            }}
            onChanged={acceptChangedAccount}
          />
        </Suspense>
      ) : null}
    </div>
  );
}

function SecondaryNavigation({
  primary,
  page,
  onNavigate,
}: {
  primary: AdminPrimaryId;
  page: AdminPageId;
  onNavigate: (route: AdminRouteId) => void;
}): ReactNode {
  const items = ADMIN_SECONDARY_NAVIGATION[primary] ?? [];
  return (
    <nav className="admin-secondary-nav" aria-label={`${primary} 二级导航`}>
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          className={page === item.id ? 'active' : ''}
          aria-current={page === item.id ? 'page' : undefined}
          onClick={() => onNavigate(item.id)}
        >
          <strong>{item.label}</strong>
          <small>{item.description}</small>
        </button>
      ))}
    </nav>
  );
}
