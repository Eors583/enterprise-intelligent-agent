import type {
  AdminOrganizationResponse,
  AdminOrgUnit,
  BindFeishuOrganizationRequest,
  FeishuDirectoryPreview,
  FeishuDirectorySyncRunDetail,
  FeishuOrganizationSyncStatus,
} from '@enterprise/contracts';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
} from 'react';

import {
  archiveOrgUnit,
  applyFeishuDirectoryPreview,
  bindFeishuOrganization,
  createFeishuDirectoryPreview,
  createOrgUnit,
  getFeishuOrganizationSyncStatus,
  getFeishuDirectoryPreview,
  getOrganization,
  listFeishuDirectorySyncRuns,
  updateOrganization,
  updateOrgUnit,
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

interface TreeRow {
  unit: AdminOrgUnit;
  depth: number;
}

function flattenTree(units: ReadonlyArray<AdminOrgUnit>): TreeRow[] {
  const byParent = new Map<string | null, AdminOrgUnit[]>();
  for (const unit of units) {
    const siblings = byParent.get(unit.parentId) ?? [];
    siblings.push(unit);
    byParent.set(unit.parentId, siblings);
  }
  for (const siblings of byParent.values()) {
    siblings.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'zh-CN'));
  }
  const rows: TreeRow[] = [];
  const seen = new Set<string>();
  const walk = (parentId: string | null, depth: number): void => {
    for (const unit of byParent.get(parentId) ?? []) {
      if (seen.has(unit.id)) continue;
      seen.add(unit.id);
      rows.push({ unit, depth });
      walk(unit.id, depth + 1);
    }
  };
  walk(null, 0);
  for (const unit of units) {
    if (!seen.has(unit.id)) rows.push({ unit, depth: 0 });
  }
  return rows;
}

function descendantsOf(id: string, units: ReadonlyArray<AdminOrgUnit>): Set<string> {
  const result = new Set<string>([id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const unit of units) {
      if (unit.parentId && result.has(unit.parentId) && !result.has(unit.id)) {
        result.add(unit.id);
        changed = true;
      }
    }
  }
  return result;
}

export function OrganizationPage(): ReactNode {
  const [data, setData] = useState<AdminOrganizationResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [feishuStatus, setFeishuStatus] = useState<FeishuOrganizationSyncStatus | null>(null);
  const [feishuPreview, setFeishuPreview] = useState<FeishuDirectoryPreview | null>(null);
  const [feishuRun, setFeishuRun] = useState<FeishuDirectorySyncRunDetail | null>(null);
  const [feishuLoading, setFeishuLoading] = useState(true);
  const [feishuStarting, setFeishuStarting] = useState(false);
  const [feishuBinding, setFeishuBinding] = useState(false);
  const [feishuError, setFeishuError] = useState<string | null>(null);
  const [feishuReloadKey, setFeishuReloadKey] = useState(0);
  const feishuWasRunning = useRef(false);

  const reload = (): void => setReloadKey((value) => value + 1);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void getOrganization(controller.signal)
      .then((response) => {
        setData(response);
        setSelectedId((current) => {
          if (current && response.orgUnits.some((unit) => unit.id === current)) return current;
          return response.orgUnits.find((unit) => unit.status === 'ACTIVE')?.id ?? null;
        });
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) setError(messageFromError(caught));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [reloadKey]);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let shouldPoll = false;

    const loadStatus = async (initial: boolean): Promise<void> => {
      if (initial) setFeishuLoading(true);
      try {
        const [response, preview, runs] = await Promise.all([
          getFeishuOrganizationSyncStatus(controller.signal),
          getFeishuDirectoryPreview(controller.signal),
          listFeishuDirectorySyncRuns(controller.signal),
        ]);
        if (controller.signal.aborted) return;
        setFeishuStatus(response);
        setFeishuPreview(preview);
        setFeishuRun(runs.items[0] ?? null);
        setFeishuError(null);
        shouldPoll =
          response.status === 'RUNNING' ||
          runs.items[0]?.status === 'QUEUED' ||
          runs.items[0]?.status === 'RUNNING';
        if (shouldPoll) feishuWasRunning.current = true;
        if (response.status === 'SUCCEEDED' && feishuWasRunning.current) {
          feishuWasRunning.current = false;
          setNotice('飞书组织同步完成，组织架构已刷新。');
          reload();
        } else if (response.status === 'FAILED') {
          feishuWasRunning.current = false;
        }
      } catch (caught) {
        if (!controller.signal.aborted) {
          setFeishuError(messageFromError(caught));
          shouldPoll = feishuWasRunning.current;
        }
      } finally {
        if (!controller.signal.aborted) {
          if (initial) setFeishuLoading(false);
          if (shouldPoll) timer = setTimeout(() => void loadStatus(false), 2_500);
        }
      }
    };

    void loadStatus(true);
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [feishuReloadKey]);

  const refreshFeishuStatus = (): void => setFeishuReloadKey((value) => value + 1);
  const startFeishuSync = async (): Promise<void> => {
    setFeishuStarting(true);
    setFeishuError(null);
    try {
      const preview = await createFeishuDirectoryPreview();
      setFeishuPreview(preview);
      setNotice('飞书通讯录差异预览已生成，请核对后确认应用。');
    } catch (caught) {
      setFeishuError(messageFromError(caught));
    } finally {
      setFeishuStarting(false);
    }
  };
  const applyFeishuSync = async (): Promise<void> => {
    if (!feishuPreview || feishuPreview.status !== 'READY') return;
    setFeishuStarting(true);
    setFeishuError(null);
    try {
      const run = await applyFeishuDirectoryPreview({
        previewId: feishuPreview.id,
        idempotencyKey: buildFeishuApplyIdempotencyKey(feishuPreview.id, feishuRun),
      });
      setFeishuRun(run);
      feishuWasRunning.current = true;
      refreshFeishuStatus();
    } catch (caught) {
      setFeishuError(messageFromError(caught));
    } finally {
      setFeishuStarting(false);
    }
  };
  const bindFeishu = async (input: BindFeishuOrganizationRequest): Promise<void> => {
    setFeishuBinding(true);
    setFeishuError(null);
    try {
      const response = await bindFeishuOrganization(input);
      setFeishuStatus(response);
      setNotice('飞书应用凭据与通讯录权限已通过本次在线验证；尚未导入任何组织数据。');
    } catch (caught) {
      const message = messageFromError(caught);
      setFeishuError(message);
      throw caught;
    } finally {
      setFeishuBinding(false);
    }
  };

  const treeRows = useMemo(() => flattenTree(data?.orgUnits ?? []), [data?.orgUnits]);
  const selected = data?.orgUnits.find((unit) => unit.id === selectedId) ?? null;

  return (
    <section className="page-section">
      <header className="page-header">
        <div>
          <span className="eyebrow">ORGANIZATION</span>
          <h1>组织架构</h1>
          <p>维护企业部门层级。调整后，桌面端通讯录会读取最新结构。</p>
        </div>
        <div className="page-actions">
          <button className="button secondary" type="button" onClick={reload} disabled={loading}>
            <Icon name="refresh" size={17} /> 刷新
          </button>
          <button
            className="button primary"
            type="button"
            onClick={() => setCreateOpen(true)}
            disabled={!data}
          >
            <Icon name="plus" size={17} /> 新建部门
          </button>
        </div>
      </header>

      {notice ? (
        <Notice tone="success" onClose={() => setNotice(null)}>
          {notice}
        </Notice>
      ) : null}
      <FeishuSyncCard
        status={feishuStatus}
        loading={feishuLoading}
        starting={feishuStarting}
        binding={feishuBinding}
        error={feishuError}
        preview={feishuPreview}
        durableRun={feishuRun}
        onRefresh={refreshFeishuStatus}
        onStart={() => void startFeishuSync()}
        onApply={() => void applyFeishuSync()}
        onBind={bindFeishu}
      />
      {loading && !data ? <LoadingPanel label="正在读取组织架构…" /> : null}
      {error && !data ? <ErrorState message={error} onRetry={reload} /> : null}

      {data ? (
        <>
          <div className="summary-grid">
            <article className="summary-card accent">
              <span>当前组织</span>
              <strong>{data.organization.name}</strong>
              <button className="text-button" type="button" onClick={() => setRenameOpen(true)}>
                编辑组织信息
              </button>
            </article>
            <article className="summary-card">
              <span>启用部门</span>
              <strong>{data.orgUnits.filter((unit) => unit.status === 'ACTIVE').length}</strong>
              <small>共 {data.orgUnits.length} 个部门记录</small>
            </article>
            <article className="summary-card">
              <span>企业成员</span>
              <strong>{data.members.filter((member) => member.status === 'ACTIVE').length}</strong>
              <small>共 {data.members.length} 个账号</small>
            </article>
          </div>

          {data.orgUnits.length === 0 ? (
            <EmptyState
              title="还没有部门"
              description="创建第一个部门，开始搭建企业组织架构。"
              action={
                <button
                  className="button primary"
                  type="button"
                  onClick={() => setCreateOpen(true)}
                >
                  新建部门
                </button>
              }
            />
          ) : (
            <div className="split-layout organization-layout">
              <section className="card tree-card">
                <header className="card-header">
                  <div>
                    <h2>部门树</h2>
                    <p>选择部门后可修改名称、排序或上级部门。</p>
                  </div>
                </header>
                <div className="tree-list" role="tree" aria-label="企业部门">
                  {treeRows.map(({ unit, depth }) => (
                    <button
                      type="button"
                      role="treeitem"
                      aria-selected={selectedId === unit.id}
                      key={unit.id}
                      className={`tree-row ${selectedId === unit.id ? 'selected' : ''} ${unit.status === 'ARCHIVED' ? 'muted' : ''}`}
                      style={{ '--tree-depth': depth } as CSSProperties}
                      onClick={() => setSelectedId(unit.id)}
                    >
                      <span className="tree-branch" aria-hidden="true" />
                      <span className="unit-icon">{depth === 0 ? '企' : '部'}</span>
                      <span className="tree-row-copy">
                        <strong>{unit.name}</strong>
                        <small>{unit.memberCount} 位成员</small>
                      </span>
                      {unit.source === 'FEISHU' ? <span className="source-badge">飞书</span> : null}
                      {unit.status === 'ARCHIVED' ? <StatusPill value={unit.status} /> : null}
                    </button>
                  ))}
                </div>
              </section>
              <section className="card editor-card">
                {selected ? (
                  <OrgUnitEditor
                    key={`${selected.id}-${selected.version}`}
                    unit={selected}
                    units={data.orgUnits}
                    onSaved={(message) => {
                      setNotice(message);
                      reload();
                    }}
                  />
                ) : (
                  <EmptyState title="请选择部门" description="从左侧部门树选择需要维护的部门。" />
                )}
              </section>
            </div>
          )}
        </>
      ) : null}

      {createOpen && data ? (
        <CreateOrgUnitModal
          units={data.orgUnits}
          onClose={() => setCreateOpen(false)}
          onCreated={() => {
            setCreateOpen(false);
            setNotice('部门创建成功。');
            reload();
          }}
        />
      ) : null}
      {renameOpen && data ? (
        <RenameOrganizationModal
          data={data}
          onClose={() => setRenameOpen(false)}
          onSaved={() => {
            setRenameOpen(false);
            setNotice('组织信息已更新。');
            reload();
          }}
        />
      ) : null}
    </section>
  );
}

function formatSyncTime(value: string | null): string {
  if (!value) return '尚未同步';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function FeishuSyncCard({
  status,
  loading,
  starting,
  binding,
  error,
  preview,
  durableRun,
  onRefresh,
  onStart,
  onApply,
  onBind,
}: {
  status: FeishuOrganizationSyncStatus | null;
  loading: boolean;
  starting: boolean;
  binding: boolean;
  error: string | null;
  preview: FeishuDirectoryPreview | null;
  durableRun: FeishuDirectorySyncRunDetail | null;
  onRefresh: () => void;
  onStart: () => void;
  onApply: () => void;
  onBind: (input: BindFeishuOrganizationRequest) => Promise<void>;
}): ReactNode {
  const [appId, setAppId] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [credentialHandlingAttested, setCredentialHandlingAttested] = useState(false);
  const [showBindingForm, setShowBindingForm] = useState(false);
  const running = status?.status === 'RUNNING';
  const notConfigured = status?.status === 'NOT_CONFIGURED';
  const run = status?.run ?? null;
  const syncDisabled = loading || starting || !status || notConfigured || running;

  const submitBinding = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    try {
      await onBind({ appId, appSecret });
      setAppSecret('');
      setCredentialHandlingAttested(false);
      setShowBindingForm(false);
    } catch {
      // The parent renders the sanitized API error in this card.
    }
  };

  return (
    <section className="card integration-card" aria-labelledby="feishu-sync-title">
      <header className="integration-header">
        <div className="integration-title">
          <span className="integration-mark" aria-hidden="true">
            飞
          </span>
          <div>
            <h2 id="feishu-sync-title">飞书组织同步</h2>
            <p>从飞书通讯录同步部门、成员、调岗与在离职状态。</p>
          </div>
        </div>
        {status ? (
          <StatusPill value={status.status} label={feishuSyncStatusLabel(status.status)} />
        ) : null}
      </header>

      <div className="integration-body" aria-live="polite">
        {loading && !status ? <Spinner label="正在检查飞书连接…" /> : null}
        {!loading && !status ? (
          <p className="integration-empty">暂时无法读取飞书连接状态。</p>
        ) : null}
        {status ? (
          <div className="integration-overview">
            <div>
              <span>目标本地企业</span>
              <strong>{status.tenantName ?? '尚未完成配置'}</strong>
            </div>
            <div>
              <span>最近成功同步</span>
              <strong>{formatSyncTime(status.lastSuccessfulAt)}</strong>
            </div>
            <div>
              <span>同步策略</span>
              <strong>飞书管理组织字段</strong>
            </div>
            <div>
              <span>应用身份</span>
              <strong>{status.appIdMasked ?? '尚未绑定'}</strong>
            </div>
          </div>
        ) : null}

        {notConfigured ? (
          <Notice tone="info">
            未配置，飞书同步当前不可用。请先绑定企业自建应用；App Secret
            只会加密保存在服务端，状态接口不会回传。
          </Notice>
        ) : null}
        {status?.status === 'READY' ? (
          <Notice tone="info">
            当前只确认服务端保存了连接配置，不代表此刻仍可访问飞书。生成差异预览时会重新验证真实连接与通讯录权限。
          </Notice>
        ) : null}

        {(notConfigured || showBindingForm) && (
          <Notice tone="error">
            安全阻断：曾在聊天、工单、截图、日志或源码中暴露的 App Secret
            不得再次使用。请先在飞书开放平台轮换，再输入新生成且未暴露的
            Secret；系统不会从历史内容复用密钥。
          </Notice>
        )}

        {notConfigured || showBindingForm ? (
          <form className="feishu-binding-form" onSubmit={(event) => void submitBinding(event)}>
            <div className="binding-form-heading">
              <div>
                <strong>{notConfigured ? '绑定飞书应用' : '更新飞书应用凭据'}</strong>
                <small>请在飞书开放平台创建企业自建应用，并授予部门与成员只读通讯录权限。</small>
              </div>
              {!notConfigured ? (
                <button
                  className="text-button"
                  type="button"
                  onClick={() => {
                    setAppSecret('');
                    setCredentialHandlingAttested(false);
                    setShowBindingForm(false);
                  }}
                >
                  收起
                </button>
              ) : null}
            </div>
            <div className="binding-fields">
              <label>
                <span>App ID</span>
                <input
                  value={appId}
                  onChange={(event) => setAppId(event.target.value)}
                  placeholder="cli_xxxxxxxxxxxxxxxx"
                  autoComplete="off"
                  required
                />
              </label>
              <label>
                <span>App Secret</span>
                <input
                  type="password"
                  value={appSecret}
                  onChange={(event) => setAppSecret(event.target.value)}
                  placeholder="请输入应用密钥"
                  autoComplete="new-password"
                  required
                />
              </label>
            </div>
            <div className="binding-form-actions">
              <label>
                <input
                  type="checkbox"
                  checked={credentialHandlingAttested}
                  onChange={(event) => setCredentialHandlingAttested(event.target.checked)}
                  required
                />
                <span>
                  我确认当前 Secret 已在飞书后台新生成，且未在聊天、工单、日志或源码中暴露。
                </span>
              </label>
              <small>
                绑定时会实际探测令牌、部门读取和成员读取权限；通过只代表凭据和权限已验证，不代表目录已同步。
              </small>
              <button
                className="button primary"
                type="submit"
                disabled={binding || running || !credentialHandlingAttested}
              >
                {binding ? <Spinner label="正在验证…" /> : '验证并绑定'}
              </button>
            </div>
          </form>
        ) : null}
        {error ? <Notice tone="error">{error}</Notice> : null}

        {run ? (
          <div className="sync-run-panel">
            <div className="sync-run-heading">
              <div>
                <strong>
                  {run.status === 'RUNNING' ? '正在同步组织通讯录' : '最近一次同步结果'}
                </strong>
                <small>
                  开始于 {formatSyncTime(run.startedAt)}
                  {run.finishedAt ? ` · 完成于 ${formatSyncTime(run.finishedAt)}` : ''}
                </small>
              </div>
              <StatusPill value={run.status} label={feishuSyncStatusLabel(run.status)} />
            </div>
            {run.status === 'RUNNING' ? (
              <Spinner label="同步正在后台执行，页面会自动更新…" />
            ) : (
              <>
                <dl className="sync-result-grid">
                  <div>
                    <dt>部门新增</dt>
                    <dd>{run.departments.created}</dd>
                  </div>
                  <div>
                    <dt>部门更新</dt>
                    <dd>{run.departments.updated}</dd>
                  </div>
                  <div>
                    <dt>部门归档</dt>
                    <dd>{run.departments.archived}</dd>
                  </div>
                  <div>
                    <dt>成员新增</dt>
                    <dd>{run.members.created}</dd>
                  </div>
                  <div>
                    <dt>成员更新</dt>
                    <dd>{run.members.updated}</dd>
                  </div>
                  <div>
                    <dt>成员停用</dt>
                    <dd>{run.members.deactivated}</dd>
                  </div>
                  <div>
                    <dt>冲突</dt>
                    <dd>{run.conflictCount}</dd>
                  </div>
                  <div>
                    <dt>失败记录</dt>
                    <dd>{run.departments.failed + run.members.failed}</dd>
                  </div>
                </dl>
                <p className="sync-unchanged">
                  未变化：{run.departments.unchanged} 个部门、{run.members.unchanged} 位成员
                </p>
              </>
            )}
            {run.errorMessage ? <Notice tone="error">{run.errorMessage}</Notice> : null}
          </div>
        ) : null}
        {preview ? (
          <div className="sync-run-panel" aria-label="飞书同步差异预览">
            <div className="sync-run-heading">
              <div>
                <strong>同步差异预览</strong>
                <small>
                  快照 {preview.snapshotCursor.slice(0, 12)}… · 有效期至{' '}
                  {formatSyncTime(preview.expiresAt)}
                </small>
              </div>
              <StatusPill value={preview.status} />
            </div>
            <dl className="sync-result-grid">
              <div>
                <dt>新增</dt>
                <dd>{preview.summary.created}</dd>
              </div>
              <div>
                <dt>更新</dt>
                <dd>{preview.summary.updated}</dd>
              </div>
              <div>
                <dt>归档</dt>
                <dd>{preview.summary.archived}</dd>
              </div>
              <div>
                <dt>停用</dt>
                <dd>{preview.summary.deactivated}</dd>
              </div>
              <div>
                <dt>冲突</dt>
                <dd>{preview.summary.conflicts}</dd>
              </div>
              <div>
                <dt>无变化</dt>
                <dd>{preview.summary.unchanged}</dd>
              </div>
            </dl>
            {preview.items.length === 0 ? (
              <p className="sync-unchanged">当前飞书快照与本地组织一致。</p>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>对象</th>
                      <th>类型</th>
                      <th>动作</th>
                      <th>应用状态 / 诊断</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.items.map((item) => (
                      <tr key={item.id}>
                        <td>{item.displayName}</td>
                        <td>{item.entityType === 'DEPARTMENT' ? '部门' : '成员'}</td>
                        <td>{item.action}</td>
                        <td>
                          <strong>{item.diagnosticCode ?? item.applyStatus}</strong>
                          <small>{summarizeFeishuFieldChanges(item.fieldChanges)}</small>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {durableRun?.lastErrorCode ? (
              <Notice tone="error">
                同步任务 {durableRun.status}：{durableRun.lastErrorCode}
              </Notice>
            ) : null}
          </div>
        ) : null}
      </div>

      <footer className="integration-actions">
        {!notConfigured && !showBindingForm ? (
          <button
            className="button secondary"
            type="button"
            onClick={() => {
              setAppSecret('');
              setCredentialHandlingAttested(false);
              setShowBindingForm(true);
            }}
            disabled={loading || starting || binding || running}
          >
            更新绑定
          </button>
        ) : null}
        <button
          className="button secondary"
          type="button"
          onClick={onRefresh}
          disabled={loading || starting}
        >
          <Icon name="refresh" size={17} /> {loading ? '正在刷新…' : '刷新状态'}
        </button>
        <button className="button primary" type="button" onClick={onStart} disabled={syncDisabled}>
          {starting ? (
            <Spinner label="正在启动…" />
          ) : running ? (
            <Spinner label="同步中…" />
          ) : status?.status === 'FAILED' ? (
            '重新生成预览'
          ) : (
            '生成差异预览'
          )}
        </button>
        <button
          className="button primary"
          type="button"
          onClick={onApply}
          disabled={
            syncDisabled ||
            preview?.status !== 'READY' ||
            durableRun?.status === 'QUEUED' ||
            durableRun?.status === 'RUNNING'
          }
        >
          {isFeishuRetryableTerminalRun(durableRun, preview?.id)
            ? '重试后台应用'
            : '确认并后台应用'}
        </button>
      </footer>
    </section>
  );
}

export function buildFeishuApplyIdempotencyKey(
  previewId: string,
  run: Pick<FeishuDirectorySyncRunDetail, 'id' | 'previewId' | 'status'> | null,
): string {
  return run !== null && isFeishuRetryableTerminalRun(run, previewId)
    ? `admin-${previewId}-retry-${run.id}`
    : `admin-${previewId}`;
}

export function isFeishuRetryableTerminalRun(
  run: Pick<FeishuDirectorySyncRunDetail, 'previewId' | 'status'> | null,
  previewId: string | undefined,
): boolean {
  return (
    run !== null &&
    previewId !== undefined &&
    run.previewId === previewId &&
    (run.status === 'FAILED' || run.status === 'DEAD_LETTER')
  );
}

export function summarizeFeishuFieldChanges(fieldChanges: Record<string, unknown>): string {
  const labels: Record<string, string> = {
    name: '名称',
    parentExternalId: '上级部门',
    sortOrder: '排序',
    status: '状态',
    displayName: '姓名',
    active: '在职状态',
    avatarUrl: '头像',
    openId: 'Open ID',
    unionId: 'Union ID',
    departments: '所属部门/调岗',
    primaryDepartment: '主部门',
    jobTitle: '岗位',
    workEmail: '工作邮箱',
    employeeNumber: '工号',
  };
  const fields = Object.keys(fieldChanges)
    .sort()
    .map((field) => labels[field] ?? field);
  return fields.length === 0 ? '无字段变化明细' : `字段：${fields.join('、')}`;
}

export function feishuSyncStatusLabel(
  status:
    | FeishuOrganizationSyncStatus['status']
    | NonNullable<FeishuOrganizationSyncStatus['run']>['status'],
): string {
  return {
    NOT_CONFIGURED: '未配置',
    READY: '已配置（尚未同步）',
    RUNNING: '正在同步',
    SUCCEEDED: '最近一次同步成功',
    FAILED: '最近一次同步失败',
  }[status];
}

function CreateOrgUnitModal({
  units,
  onClose,
  onCreated,
}: {
  units: ReadonlyArray<AdminOrgUnit>;
  onClose: () => void;
  onCreated: () => void;
}): ReactNode {
  const [name, setName] = useState('');
  const [parentId, setParentId] = useState('');
  const [sortOrder, setSortOrder] = useState('0');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await createOrgUnit({
        name,
        parentId: parentId || null,
        sortOrder: Number(sortOrder),
      });
      onCreated();
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal title="新建部门" description="新部门会立即出现在桌面端通讯录中。" onClose={onClose}>
      <form className="form-stack" onSubmit={(event) => void submit(event)}>
        <label>
          <span>部门名称</span>
          <input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="例如 产品研发中心"
          />
        </label>
        <label>
          <span>上级部门</span>
          <select value={parentId} onChange={(event) => setParentId(event.target.value)}>
            <option value="">无（一级部门）</option>
            {flattenTree(units)
              .filter(({ unit }) => unit.status === 'ACTIVE')
              .map(({ unit, depth }) => (
                <option key={unit.id} value={unit.id}>
                  {'　'.repeat(depth)}
                  {unit.name}
                </option>
              ))}
          </select>
        </label>
        <label>
          <span>排序值</span>
          <input
            type="number"
            min="0"
            max="1000000"
            value={sortOrder}
            onChange={(event) => setSortOrder(event.target.value)}
          />
        </label>
        <FieldError message={error} />
        <div className="modal-actions">
          <button className="button secondary" type="button" onClick={onClose}>
            取消
          </button>
          <button className="button primary" type="submit" disabled={submitting}>
            {submitting ? <Spinner label="正在创建…" /> : '创建部门'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function RenameOrganizationModal({
  data,
  onClose,
  onSaved,
}: {
  data: AdminOrganizationResponse;
  onClose: () => void;
  onSaved: () => void;
}): ReactNode {
  const [name, setName] = useState(data.organization.name);
  const [legalName, setLegalName] = useState(data.organization.legalName ?? '');
  const [timezone, setTimezone] = useState(data.organization.timezone);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await updateOrganization({
        name,
        legalName: legalName || null,
        timezone,
        expectedVersion: data.organization.version,
      });
      onSaved();
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <Modal title="编辑组织信息" onClose={onClose}>
      <form className="form-stack" onSubmit={(event) => void submit(event)}>
        <label>
          <span>组织显示名称</span>
          <input autoFocus value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <label>
          <span>法定名称（可选）</span>
          <input value={legalName} onChange={(event) => setLegalName(event.target.value)} />
        </label>
        <label>
          <span>默认时区</span>
          <input
            value={timezone}
            onChange={(event) => setTimezone(event.target.value)}
            placeholder="Asia/Shanghai"
          />
        </label>
        <FieldError message={error} />
        <div className="modal-actions">
          <button className="button secondary" type="button" onClick={onClose}>
            取消
          </button>
          <button className="button primary" type="submit" disabled={submitting}>
            {submitting ? <Spinner label="正在保存…" /> : '保存修改'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function OrgUnitEditor({
  unit,
  units,
  onSaved,
}: {
  unit: AdminOrgUnit;
  units: ReadonlyArray<AdminOrgUnit>;
  onSaved: (message: string) => void;
}): ReactNode {
  const [name, setName] = useState(unit.name);
  const [parentId, setParentId] = useState(unit.parentId ?? '');
  const [sortOrder, setSortOrder] = useState(String(unit.sortOrder));
  const [submitting, setSubmitting] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const excluded = descendantsOf(unit.id, units);
  const externallyManaged = unit.source === 'FEISHU';

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (externallyManaged) return;
    setSubmitting(true);
    setError(null);
    try {
      await updateOrgUnit(unit.id, {
        name,
        parentId: parentId || null,
        sortOrder: Number(sortOrder),
        expectedVersion: unit.version,
      });
      onSaved('部门信息已更新。');
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setSubmitting(false);
    }
  };

  const archive = async (): Promise<void> => {
    if (externallyManaged) return;
    if (!window.confirm(`确认归档“${unit.name}”吗？存在下级部门或在职成员时服务端会拒绝该操作。`))
      return;
    setArchiving(true);
    setError(null);
    try {
      await archiveOrgUnit(unit.id, unit.version);
      onSaved('部门已归档。');
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setArchiving(false);
    }
  };

  return (
    <form className="form-stack editor-form" onSubmit={(event) => void submit(event)}>
      <header className="editor-heading">
        <div>
          <span className="unit-icon large">部</span>
        </div>
        <div>
          <h2>{unit.name}</h2>
          <p>
            {unit.memberCount} 位成员 · 版本 {unit.version}
          </p>
        </div>
        <div className="editor-heading-status">
          {externallyManaged ? <span className="source-badge">飞书同步</span> : null}
          <StatusPill value={unit.status} />
        </div>
      </header>
      {externallyManaged ? (
        <Notice tone="info">
          该部门的名称、层级、排序和状态由飞书通讯录管理。如需调整，请在飞书修改后重新同步。
        </Notice>
      ) : null}
      <div className="form-grid two">
        <label>
          <span>部门名称</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            disabled={unit.status === 'ARCHIVED' || externallyManaged}
          />
        </label>
        <label>
          <span>排序值</span>
          <input
            type="number"
            min="0"
            max="1000000"
            value={sortOrder}
            onChange={(event) => setSortOrder(event.target.value)}
            disabled={unit.status === 'ARCHIVED' || externallyManaged}
          />
        </label>
      </div>
      <label>
        <span>上级部门</span>
        <select
          value={parentId}
          onChange={(event) => setParentId(event.target.value)}
          disabled={unit.status === 'ARCHIVED' || externallyManaged}
        >
          <option value="">无（一级部门）</option>
          {flattenTree(units)
            .filter(
              ({ unit: candidate }) => candidate.status === 'ACTIVE' && !excluded.has(candidate.id),
            )
            .map(({ unit: candidate, depth }) => (
              <option key={candidate.id} value={candidate.id}>
                {'　'.repeat(depth)}
                {candidate.name}
              </option>
            ))}
        </select>
        <small className="form-hint">不能移动到自身或下级部门，防止形成循环层级。</small>
      </label>
      <FieldError message={error} />
      <div className="editor-footer">
        {unit.status === 'ACTIVE' && !externallyManaged ? (
          <button
            className="button danger-ghost"
            type="button"
            onClick={() => void archive()}
            disabled={archiving || submitting}
          >
            {archiving ? '正在归档…' : '归档部门'}
          </button>
        ) : (
          <span />
        )}
        <button
          className="button primary"
          type="submit"
          disabled={unit.status === 'ARCHIVED' || externallyManaged || submitting || archiving}
        >
          {submitting ? <Spinner label="正在保存…" /> : '保存部门'}
        </button>
      </div>
    </form>
  );
}
