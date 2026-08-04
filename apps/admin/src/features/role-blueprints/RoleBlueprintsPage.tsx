import type { RoleBlueprint, RoleVersion } from '@enterprise/contracts';
import { useEffect, useMemo, useState, type ReactNode } from 'react';

import { listRoleBlueprints } from '@/api/admin-api';
import { messageFromError } from '@/api/client';
import { Icon } from '@/components/Icons';
import { EmptyState, ErrorState, LoadingPanel, Notice, StatusPill } from '@/components/ui';

import { RoleBlueprintEditor } from './RoleBlueprintEditor';
import {
  RoleVersionEditor,
  RoleVersionReviewModal,
  RoleVersionRollbackModal,
  RoleVersionTransitionModal,
  type RoleVersionTransitionAction,
} from './RoleVersionModals';
import {
  currentPublishedVersionId,
  diffRoleVersions,
  formatJsonObject,
  formatRoleBlueprintDate,
  roleVersionActions,
  roleVersionDiffKindLabel,
  roleVersionDiffSectionLabel,
  roleVersionReviewLabel,
  roleVersionStageDescription,
  roleVersionStatusLabel,
} from './role-blueprint-view';

interface TransitionTarget {
  version: RoleVersion;
  action: RoleVersionTransitionAction;
}

export function RoleBlueprintsPage({ currentUserId }: { currentUserId: string }): ReactNode {
  const [items, setItems] = useState<RoleBlueprint[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [editingBlueprint, setEditingBlueprint] = useState<RoleBlueprint | null | undefined>(
    undefined,
  );
  const [editingVersion, setEditingVersion] = useState<RoleVersion | null | undefined>(undefined);
  const [reviewingVersion, setReviewingVersion] = useState<RoleVersion | null>(null);
  const [transitionTarget, setTransitionTarget] = useState<TransitionTarget | null>(null);
  const [rollbackVersion, setRollbackVersion] = useState<RoleVersion | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError(null);
    void listRoleBlueprints(controller.signal)
      .then((result) => {
        setItems(result.items);
        setSelectedId((current) =>
          current && result.items.some((item) => item.id === current)
            ? current
            : (result.items[0]?.id ?? null),
        );
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) setLoadError(messageFromError(caught));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [reloadKey]);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return (items ?? []).filter(
      (item) =>
        !normalized ||
        item.name.toLowerCase().includes(normalized) ||
        item.key.toLowerCase().includes(normalized) ||
        item.mission.toLowerCase().includes(normalized),
    );
  }, [items, query]);
  const selected = items?.find((item) => item.id === selectedId) ?? null;
  const reload = (): void => setReloadKey((value) => value + 1);

  const completedVersionAction = (message: string): void => {
    setEditingVersion(undefined);
    setReviewingVersion(null);
    setTransitionTarget(null);
    setRollbackVersion(null);
    setNotice(message);
    setItems(null);
    reload();
  };

  return (
    <section className="page-section role-blueprints-page">
      <header className="page-header">
        <div>
          <span className="eyebrow">ROLE BLUEPRINT GOVERNANCE</span>
          <h1>角色蓝图</h1>
          <p>结构化定义企业角色，并通过独立审核、发布、停用与回滚治理 Agent 版本。</p>
        </div>
        <div className="page-actions">
          <button className="button secondary" type="button" onClick={reload} disabled={loading}>
            <Icon name="refresh" size={17} /> 刷新
          </button>
          <button
            className="button primary"
            type="button"
            onClick={() => setEditingBlueprint(null)}
          >
            <Icon name="plus" size={17} /> 新建蓝图
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
      {loading && items === null ? <LoadingPanel label="正在读取角色蓝图…" /> : null}
      {loadError && items === null ? <ErrorState message={loadError} onRetry={reload} /> : null}

      {items !== null ? (
        items.length === 0 ? (
          <div className="card">
            <EmptyState
              title="还没有角色蓝图"
              description="从使命、职责和价值定义开始，创建第一个受治理的企业角色。"
              action={
                <button
                  className="button primary"
                  type="button"
                  onClick={() => setEditingBlueprint(null)}
                >
                  新建角色蓝图
                </button>
              }
            />
          </div>
        ) : (
          <div className="role-blueprint-layout">
            <aside className="card role-blueprint-index" aria-label="角色蓝图列表">
              <header>
                <div>
                  <strong>蓝图目录</strong>
                  <small>{items.length} 个角色</small>
                </div>
                <div className="search-input">
                  <span aria-hidden="true">⌕</span>
                  <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="搜索角色或使命"
                    aria-label="搜索角色蓝图"
                  />
                </div>
              </header>
              <div className="role-blueprint-list">
                {filtered.map((blueprint) => {
                  const published = currentPublishedVersionId(blueprint);
                  const drafts = blueprint.versions.filter(
                    (version) => version.status === 'DRAFT',
                  ).length;
                  return (
                    <button
                      type="button"
                      key={blueprint.id}
                      className={blueprint.id === selectedId ? 'selected' : ''}
                      aria-current={blueprint.id === selectedId ? 'true' : undefined}
                      onClick={() => setSelectedId(blueprint.id)}
                    >
                      <span className="role-blueprint-mark" aria-hidden="true">
                        角
                      </span>
                      <span>
                        <strong>{blueprint.name}</strong>
                        <code>{blueprint.key}</code>
                        <small>
                          {published ? '存在已发布版本' : '尚未发布'}
                          {drafts > 0 ? ` · ${drafts} 个草稿` : ''}
                        </small>
                      </span>
                    </button>
                  );
                })}
                {filtered.length === 0 ? (
                  <p className="role-blueprint-no-match">没有匹配的角色蓝图。</p>
                ) : null}
              </div>
            </aside>

            {selected ? (
              <RoleBlueprintDetail
                blueprint={selected}
                currentUserId={currentUserId}
                onEditBlueprint={() => setEditingBlueprint(selected)}
                onCreateDraft={() => setEditingVersion(null)}
                onEditVersion={(version) => setEditingVersion(version)}
                onReview={(version) => setReviewingVersion(version)}
                onTransition={(version, action) => setTransitionTarget({ version, action })}
                onRollback={(version) => setRollbackVersion(version)}
              />
            ) : (
              <div className="card">
                <EmptyState
                  title="选择一个角色蓝图"
                  description="从左侧目录选择角色以查看结构化定义和版本治理状态。"
                />
              </div>
            )}
          </div>
        )
      ) : null}

      {editingBlueprint !== undefined ? (
        <RoleBlueprintEditor
          blueprint={editingBlueprint}
          onClose={() => setEditingBlueprint(undefined)}
          onSaved={(saved, created) => {
            setEditingBlueprint(undefined);
            setItems((current) => {
              if (current === null) return [saved];
              const exists = current.some((item) => item.id === saved.id);
              return exists
                ? current.map((item) => (item.id === saved.id ? saved : item))
                : [...current, saved].toSorted((left, right) =>
                    left.name.localeCompare(right.name, 'zh-CN'),
                  );
            });
            setSelectedId(saved.id);
            setNotice(created ? `已创建角色蓝图“${saved.name}”。` : `已保存“${saved.name}”。`);
          }}
        />
      ) : null}

      {selected && editingVersion !== undefined ? (
        <RoleVersionEditor
          blueprint={selected}
          version={editingVersion}
          sourceVersion={
            selected.versions.find(
              (version) => version.id === currentPublishedVersionId(selected),
            ) ?? null
          }
          onClose={() => setEditingVersion(undefined)}
          onSaved={(version, created) =>
            completedVersionAction(
              created ? `已创建 v${version.version} 草稿。` : `已保存 v${version.version} 草稿。`,
            )
          }
        />
      ) : null}

      {selected && reviewingVersion ? (
        <RoleVersionReviewModal
          blueprint={selected}
          version={reviewingVersion}
          onClose={() => setReviewingVersion(null)}
          onSaved={(version) =>
            completedVersionAction(
              version.reviewStatus === 'APPROVED'
                ? `v${version.version} 已通过独立审核。`
                : `v${version.version} 已退回修改。`,
            )
          }
        />
      ) : null}

      {selected && transitionTarget ? (
        <RoleVersionTransitionModal
          blueprint={selected}
          version={transitionTarget.version}
          action={transitionTarget.action}
          onClose={() => setTransitionTarget(null)}
          onSaved={(version) => {
            const label = {
              submit: '已提交审核',
              publish: '已发布',
              retire: '已停用',
            }[transitionTarget.action];
            completedVersionAction(`v${version.version} ${label}。`);
          }}
        />
      ) : null}

      {selected && rollbackVersion ? (
        <RoleVersionRollbackModal
          blueprint={selected}
          sourceVersion={rollbackVersion}
          expectedPublishedVersionId={currentPublishedVersionId(selected)}
          onClose={() => setRollbackVersion(null)}
          onSaved={(version) =>
            completedVersionAction(
              `已创建 v${version.version} 回滚草稿；请提交审核，由另一位管理员审批后再发布。`,
            )
          }
        />
      ) : null}
    </section>
  );
}

export function RoleBlueprintDetail({
  blueprint,
  currentUserId,
  onEditBlueprint,
  onCreateDraft,
  onEditVersion,
  onReview,
  onTransition,
  onRollback,
}: {
  blueprint: RoleBlueprint;
  currentUserId: string;
  onEditBlueprint: () => void;
  onCreateDraft: () => void;
  onEditVersion: (version: RoleVersion) => void;
  onReview: (version: RoleVersion) => void;
  onTransition: (version: RoleVersion, action: RoleVersionTransitionAction) => void;
  onRollback: (version: RoleVersion) => void;
}): ReactNode {
  const publishedVersionId = currentPublishedVersionId(blueprint);
  return (
    <article className="role-blueprint-detail">
      <header className="card role-blueprint-hero">
        <div className="role-blueprint-hero-mark" aria-hidden="true">
          角
        </div>
        <div>
          <span className="eyebrow">{blueprint.key}</span>
          <h2>{blueprint.name}</h2>
          <p>{blueprint.description ?? '未填写角色说明。'}</p>
          <small>
            蓝图修订 r{blueprint.revision} · 更新于 {formatRoleBlueprintDate(blueprint.updatedAt)}
          </small>
        </div>
        <div className="role-blueprint-hero-actions">
          <button className="button secondary" type="button" onClick={onEditBlueprint}>
            编辑结构定义
          </button>
          <button className="button primary" type="button" onClick={onCreateDraft}>
            <Icon name="plus" size={16} /> 创建版本草稿
          </button>
        </div>
      </header>

      <section className="card role-definition-card">
        <header>
          <div>
            <span className="eyebrow">STRUCTURED ROLE</span>
            <h3>使命与价值</h3>
          </div>
        </header>
        <div className="role-mission-panel">
          <strong>使命</strong>
          <p>{blueprint.mission}</p>
        </div>
        <div className="role-value-grid">
          <div>
            <strong>价值主张</strong>
            <p>{blueprint.valueDefinition.statement}</p>
          </div>
          <div>
            <strong>利益相关方结果</strong>
            <StringList items={blueprint.valueDefinition.stakeholderOutcomes} />
          </div>
          <div>
            <strong>衡量指标</strong>
            <StringList items={blueprint.valueDefinition.measures} empty="未定义衡量指标" />
          </div>
        </div>
      </section>

      <div className="role-definition-grid">
        <DefinitionCollection
          title="职责"
          items={blueprint.responsibilities}
          detail={(item) =>
            item.outcomes.length > 0 ? `结果：${item.outcomes.join('；')}` : '未定义预期结果'
          }
        />
        <DefinitionCollection
          title="能力"
          items={blueprint.capabilities}
          detail={(item) =>
            item.level ? `级别：${capabilityLevelLabel(item.level)}` : '未指定级别'
          }
        />
        <DefinitionCollection
          title="流程"
          items={blueprint.processes}
          detail={(item) => `责任：${processResponsibilityLabel(item.responsibility)}`}
        />
        <DefinitionCollection
          title="工具"
          items={blueprint.tools}
          detail={(item) => `访问：${toolAccessLabel(item.access)}`}
        />
        <DefinitionCollection
          title="知识域"
          items={blueprint.knowledgeDomains}
          detail={(item) => `敏感级别：${sensitivityLabel(item.sensitivity)}`}
        />
      </div>

      <section className="card role-version-governance">
        <header>
          <div>
            <span className="eyebrow">VERSION GOVERNANCE</span>
            <h3>角色版本</h3>
            <p>所有状态均来自服务端；版本操作完成后会重新加载。</p>
          </div>
          <span>{blueprint.versions.length} 个版本</span>
        </header>
        {blueprint.versions.length === 0 ? (
          <EmptyState
            title="还没有角色版本"
            description="创建草稿，完成独立审核后才能发布并用于角色任命。"
            action={
              <button className="button primary" type="button" onClick={onCreateDraft}>
                创建版本草稿
              </button>
            }
          />
        ) : (
          <div className="role-version-list">
            {blueprint.versions.map((version) => {
              const actions = roleVersionActions(version, currentUserId, publishedVersionId);
              return (
                <article className="role-version-card" key={version.id}>
                  <header>
                    <div className="role-version-title">
                      <span>v{version.version}</span>
                      <div>
                        <strong>{version.changeSummary ?? '未填写变更摘要'}</strong>
                        <small>
                          {formatRoleBlueprintDate(version.createdAt)} 创建 · 蓝图修订 r
                          {version.blueprintRevision}
                        </small>
                      </div>
                    </div>
                    <div className="role-version-statuses">
                      <StatusPill
                        value={version.status}
                        label={roleVersionStatusLabel(version.status)}
                      />
                      <StatusPill
                        value={version.reviewStatus}
                        label={roleVersionReviewLabel(version.reviewStatus)}
                      />
                    </div>
                  </header>
                  <p className="role-version-stage">{roleVersionStageDescription(version)}</p>
                  {actions.reviewBlockedForAuthor ? (
                    <div className="role-two-person-warning" role="status">
                      <strong>等待另一位管理员审核</strong>
                      <span>
                        双人审批要求版本作者不能审核自己的版本，请切换到另一位企业所有者或管理员账号。
                      </span>
                    </div>
                  ) : null}
                  {version.reviewComment ? (
                    <blockquote>
                      <strong>审核意见</strong>
                      <p>{version.reviewComment}</p>
                    </blockquote>
                  ) : null}
                  {version.rollbackOfVersionId ? (
                    <p className="role-rollback-origin">
                      回滚来源：<code>{version.rollbackOfVersionId}</code>
                    </p>
                  ) : null}
                  <RoleVersionDiffPanel version={version} versions={blueprint.versions} />
                  <details className="role-version-config">
                    <summary>查看运行配置</summary>
                    <div>
                      <section>
                        <strong>系统提示词</strong>
                        <pre>{version.systemPrompt}</pre>
                      </section>
                      <section>
                        <strong>模型策略</strong>
                        <pre>{formatJsonObject(version.modelPolicy)}</pre>
                      </section>
                      <section>
                        <strong>工具策略</strong>
                        <pre>{formatJsonObject(version.toolPolicy)}</pre>
                      </section>
                      <section>
                        <strong>知识范围</strong>
                        <pre>{formatJsonObject(version.knowledgeScope)}</pre>
                      </section>
                    </div>
                  </details>
                  <footer>
                    {actions.canEdit ? (
                      <button
                        className="button compact secondary"
                        type="button"
                        onClick={() => onEditVersion(version)}
                      >
                        编辑草稿
                      </button>
                    ) : null}
                    {actions.canSubmit ? (
                      <button
                        className="button compact primary"
                        type="button"
                        onClick={() => onTransition(version, 'submit')}
                      >
                        提交审核
                      </button>
                    ) : null}
                    {actions.canReview ? (
                      <button
                        className="button compact primary"
                        type="button"
                        onClick={() => onReview(version)}
                      >
                        审批 / 退回
                      </button>
                    ) : null}
                    {actions.canPublish ? (
                      <button
                        className="button compact primary"
                        type="button"
                        onClick={() => onTransition(version, 'publish')}
                      >
                        发布
                      </button>
                    ) : null}
                    {actions.canRetire ? (
                      <button
                        className="button compact danger-ghost"
                        type="button"
                        onClick={() => onTransition(version, 'retire')}
                      >
                        停用
                      </button>
                    ) : null}
                    {actions.canRollback ? (
                      <button
                        className="button compact secondary"
                        type="button"
                        onClick={() => onRollback(version)}
                      >
                        回滚至此版本
                      </button>
                    ) : null}
                  </footer>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </article>
  );
}

function RoleVersionDiffPanel({
  version,
  versions,
}: {
  version: RoleVersion;
  versions: ReadonlyArray<RoleVersion>;
}): ReactNode {
  const baselines = useMemo(
    () =>
      versions
        .filter((candidate) => candidate.id !== version.id)
        .toSorted((left, right) => right.version - left.version),
    [version.id, versions],
  );
  const suggestedBaseline =
    baselines.find((candidate) => candidate.version < version.version) ??
    baselines.toSorted(
      (left, right) =>
        Math.abs(left.version - version.version) - Math.abs(right.version - version.version),
    )[0] ??
    null;
  const [baselineId, setBaselineId] = useState(suggestedBaseline?.id ?? '');
  const baseline =
    baselines.find((candidate) => candidate.id === baselineId) ?? suggestedBaseline ?? null;
  const changes = useMemo(
    () => (baseline ? diffRoleVersions(baseline, version) : []),
    [baseline, version],
  );

  return (
    <details className="role-version-diff">
      <summary>
        查看历史差异
        <span>
          {baseline ? `${changes.length} 项 · 蓝图 r${version.blueprintRevision}` : '首个版本'}
        </span>
      </summary>
      {baseline ? (
        <div className="role-version-diff-body">
          <div className="role-version-diff-toolbar">
            <div>
              <strong>
                v{baseline.version} → v{version.version}
              </strong>
              <small>
                蓝图修订 r{baseline.blueprintRevision} → r{version.blueprintRevision}
              </small>
            </div>
            <label>
              <span>比较基准</span>
              <select
                value={baseline.id}
                onChange={(event) => setBaselineId(event.target.value)}
                aria-label={`选择 v${version.version} 的比较基准`}
              >
                {baselines.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    v{candidate.version} · 蓝图 r{candidate.blueprintRevision}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {changes.length > 0 ? (
            <div className="role-version-diff-list">
              {changes.map((change) => (
                <article className={`role-version-diff-item ${change.kind}`} key={change.id}>
                  <header>
                    <span>{roleVersionDiffKindLabel(change.kind)}</span>
                    <div>
                      <strong>{change.label}</strong>
                      <small>{roleVersionDiffSectionLabel(change.section)}</small>
                    </div>
                  </header>
                  <div className="role-version-diff-values">
                    {change.before !== null ? (
                      <section>
                        <strong>基准值</strong>
                        <pre>{change.before}</pre>
                      </section>
                    ) : null}
                    {change.after !== null ? (
                      <section>
                        <strong>当前值</strong>
                        <pre>{change.after}</pre>
                      </section>
                    ) : null}
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <p className="role-version-diff-empty">与所选基准相比没有字段变化。</p>
          )}
        </div>
      ) : (
        <p className="role-version-diff-empty">
          这是该角色蓝图的首个版本，暂无其他历史版本可作为比较基准。
        </p>
      )}
    </details>
  );
}

function DefinitionCollection<T extends { key: string; name: string; description: string }>({
  title,
  items,
  detail,
}: {
  title: string;
  items: ReadonlyArray<T>;
  detail: (item: T) => string;
}): ReactNode {
  return (
    <section className="card role-definition-collection">
      <header>
        <h3>{title}</h3>
        <span>{items.length}</span>
      </header>
      {items.length === 0 ? (
        <p className="role-definition-empty">未定义{title}。</p>
      ) : (
        <div>
          {items.map((item) => (
            <article key={item.key}>
              <strong>{item.name}</strong>
              <code>{item.key}</code>
              <p>{item.description}</p>
              <small>{detail(item)}</small>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function StringList({
  items,
  empty = '未定义',
}: {
  items: readonly string[];
  empty?: string;
}): ReactNode {
  if (items.length === 0) return <p className="role-definition-empty">{empty}</p>;
  return (
    <ul>
      {items.map((item, index) => (
        <li key={`${item}-${index}`}>{item}</li>
      ))}
    </ul>
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

function sensitivityLabel(value: string): string {
  return (
    {
      PUBLIC: '公开',
      INTERNAL: '内部',
      CONFIDENTIAL: '机密',
      RESTRICTED: '严格限制',
    }[value] ?? value
  );
}
