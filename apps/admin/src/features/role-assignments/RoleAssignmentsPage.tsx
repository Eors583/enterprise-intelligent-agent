import type {
  AdminMember,
  CreateRoleAssignmentRequest,
  RoleAssignment,
  RoleAssignmentCandidate,
  RoleAssignmentSource,
} from '@enterprise/contracts';
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';

import {
  createRoleAssignment,
  getOrganization,
  listRoleAssignments,
  listRoleAssignmentCandidates,
  revokeRoleAssignment,
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
  Spinner,
  StatusPill,
} from '@/components/ui';

import {
  canRevokeRoleAssignment,
  eligibleAssignmentMembers,
  formatRoleAssignmentDate,
  formatRoleAssignmentPeriod,
  localDateTimeToIso,
  localDateTimeValue,
  parseScopeJson,
  roleAssignmentSourceLabel,
  roleAssignmentStatusLabel,
  type EligibleAssignmentMember,
} from './role-assignment-view';

type CreateSource = Extract<RoleAssignmentSource, 'LOCAL' | 'PROJECT' | 'TEMPORARY'>;

const CREATE_SOURCES: ReadonlyArray<CreateSource> = ['LOCAL', 'PROJECT', 'TEMPORARY'];
const ASSIGNMENT_STATUSES = ['PENDING', 'ACTIVE', 'SUSPENDED', 'REVOKED', 'EXPIRED'] as const;

export function RoleAssignmentsPage(): ReactNode {
  const [items, setItems] = useState<RoleAssignment[] | null>(null);
  const [members, setMembers] = useState<AdminMember[]>([]);
  const [roleCandidates, setRoleCandidates] = useState<RoleAssignmentCandidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('ALL');
  const [createOpen, setCreateOpen] = useState(false);
  const [revoking, setRevoking] = useState<RoleAssignment | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError(null);
    void Promise.all([
      listRoleAssignments(controller.signal),
      getOrganization(controller.signal),
      listRoleAssignmentCandidates(controller.signal),
    ])
      .then(([assignmentResult, organization, candidateResult]) => {
        setItems(assignmentResult.items);
        setMembers(organization.members);
        setRoleCandidates(candidateResult.items);
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) setLoadError(messageFromError(caught));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [reloadKey]);

  const eligibleMembers = useMemo(() => eligibleAssignmentMembers(members), [members]);
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return (items ?? []).filter((assignment) => {
      const matchesQuery =
        !normalized ||
        assignment.key.toLowerCase().includes(normalized) ||
        assignment.assignee.displayName.toLowerCase().includes(normalized) ||
        assignment.agent.name.toLowerCase().includes(normalized) ||
        assignment.agent.template.name.toLowerCase().includes(normalized);
      return matchesQuery && (status === 'ALL' || assignment.status === status);
    });
  }, [items, query, status]);

  const reload = (): void => setReloadKey((value) => value + 1);
  const createDisabled = eligibleMembers.length === 0 || roleCandidates.length === 0;

  return (
    <section className="page-section">
      <header className="page-header">
        <div>
          <span className="eyebrow">ROLE AGENT GOVERNANCE</span>
          <h1>角色任命</h1>
          <p>
            将已通过独立审核并发布的角色蓝图版本任命给企业成员，并管理任命来源、有效期与访问范围。
          </p>
        </div>
        <div className="page-actions">
          <button className="button secondary" type="button" onClick={reload} disabled={loading}>
            <Icon name="refresh" size={17} /> 刷新
          </button>
          <button
            className="button primary"
            type="button"
            aria-haspopup="dialog"
            onClick={() => setCreateOpen(true)}
            disabled={createDisabled}
            title={
              eligibleMembers.length === 0
                ? '需要至少一位账号启用且存在有效在职关系的成员'
                : roleCandidates.length === 0
                  ? '需要至少一个已通过审核并发布的角色蓝图版本'
                  : undefined
            }
          >
            <Icon name="plus" size={17} /> 新建任命
          </button>
        </div>
      </header>

      {notice ? (
        <Notice tone="success" onClose={() => setNotice(null)}>
          {notice}
        </Notice>
      ) : null}
      {loadError && items !== null ? (
        <Notice tone="error" onClose={() => setLoadError(null)}>
          刷新失败：{loadError}。当前仍显示上次成功加载的数据。
        </Notice>
      ) : null}
      {items !== null && eligibleMembers.length === 0 ? (
        <Notice tone="info">
          当前没有可任命的成员；成员账号和对应 employment 必须同时为 ACTIVE。
        </Notice>
      ) : null}
      {items !== null && roleCandidates.length === 0 ? (
        <Notice tone="info">
          当前没有可任命的角色蓝图版本；请先提交审核，由另一位管理员审批通过后再发布。
        </Notice>
      ) : null}

      {loading && items === null ? <LoadingPanel label="正在读取角色任命…" /> : null}
      {loadError && items === null ? <ErrorState message={loadError} onRetry={reload} /> : null}

      {items !== null ? (
        <div className="card table-card role-assignment-card">
          <div className="table-toolbar">
            <div className="search-input">
              <span aria-hidden="true">⌕</span>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索成员、Agent 或任命标识"
                aria-label="搜索角色任命"
              />
            </div>
            <select
              value={status}
              onChange={(event) => setStatus(event.target.value)}
              aria-label="按任命状态筛选"
            >
              <option value="ALL">全部状态</option>
              {ASSIGNMENT_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {roleAssignmentStatusLabel(value)}
                </option>
              ))}
            </select>
            <span className="table-count">
              显示 {filtered.length} / {items.length} 条任命
            </span>
          </div>

          {filtered.length === 0 ? (
            <EmptyState
              title={items.length === 0 ? '还没有角色任命' : '没有匹配的角色任命'}
              description={
                items.length === 0
                  ? '选择企业成员和已审核发布的角色蓝图版本，创建第一条有时效边界的任命。'
                  : '尝试更换搜索词或状态筛选条件。'
              }
              action={
                items.length === 0 && !createDisabled ? (
                  <button
                    className="button primary"
                    type="button"
                    aria-haspopup="dialog"
                    onClick={() => setCreateOpen(true)}
                  >
                    新建任命
                  </button>
                ) : undefined
              }
            />
          ) : (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>成员 / 任命标识</th>
                    <th>Agent 版本</th>
                    <th>来源与有效期</th>
                    <th>状态</th>
                    <th>创建信息</th>
                    <th>
                      <span className="sr-only">操作</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((assignment) => (
                    <tr key={assignment.id}>
                      <td>
                        <div className="person-cell">
                          <span className="avatar soft">
                            {assignment.assignee.displayName.slice(0, 1).toUpperCase()}
                          </span>
                          <span>
                            <strong>{assignment.assignee.displayName}</strong>
                            <code className="role-assignment-key">{assignment.key}</code>
                          </span>
                        </div>
                      </td>
                      <td>
                        <strong className="table-primary">{assignment.agent.name}</strong>
                        <small className="table-secondary">
                          {assignment.agent.template.name} · v{assignment.agent.version}
                        </small>
                      </td>
                      <td>
                        <strong className="table-primary">
                          {roleAssignmentSourceLabel(assignment.source)}
                        </strong>
                        <small className="table-secondary">
                          {formatRoleAssignmentPeriod(assignment)}
                        </small>
                      </td>
                      <td>
                        <StatusPill
                          value={assignment.status}
                          label={roleAssignmentStatusLabel(assignment.status)}
                        />
                        {assignment.revokedAt ? (
                          <small className="table-secondary">
                            {formatRoleAssignmentDate(assignment.revokedAt)} 撤销
                          </small>
                        ) : null}
                      </td>
                      <td>
                        <strong className="table-primary">
                          {assignment.createdBy.displayName}
                        </strong>
                        <small className="table-secondary">
                          {formatRoleAssignmentDate(assignment.createdAt)}
                        </small>
                      </td>
                      <td className="align-right">
                        {canRevokeRoleAssignment(assignment) ? (
                          <button
                            className="button compact danger-ghost"
                            type="button"
                            onClick={() => setRevoking(assignment)}
                          >
                            撤销
                          </button>
                        ) : (
                          <span className="table-secondary">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : null}

      {createOpen ? (
        <CreateRoleAssignmentModal
          members={eligibleMembers}
          roleCandidates={roleCandidates}
          onClose={() => setCreateOpen(false)}
          onCreated={(created) => {
            setCreateOpen(false);
            setItems((current) => (current === null ? [created] : [created, ...current]));
            setNotice(`已为 ${created.assignee.displayName} 创建角色任命。`);
          }}
        />
      ) : null}
      {revoking ? (
        <RevokeRoleAssignmentModal
          assignment={revoking}
          onClose={() => setRevoking(null)}
          onRevoked={(updated) => {
            setRevoking(null);
            setItems(
              (current) =>
                current?.map((item) => (item.id === updated.id ? updated : item)) ?? [updated],
            );
            setNotice(`已撤销 ${updated.assignee.displayName} 的角色任命。`);
          }}
        />
      ) : null}
    </section>
  );
}

function CreateRoleAssignmentModal({
  members,
  roleCandidates,
  onClose,
  onCreated,
}: {
  members: ReadonlyArray<EligibleAssignmentMember>;
  roleCandidates: ReadonlyArray<RoleAssignmentCandidate>;
  onClose: () => void;
  onCreated: (assignment: RoleAssignment) => void;
}): ReactNode {
  const [userId, setUserId] = useState(members[0]?.id ?? '');
  const [roleVersionId, setRoleVersionId] = useState(roleCandidates[0]?.id ?? '');
  const [agentName, setAgentName] = useState('');
  const [key, setKey] = useState('');
  const [source, setSource] = useState<CreateSource>('LOCAL');
  const [effectiveFrom, setEffectiveFrom] = useState(() => localDateTimeValue());
  const [effectiveTo, setEffectiveTo] = useState('');
  const [organizationScope, setOrganizationScope] = useState('{}');
  const [memoryPolicy, setMemoryPolicy] = useState('{}');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const member = members.find((item) => item.id === userId);
      if (!member) throw new Error('请选择一位账号和在职关系均有效的成员。');
      if (!roleCandidates.some((item) => item.id === roleVersionId)) {
        throw new Error('请选择一个已通过审核并发布的角色蓝图版本。');
      }
      const effectiveFromIso = localDateTimeToIso(effectiveFrom, '生效时间');
      const effectiveToIso = effectiveTo ? localDateTimeToIso(effectiveTo, '失效时间') : null;
      if (
        effectiveToIso !== null &&
        new Date(effectiveToIso).getTime() <= new Date(effectiveFromIso).getTime()
      ) {
        throw new Error('失效时间必须晚于生效时间。');
      }
      const input: CreateRoleAssignmentRequest = {
        userId,
        employmentId: member.employment.id,
        agentVersionId: roleVersionId,
        effectiveFrom: effectiveFromIso,
        effectiveTo: effectiveToIso,
        source,
        organizationScope: parseScopeJson(organizationScope, '组织范围'),
        permissionScope: {},
        memoryPolicy: parseScopeJson(memoryPolicy, '记忆策略'),
        ...(key.trim() ? { key } : {}),
        ...(agentName.trim() ? { agentName } : {}),
      };
      onCreated(await createRoleAssignment(input));
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title="新建角色任命"
      description="任命会为成员创建独立的角色 Agent 实例；只有已通过独立审核并发布的角色蓝图版本可被选择，提交时服务端仍会再次校验。"
      onClose={onClose}
      size="wide"
    >
      <form className="form-stack" onSubmit={(event) => void submit(event)}>
        <div className="form-grid two">
          <label>
            <span>企业成员</span>
            <select
              autoFocus
              required
              value={userId}
              onChange={(event) => setUserId(event.target.value)}
            >
              {members.map((member) => (
                <option key={member.id} value={member.id}>
                  {member.displayName} · {member.email}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>角色蓝图版本</span>
            <select
              required
              value={roleVersionId}
              onChange={(event) => setRoleVersionId(event.target.value)}
            >
              {roleCandidates.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.blueprint.name} · v{candidate.version}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="form-grid two">
          <label>
            <span>Agent 显示名称（可选）</span>
            <input
              value={agentName}
              maxLength={200}
              onChange={(event) => setAgentName(event.target.value)}
              placeholder="留空时由系统生成"
            />
          </label>
          <label>
            <span>任命标识（可选）</span>
            <input
              value={key}
              maxLength={160}
              onChange={(event) => setKey(event.target.value)}
              placeholder="例如 project:alpha:reviewer"
            />
          </label>
        </div>
        <div className="form-grid two">
          <label>
            <span>生效时间</span>
            <input
              required
              type="datetime-local"
              value={effectiveFrom}
              onChange={(event) => setEffectiveFrom(event.target.value)}
            />
          </label>
          <label>
            <span>失效时间（可选）</span>
            <input
              type="datetime-local"
              min={effectiveFrom}
              value={effectiveTo}
              onChange={(event) => setEffectiveTo(event.target.value)}
            />
          </label>
        </div>
        <label>
          <span>任命来源</span>
          <select
            value={source}
            onChange={(event) => setSource(event.target.value as CreateSource)}
          >
            {CREATE_SOURCES.map((value) => (
              <option key={value} value={value}>
                {roleAssignmentSourceLabel(value)}
              </option>
            ))}
          </select>
        </label>
        <details className="role-assignment-advanced">
          <summary>高级范围配置（JSON）</summary>
          <p>
            组织范围和记忆策略必须是 JSON
            对象。工具与数据权限只能来自已审核发布的角色蓝图版本，不能在任命时临时扩权。
          </p>
          <div className="form-grid role-assignment-json-grid">
            <label>
              <span>组织范围</span>
              <textarea
                spellCheck={false}
                value={organizationScope}
                onChange={(event) => setOrganizationScope(event.target.value)}
              />
            </label>
            <label>
              <span>记忆策略</span>
              <textarea
                spellCheck={false}
                value={memoryPolicy}
                onChange={(event) => setMemoryPolicy(event.target.value)}
              />
            </label>
          </div>
        </details>
        <FieldError message={error} />
        <div className="modal-actions">
          <button className="button secondary" type="button" onClick={onClose}>
            取消
          </button>
          <button
            className="button primary"
            type="submit"
            disabled={submitting || !userId || !roleVersionId}
          >
            {submitting ? <Spinner label="正在创建任命…" /> : '创建任命'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function RevokeRoleAssignmentModal({
  assignment,
  onClose,
  onRevoked,
}: {
  assignment: RoleAssignment;
  onClose: () => void;
  onRevoked: (assignment: RoleAssignment) => void;
}): ReactNode {
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      onRevoked(
        await revokeRoleAssignment(assignment.id, {
          reason,
          expectedUpdatedAt: assignment.updatedAt,
        }),
      );
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title="撤销角色任命"
      description={`撤销 ${assignment.assignee.displayName} 的“${assignment.agent.name}”任命。`}
      onClose={onClose}
    >
      <form className="form-stack" onSubmit={(event) => void submit(event)}>
        <Notice tone="info">
          撤销后该角色 Agent 将停止继续生效。系统会校验当前版本，若任命已被他人修改，请刷新后重试。
        </Notice>
        <label>
          <span>撤销原因</span>
          <textarea
            autoFocus
            required
            maxLength={500}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="请说明撤销原因，便于审计追踪"
          />
        </label>
        <FieldError message={error} />
        <div className="modal-actions">
          <button className="button secondary" type="button" onClick={onClose}>
            取消
          </button>
          <button
            className="button danger-ghost"
            type="submit"
            disabled={submitting || !reason.trim()}
          >
            {submitting ? <Spinner label="正在撤销…" /> : '确认撤销'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
