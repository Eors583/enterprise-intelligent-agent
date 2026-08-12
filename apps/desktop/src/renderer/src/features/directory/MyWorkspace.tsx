import type { RoleAssignment } from '@enterprise/contracts';
import type { DesktopRuntimeInfo } from '../../../../shared/desktop-api';

export type MySection = 'overview' | 'manual' | 'roles' | 'security' | 'about';

export function MySidebar({
  active,
  assignments,
  selectedAssignmentId,
  onSelect,
  onSelectAssignment,
}: {
  active: MySection;
  assignments: readonly RoleAssignment[];
  selectedAssignmentId: string | null;
  onSelect: (section: MySection) => void;
  onSelectAssignment: (assignmentId: string) => void;
}): React.JSX.Element {
  const items: Array<{ id: MySection; label: string; detail: string }> = [
    { id: 'overview', label: '个人主页', detail: '账号与常用设置' },
    { id: 'manual', label: '个人使用说明书', detail: '介绍自己与协作方式' },
    { id: 'roles', label: '角色与权限', detail: `${assignments.length} 个角色任命` },
    { id: 'security', label: '账号与安全', detail: '切换账号、密码与登录保护' },
    { id: 'about', label: '关于', detail: '版本和客户端信息' },
  ];
  return (
    <aside className="directory-sidebar module-sidebar my-sidebar" aria-label="我的">
      <header>
        <p className="eyebrow">MY ACCOUNT</p>
        <h1>我的</h1>
        <p>个人账号、角色权限和客户端信息集中在这里。</p>
      </header>
      <nav>
        {items.map((item) => (
          <button
            type="button"
            key={item.id}
            className={active === item.id ? 'active' : ''}
            aria-current={active === item.id ? 'page' : undefined}
            onClick={() => onSelect(item.id)}
          >
            <span>{myGlyph(item.id)}</span>
            <span>
              <strong>{item.label}</strong>
              <small>{item.detail}</small>
            </span>
          </button>
        ))}
      </nav>
      {active === 'roles' && assignments.length > 0 && (
        <section className="my-role-list" aria-label="角色任命">
          <strong>选择角色</strong>
          {assignments.map((assignment) => (
            <button
              type="button"
              key={assignment.id}
              className={assignment.id === selectedAssignmentId ? 'active' : ''}
              aria-current={assignment.id === selectedAssignmentId ? 'true' : undefined}
              onClick={() => onSelectAssignment(assignment.id)}
            >
              <span>角</span>
              <span>
                <strong>{assignment.agent.template.name}</strong>
                <small>{assignment.agent.name}</small>
              </span>
            </button>
          ))}
        </section>
      )}
    </aside>
  );
}

export function MyOverviewWorkspace({
  user,
  assignments,
  onOpenManual,
  onOpenRoles,
  onOpenAccountMenu,
  onChangePassword,
  onOpenSecurity,
  onOpenAbout,
}: {
  user: { name: string; title?: string | undefined };
  assignments: readonly RoleAssignment[];
  onOpenManual: () => void;
  onOpenRoles: () => void;
  onOpenAccountMenu: () => void;
  onChangePassword: () => void;
  onOpenSecurity: () => void;
  onOpenAbout: () => void;
}): React.JSX.Element {
  return (
    <div className="my-workspace">
      <section className="content-card my-profile-card">
        <span>{initials(user.name)}</span>
        <div>
          <p className="eyebrow">PROFILE</p>
          <h1>{user.name}</h1>
          <p>{user.title ?? '企业成员'}</p>
        </div>
      </section>
      <section className="my-action-grid">
        <ActionCard
          glyph="介"
          title="个人使用说明书"
          detail="介绍岗位职责、协作方式，以及你能提供的技能与资源"
          action="开始填写"
          onClick={onOpenManual}
        />
        <ActionCard
          glyph="角"
          title="角色与权限"
          detail={`${assignments.length} 个可见角色任命`}
          action="查看角色"
          onClick={onOpenRoles}
        />
        <ActionCard
          glyph="户"
          title="账号切换"
          detail="切换企业账号或添加另一个账号"
          action="打开头像菜单"
          onClick={onOpenAccountMenu}
        />
        <ActionCard
          glyph="密"
          title="修改密码"
          detail="更新当前账号密码并保护登录安全"
          action="修改密码"
          onClick={onChangePassword}
        />
        <ActionCard
          glyph="安"
          title="账号安全"
          detail="查看本机凭证保护和安全说明"
          action="查看安全"
          onClick={onOpenSecurity}
        />
        <ActionCard
          glyph="版"
          title="关于"
          detail="查看桌面端版本和运行环境信息"
          action="查看关于"
          onClick={onOpenAbout}
        />
      </section>
    </div>
  );
}

export function AccountSecurityWorkspace({
  onOpenAccountMenu,
  onChangePassword,
}: {
  onOpenAccountMenu: () => void;
  onChangePassword: () => void;
}): React.JSX.Element {
  return (
    <div className="my-workspace">
      <section className="content-card my-detail-card">
        <p className="eyebrow">ACCOUNT & SECURITY</p>
        <h1>账号与安全</h1>
        <p>登录凭证由桌面主进程保存在系统加密存储中；业务页面无法直接读取访问令牌。</p>
        <div>
          <button type="button" onClick={onOpenAccountMenu}>
            切换或添加账号
          </button>
          <button type="button" onClick={onChangePassword}>
            修改当前密码
          </button>
        </div>
      </section>
    </div>
  );
}

export function AboutWorkspace({
  runtimeInfo,
}: {
  runtimeInfo: DesktopRuntimeInfo | null;
}): React.JSX.Element {
  return (
    <div className="my-workspace">
      <section className="content-card my-detail-card">
        <p className="eyebrow">ABOUT</p>
        <h1>企业智能体桌面端</h1>
        <p>面向企业员工的目标、会话、通讯录与个人账号工作入口。</p>
        <dl>
          <div>
            <dt>版本</dt>
            <dd>{runtimeInfo ? `v${runtimeInfo.appVersion}` : '读取中…'}</dd>
          </div>
          <div>
            <dt>平台</dt>
            <dd>{runtimeInfo ? platformLabel(runtimeInfo.platform) : '读取中…'}</dd>
          </div>
        </dl>
      </section>
    </div>
  );
}

function ActionCard({
  glyph,
  title,
  detail,
  action,
  onClick,
}: {
  glyph: string;
  title: string;
  detail: string;
  action: string;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <article className="content-card my-action-card">
      <span>{glyph}</span>
      <div>
        <h2>{title}</h2>
        <p>{detail}</p>
      </div>
      <button type="button" onClick={onClick}>
        {action}
      </button>
    </article>
  );
}

function initials(name: string): string {
  return [...name.trim()].slice(-2).join('').toLocaleUpperCase('zh-CN') || '?';
}

function myGlyph(section: MySection): string {
  return { overview: '我', manual: '介', roles: '角', security: '安', about: '版' }[section];
}

function platformLabel(platform: DesktopRuntimeInfo['platform']): string {
  return { win32: 'Windows', darwin: 'macOS', linux: 'Linux', other: 'Desktop' }[platform];
}
