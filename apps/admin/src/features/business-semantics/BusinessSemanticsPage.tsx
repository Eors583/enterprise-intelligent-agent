import type {
  Evidence,
  MetricDefinition,
  Objective,
  ProcessDefinition,
  Strategy,
  Task,
  ValueDefinition,
} from '@enterprise/contracts';
import { useEffect, useMemo, useState, type ReactNode } from 'react';

import { messageFromError } from '@/api/client';
import { Icon } from '@/components/Icons';
import { EmptyState, ErrorState, LoadingPanel, Notice, StatusPill } from '@/components/ui';

import {
  listEvidence,
  listMetricDefinitions,
  listObjectives,
  listProcessDefinitions,
  listStrategies,
  listTasks,
  listValueDefinitions,
} from './api';
import {
  associationChecks,
  BUSINESS_RESOURCES,
  entityDescription,
  entityStatus,
  entityTitle,
  formatDate,
  formatEffectivePeriod,
  ownerLabel,
  resourceDefinition,
  semanticStatusLabel,
  shortId,
  type BusinessResourceKey,
  type BusinessSemanticEntity,
} from './business-semantics-view';
import { ContractJsonEditor, type ContractJsonEditorConfig } from './ContractJsonEditor';
import {
  createEntityEditorConfig,
  transitionEntityEditorConfig,
  updateEntityEditorConfig,
} from './editor-config';
import { EvidenceLinksPanel, ObjectiveRelationsPanel, TaskGovernancePanel } from './NestedPanels';
import { ProcessVersionsPanel, ValueVersionsPanel } from './VersionPanels';
import './business-semantics.css';

export function BusinessSemanticsPage({ currentUserId }: { currentUserId: string }): ReactNode {
  const [resource, setResource] = useState<BusinessResourceKey>('values');
  const [items, setItems] = useState<BusinessSemanticEntity[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [editor, setEditor] = useState<ContractJsonEditorConfig | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError(null);
    setItems(null);
    setSelectedId(null);
    void loadResource(resource, controller.signal)
      .then((loaded) => {
        setItems(loaded);
        setSelectedId(loaded[0]?.id ?? null);
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) setLoadError(messageFromError(caught));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [reloadKey, resource]);

  const definition = resourceDefinition(resource);
  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase('zh-CN');
    return (items ?? []).filter(
      (item) =>
        normalized.length === 0 ||
        item.code.toLocaleLowerCase('zh-CN').includes(normalized) ||
        entityTitle(item).toLocaleLowerCase('zh-CN').includes(normalized) ||
        entityDescription(item).toLocaleLowerCase('zh-CN').includes(normalized),
    );
  }, [items, query]);
  const selected = items?.find((item) => item.id === selectedId) ?? null;
  const transition = selected ? transitionEntityEditorConfig(resource, selected) : null;

  const reload = (): void => setReloadKey((value) => value + 1);
  const editorSaved = (): void => {
    setEditor(null);
    setNotice(`${definition.label}操作已由服务端确认，列表已刷新。`);
    reload();
  };

  return (
    <section className="page-section business-semantics-page">
      <header className="page-header semantic-page-header">
        <div>
          <span className="eyebrow">BUSINESS SEMANTIC MAIN CHAIN</span>
          <h1>经营主链</h1>
          <p>
            治理 Value → Strategy → Objective → Metric → Process → Task → Evidence 的可追溯语义。
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
            onClick={() => setEditor(createEntityEditorConfig(resource, currentUserId))}
          >
            <Icon name="plus" size={17} /> 新建{definition.label}
          </button>
        </div>
      </header>

      <div className="semantic-chain" aria-label="经营语义主链">
        {BUSINESS_RESOURCES.map((candidate, index) => (
          <span key={candidate.key}>
            <b>{candidate.mark}</b>
            <small>{candidate.singular}</small>
            {index < BUSINESS_RESOURCES.length - 1 ? <i aria-hidden="true">→</i> : null}
          </span>
        ))}
      </div>

      <div className="semantic-resource-tabs" role="tablist" aria-label="经营主链资源">
        {BUSINESS_RESOURCES.map((candidate) => (
          <button
            key={candidate.key}
            id={`semantic-tab-${candidate.key}`}
            type="button"
            role="tab"
            aria-selected={resource === candidate.key}
            aria-controls="semantic-resource-panel"
            tabIndex={resource === candidate.key ? 0 : -1}
            className={resource === candidate.key ? 'active' : ''}
            onClick={() => {
              setItems(null);
              setSelectedId(null);
              setLoading(true);
              setResource(candidate.key);
              setQuery('');
              setNotice(null);
            }}
          >
            <span>{candidate.mark}</span>
            <strong>{candidate.label}</strong>
            <small>{candidate.description}</small>
          </button>
        ))}
      </div>

      {notice ? (
        <Notice tone="success" onClose={() => setNotice(null)}>
          {notice}
        </Notice>
      ) : null}
      {loading && items === null ? <LoadingPanel label={`正在读取${definition.label}…`} /> : null}
      {loadError && items === null ? <ErrorState message={loadError} onRetry={reload} /> : null}
      {loadError && items !== null ? (
        <Notice tone="error">刷新失败：{loadError}。当前显示上次成功数据。</Notice>
      ) : null}

      {items !== null ? (
        <div
          id="semantic-resource-panel"
          role="tabpanel"
          aria-labelledby={`semantic-tab-${resource}`}
          className="semantic-resource-layout"
        >
          <aside className="card semantic-entity-index" aria-label={`${definition.label}列表`}>
            <header>
              <div>
                <strong>{definition.label}目录</strong>
                <small>{items.length} 条服务端记录</small>
              </div>
              <label className="search-input">
                <span aria-hidden="true">⌕</span>
                <input
                  type="search"
                  value={query}
                  placeholder={`搜索${definition.label}名称或 code`}
                  aria-label={`搜索${definition.label}`}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </label>
            </header>
            {items.length === 0 ? (
              <EmptyState
                title={`还没有${definition.label}`}
                description={`服务端尚未返回可管理的${definition.label}记录。`}
                action={
                  <button
                    className="button primary"
                    type="button"
                    aria-haspopup="dialog"
                    onClick={() => setEditor(createEntityEditorConfig(resource, currentUserId))}
                  >
                    新建{definition.label}
                  </button>
                }
              />
            ) : (
              <div className="semantic-entity-list">
                {filtered.map((item) => {
                  const status = entityStatus(resource, item);
                  return (
                    <button
                      type="button"
                      key={item.id}
                      className={item.id === selectedId ? 'selected' : ''}
                      aria-current={item.id === selectedId ? 'true' : undefined}
                      onClick={() => setSelectedId(item.id)}
                    >
                      <span className="semantic-list-mark" aria-hidden="true">
                        {definition.mark}
                      </span>
                      <span>
                        <strong>{entityTitle(item)}</strong>
                        <code>{item.code}</code>
                        <small>
                          {semanticStatusLabel(status)} · v{item.version} / r{item.revision}
                        </small>
                      </span>
                    </button>
                  );
                })}
                {filtered.length === 0 ? (
                  <p className="semantic-no-match">没有匹配的{definition.label}。</p>
                ) : null}
              </div>
            )}
          </aside>

          {selected ? (
            <div className="semantic-detail-stack">
              <article className="card semantic-entity-detail">
                <header className="semantic-detail-hero">
                  <span className="semantic-detail-mark" aria-hidden="true">
                    {definition.mark}
                  </span>
                  <div>
                    <span className="eyebrow">{selected.code}</span>
                    <h2>{entityTitle(selected)}</h2>
                    <p>{entityDescription(selected)}</p>
                    <div className="semantic-detail-statuses">
                      <StatusPill
                        value={entityStatus(resource, selected)}
                        label={semanticStatusLabel(entityStatus(resource, selected))}
                      />
                      <span>v{selected.version}</span>
                      <span>revision {selected.revision}</span>
                    </div>
                  </div>
                  <div className="semantic-detail-actions">
                    <button
                      className="button compact secondary"
                      type="button"
                      aria-haspopup="dialog"
                      onClick={() => setEditor(updateEntityEditorConfig(resource, selected))}
                    >
                      编辑
                    </button>
                    {transition ? (
                      <button
                        className="button compact primary"
                        type="button"
                        aria-haspopup="dialog"
                        onClick={() => setEditor(transition.editor)}
                      >
                        {transition.label}
                      </button>
                    ) : null}
                  </div>
                </header>

                <dl className="semantic-governance-grid">
                  <div>
                    <dt>Owner</dt>
                    <dd>{ownerLabel(selected)}</dd>
                  </div>
                  <div>
                    <dt>有效期</dt>
                    <dd>{formatEffectivePeriod(selected)}</dd>
                  </div>
                  <div>
                    <dt>服务端版本</dt>
                    <dd>
                      v{selected.version} · 并发修订 r{selected.revision}
                    </dd>
                  </div>
                  <div>
                    <dt>最后更新</dt>
                    <dd>{formatDate(selected.updatedAt)}</dd>
                  </div>
                </dl>

                <section className="semantic-permission-section">
                  <header>
                    <strong>权限标签</strong>
                    <small>服务端仍执行实际授权判断</small>
                  </header>
                  <div className="semantic-permissions">
                    {selected.permissionLabels.length > 0 ? (
                      selected.permissionLabels.map((label) => <code key={label}>{label}</code>)
                    ) : (
                      <span>未附加资源级权限标签</span>
                    )}
                  </div>
                </section>

                <EntitySpecificDetails resource={resource} entity={selected} />

                <section className="semantic-association-section">
                  <header>
                    <strong>关联校验</strong>
                    <small>契约字段完整性；跨实体存在性由写接口原子校验</small>
                  </header>
                  <div className="semantic-association-grid">
                    {associationChecks(resource, selected).map((check) => (
                      <div className={check.valid ? 'valid' : 'warning'} key={check.label}>
                        <span aria-hidden="true">{check.valid ? '✓' : '!'}</span>
                        <strong>{check.label}</strong>
                        <small>{check.detail}</small>
                      </div>
                    ))}
                  </div>
                </section>
              </article>

              {resource === 'values' ? (
                <ValueVersionsPanel
                  definition={selected as ValueDefinition}
                  onDefinitionChanged={reload}
                />
              ) : null}
              {resource === 'processes' ? (
                <ProcessVersionsPanel
                  definition={selected as ProcessDefinition}
                  onDefinitionChanged={reload}
                />
              ) : null}
              {resource === 'objectives' ? (
                <ObjectiveRelationsPanel objective={selected as Objective} />
              ) : null}
              {resource === 'tasks' ? (
                <TaskGovernancePanel task={selected as Task} onTaskChanged={reload} />
              ) : null}
              {resource === 'evidence' ? (
                <EvidenceLinksPanel evidence={selected as Evidence} />
              ) : null}
            </div>
          ) : items.length > 0 ? (
            <div className="card">
              <EmptyState
                title={`选择一个${definition.label}`}
                description="从左侧目录选择记录以查看治理元数据与关联状态。"
              />
            </div>
          ) : null}
        </div>
      ) : null}

      {editor ? (
        <ContractJsonEditor config={editor} onClose={() => setEditor(null)} onSaved={editorSaved} />
      ) : null}
    </section>
  );
}

function EntitySpecificDetails({
  resource,
  entity,
}: {
  resource: BusinessResourceKey;
  entity: BusinessSemanticEntity;
}): ReactNode {
  const entries: Array<[string, string]> = [];
  switch (resource) {
    case 'values': {
      const value = entity as ValueDefinition;
      entries.push(
        ['价值类型', value.type],
        ['当前版本', value.currentVersionId ? shortId(value.currentVersionId) : '尚未发布'],
      );
      break;
    }
    case 'strategies': {
      const strategy = entity as Strategy;
      entries.push(
        ['关联价值版本', `${strategy.valueVersionIds.length} 个`],
        [
          '预算',
          strategy.budget
            ? `${strategy.budget.currency} ${strategy.budget.amount.toLocaleString('zh-CN')}`
            : '未设置',
        ],
      );
      break;
    }
    case 'objectives': {
      const objective = entity as Objective;
      entries.push(
        ['BSC 视角', objective.bscPerspective],
        ['指标属性', objective.indicatorType],
        ['权重', String(objective.weight)],
        ['父目标', objective.parentObjectiveId ? shortId(objective.parentObjectiveId) : '根目标'],
      );
      break;
    }
    case 'metrics': {
      const metric = entity as MetricDefinition;
      entries.push(
        ['值类型', metric.valueType],
        ['单位', metric.unit],
        ['聚合', metric.aggregation],
        ['方向', metric.direction],
      );
      break;
    }
    case 'processes': {
      const process = entity as ProcessDefinition;
      entries.push([
        '当前流程版本',
        process.currentVersionId ? shortId(process.currentVersionId) : '尚未发布',
      ]);
      break;
    }
    case 'tasks': {
      const task = entity as Task;
      entries.push(
        ['优先级', task.priority],
        ['截止时间', formatDate(task.dueAt)],
        ['流程', task.processRef.definitionCode],
        ['流程节点', task.processRef.nodeCode],
      );
      break;
    }
    case 'evidence': {
      const evidence = entity as Evidence;
      entries.push(
        ['来源类型', evidence.sourceType],
        ['来源系统', evidence.sourceSystem],
        ['可信度', evidence.trustLevel],
        ['置信度', `${Math.round(evidence.confidence * 100)}%`],
      );
      break;
    }
  }
  return (
    <section className="semantic-specific-section">
      <header>
        <strong>业务属性</strong>
      </header>
      <dl>
        {entries.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

async function loadResource(
  resource: BusinessResourceKey,
  signal: AbortSignal,
): Promise<BusinessSemanticEntity[]> {
  switch (resource) {
    case 'values':
      return listValueDefinitions(signal);
    case 'strategies':
      return listStrategies(signal);
    case 'objectives':
      return listObjectives(signal);
    case 'metrics':
      return listMetricDefinitions(signal);
    case 'processes':
      return listProcessDefinitions(signal);
    case 'tasks':
      return listTasks(signal);
    case 'evidence':
      return listEvidence(signal);
  }
}
