import type { RoleAssignment, RoleDefinitionSnapshot } from '@enterprise/contracts';

import {
  agentRuntimeLabel,
  formatRoleTerm,
  formatScope,
  groupRoleAssignments,
  roleAgentAvailability,
  roleSourceLabel,
  roleStatusLabel,
  versionStatusLabel,
  type RoleAssignmentGroup,
} from './role-assignment-view';

interface RoleSidebarProps {
  assignments: RoleAssignment[] | undefined;
  selectedAssignmentId: string | null;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  onSelect: (assignmentId: string) => void;
  onRetry: () => void;
}

export function RoleSidebar({
  assignments,
  selectedAssignmentId,
  isLoading,
  isError,
  error,
  onSelect,
  onRetry,
}: RoleSidebarProps): React.JSX.Element {
  const groups = groupRoleAssignments(assignments ?? []);
  return (
    <aside className="directory-sidebar module-sidebar role-sidebar" aria-label="我的角色">
      <header className="role-sidebar-header">
        <div>
          <p className="eyebrow">Role workbench</p>
          <h1>我的角色</h1>
        </div>
        <button type="button" className="role-refresh" onClick={onRetry} disabled={isLoading}>
          {isLoading ? '刷新中…' : '刷新'}
        </button>
      </header>

      <p className="role-sidebar-intro">
        查看任命状态，并进入当前可使用的角色 Agent。最多显示最近 200 条任命。
      </p>

      {isError && (
        <div className="role-sidebar-error" role="alert">
          <strong>角色列表刷新失败</strong>
          <span>{readableError(error)}</span>
        </div>
      )}
      {isLoading && assignments === undefined ? (
        <div className="role-sidebar-loading" role="status">
          正在读取角色任命…
        </div>
      ) : (
        <div className="role-groups">
          <RoleGroup
            title="当前角色"
            group="current"
            items={groups.current}
            selectedAssignmentId={selectedAssignmentId}
            onSelect={onSelect}
          />
          <RoleGroup
            title="待生效"
            group="pending"
            items={groups.pending}
            selectedAssignmentId={selectedAssignmentId}
            onSelect={onSelect}
          />
          <RoleGroup
            title="历史记录"
            group="history"
            items={groups.history}
            selectedAssignmentId={selectedAssignmentId}
            onSelect={onSelect}
          />
        </div>
      )}
    </aside>
  );
}

interface RoleGroupProps {
  title: string;
  group: RoleAssignmentGroup;
  items: RoleAssignment[];
  selectedAssignmentId: string | null;
  onSelect: (assignmentId: string) => void;
}

function RoleGroup({
  title,
  group,
  items,
  selectedAssignmentId,
  onSelect,
}: RoleGroupProps): React.JSX.Element {
  return (
    <section className={`role-group ${group}`}>
      <header>
        <strong>{title}</strong>
        <span>{items.length}</span>
      </header>
      {items.length === 0 ? (
        <p className="role-group-empty">暂无记录</p>
      ) : (
        items.map((assignment) => (
          <button
            type="button"
            key={assignment.id}
            className={
              assignment.id === selectedAssignmentId ? 'role-list-item selected' : 'role-list-item'
            }
            aria-current={assignment.id === selectedAssignmentId ? 'true' : undefined}
            onClick={() => onSelect(assignment.id)}
          >
            <span className="role-list-mark" aria-hidden="true">
              角
            </span>
            <span>
              <strong>{assignment.agent.template.name}</strong>
              <small>{assignment.agent.name}</small>
              <em>{agentRuntimeLabel(assignment)}</em>
            </span>
            <i className={`role-state-dot ${group}`} title={roleStatusLabel(assignment)} />
          </button>
        ))
      )}
    </section>
  );
}

export interface RoleAgentOperation {
  assignmentId: string;
  status: 'pending' | 'error';
  message?: string | undefined;
}

interface RoleWorkspaceProps {
  assignment: RoleAssignment | null;
  isLoading: boolean;
  operation: RoleAgentOperation | null;
  onOpenAgent: (assignment: RoleAssignment) => void;
  onRetryAgent: () => void;
}

export function RoleWorkspace({
  assignment,
  isLoading,
  operation,
  onOpenAgent,
  onRetryAgent,
}: RoleWorkspaceProps): React.JSX.Element {
  if (isLoading && assignment === null) {
    return (
      <RoleEmpty title="正在加载角色" description="正在读取当前账号的角色任命与 Agent 状态…" />
    );
  }
  if (assignment === null) {
    return (
      <RoleEmpty
        title="暂无角色任命"
        description="当前账号还没有可展示的角色。角色由企业管理员完成任命后出现在这里。"
      />
    );
  }

  const availability = roleAgentAvailability(assignment);
  const opening = operation?.assignmentId === assignment.id && operation.status === 'pending';
  const openError =
    operation?.assignmentId === assignment.id && operation.status === 'error'
      ? operation.message
      : undefined;
  const definitionSnapshot = assignment.roleDefinitionSnapshot;

  return (
    <article className="role-workspace" aria-labelledby="role-workspace-title">
      <header className="role-hero">
        <div className="role-hero-icon" aria-hidden="true">
          角
        </div>
        <div className="role-hero-copy">
          <p className="eyebrow">{assignment.agent.template.key}</p>
          <h1 id="role-workspace-title">{assignment.agent.template.name}</h1>
          <div className="role-hero-badges">
            <span className={`role-badge ${roleAssignmentGroupClass(assignment)}`}>
              {roleStatusLabel(assignment)}
            </span>
            <span className={`role-badge agent-${assignment.agent.status.toLowerCase()}`}>
              {agentRuntimeLabel(assignment)}
            </span>
            <span className="role-badge neutral">{roleSourceLabel(assignment.source)}</span>
          </div>
          <p>{formatRoleTerm(assignment)}</p>
        </div>
        <div className="role-hero-action">
          <button
            type="button"
            className="primary-button role-open-agent"
            disabled={!availability.available || opening}
            title={availability.reason}
            onClick={() => onOpenAgent(assignment)}
          >
            {opening ? '正在进入…' : '进入角色 Agent'}
          </button>
          <small>{availability.reason}</small>
        </div>
      </header>

      {openError && (
        <div className="role-open-error" role="alert">
          <div>
            <strong>无法进入角色 Agent</strong>
            <span>{openError}</span>
          </div>
          <button type="button" onClick={onRetryAgent}>
            重试
          </button>
        </div>
      )}

      <div className="role-detail-grid">
        <RoleDefinitionCards snapshot={definitionSnapshot} />

        <section className="role-detail-card">
          <header>
            <span aria-hidden="true">版</span>
            <div>
              <p className="eyebrow">Runtime</p>
              <h2>Agent 与版本</h2>
            </div>
          </header>
          <dl>
            <div>
              <dt>Agent 状态</dt>
              <dd>{agentRuntimeLabel(assignment)}</dd>
            </div>
            <div>
              <dt>角色版本</dt>
              <dd>
                v{assignment.agent.version} · {versionStatusLabel(assignment.agent.versionStatus)}
              </dd>
            </div>
            <div>
              <dt>蓝图修订</dt>
              <dd>r{assignment.blueprintRevision} · 任命时快照</dd>
            </div>
            <div>
              <dt>任命编号</dt>
              <dd>
                <code>{assignment.key}</code>
              </dd>
            </div>
          </dl>
        </section>

        <section className="role-detail-card scope-card">
          <header>
            <span aria-hidden="true">权</span>
            <div>
              <p className="eyebrow">Server-enforced scope</p>
              <h2>权限范围</h2>
            </div>
          </header>
          <pre>
            {formatScope(
              assignment.permissionScope,
              '未返回可展示的权限范围；实际访问仍由服务端策略校验。',
            )}
          </pre>
        </section>

        <section className="role-detail-card scope-card">
          <header>
            <span aria-hidden="true">组</span>
            <div>
              <p className="eyebrow">Organization scope</p>
              <h2>组织范围</h2>
            </div>
          </header>
          <pre>{formatScope(assignment.organizationScope, '未设置任命级组织范围。')}</pre>
        </section>

        <section className="role-detail-card role-audit-card">
          <header>
            <span aria-hidden="true">源</span>
            <div>
              <p className="eyebrow">Assignment provenance</p>
              <h2>任命来源与期限</h2>
            </div>
          </header>
          <dl>
            <div>
              <dt>来源</dt>
              <dd>{roleSourceLabel(assignment.source)}</dd>
            </div>
            <div>
              <dt>有效期</dt>
              <dd>{formatRoleTerm(assignment)}</dd>
            </div>
            <div>
              <dt>任命人</dt>
              <dd>{assignment.createdBy.displayName}</dd>
            </div>
            {assignment.revokeReason !== null && (
              <div>
                <dt>撤销原因</dt>
                <dd>{assignment.revokeReason}</dd>
              </div>
            )}
          </dl>
        </section>
      </div>
    </article>
  );
}

function RoleDefinitionCards({
  snapshot,
}: {
  snapshot: RoleDefinitionSnapshot | null;
}): React.JSX.Element {
  if (snapshot === null) {
    return (
      <section className="role-detail-card role-wide-card role-legacy-definition" role="note">
        <header>
          <span aria-hidden="true">史</span>
          <div>
            <p className="eyebrow">Immutable role definition</p>
            <h2>历史版本未结构化</h2>
          </div>
        </header>
        <p>
          此任命创建时尚未保存版本化角色定义快照，因此无法还原当时的使命、职责与治理边界。为避免把可变的当前角色蓝图冒充历史版本，这里不会读取当前模板补全内容。
        </p>
      </section>
    );
  }

  return (
    <>
      <section className="role-detail-card role-wide-card role-definition-overview">
        <header>
          <span aria-hidden="true">使</span>
          <div>
            <p className="eyebrow">Versioned role definition</p>
            <h2>使命</h2>
          </div>
        </header>
        <p className="role-definition-mission">{snapshot.mission}</p>
      </section>

      <section className="role-detail-card role-wide-card role-definition-card">
        <header>
          <span aria-hidden="true">责</span>
          <div>
            <p className="eyebrow">Responsibilities & outcomes</p>
            <h2>职责与成果</h2>
          </div>
        </header>
        <div className="role-definition-list">
          {snapshot.responsibilities.map((responsibility) => (
            <article className="role-definition-entry" key={responsibility.key}>
              <div className="role-definition-entry-title">
                <strong>{responsibility.name}</strong>
                <code>{responsibility.key}</code>
              </div>
              <p>{responsibility.description}</p>
              <div className="role-definition-outcomes">
                <span>预期成果</span>
                {responsibility.outcomes.length > 0 ? (
                  <ul>
                    {responsibility.outcomes.map((outcome, index) => (
                      <li key={`${outcome}-${index}`}>{outcome}</li>
                    ))}
                  </ul>
                ) : (
                  <small>该版本未定义预期成果。</small>
                )}
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="role-detail-card role-wide-card role-value-card">
        <header>
          <span aria-hidden="true">值</span>
          <div>
            <p className="eyebrow">Value & measures</p>
            <h2>价值与衡量</h2>
          </div>
        </header>
        <div className="role-value-grid">
          <article>
            <strong>价值主张</strong>
            <p>{snapshot.valueDefinition.statement}</p>
          </article>
          <RoleDefinitionStringList
            title="利益相关方成果"
            items={snapshot.valueDefinition.stakeholderOutcomes}
            empty="该版本未定义利益相关方成果。"
          />
          <RoleDefinitionStringList
            title="衡量指标"
            items={snapshot.valueDefinition.measures}
            empty="该版本未定义衡量指标。"
          />
        </div>
      </section>

      <RoleDefinitionCollection
        icon="能"
        eyebrow="Capabilities"
        title="能力"
        items={snapshot.capabilities}
        empty="该版本未定义能力要求。"
        meta={(capability) =>
          capability.level ? capabilityLevelLabel(capability.level) : '未指定能力级别'
        }
      />
      <RoleDefinitionCollection
        icon="流"
        eyebrow="Processes"
        title="流程"
        items={snapshot.processes}
        empty="该版本未定义负责流程。"
        meta={(process) => processResponsibilityLabel(process.responsibility)}
      />
      <RoleDefinitionCollection
        icon="工"
        eyebrow="Tool permissions"
        title="工具权限"
        items={snapshot.tools}
        empty="该版本未定义工具权限。"
        meta={(tool) => toolAccessLabel(tool.access)}
      />
      <RoleDefinitionCollection
        icon="知"
        eyebrow="Knowledge domains"
        title="知识域"
        items={snapshot.knowledgeDomains}
        empty="该版本未定义知识域。"
        meta={(domain) => knowledgeSensitivityLabel(domain.sensitivity)}
      />
    </>
  );
}

function RoleDefinitionCollection<T extends { key: string; name: string; description: string }>({
  icon,
  eyebrow,
  title,
  items,
  empty,
  meta,
}: {
  icon: string;
  eyebrow: string;
  title: string;
  items: readonly T[];
  empty: string;
  meta: (item: T) => string;
}): React.JSX.Element {
  return (
    <section className="role-detail-card role-definition-card">
      <header>
        <span aria-hidden="true">{icon}</span>
        <div>
          <p className="eyebrow">{eyebrow}</p>
          <h2>{title}</h2>
        </div>
      </header>
      {items.length > 0 ? (
        <div className="role-definition-list compact">
          {items.map((item) => (
            <article className="role-definition-entry" key={item.key}>
              <div className="role-definition-entry-title">
                <strong>{item.name}</strong>
                <span className="role-definition-meta">{meta(item)}</span>
              </div>
              <p>{item.description}</p>
              <code>{item.key}</code>
            </article>
          ))}
        </div>
      ) : (
        <p className="role-definition-empty">{empty}</p>
      )}
    </section>
  );
}

function RoleDefinitionStringList({
  title,
  items,
  empty,
}: {
  title: string;
  items: readonly string[];
  empty: string;
}): React.JSX.Element {
  return (
    <article>
      <strong>{title}</strong>
      {items.length > 0 ? (
        <ul>
          {items.map((item, index) => (
            <li key={`${item}-${index}`}>{item}</li>
          ))}
        </ul>
      ) : (
        <p>{empty}</p>
      )}
    </article>
  );
}

function capabilityLevelLabel(value: string): string {
  return (
    {
      FOUNDATIONAL: '基础',
      PRACTITIONER: '熟练',
      ADVANCED: '高级',
      EXPERT: '专家',
    }[value] ?? value
  );
}

function processResponsibilityLabel(value: string): string {
  return (
    {
      OWNER: '负责',
      APPROVER: '审批',
      CONTRIBUTOR: '参与',
      OBSERVER: '观察',
    }[value] ?? value
  );
}

function toolAccessLabel(value: string): string {
  return (
    {
      READ: '只读',
      DRAFT: '草拟',
      EXECUTE: '执行',
      APPROVAL_REQUIRED: '需审批',
    }[value] ?? value
  );
}

function knowledgeSensitivityLabel(value: string): string {
  return (
    {
      PUBLIC: '公开',
      INTERNAL: '内部',
      CONFIDENTIAL: '机密',
      RESTRICTED: '严格限制',
    }[value] ?? value
  );
}

function RoleEmpty({
  title,
  description,
}: {
  title: string;
  description: string;
}): React.JSX.Element {
  return (
    <div className="role-empty">
      <span aria-hidden="true">角</span>
      <h1>{title}</h1>
      <p>{description}</p>
    </div>
  );
}

function roleAssignmentGroupClass(assignment: RoleAssignment): RoleAssignmentGroup {
  const groups = groupRoleAssignments([assignment]);
  if (groups.current.length > 0) return 'current';
  if (groups.pending.length > 0) return 'pending';
  return 'history';
}

function readableError(error: unknown): string {
  return error instanceof Error ? error.message : '请稍后重试。';
}
