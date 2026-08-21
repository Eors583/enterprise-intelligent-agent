import type {
  ProcessDefinition,
  ProcessVersion,
  ValueDefinition,
  ValueVersion,
} from '@enterprise/contracts';
import { useEffect, useState, type ReactNode } from 'react';

import { messageFromError } from '@/api/client';
import { EmptyState, ErrorState, LoadingPanel, Notice, StatusPill } from '@/components/ui';

import { listProcessVersions, listValueVersions } from './api';
import { ContractJsonEditor, type ContractJsonEditorConfig } from './ContractJsonEditor';
import {
  createProcessVersionEditorConfig,
  createValueVersionEditorConfig,
  transitionProcessVersionEditorConfig,
  transitionValueVersionEditorConfig,
  updateProcessVersionEditorConfig,
  updateValueVersionEditorConfig,
} from './editor-config';
import {
  formatDate,
  formatEffectivePeriod,
  ownerTypeLabel,
  semanticStatusLabel,
  shortId,
} from './business-semantics-view';

export function ValueVersionsPanel({
  definition,
  onDefinitionChanged,
}: {
  definition: ValueDefinition;
  onDefinitionChanged: () => void;
}): ReactNode {
  const [versions, setVersions] = useState<ValueVersion[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [editor, setEditor] = useState<ContractJsonEditorConfig | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void listValueVersions(definition.id, controller.signal)
      .then(setVersions)
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) setError(messageFromError(caught));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [definition.id, reloadKey]);

  const reload = (): void => setReloadKey((value) => value + 1);
  const saved = (): void => {
    setEditor(null);
    setNotice('价值版本操作已由服务端确认。');
    reload();
    onDefinitionChanged();
  };

  return (
    <section className="card semantic-child-panel">
      <header className="semantic-child-heading">
        <div>
          <span className="eyebrow">VERSIONED VALUE</span>
          <h3>价值版本</h3>
          <p>行为、约束和指标绑定在不可变版本身份上。</p>
        </div>
        <button
          className="button compact primary"
          type="button"
          onClick={() => setEditor(createValueVersionEditorConfig(definition))}
        >
          创建版本草稿
        </button>
      </header>
      {notice ? (
        <Notice tone="success" onClose={() => setNotice(null)}>
          {notice}
        </Notice>
      ) : null}
      {loading && versions === null ? <LoadingPanel label="正在读取价值版本…" /> : null}
      {error && versions === null ? <ErrorState message={error} onRetry={reload} /> : null}
      {error && versions !== null ? <Notice tone="error">{error}</Notice> : null}
      {versions?.length === 0 ? (
        <EmptyState
          title="还没有价值版本"
          description="创建草稿并完成指标、约束和行为定义后才能发布。"
        />
      ) : null}
      {versions && versions.length > 0 ? (
        <div className="semantic-version-list">
          {versions
            .toSorted((left, right) => right.version - left.version)
            .map((version) => {
              const transition = transitionValueVersionEditorConfig(definition, version);
              return (
                <article key={version.id} className="semantic-version-card">
                  <header>
                    <div>
                      <strong>v{version.version}</strong>
                      <small>{version.changeSummary}</small>
                    </div>
                    <StatusPill
                      value={version.status}
                      label={semanticStatusLabel(version.status)}
                    />
                  </header>
                  <p>{version.statement}</p>
                  <dl>
                    <div>
                      <dt>修订</dt>
                      <dd>r{version.revision}</dd>
                    </div>
                    <div>
                      <dt>Owner</dt>
                      <dd>
                        {ownerTypeLabel(version.owner.type)} · {shortId(version.owner.id)}
                      </dd>
                    </div>
                    <div>
                      <dt>有效期</dt>
                      <dd>{formatEffectivePeriod(version)}</dd>
                    </div>
                    <div>
                      <dt>指标 / 约束</dt>
                      <dd>
                        {version.metrics.length} / {version.constraints.length}
                      </dd>
                    </div>
                  </dl>
                  <div className="semantic-permissions" aria-label="权限标签">
                    {version.permissionLabels.length > 0 ? (
                      version.permissionLabels.map((label) => <code key={label}>{label}</code>)
                    ) : (
                      <span>无附加权限标签</span>
                    )}
                  </div>
                  <footer>
                    <button
                      className="button compact secondary"
                      type="button"
                      onClick={() => setEditor(updateValueVersionEditorConfig(definition, version))}
                    >
                      编辑版本
                    </button>
                    {transition ? (
                      <button
                        className="button compact primary"
                        type="button"
                        onClick={() => setEditor(transition.editor)}
                      >
                        {transition.label}
                      </button>
                    ) : null}
                  </footer>
                </article>
              );
            })}
        </div>
      ) : null}
      {editor ? (
        <ContractJsonEditor config={editor} onClose={() => setEditor(null)} onSaved={saved} />
      ) : null}
    </section>
  );
}

export function ProcessVersionsPanel({
  definition,
  onDefinitionChanged,
}: {
  definition: ProcessDefinition;
  onDefinitionChanged: () => void;
}): ReactNode {
  const [versions, setVersions] = useState<ProcessVersion[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [editor, setEditor] = useState<ContractJsonEditorConfig | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void listProcessVersions(definition.id, controller.signal)
      .then(setVersions)
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) setError(messageFromError(caught));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [definition.id, reloadKey]);

  const reload = (): void => setReloadKey((value) => value + 1);
  const saved = (): void => {
    setEditor(null);
    setNotice('流程版本操作已由服务端确认。');
    reload();
    onDefinitionChanged();
  };

  return (
    <section className="card semantic-child-panel">
      <header className="semantic-child-heading">
        <div>
          <span className="eyebrow">PROCESS IDENTITY</span>
          <h3>流程版本与节点身份</h3>
          <p>任务只引用已发布版本中的稳定节点 ID 和 code。</p>
        </div>
        <button
          className="button compact primary"
          type="button"
          onClick={() => setEditor(createProcessVersionEditorConfig(definition))}
        >
          创建版本草稿
        </button>
      </header>
      <Notice tone="info">
        Process Definition / Version 暂由隔离 DTO 校验，待共享 contract 提供对应 schema 后收敛。
      </Notice>
      {notice ? (
        <Notice tone="success" onClose={() => setNotice(null)}>
          {notice}
        </Notice>
      ) : null}
      {loading && versions === null ? <LoadingPanel label="正在读取流程版本…" /> : null}
      {error && versions === null ? <ErrorState message={error} onRetry={reload} /> : null}
      {error && versions !== null ? <Notice tone="error">{error}</Notice> : null}
      {versions?.length === 0 ? (
        <EmptyState
          title="还没有流程版本"
          description="创建至少包含 START 和 END 节点的草稿后再发布。"
        />
      ) : null}
      {versions && versions.length > 0 ? (
        <div className="semantic-version-list">
          {versions
            .toSorted((left, right) => right.version - left.version)
            .map((version) => {
              const transition = transitionProcessVersionEditorConfig(definition, version);
              return (
                <article key={version.id} className="semantic-version-card">
                  <header>
                    <div>
                      <strong>v{version.version}</strong>
                      <small>{version.changeSummary}</small>
                    </div>
                    <StatusPill
                      value={version.status}
                      label={semanticStatusLabel(version.status)}
                    />
                  </header>
                  <dl>
                    <div>
                      <dt>修订</dt>
                      <dd>r{version.revision}</dd>
                    </div>
                    <div>
                      <dt>Owner</dt>
                      <dd>
                        {ownerTypeLabel(version.owner.type)} · {shortId(version.owner.id)}
                      </dd>
                    </div>
                    <div>
                      <dt>有效期</dt>
                      <dd>{formatEffectivePeriod(version)}</dd>
                    </div>
                    <div>
                      <dt>节点</dt>
                      <dd>{version.nodes.length} 个</dd>
                    </div>
                  </dl>
                  <div className="process-node-list" aria-label={`流程 v${version.version} 节点`}>
                    {version.nodes
                      .toSorted((left, right) => left.ordinal - right.ordinal)
                      .map((node) => (
                        <span key={node.id}>
                          <i>{node.ordinal + 1}</i>
                          <strong>{node.name}</strong>
                          <code>{node.code}</code>
                          <small>{node.type}</small>
                        </span>
                      ))}
                  </div>
                  <footer>
                    <button
                      className="button compact secondary"
                      type="button"
                      onClick={() =>
                        setEditor(updateProcessVersionEditorConfig(definition, version))
                      }
                    >
                      编辑版本
                    </button>
                    {transition ? (
                      <button
                        className="button compact primary"
                        type="button"
                        onClick={() => setEditor(transition.editor)}
                      >
                        {transition.label}
                      </button>
                    ) : null}
                  </footer>
                  <small className="semantic-version-updated">
                    更新于 {formatDate(version.updatedAt)}
                  </small>
                </article>
              );
            })}
        </div>
      ) : null}
      {editor ? (
        <ContractJsonEditor config={editor} onClose={() => setEditor(null)} onSaved={saved} />
      ) : null}
    </section>
  );
}
