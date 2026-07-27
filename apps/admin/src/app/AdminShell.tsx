import type { AuthAccount, AuthSessionResponse } from '@enterprise/contracts';
import { useEffect, useState, type ReactNode } from 'react';

import { logout } from '@/api/admin-api';
import { readSession, writeSession } from '@/auth/session';
import { Icon, type IconName } from '@/components/Icons';
import { roleLabel } from '@/components/ui';
import { ChangePasswordModal } from '@/features/auth/ChangePasswordModal';
import { KnowledgePage } from '@/features/knowledge/KnowledgePage';
import { AgentsPage } from '@/features/agents/AgentsPage';
import { MembersPage } from '@/features/members/MembersPage';
import { OrganizationPage } from '@/features/organization/OrganizationPage';

type PageId = 'organization' | 'members' | 'agents' | 'knowledge';

interface NavigationItem {
  id: PageId;
  label: string;
  description: string;
  icon: IconName;
}

const NAVIGATION: ReadonlyArray<NavigationItem> = [
  { id: 'organization', label: '组织架构', description: '部门与层级', icon: 'organization' },
  { id: 'members', label: '成员管理', description: '账号与权限', icon: 'members' },
  { id: 'agents', label: '智能体管理', description: '角色与运行状态', icon: 'agent' },
  { id: 'knowledge', label: '知识库', description: '范围与文档', icon: 'knowledge' },
];

function initialPage(canManageOrganization: boolean): PageId {
  const value = window.location.hash.replace(/^#\/?/, '');
  if (value === 'knowledge') return value;
  if (
    canManageOrganization &&
    (value === 'organization' || value === 'members' || value === 'agents')
  )
    return value;
  return canManageOrganization ? 'organization' : 'knowledge';
}

export function AdminShell({ session }: { session: AuthSessionResponse }): ReactNode {
  const canManageOrganization =
    session.account.role === 'OWNER' || session.account.role === 'ADMIN';
  const [page, setPage] = useState<PageId>(() => initialPage(canManageOrganization));
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [passwordModalOpen, setPasswordModalOpen] = useState(
    session.account.passwordChangeRequired,
  );

  const navigation = canManageOrganization
    ? NAVIGATION
    : NAVIGATION.filter((item) => item.id === 'knowledge');

  useEffect(() => {
    window.location.hash = page;
    setSidebarOpen(false);
  }, [page]);

  useEffect(() => {
    if (session.account.passwordChangeRequired) setPasswordModalOpen(true);
  }, [session.account.passwordChangeRequired]);

  const acceptChangedAccount = (account: AuthAccount): void => {
    setPasswordModalOpen(false);
    writeSession({ ...(readSession() ?? session), account });
  };

  const signOut = async (): Promise<void> => {
    try {
      await logout(session.refreshToken);
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
        <nav className="sidebar-nav" aria-label="管理功能">
          <span className="nav-group-label">企业管理</span>
          {navigation.map((item) => (
            <button
              type="button"
              key={item.id}
              className={page === item.id ? 'active' : ''}
              onClick={() => setPage(item.id)}
            >
              <Icon name={item.icon} />
              <span>
                <strong>{item.label}</strong>
                <small>{item.description}</small>
              </span>
            </button>
          ))}
        </nav>
        <div className="sidebar-account">
          <span className="avatar">{session.account.displayName.slice(0, 1).toUpperCase()}</span>
          <span className="account-copy">
            <strong>{session.account.displayName}</strong>
            <small>{roleLabel(session.account.role)}</small>
          </span>
          <span className="account-actions">
            <button
              type="button"
              className="icon-button"
              title="修改密码"
              aria-label="修改密码"
              onClick={() => setPasswordModalOpen(true)}
            >
              <Icon name="password" size={18} />
            </button>
            <button
              type="button"
              className="icon-button"
              title="退出登录"
              aria-label="退出登录"
              onClick={() => void signOut()}
            >
              <Icon name="logout" size={18} />
            </button>
          </span>
        </div>
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
          <div className="topbar-meta">
            <span className="secure-dot" />
            已安全登录
          </div>
        </header>
        <div className="page-container">
          {page === 'organization' ? <OrganizationPage /> : null}
          {page === 'members' ? <MembersPage currentUserId={session.account.userId} /> : null}
          {page === 'agents' ? (
            <AgentsPage canManageLimits={session.account.role === 'OWNER'} />
          ) : null}
          {page === 'knowledge' ? <KnowledgePage /> : null}
        </div>
      </main>
      {passwordModalOpen || session.account.passwordChangeRequired ? (
        <ChangePasswordModal
          required={session.account.passwordChangeRequired}
          onClose={() => {
            if (!session.account.passwordChangeRequired) setPasswordModalOpen(false);
          }}
          onChanged={acceptChangedAccount}
        />
      ) : null}
    </div>
  );
}
