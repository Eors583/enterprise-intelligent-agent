import type {
  AdminMember,
  AdminOrganizationResponse,
  AdminOrgUnit,
  IssueMemberInvitationResponse,
  MemberInvitation,
  TenantRole,
  UpdateMemberRequest,
} from '@enterprise/contracts';
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';

import {
  createMember,
  getOrganization,
  inviteMember,
  issueDirectoryMemberInvitation,
  listMemberInvitations,
  resendMemberInvitation,
  resetMemberPassword,
  updateMember,
} from '@/api/admin-api';
import { messageFromError } from '@/api/client';
import { Icon } from '@/components/Icons';
import {
  EmptyState,
  ErrorState,
  FieldError,
  LoadingPanel,
  Modal,
  Notice,
  roleLabel,
  Spinner,
  StatusPill,
} from '@/components/ui';

function unitName(units: ReadonlyArray<AdminOrgUnit>, id: string | undefined): string {
  if (!id) return '未分配部门';
  return units.find((unit) => unit.id === id)?.name ?? '未知部门';
}

const ROLES: ReadonlyArray<TenantRole> = ['OWNER', 'ADMIN', 'KNOWLEDGE_ADMIN', 'MEMBER'];

function invitationStatusLabel(status: MemberInvitation['status']): string {
  return {
    PENDING: '待发送',
    SENT: '待接受',
    DELIVERY_FAILED: '发送失败',
    ACCEPTED: '已接受',
    EXPIRED: '已过期',
    REVOKED: '已撤销',
  }[status];
}

export function buildMemberUpdateRequest(
  member: AdminMember,
  values: {
    displayName: string;
    role: TenantRole;
    status: AdminMember['status'];
    orgUnitId: string;
    title: string;
  },
): UpdateMemberRequest {
  if (member.source === 'FEISHU') return { role: values.role };
  return {
    displayName: values.displayName,
    role: values.role,
    status: values.status,
    ...(values.orgUnitId ? { orgUnitId: values.orgUnitId } : {}),
    ...(values.title.trim() ? { title: values.title } : {}),
  };
}

export function MembersPage({ currentUserId }: { currentUserId: string }): ReactNode {
  const [data, setData] = useState<AdminOrganizationResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('ALL');
  const [createOpen, setCreateOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [invitations, setInvitations] = useState<ReadonlyArray<MemberInvitation>>([]);
  const [editing, setEditing] = useState<AdminMember | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void Promise.all([
      getOrganization(controller.signal),
      listMemberInvitations(controller.signal).catch(() => []),
    ])
      .then(([organization, invitationRows]) => {
        setData(organization);
        setInvitations(invitationRows);
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) setError(messageFromError(caught));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [reloadKey]);

  const reload = (): void => setReloadKey((value) => value + 1);
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return (data?.members ?? []).filter((member) => {
      const matchesQuery =
        !normalized ||
        member.displayName.toLowerCase().includes(normalized) ||
        member.email.toLowerCase().includes(normalized);
      return matchesQuery && (status === 'ALL' || member.status === status);
    });
  }, [data?.members, query, status]);

  return (
    <section className="page-section">
      <header className="page-header">
        <div>
          <span className="eyebrow">PEOPLE & ACCESS</span>
          <h1>成员管理</h1>
          <p>创建成员账号，分配部门、岗位和企业管理角色。</p>
        </div>
        <div className="page-actions">
          <button className="button secondary" type="button" onClick={reload} disabled={loading}>
            <Icon name="refresh" size={17} /> 刷新
          </button>
          <button
            className="button secondary"
            type="button"
            onClick={() => setInviteOpen(true)}
            disabled={!data?.orgUnits.some((unit) => unit.status === 'ACTIVE')}
          >
            <Icon name="plus" size={17} /> 邀请成员
          </button>
          <button
            className="button primary"
            type="button"
            onClick={() => setCreateOpen(true)}
            disabled={!data?.orgUnits.some((unit) => unit.status === 'ACTIVE')}
          >
            <Icon name="plus" size={17} /> 添加成员
          </button>
        </div>
      </header>
      {notice ? (
        <Notice tone="success" onClose={() => setNotice(null)}>
          {notice}
        </Notice>
      ) : null}
      {loading && !data ? <LoadingPanel label="正在读取成员列表…" /> : null}
      {error && !data ? <ErrorState message={error} onRetry={reload} /> : null}

      {data ? (
        <div className="card table-card">
          <div className="table-toolbar">
            <div className="search-input">
              <span aria-hidden="true">⌕</span>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索姓名或邮箱"
                aria-label="搜索成员"
              />
            </div>
            <select
              value={status}
              onChange={(event) => setStatus(event.target.value)}
              aria-label="按账号状态筛选"
            >
              <option value="ALL">全部状态</option>
              <option value="ACTIVE">启用</option>
              <option value="INACTIVE">停用</option>
              <option value="LOCKED">锁定</option>
            </select>
            <span className="table-count">
              显示 {filtered.length} / {data.members.length} 位成员
            </span>
          </div>
          {filtered.length === 0 ? (
            <EmptyState
              title={data.members.length === 0 ? '还没有成员' : '没有匹配的成员'}
              description={
                data.members.length === 0
                  ? '添加成员并为其分配部门和初始密码。'
                  : '尝试更换搜索词或筛选条件。'
              }
            />
          ) : (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>成员</th>
                    <th>部门 / 职位</th>
                    <th>角色</th>
                    <th>状态</th>
                    <th>
                      <span className="sr-only">操作</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((member) => (
                    <tr key={member.id}>
                      <td>
                        <div className="person-cell">
                          <span className="avatar soft">
                            {member.displayName.slice(0, 1).toUpperCase()}
                          </span>
                          <span>
                            <span className="person-name-line">
                              <strong>{member.displayName}</strong>
                              {member.source === 'FEISHU' ? (
                                <span className="source-badge">飞书</span>
                              ) : null}
                            </span>
                            <small>{member.email}</small>
                          </span>
                        </div>
                      </td>
                      <td>
                        <strong className="table-primary">
                          {unitName(data.orgUnits, member.employment?.orgUnitId)}
                        </strong>
                        <small className="table-secondary">
                          {member.employment?.title ?? '未设置职位'}
                        </small>
                      </td>
                      <td>{roleLabel(member.role)}</td>
                      <td>
                        {invitations.find((invitation) => invitation.memberId === member.id) ? (
                          <span className="source-badge">
                            {invitationStatusLabel(
                              invitations.find((invitation) => invitation.memberId === member.id)!
                                .status,
                            )}
                          </span>
                        ) : (
                          <StatusPill value={member.status} />
                        )}
                      </td>
                      <td className="align-right">
                        <button
                          className="button compact secondary"
                          type="button"
                          onClick={() => setEditing(member)}
                        >
                          管理
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : null}

      {createOpen && data ? (
        <CreateMemberModal
          units={data.orgUnits}
          onClose={() => setCreateOpen(false)}
          onCreated={() => {
            setCreateOpen(false);
            setNotice('成员账号已创建，可使用企业标识、邮箱和初始密码登录。');
            reload();
          }}
        />
      ) : null}
      {inviteOpen && data ? (
        <InviteMemberModal
          units={data.orgUnits}
          onClose={() => setInviteOpen(false)}
          onIssued={() => reload()}
        />
      ) : null}
      {editing && data ? (
        <EditMemberModal
          key={editing.id}
          member={editing}
          units={data.orgUnits}
          currentUserId={currentUserId}
          invitation={invitations.find((invitation) => invitation.memberId === editing.id) ?? null}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            setNotice('成员信息与权限已更新。');
            reload();
          }}
        />
      ) : null}
    </section>
  );
}

function InviteMemberModal({
  units,
  onClose,
  onIssued,
}: {
  units: ReadonlyArray<AdminOrgUnit>;
  onClose: () => void;
  onIssued: () => void;
}): ReactNode {
  const activeUnits = units.filter((unit) => unit.status === 'ACTIVE');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<TenantRole>('MEMBER');
  const [orgUnitId, setOrgUnitId] = useState(activeUnits[0]?.id ?? '');
  const [title, setTitle] = useState('');
  const [employeeNumber, setEmployeeNumber] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issued, setIssued] = useState<IssueMemberInvitationResponse | null>(null);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const result = await inviteMember({
        displayName,
        email,
        role,
        orgUnitId,
        ...(title.trim() ? { title } : {}),
        ...(employeeNumber.trim() ? { employeeNumber } : {}),
      });
      setIssued(result);
      onIssued();
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title="邀请企业成员"
      description="成员通过一次性链接设置密码并激活账号；系统仅保存令牌摘要。"
      onClose={onClose}
      size="wide"
    >
      {issued ? (
        <div className="form-stack">
          <Notice tone={issued.deliveryKind === 'EMAIL_SENT' ? 'success' : 'info'}>
            {issued.deliveryKind === 'EMAIL_SENT'
              ? '邀请邮件已发送。安全起见，系统不会向管理端返回邀请令牌或链接。'
              : '邮件投递尚未配置或失败。下方是显式手工回退链接，仅显示一次且将在短时间内失效。'}
          </Notice>
          {issued.fallback ? (
            <label>
              <span>
                一次性邀请链接（有效期至{' '}
                {new Date(issued.fallback.expiresAt).toLocaleString('zh-CN')}）
              </span>
              <input readOnly value={issued.fallback.acceptanceUrl} />
            </label>
          ) : null}
          <div className="modal-actions">
            {issued.fallback ? (
              <button
                className="button secondary"
                type="button"
                onClick={() => void navigator.clipboard?.writeText(issued.fallback!.acceptanceUrl)}
              >
                复制回退链接
              </button>
            ) : null}
            <button className="button primary" type="button" onClick={onClose}>
              完成
            </button>
          </div>
        </div>
      ) : (
        <form className="form-stack" onSubmit={(event) => void submit(event)}>
          <div className="form-grid two">
            <label>
              <span>成员姓名</span>
              <input
                autoFocus
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
              />
            </label>
            <label>
              <span>登录邮箱</span>
              <input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </label>
          </div>
          <div className="form-grid two">
            <label>
              <span>所属部门</span>
              <select value={orgUnitId} onChange={(event) => setOrgUnitId(event.target.value)}>
                {activeUnits.map((unit) => (
                  <option key={unit.id} value={unit.id}>
                    {unit.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>企业角色</span>
              <select value={role} onChange={(event) => setRole(event.target.value as TenantRole)}>
                {ROLES.map((item) => (
                  <option key={item} value={item}>
                    {roleLabel(item)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="form-grid two">
            <label>
              <span>职位（可选）</span>
              <input value={title} onChange={(event) => setTitle(event.target.value)} />
            </label>
            <label>
              <span>工号（可选）</span>
              <input
                value={employeeNumber}
                onChange={(event) => setEmployeeNumber(event.target.value)}
              />
            </label>
          </div>
          <FieldError message={error} />
          <div className="modal-actions">
            <button className="button secondary" type="button" onClick={onClose}>
              取消
            </button>
            <button className="button primary" type="submit" disabled={submitting || !orgUnitId}>
              {submitting ? <Spinner label="正在创建邀请…" /> : '创建邀请'}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}

function CreateMemberModal({
  units,
  onClose,
  onCreated,
}: {
  units: ReadonlyArray<AdminOrgUnit>;
  onClose: () => void;
  onCreated: () => void;
}): ReactNode {
  const activeUnits = units.filter((unit) => unit.status === 'ACTIVE');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<TenantRole>('MEMBER');
  const [orgUnitId, setOrgUnitId] = useState(activeUnits[0]?.id ?? '');
  const [title, setTitle] = useState('');
  const [employeeNumber, setEmployeeNumber] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await createMember({
        displayName,
        email,
        password,
        role,
        orgUnitId,
        ...(title.trim() ? { title } : {}),
        ...(employeeNumber.trim() ? { employeeNumber } : {}),
      });
      onCreated();
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title="添加企业成员"
      description="创建账号后，将初始密码通过安全渠道告知成员。"
      onClose={onClose}
      size="wide"
    >
      <form className="form-stack" onSubmit={(event) => void submit(event)}>
        <div className="form-grid two">
          <label>
            <span>成员姓名</span>
            <input
              autoFocus
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder="例如 张晨"
            />
          </label>
          <label>
            <span>登录邮箱</span>
            <input
              type="email"
              autoComplete="off"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="name@company.com"
            />
          </label>
        </div>
        <div className="form-grid two">
          <label>
            <span>所属部门</span>
            <select value={orgUnitId} onChange={(event) => setOrgUnitId(event.target.value)}>
              {activeUnits.map((unit) => (
                <option key={unit.id} value={unit.id}>
                  {unit.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>职位（可选）</span>
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="例如 产品经理"
            />
          </label>
        </div>
        <div className="form-grid two">
          <label>
            <span>企业角色</span>
            <select value={role} onChange={(event) => setRole(event.target.value as TenantRole)}>
              {ROLES.map((item) => (
                <option key={item} value={item}>
                  {roleLabel(item)}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>工号（可选）</span>
            <input
              value={employeeNumber}
              onChange={(event) => setEmployeeNumber(event.target.value)}
            />
          </label>
        </div>
        <label>
          <span>初始密码</span>
          <span className="password-input">
            <input
              type={showPassword ? 'text' : 'password'}
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="至少 10 位"
            />
            <button type="button" onClick={() => setShowPassword((value) => !value)}>
              {showPassword ? '隐藏' : '显示'}
            </button>
          </span>
        </label>
        <FieldError message={error} />
        <div className="modal-actions">
          <button className="button secondary" type="button" onClick={onClose}>
            取消
          </button>
          <button className="button primary" type="submit" disabled={submitting || !orgUnitId}>
            {submitting ? <Spinner label="正在创建…" /> : '创建成员'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function EditMemberModal({
  member,
  units,
  currentUserId,
  invitation,
  onClose,
  onSaved,
}: {
  member: AdminMember;
  units: ReadonlyArray<AdminOrgUnit>;
  currentUserId: string;
  invitation: MemberInvitation | null;
  onClose: () => void;
  onSaved: () => void;
}): ReactNode {
  const [displayName, setDisplayName] = useState(member.displayName);
  const [role, setRole] = useState<TenantRole>(member.role);
  const [status, setStatus] = useState(member.status);
  const [orgUnitId, setOrgUnitId] = useState(member.employment?.orgUnitId ?? '');
  const [title, setTitle] = useState(member.employment?.title ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [temporaryPassword, setTemporaryPassword] = useState('');
  const [showTemporaryPassword, setShowTemporaryPassword] = useState(false);
  const [resettingPassword, setResettingPassword] = useState(false);
  const [passwordResetError, setPasswordResetError] = useState<string | null>(null);
  const [revokedSessionCount, setRevokedSessionCount] = useState<number | null>(null);
  const [resendingInvitation, setResendingInvitation] = useState(false);
  const [invitationLink, setInvitationLink] = useState<string | null>(null);
  const [invitationEmailSent, setInvitationEmailSent] = useState(false);
  const [invitationError, setInvitationError] = useState<string | null>(null);
  const externallyManaged = member.source === 'FEISHU';
  const isCurrentUser = member.id === currentUserId;

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await updateMember(
        member.id,
        buildMemberUpdateRequest(member, {
          displayName,
          role,
          status,
          orgUnitId,
          title,
        }),
      );
      onSaved();
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setSubmitting(false);
    }
  };

  const submitPasswordReset = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setResettingPassword(true);
    setPasswordResetError(null);
    setRevokedSessionCount(null);
    try {
      const result = await resetMemberPassword(member.id, { temporaryPassword });
      setTemporaryPassword('');
      setShowTemporaryPassword(false);
      setRevokedSessionCount(result.revokedSessionCount);
    } catch (caught) {
      setPasswordResetError(messageFromError(caught));
    } finally {
      setResettingPassword(false);
    }
  };

  const resendInvitation = async (): Promise<void> => {
    setResendingInvitation(true);
    setInvitationError(null);
    setInvitationEmailSent(false);
    try {
      const result = await resendMemberInvitation(member.id);
      setInvitationLink(result.fallback?.acceptanceUrl ?? null);
      setInvitationEmailSent(result.deliveryKind === 'EMAIL_SENT');
    } catch (caught) {
      setInvitationError(messageFromError(caught));
    } finally {
      setResendingInvitation(false);
    }
  };

  const issueInvitation = async (): Promise<void> => {
    setResendingInvitation(true);
    setInvitationError(null);
    setInvitationEmailSent(false);
    try {
      const result = await issueDirectoryMemberInvitation(member.id);
      setInvitationLink(result.fallback?.acceptanceUrl ?? null);
      setInvitationEmailSent(result.deliveryKind === 'EMAIL_SENT');
    } catch (caught) {
      setInvitationError(messageFromError(caught));
    } finally {
      setResendingInvitation(false);
    }
  };

  return (
    <Modal
      title={`管理成员 · ${member.displayName}`}
      description={member.email}
      onClose={onClose}
      size="wide"
    >
      <form className="form-stack" onSubmit={(event) => void submit(event)}>
        <div className="form-grid two">
          <label>
            <span>显示姓名</span>
            <input
              autoFocus={!externallyManaged}
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              disabled={externallyManaged}
            />
          </label>
          <label>
            <span>账号状态</span>
            <select
              value={status}
              onChange={(event) => setStatus(event.target.value as typeof status)}
              disabled={externallyManaged}
            >
              <option value="ACTIVE">启用</option>
              <option value="INACTIVE">停用</option>
              <option value="LOCKED">锁定</option>
            </select>
          </label>
        </div>
        <div className="form-grid two">
          <label>
            <span>企业角色</span>
            <select
              autoFocus={externallyManaged}
              value={role}
              onChange={(event) => setRole(event.target.value as TenantRole)}
            >
              {ROLES.map((item) => (
                <option
                  key={item}
                  value={item}
                  disabled={externallyManaged && item === 'OWNER' && member.role !== 'OWNER'}
                >
                  {roleLabel(item)}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>所属部门</span>
            <select
              value={orgUnitId}
              onChange={(event) => setOrgUnitId(event.target.value)}
              disabled={externallyManaged}
            >
              {!orgUnitId ? <option value="">未分配</option> : null}
              {units
                .filter((unit) => unit.status === 'ACTIVE')
                .map((unit) => (
                  <option key={unit.id} value={unit.id}>
                    {unit.name}
                  </option>
                ))}
            </select>
          </label>
        </div>
        <label>
          <span>职位</span>
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="未设置"
            disabled={externallyManaged}
          />
        </label>
        <Notice tone="info">
          {externallyManaged
            ? '姓名、部门、职位和账号状态由飞书管理；企业角色由本系统维护，但绑定登录身份前不能设为所有者。'
            : '角色或账号状态变更会影响该成员后续请求的访问权限。'}
        </Notice>
        <FieldError message={error} />
        <div className="member-modal-actions">
          <button className="button secondary" type="button" onClick={onClose}>
            取消
          </button>
          <button className="button primary" type="submit" disabled={submitting}>
            {submitting ? <Spinner label="正在保存…" /> : '保存成员设置'}
          </button>
        </div>
      </form>
      {invitation && invitation.status !== 'ACCEPTED' ? (
        <div className="member-password-reset">
          <div>
            <strong>成员邀请</strong>
            <p>
              当前状态：{invitationStatusLabel(invitation.status)}。重发会立即撤销此前未使用的链接。
            </p>
          </div>
          <div className="form-stack">
            {invitationEmailSent ? (
              <Notice tone="success">
                邀请邮件已发送；安全起见，管理端不会显示邀请令牌或链接。
              </Notice>
            ) : null}
            {invitationLink ? (
              <>
                <Notice tone="success">新的一次性邀请链接已生成。</Notice>
                <label>
                  <span>邀请链接</span>
                  <input readOnly value={invitationLink} />
                </label>
                <button
                  className="button secondary"
                  type="button"
                  onClick={() => void navigator.clipboard?.writeText(invitationLink)}
                >
                  复制链接
                </button>
              </>
            ) : null}
            <FieldError message={invitationError} />
            <button
              className="button secondary"
              type="button"
              disabled={resendingInvitation}
              onClick={() => void resendInvitation()}
            >
              {resendingInvitation ? <Spinner label="正在重发…" /> : '重新发送邀请'}
            </button>
          </div>
        </div>
      ) : externallyManaged && invitation === null ? (
        <div className="member-password-reset">
          <div>
            <strong>激活登录身份</strong>
            <p>
              飞书同步不会创建共享密码。请向该成员的唯一有效工作邮箱发送一次性邀请，或使用企业 SSO。
            </p>
          </div>
          <div className="form-stack">
            {invitationEmailSent ? (
              <Notice tone="success">
                邀请邮件已发送；安全起见，管理端不会显示邀请令牌或链接。
              </Notice>
            ) : null}
            {invitationLink ? (
              <>
                <Notice tone="success">一次性邀请链接已生成。</Notice>
                <label>
                  <span>邀请链接</span>
                  <input readOnly value={invitationLink} />
                </label>
                <button
                  className="button secondary"
                  type="button"
                  onClick={() => void navigator.clipboard?.writeText(invitationLink)}
                >
                  复制链接
                </button>
              </>
            ) : null}
            <FieldError message={invitationError} />
            <button
              className="button secondary"
              type="button"
              disabled={resendingInvitation}
              onClick={() => void issueInvitation()}
            >
              {resendingInvitation ? <Spinner label="正在发送…" /> : '发送一次性邀请'}
            </button>
          </div>
        </div>
      ) : null}
      {!externallyManaged || invitation?.status === 'ACCEPTED' ? (
        <div className="member-password-reset">
          <div>
            <strong>重置登录密码</strong>
            <p>设置一次性临时密码，并立即吊销该成员在所有设备上的会话。</p>
          </div>
          {isCurrentUser ? (
            <Notice tone="info">请使用右上角账号菜单修改自己的密码，该流程会校验当前密码。</Notice>
          ) : (
            <form className="form-stack" onSubmit={(event) => void submitPasswordReset(event)}>
              <label>
                <span>一次性临时密码</span>
                <span className="password-input">
                  <input
                    type={showTemporaryPassword ? 'text' : 'password'}
                    autoComplete="new-password"
                    value={temporaryPassword}
                    onChange={(event) => setTemporaryPassword(event.target.value)}
                    placeholder="至少 10 位"
                  />
                  <button type="button" onClick={() => setShowTemporaryPassword((value) => !value)}>
                    {showTemporaryPassword ? '隐藏' : '显示'}
                  </button>
                </span>
              </label>
              <Notice tone="info">
                重置后成员必须在下次登录时设置新密码；系统不会通过邮件发送该密码。
              </Notice>
              {revokedSessionCount === null ? null : (
                <Notice tone="success">
                  密码已重置，已退出 {revokedSessionCount} 个活跃会话。请通过安全渠道告知成员。
                </Notice>
              )}
              <FieldError message={passwordResetError} />
              <div className="member-modal-actions">
                <button
                  className="button danger-ghost"
                  type="submit"
                  disabled={resettingPassword || temporaryPassword.length < 10}
                >
                  {resettingPassword ? <Spinner label="正在重置…" /> : '重置密码并退出全部设备'}
                </button>
              </div>
            </form>
          )}
        </div>
      ) : null}
    </Modal>
  );
}
