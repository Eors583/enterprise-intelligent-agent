import type { AuthAccount, BrowserAuthSessionResponse } from '@enterprise/contracts';
import { useEffect, useState, type ReactNode } from 'react';

import { logout } from '@/api/admin-api';
import { writeSession } from '@/auth/session';
import { Icon, type IconName } from '@/components/Icons';
import { roleLabel } from '@/components/ui';
import { ChangePasswordModal } from '@/features/auth/ChangePasswordModal';
import { KnowledgePage } from '@/features/knowledge/KnowledgePage';
import { MarketingManagementPage } from '@/features/marketing-management/MarketingManagementPage';
import { PeopleOrganizationPage } from '@/features/people-organization/PeopleOrganizationPage';
import { FinanceFinopsPage } from '@/features/finance-finops/FinanceFinopsPage';
import { AgentsPage } from '@/features/agents/AgentsPage';
import { MembersPage } from '@/features/members/MembersPage';
import { OrganizationPage } from '@/features/organization/OrganizationPage';
import { RoleAssignmentsPage } from '@/features/role-assignments/RoleAssignmentsPage';
import { RoleBlueprintsPage } from '@/features/role-blueprints/RoleBlueprintsPage';
import { BusinessSemanticsPage } from '@/features/business-semantics/BusinessSemanticsPage';
import { ExperienceGovernancePage } from '@/features/experience-governance/ExperienceGovernancePage';
import { RuntimeGovernancePage } from '@/features/runtime-governance/RuntimeGovernancePage';
import { ToolGovernancePage } from '@/features/tool-governance/ToolGovernancePage';
import { AuditGovernancePage } from '@/features/audit-governance/AuditGovernancePage';
import { IdentityGovernancePage } from '@/features/identity-governance/IdentityGovernancePage';
import { IdentitySecurityPage } from '@/features/identity-governance/IdentitySecurityPage';
import { AiModelRoutingPage } from '@/features/ai-model-routing/AiModelRoutingPage';
import { AiEvaluationPage } from '@/features/ai-evaluation/AiEvaluationPage';
import { AdminOverviewPage } from '@/features/admin-overview/AdminOverviewPage';

type PageId =
  | 'overview'
  | 'organization'
  | 'members'
  | 'agents'
  | 'role-blueprints'
  | 'role-assignments'
  | 'business-semantics'
  | 'marketing-management'
  | 'people-organization'
  | 'finance-finops'
  | 'runtime-governance'
  | 'experience-governance'
  | 'tool-governance'
  | 'audit-governance'
  | 'identity-governance'
  | 'identity-security'
  | 'ai-model-routing'
  | 'ai-evaluation'
  | 'knowledge';

interface NavigationItem {
  id: PageId;
  label: string;
  description: string;
  icon: IconName;
}

const NAVIGATION: ReadonlyArray<NavigationItem> = [
  {
    id: 'overview',
    label: '管理概览',
    description: '运行、质量、成本与风险',
    icon: 'business',
  },
  {
    id: 'identity-security',
    label: '我的身份安全',
    description: 'MFA、设备与临时授权',
    icon: 'settings',
  },
  { id: 'organization', label: '组织架构', description: '部门与层级', icon: 'organization' },
  { id: 'members', label: '成员管理', description: '账号与权限', icon: 'members' },
  { id: 'agents', label: '智能体管理', description: '角色与运行状态', icon: 'agent' },
  { id: 'role-blueprints', label: '角色蓝图', description: '定义与版本治理', icon: 'blueprint' },
  { id: 'role-assignments', label: '角色任命', description: '成员与 Agent 版本', icon: 'agent' },
  {
    id: 'business-semantics',
    label: '经营主链',
    description: '价值到证据的语义治理',
    icon: 'business',
  },
  {
    id: 'marketing-management',
    label: '营销管理',
    description: '五看洞察与目标作战',
    icon: 'business',
  },
  {
    id: 'people-organization',
    label: '人才与组织',
    description: '能力证据、铁三角与变更治理',
    icon: 'organization',
  },
  {
    id: 'finance-finops',
    label: 'AI FinOps',
    description: '成本、预算、价值与 ROI',
    icon: 'business',
  },
  {
    id: 'runtime-governance',
    label: '运行治理',
    description: '流程、事件与 DLQ',
    icon: 'runtime',
  },
  {
    id: 'experience-governance',
    label: '经验治理',
    description: '脱敏、审核、验证与发布',
    icon: 'knowledge',
  },
  {
    id: 'tool-governance',
    label: '工具治理',
    description: '注册、风险、测试与发布',
    icon: 'settings',
  },
  {
    id: 'audit-governance',
    label: '审计治理',
    description: '查询、校验与受控导出',
    icon: 'settings',
  },
  {
    id: 'identity-governance',
    label: '身份治理',
    description: 'SSO、策略与紧急授权',
    icon: 'settings',
  },
  {
    id: 'ai-model-routing',
    label: '模型路由与安全',
    description: '版本、熔断与安全决策',
    icon: 'settings',
  },
  {
    id: 'ai-evaluation',
    label: 'AI 评测',
    description: '数据集、Run 与发布门禁',
    icon: 'agent',
  },
  { id: 'knowledge', label: '知识库', description: '范围与文档', icon: 'knowledge' },
];

function initialPage(canManageOrganization: boolean): PageId {
  const value = window.location.hash.replace(/^#\/?/, '');
  if (value === 'knowledge' || value === 'identity-security') return value;
  if (
    canManageOrganization &&
    (value === 'overview' ||
      value === 'organization' ||
      value === 'members' ||
      value === 'agents' ||
      value === 'role-blueprints' ||
      value === 'role-assignments' ||
      value === 'business-semantics' ||
      value === 'marketing-management' ||
      value === 'people-organization' ||
      value === 'finance-finops' ||
      value === 'runtime-governance' ||
      value === 'experience-governance' ||
      value === 'tool-governance' ||
      value === 'audit-governance' ||
      value === 'identity-governance' ||
      value === 'ai-model-routing' ||
      value === 'ai-evaluation')
  )
    return value;
  return canManageOrganization ? 'overview' : 'identity-security';
}

export function AdminShell({ session }: { session: BrowserAuthSessionResponse }): ReactNode {
  const canManageOrganization =
    session.account.role === 'OWNER' || session.account.role === 'ADMIN';
  const [page, setPage] = useState<PageId>(() => initialPage(canManageOrganization));
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [passwordModalOpen, setPasswordModalOpen] = useState(
    session.account.passwordChangeRequired,
  );

  const navigation = canManageOrganization
    ? NAVIGATION
    : NAVIGATION.filter((item) => item.id === 'knowledge' || item.id === 'identity-security');

  useEffect(() => {
    window.location.hash = page;
    setSidebarOpen(false);
  }, [page]);

  useEffect(() => {
    const selectHashPage = (): void => setPage(initialPage(canManageOrganization));
    window.addEventListener('hashchange', selectHashPage);
    return () => window.removeEventListener('hashchange', selectHashPage);
  }, [canManageOrganization]);

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
        <nav className="sidebar-nav" aria-label="管理功能">
          <span className="nav-group-label">企业管理</span>
          {navigation.map((item) => (
            <button
              type="button"
              key={item.id}
              className={page === item.id ? 'active' : ''}
              aria-current={page === item.id ? 'page' : undefined}
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
          {page === 'overview' ? <AdminOverviewPage /> : null}
          {page === 'organization' ? <OrganizationPage /> : null}
          {page === 'members' ? <MembersPage currentUserId={session.account.userId} /> : null}
          {page === 'agents' ? (
            <AgentsPage canManageLimits={session.account.role === 'OWNER'} />
          ) : null}
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
          {page === 'finance-finops' ? (
            <FinanceFinopsPage
              currentUserId={session.account.userId}
              tenantId={session.account.tenantId}
            />
          ) : null}
          {page === 'runtime-governance' ? <RuntimeGovernancePage /> : null}
          {page === 'experience-governance' ? <ExperienceGovernancePage /> : null}
          {page === 'tool-governance' ? <ToolGovernancePage /> : null}
          {page === 'audit-governance' ? (
            <AuditGovernancePage canExport={session.account.role === 'OWNER'} />
          ) : null}
          {page === 'identity-governance' ? (
            <IdentityGovernancePage currentUserId={session.account.userId} />
          ) : null}
          {page === 'identity-security' ? <IdentitySecurityPage /> : null}
          {page === 'ai-model-routing' ? <AiModelRoutingPage /> : null}
          {page === 'ai-evaluation' ? <AiEvaluationPage /> : null}
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
