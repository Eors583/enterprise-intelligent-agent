import type {
  AdminMember,
  AdminOrganizationResponse,
  AdminOrgUnit,
  EmploymentType,
  InviteMemberRequest,
  IssueMemberInvitationResponse,
  MemberInvitation,
  TenantRole,
  UpdateMemberRequest,
} from '@enterprise/contracts';
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';

import {
  getOrganization,
  inviteMember,
  issueDirectoryMemberInvitation,
  listMemberInvitations,
  resendMemberInvitation,
  resetMemberPassword,
  updateMember,
} from '@/api/member-api';
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

import './members.css';

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
    email: string;
    displayName: string;
    role: TenantRole;
    status: AdminMember['status'];
    orgUnitId: string;
    title: string;
  },
): UpdateMemberRequest {
  const email = values.email.trim().toLowerCase();
  const emailChanged = email !== member.email.trim().toLowerCase();
  if (member.source === 'FEISHU') {
    return {
      ...(emailChanged ? { email } : {}),
      role: values.role,
    };
  }
  return {
    ...(emailChanged ? { email } : {}),
    displayName: values.displayName,
    role: values.role,
    status: values.status,
    ...(values.orgUnitId ? { orgUnitId: values.orgUnitId } : {}),
    ...(values.title.trim() ? { title: values.title } : {}),
  };
}

export function isPlaceholderMemberEmail(email: string): boolean {
  return email.trim().toLowerCase().endsWith('@external.invalid');
}

export function MembersPage({ currentUserId }: { currentUserId: string }): ReactNode {
  const [data, setData] = useState<AdminOrganizationResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('ALL');
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
          <p>通过一次性邀请安全加入成员，并分配部门、岗位和企业角色。</p>
        </div>
        <div className="page-actions">
          <button className="button secondary" type="button" onClick={reload} disabled={loading}>
            <Icon name="refresh" size={17} /> 刷新
          </button>
          <button
            className="button primary"
            type="button"
            onClick={() => setInviteOpen(true)}
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
                  ? '发送一次性邀请，成员自行设置密码并激活账号。'
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

      {inviteOpen && data ? (
        <InviteMemberModal
          units={data.orgUnits}
          members={data.members}
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
  members,
  onClose,
  onIssued,
}: {
  units: ReadonlyArray<AdminOrgUnit>;
  members: ReadonlyArray<AdminMember>;
  onClose: () => void;
  onIssued: () => void;
}): ReactNode {
  const activeUnits = units.filter((unit) => unit.status === 'ACTIVE');
  const managerCandidates = members.filter(
    (member) => member.status === 'ACTIVE' && member.employment?.status === 'ACTIVE',
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issued, setIssued] = useState<IssueMemberInvitationResponse | null>(null);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const result = await inviteMember(
        buildMemberInvitationRequest(new FormData(event.currentTarget as HTMLFormElement)),
      );
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
      title="添加成员"
      description="填写成员的基础资料和工作关系。创建后，成员通过一次性邀请设置密码，并在用户端自行完善个人使用说明书。"
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
        <form
          className="form-stack member-onboarding-form"
          onSubmit={(event) => void submit(event)}
        >
          <MemberFormSection
            title="基础信息"
            description="用于成员登录、通讯录展示和日常联系。姓名、部门、手机号和工作邮箱为必填项。"
          >
            <div className="form-grid two">
              <label>
                <span>姓名</span>
                <input
                  name="displayName"
                  autoFocus
                  required
                  maxLength={120}
                  placeholder="例如 张晨"
                />
              </label>
              <label>
                <span>部门</span>
                <select name="orgUnitId" required defaultValue={activeUnits[0]?.id ?? ''}>
                  {activeUnits.map((unit) => (
                    <option key={unit.id} value={unit.id}>
                      {unit.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="form-grid two">
              <label>
                <span>手机号码</span>
                <span className="member-phone-field">
                  <select name="phoneCountryCode" aria-label="手机号国家代码" defaultValue="+86">
                    <option value="+86">+86</option>
                    <option value="+852">+852</option>
                    <option value="+853">+853</option>
                    <option value="+886">+886</option>
                    <option value="+65">+65</option>
                    <option value="+1">+1</option>
                    <option value="+44">+44</option>
                  </select>
                  <input
                    name="phoneNumber"
                    inputMode="tel"
                    required
                    maxLength={30}
                    placeholder="成员可使用该号码联系"
                  />
                </span>
              </label>
              <label>
                <span>工作邮箱</span>
                <input
                  name="email"
                  type="email"
                  required
                  maxLength={320}
                  placeholder="name@company.com"
                />
              </label>
            </div>
            <div className="form-grid two">
              <label>
                <span>头像链接（可选）</span>
                <input name="avatarUrl" type="url" maxLength={2048} placeholder="https://…" />
              </label>
              <label>
                <span>工号（可选）</span>
                <input name="employeeNumber" maxLength={255} />
              </label>
            </div>
          </MemberFormSection>

          <MemberFormSection
            title="工作信息"
            description="记录人员类型、入职信息和汇报关系，供组织权限与智能体工作上下文使用。"
          >
            <div className="form-grid two">
              <label>
                <span>人员类型</span>
                <select name="employmentType" defaultValue="REGULAR" required>
                  {EMPLOYMENT_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {employmentTypeLabel(type)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>入职日期</span>
                <input name="hireDate" type="date" defaultValue={todayDate()} />
              </label>
            </div>
            <div className="form-grid two">
              <label>
                <span>工作国家或地区（可选）</span>
                <input name="countryOrRegion" maxLength={120} placeholder="例如 中国" />
              </label>
              <label>
                <span>工作城市（可选）</span>
                <input name="city" maxLength={120} placeholder="例如 深圳" />
              </label>
            </div>
            <div className="form-grid two">
              <label>
                <span>直属上级（可选）</span>
                <select name="directManagerUserId" defaultValue="">
                  <option value="">未设置</option>
                  {managerCandidates.map((member) => (
                    <option key={member.id} value={member.id}>
                      {member.displayName} · {member.employment?.title ?? '未设置职位'}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>虚线上级（可选）</span>
                <select name="dottedLineManagerUserId" defaultValue="">
                  <option value="">未设置</option>
                  {managerCandidates.map((member) => (
                    <option key={member.id} value={member.id}>
                      {member.displayName} · {member.employment?.title ?? '未设置职位'}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="form-grid two">
              <label>
                <span>职务（可选）</span>
                <input name="title" maxLength={200} placeholder="例如 产品经理" />
              </label>
              <label>
                <span>企业角色</span>
                <select name="role" defaultValue="MEMBER">
                  {ROLES.map((item) => (
                    <option key={item} value={item}>
                      {roleLabel(item)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </MemberFormSection>

          <FieldError message={error} />
          <div className="modal-actions">
            <button className="button secondary" type="button" onClick={onClose}>
              取消
            </button>
            <button className="button primary" type="submit" disabled={submitting}>
              {submitting ? <Spinner label="正在添加成员…" /> : '添加成员并发送邀请'}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}

const EMPLOYMENT_TYPES: ReadonlyArray<EmploymentType> = [
  'REGULAR',
  'INTERN',
  'OUTSOURCED',
  'LABOR',
  'CONSULTANT',
];

function employmentTypeLabel(type: EmploymentType): string {
  return {
    REGULAR: '正式',
    INTERN: '实习',
    OUTSOURCED: '外包',
    LABOR: '劳务',
    CONSULTANT: '顾问',
  }[type];
}

function todayDate(): string {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

function MemberFormSection({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}): ReactNode {
  return (
    <fieldset className="member-form-section">
      <legend>{title}</legend>
      <p>{description}</p>
      <div className="member-form-section-content">{children}</div>
    </fieldset>
  );
}

export function buildMemberInvitationRequest(form: FormData): InviteMemberRequest {
  const phoneCountryCode = requiredFormValue(form, 'phoneCountryCode');
  const phoneNumber = requiredFormValue(form, 'phoneNumber');
  return {
    displayName: requiredFormValue(form, 'displayName'),
    email: requiredFormValue(form, 'email'),
    role: requiredFormValue(form, 'role') as TenantRole,
    orgUnitId: requiredFormValue(form, 'orgUnitId'),
    phone: `${phoneCountryCode} ${phoneNumber}`,
    employmentType: requiredFormValue(form, 'employmentType') as EmploymentType,
    ...optionalFormField(form, 'avatarUrl'),
    ...optionalFormField(form, 'title'),
    ...optionalFormField(form, 'employeeNumber'),
    ...optionalFormField(form, 'hireDate'),
    ...optionalFormField(form, 'countryOrRegion'),
    ...optionalFormField(form, 'city'),
    ...optionalFormField(form, 'directManagerUserId'),
    ...optionalFormField(form, 'dottedLineManagerUserId'),
  };
}

function requiredFormValue(form: FormData, name: string): string {
  return String(form.get(name) ?? '').trim();
}

function optionalFormField(form: FormData, name: string): Record<string, string> {
  const value = requiredFormValue(form, name);
  return value.length === 0 ? {} : { [name]: value };
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
  const [email, setEmail] = useState(member.email);
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
  const hasUnsavedEmail = email.trim().toLowerCase() !== member.email.trim().toLowerCase();
  const hasPlaceholderEmail = isPlaceholderMemberEmail(member.email);
  const identityActionBlocked = hasUnsavedEmail || hasPlaceholderEmail;

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await updateMember(
        member.id,
        buildMemberUpdateRequest(member, {
          email,
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
        <label>
          <span>登录邮箱</span>
          <input
            type="email"
            autoComplete="email"
            aria-label="登录邮箱"
            autoFocus={externallyManaged}
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>
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
            <select value={role} onChange={(event) => setRole(event.target.value as TenantRole)}>
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
            ? '姓名、部门、职位和账号状态由飞书管理；登录邮箱与企业角色由本地身份系统维护，飞书同步不会覆盖。邮箱保存后可用于登录、邀请和账号恢复，但绑定登录身份前不能设为所有者。'
            : '登录邮箱由本地身份系统维护，用于登录、邀请和账号恢复；角色或账号状态变更会影响后续请求的访问权限。'}
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
            {invitation.deliveryTargetEvidence === 'LEGACY_INFERRED' ? (
              <p>该历史投递地址由旧数据推断，并非精确投递凭证；请以当前登录邮箱为准。</p>
            ) : null}
          </div>
          <div className="form-stack">
            {identityActionBlocked ? (
              <Notice tone="info">
                {hasPlaceholderEmail
                  ? '当前是飞书同步生成的占位邮箱。请先填写并保存真实登录邮箱，再重新发送邀请。'
                  : '登录邮箱尚未保存。请先保存成员设置，再重新发送邀请。'}
              </Notice>
            ) : null}
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
              disabled={resendingInvitation || identityActionBlocked}
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
            {identityActionBlocked ? (
              <Notice tone="info">
                {hasPlaceholderEmail
                  ? '当前是飞书同步生成的占位邮箱。请先填写并保存真实登录邮箱，再发送一次性邀请。'
                  : '登录邮箱尚未保存。请先保存成员设置，再发送一次性邀请。'}
              </Notice>
            ) : null}
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
              disabled={resendingInvitation || identityActionBlocked}
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
              {hasUnsavedEmail ? (
                <Notice tone="info">登录邮箱尚未保存。请先保存成员设置，再重置密码。</Notice>
              ) : null}
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
                  disabled={resettingPassword || temporaryPassword.length < 10 || hasUnsavedEmail}
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
