import type {
  AdminOrgUnit,
  KnowledgeBase,
  KnowledgeBaseIndexReadiness,
  KnowledgeBaseOrgUnitScope,
  KnowledgeDocument,
  KnowledgeDocumentSummary,
  KnowledgeDocumentVersionDetail,
  KnowledgeGraphOverview,
} from '@enterprise/contracts';
import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';

import {
  archiveKnowledgeDocument,
  createKnowledgeBase,
  createKnowledgeDocument,
  getKnowledgeDocument,
  getKnowledgeDocumentVersion,
  getOrganization,
  listKnowledgeBases,
  updateKnowledgeBase,
  updateKnowledgeDocument,
} from '@/api/admin-api';
import { messageFromError } from '@/api/client';
import { Icon } from '@/components/Icons';
import { KnowledgeDocumentsPanel } from '@/components/knowledge/KnowledgeDocumentsPanel';
import { KnowledgeGraphPanel } from '@/components/knowledge/KnowledgeGraphPanel';
import { KnowledgeReadinessPanel } from '@/components/knowledge/KnowledgeReadinessPanel';
import {
  KnowledgeImportModal,
  type KnowledgeImportResult,
} from '@/components/knowledge/KnowledgeImportModal';
import { latestEditableDraft } from '@/components/knowledge/knowledge-ingestion-outcome';
import { KnowledgeRetrievalTestPanel } from '@/components/knowledge/KnowledgeRetrievalTestPanel';
import { knowledgeReadinessRefreshToken } from '@/components/knowledge/knowledge-readiness-view';
import { orgUnitPath } from '@/components/knowledge/knowledge-view-model';
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

function formatDate(value: string): string {
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(value));
  } catch {
    return value;
  }
}

interface EditingKnowledgeDocument {
  readonly document: KnowledgeDocument;
  readonly draft: KnowledgeDocumentVersionDetail | null;
}

interface DocumentDetailState {
  readonly summary: KnowledgeDocumentSummary;
  readonly loading: boolean;
  readonly error: string | null;
}

type KnowledgeVisibilityMode = 'ENTERPRISE' | 'DEPARTMENTS';

export function KnowledgePage(): ReactNode {
  const [items, setItems] = useState<KnowledgeBase[]>([]);
  const [units, setUnits] = useState<AdminOrgUnit[]>([]);
  const [organizationLoading, setOrganizationLoading] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [organizationError, setOrganizationError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [documentCreateOpen, setDocumentCreateOpen] = useState(false);
  const [editingDocument, setEditingDocument] = useState<EditingKnowledgeDocument | null>(null);
  const [documentDetailState, setDocumentDetailState] = useState<DocumentDetailState | null>(null);
  const documentDetailRequestId = useRef(0);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setOrganizationLoading(true);
    void getOrganization(controller.signal)
      .then((organization) => {
        setOrganizationError(null);
        setUnits(organization.orgUnits);
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) setOrganizationError(messageFromError(caught));
      })
      .finally(() => {
        if (!controller.signal.aborted) setOrganizationLoading(false);
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void listKnowledgeBases(controller.signal)
      .then((knowledge) => {
        setItems(knowledge.items);
        setSelectedId((current) => {
          if (current && knowledge.items.some((item) => item.id === current)) return current;
          return knowledge.items[0]?.id ?? null;
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

  const hasActiveIngestion = items.some((knowledgeBase) =>
    knowledgeBase.documents.some((document) =>
      document.versions.some(
        (version) =>
          version.status === 'PROCESSING' ||
          version.ingestionJob?.status === 'PENDING' ||
          version.ingestionJob?.status === 'RUNNING',
      ),
    ),
  );

  useEffect(() => {
    if (!hasActiveIngestion) return;
    let timer: number | null = null;
    const schedule = (): void => {
      if (timer !== null || document.visibilityState !== 'visible') return;
      timer = window.setTimeout(() => {
        timer = null;
        setReloadKey((value) => value + 1);
      }, 3_000);
    };
    const visibilityChanged = (): void => {
      if (document.visibilityState === 'visible') schedule();
      else if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
    };
    schedule();
    document.addEventListener('visibilitychange', visibilityChanged);
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', visibilityChanged);
    };
  }, [hasActiveIngestion, reloadKey]);

  const reload = (): void => setReloadKey((value) => value + 1);

  const closeDocumentDetail = (): void => {
    documentDetailRequestId.current += 1;
    setDocumentDetailState(null);
  };

  const openDocument = async (summary: KnowledgeDocumentSummary): Promise<void> => {
    const requestId = documentDetailRequestId.current + 1;
    documentDetailRequestId.current = requestId;
    setDocumentDetailState({ summary, loading: true, error: null });
    try {
      const document = await getKnowledgeDocument(summary.knowledgeBaseId, summary.id);
      const draftSummary = latestEditableDraft(document);
      const draft =
        draftSummary === null
          ? null
          : await getKnowledgeDocumentVersion(
              document.knowledgeBaseId,
              document.id,
              draftSummary.id,
            );
      if (documentDetailRequestId.current !== requestId) return;
      setDocumentDetailState(null);
      setEditingDocument({ document, draft });
    } catch (caught) {
      if (documentDetailRequestId.current !== requestId) return;
      setDocumentDetailState({ summary, loading: false, error: messageFromError(caught) });
    }
  };

  const selected = items.find((item) => item.id === selectedId) ?? null;
  const organizationReady = !organizationLoading && organizationError === null;
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return items.filter(
      (item) =>
        !normalized ||
        item.name.toLowerCase().includes(normalized) ||
        item.key.toLowerCase().includes(normalized),
    );
  }, [items, query]);

  const completeImport = (result: KnowledgeImportResult): void => {
    setImportOpen(false);
    setSelectedId(result.knowledgeBase.id);
    const failureCopy =
      result.failedCount > 0
        ? `，其中 ${result.failedCount} 份处理失败，可在列表中查看原因并重试`
        : '';
    setNotice(
      `“${result.knowledgeBase.name}”已由 ${result.uploadedCount} 份文件创建为草稿知识库${failureCopy}。`,
    );
    reload();
  };

  return (
    <section className="page-section">
      <header className="page-header">
        <div>
          <span className="eyebrow">KNOWLEDGE GOVERNANCE</span>
          <h1>知识库</h1>
          <p>上传 PDF、DOCX 等企业资料，自动完成内容解析、切片和检索索引。</p>
        </div>
        <div className="page-actions">
          <button className="button secondary" type="button" onClick={reload} disabled={loading}>
            <Icon name="refresh" size={17} /> 刷新
          </button>
          <button
            className="button primary"
            type="button"
            onClick={() => setImportOpen(true)}
            disabled={loading}
          >
            <span aria-hidden="true">↑</span> 上传资料
          </button>
          <details className="page-action-advanced">
            <summary>高级</summary>
            <button
              className="button secondary"
              type="button"
              onClick={() => setCreateOpen(true)}
              disabled={loading}
            >
              <Icon name="plus" size={17} /> 新建空库
            </button>
          </details>
        </div>
      </header>

      {notice ? (
        <Notice tone="success" onClose={() => setNotice(null)}>
          {notice}
        </Notice>
      ) : null}
      {organizationError ? (
        <Notice tone="info">
          组织架构暂时无法读取，部门可见范围暂不可编辑：{organizationError}
        </Notice>
      ) : null}
      {error && items.length > 0 ? (
        <Notice tone="info">刷新处理状态失败，正在保留上次结果并继续重试：{error}</Notice>
      ) : null}
      {loading && items.length === 0 ? <LoadingPanel label="正在读取知识资产…" /> : null}
      {error && items.length === 0 ? <ErrorState message={error} onRetry={reload} /> : null}

      {!loading && !error && items.length === 0 ? (
        <EmptyState
          title="上传企业资料，创建第一个知识库"
          description="支持 PDF、Word（DOCX）、TXT 和 Markdown。选择文件后会自动创建草稿知识库，并完成解析、切片和索引。"
          action={
            <div className="knowledge-empty-actions">
              <button className="button primary" type="button" onClick={() => setImportOpen(true)}>
                <span aria-hidden="true">↑</span> 选择文件并导入
              </button>
              <button
                className="button secondary"
                type="button"
                onClick={() => setCreateOpen(true)}
              >
                仅新建空库
              </button>
            </div>
          }
        />
      ) : null}

      {items.length > 0 ? (
        <div className="knowledge-layout">
          <aside className="card knowledge-list-card">
            <div className="knowledge-list-header">
              <div className="search-input">
                <span aria-hidden="true">⌕</span>
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="搜索知识库"
                  aria-label="搜索知识库"
                />
              </div>
            </div>
            <div className="knowledge-list">
              {filtered.map((item) => (
                <button
                  type="button"
                  key={item.id}
                  className={selectedId === item.id ? 'selected' : ''}
                  onClick={() => setSelectedId(item.id)}
                >
                  <span className="knowledge-glyph">知</span>
                  <span className="knowledge-list-copy">
                    <strong>{item.name}</strong>
                    <small>{item.documentCount} 篇文档</small>
                  </span>
                  <StatusPill value={item.status} />
                </button>
              ))}
              {filtered.length === 0 ? <p className="inline-empty">没有匹配的知识库</p> : null}
            </div>
          </aside>

          <section className="knowledge-detail">
            {selected ? (
              <KnowledgeBaseEditor
                key={`${selected.id}-${selected.version}`}
                item={selected}
                units={units}
                organizationReady={organizationReady}
                onCreateDocument={() => setDocumentCreateOpen(true)}
                onEditDocument={(document) => void openDocument(document)}
                onChanged={(message) => {
                  setNotice(message);
                  reload();
                }}
              />
            ) : (
              <EmptyState title="请选择知识库" description="从左侧选择需要维护的知识库。" />
            )}
          </section>
        </div>
      ) : null}

      {createOpen ? (
        <CreateKnowledgeBaseModal
          units={units}
          organizationReady={organizationReady}
          onClose={() => setCreateOpen(false)}
          onCreated={() => {
            setCreateOpen(false);
            setNotice('知识库已创建。');
            reload();
          }}
        />
      ) : null}
      {importOpen ? (
        <KnowledgeImportModal onClose={() => setImportOpen(false)} onImported={completeImport} />
      ) : null}
      {documentCreateOpen && selected ? (
        <CreateDocumentModal
          knowledgeBase={selected}
          onClose={() => setDocumentCreateOpen(false)}
          onCreated={(message) => {
            setDocumentCreateOpen(false);
            setNotice(message);
            reload();
          }}
        />
      ) : null}
      {documentDetailState ? (
        <Modal
          title={`读取“${documentDetailState.summary.title}”`}
          description="正文与草稿仅在打开编辑器时按需读取。"
          onClose={closeDocumentDetail}
        >
          {documentDetailState.loading ? (
            <LoadingPanel label="正在读取文档详情与最新草稿…" />
          ) : (
            <ErrorState
              message={documentDetailState.error ?? '文档详情读取失败。'}
              onRetry={() => void openDocument(documentDetailState.summary)}
            />
          )}
        </Modal>
      ) : null}
      {editingDocument ? (
        <EditDocumentModal
          document={editingDocument.document}
          draft={editingDocument.draft}
          onClose={() => setEditingDocument(null)}
          onChanged={(message) => {
            setEditingDocument(null);
            setNotice(message);
            reload();
          }}
        />
      ) : null}
    </section>
  );
}

function ScopePicker({
  units,
  scopes,
  mode,
  disabled,
  onModeChange,
  onChange,
}: {
  units: ReadonlyArray<AdminOrgUnit>;
  scopes: ReadonlyArray<KnowledgeBaseOrgUnitScope>;
  mode: KnowledgeVisibilityMode;
  disabled: boolean;
  onModeChange: (mode: KnowledgeVisibilityMode) => void;
  onChange: (scopes: KnowledgeBaseOrgUnitScope[]) => void;
}): ReactNode {
  const groupName = useId();
  const toggle = (id: string): void => {
    const selected = scopes.some((scope) => scope.orgUnitId === id);
    onChange(
      selected
        ? scopes.filter((scope) => scope.orgUnitId !== id)
        : [...scopes, { orgUnitId: id, includeChildren: true }],
    );
  };
  const setIncludeChildren = (id: string, includeChildren: boolean): void => {
    onChange(
      scopes.map((scope) => (scope.orgUnitId === id ? { ...scope, includeChildren } : scope)),
    );
  };
  const activeUnits = units
    .filter((unit) => unit.status === 'ACTIVE')
    .sort((left, right) =>
      orgUnitPath(units, left.id).localeCompare(orgUnitPath(units, right.id), 'zh-CN'),
    );
  return (
    <fieldset className="scope-picker" disabled={disabled}>
      <legend>可见部门范围</legend>
      <p>必须明确选择全企业或指定部门；员工检索时还会再次执行服务端权限校验。</p>
      <div className="scope-mode-options">
        <label>
          <input
            type="radio"
            name={groupName}
            checked={mode === 'ENTERPRISE'}
            onChange={() => {
              onModeChange('ENTERPRISE');
              onChange([]);
            }}
          />
          <span>全企业可见</span>
        </label>
        <label>
          <input
            type="radio"
            name={groupName}
            checked={mode === 'DEPARTMENTS'}
            onChange={() => onModeChange('DEPARTMENTS')}
          />
          <span>仅指定部门可见</span>
        </label>
      </div>
      {disabled ? (
        <span className="inline-empty">组织架构尚未就绪，当前范围不会被改写。</span>
      ) : mode === 'DEPARTMENTS' && activeUnits.length === 0 ? (
        <span className="inline-empty">当前没有可选部门</span>
      ) : mode === 'DEPARTMENTS' ? (
        <div className="checkbox-grid">
          {activeUnits.map((unit) => {
            const scope = scopes.find((candidate) => candidate.orgUnitId === unit.id);
            return (
              <div className="scope-picker-row" key={unit.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={scope !== undefined}
                    onChange={() => toggle(unit.id)}
                  />
                  <span>{orgUnitPath(units, unit.id)}</span>
                </label>
                {scope ? (
                  <label className="scope-picker-children">
                    <input
                      type="checkbox"
                      checked={scope.includeChildren}
                      onChange={(event) => setIncludeChildren(unit.id, event.target.checked)}
                    />
                    <span>包含下级部门</span>
                  </label>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : (
        <span className="form-hint">该知识库启用后，企业内所有员工均可在权限范围内检索。</span>
      )}
    </fieldset>
  );
}

function CreateKnowledgeBaseModal({
  units,
  organizationReady,
  onClose,
  onCreated,
}: {
  units: ReadonlyArray<AdminOrgUnit>;
  organizationReady: boolean;
  onClose: () => void;
  onCreated: () => void;
}): ReactNode {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [visibilityMode, setVisibilityMode] = useState<KnowledgeVisibilityMode>('ENTERPRISE');
  const [orgUnitScopes, setOrgUnitScopes] = useState<KnowledgeBaseOrgUnitScope[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!organizationReady) {
      setError('组织架构尚未读取完成，暂不能保存知识库可见范围。');
      return;
    }
    if (visibilityMode === 'DEPARTMENTS' && orgUnitScopes.length === 0) {
      setError('请选择至少一个可见部门，或改为全企业可见。');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await createKnowledgeBase({
        name,
        description: description || null,
        status: 'DRAFT',
        orgUnitIds: [],
        orgUnitScopes,
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
      title="新建知识库"
      description="空知识库会自动生成内部标识并以草稿创建；更推荐直接上传资料。"
      onClose={onClose}
      size="wide"
    >
      <form className="form-stack" onSubmit={(event) => void submit(event)}>
        <label>
          <span>知识库名称</span>
          <input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="例如 产品知识中心"
          />
        </label>
        <label>
          <span>说明</span>
          <textarea
            rows={3}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="说明知识来源、维护责任和适用场景"
          />
        </label>
        <p className="form-hint">创建后先上传资料并完成解析、评测与发布，知识库才会对员工可用。</p>
        <ScopePicker
          units={units}
          scopes={orgUnitScopes}
          mode={visibilityMode}
          disabled={!organizationReady}
          onModeChange={setVisibilityMode}
          onChange={setOrgUnitScopes}
        />
        <FieldError message={error} />
        <div className="modal-actions">
          <button className="button secondary" type="button" onClick={onClose}>
            取消
          </button>
          <button
            className="button primary"
            type="submit"
            disabled={submitting || !organizationReady}
          >
            {submitting ? <Spinner label="正在创建…" /> : '创建知识库'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function KnowledgeBaseEditor({
  item,
  units,
  organizationReady,
  onCreateDocument,
  onEditDocument,
  onChanged,
}: {
  item: KnowledgeBase;
  units: ReadonlyArray<AdminOrgUnit>;
  organizationReady: boolean;
  onCreateDocument: () => void;
  onEditDocument: (document: KnowledgeDocumentSummary) => void;
  onChanged: (message: string) => void;
}): ReactNode {
  const [name, setName] = useState(item.name);
  const [description, setDescription] = useState(item.description ?? '');
  const [status, setStatus] = useState(item.status);
  const [visibilityMode, setVisibilityMode] = useState<KnowledgeVisibilityMode>(
    item.orgUnitScopes.length > 0 ? 'DEPARTMENTS' : 'ENTERPRISE',
  );
  const [orgUnitScopes, setOrgUnitScopes] = useState<KnowledgeBaseOrgUnitScope[]>([
    ...item.orgUnitScopes,
  ]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'documents' | 'graph' | 'retrieval' | 'settings'>(
    'documents',
  );
  const [enterpriseReadiness, setEnterpriseReadiness] =
    useState<KnowledgeBaseIndexReadiness | null>(null);
  const [enterpriseGraphOverview, setEnterpriseGraphOverview] =
    useState<KnowledgeGraphOverview | null>(null);
  const activationRequested = status === 'ACTIVE' && item.status !== 'ACTIVE';
  const activationBlocked =
    activationRequested && (enterpriseReadiness === null || !enterpriseReadiness.activationAllowed);
  const readinessRefreshToken = knowledgeReadinessRefreshToken(item.documents);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!organizationReady) {
      setError('组织架构尚未读取完成，暂不能保存可见范围。');
      return;
    }
    if (visibilityMode === 'DEPARTMENTS' && orgUnitScopes.length === 0) {
      setError('请选择至少一个可见部门，或改为全企业可见。');
      return;
    }
    if (activationBlocked) {
      setError('企业就绪度检查尚未通过，请先处理索引、模型或关系证据阻断项。');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await updateKnowledgeBase(item.id, {
        name,
        description: description || null,
        ...(status === item.status ? {} : { status }),
        orgUnitScopes,
        expectedVersion: item.version,
      });
      onChanged('知识库设置已更新。');
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="knowledge-editor-stack">
      <section className="card knowledge-workspace-header">
        <header className="card-header knowledge-title-header">
          <div className="knowledge-title">
            <span className="knowledge-glyph large">知</span>
            <span>
              <h2>{item.name}</h2>
              <p>
                {item.key} · 更新于 {formatDate(item.updatedAt)}
              </p>
            </span>
          </div>
          <StatusPill value={item.status} />
        </header>
        <nav className="knowledge-tabs" aria-label="知识库管理视图">
          <button
            type="button"
            className={activeTab === 'documents' ? 'active' : ''}
            onClick={() => setActiveTab('documents')}
          >
            文档管理
            <span>{item.documents.length}</span>
          </button>
          <button
            type="button"
            className={activeTab === 'graph' ? 'active' : ''}
            onClick={() => setActiveTab('graph')}
          >
            实体关系
            <span>{enterpriseGraphOverview?.relationCount ?? 0}</span>
          </button>
          <button
            type="button"
            className={activeTab === 'retrieval' ? 'active' : ''}
            onClick={() => setActiveTab('retrieval')}
          >
            检索测试
          </button>
          <button
            type="button"
            className={activeTab === 'settings' ? 'active' : ''}
            onClick={() => setActiveTab('settings')}
          >
            知识库设置
          </button>
        </nav>
      </section>

      <KnowledgeReadinessPanel
        knowledgeBaseId={item.id}
        refreshToken={readinessRefreshToken}
        onReadinessChange={setEnterpriseReadiness}
        onGraphOverviewChange={setEnterpriseGraphOverview}
        onReviewFailures={() => setActiveTab('documents')}
      />

      {activeTab === 'documents' ? (
        <KnowledgeDocumentsPanel
          item={item}
          readiness={enterpriseReadiness}
          onCreateDocument={onCreateDocument}
          onEditDocument={onEditDocument}
          onChanged={onChanged}
        />
      ) : null}

      {activeTab === 'retrieval' ? (
        <KnowledgeRetrievalTestPanel
          knowledgeBaseId={item.id}
          knowledgeBaseStatus={item.status}
          documents={item.documents}
        />
      ) : null}

      {activeTab === 'graph' ? <KnowledgeGraphPanel knowledgeBaseId={item.id} /> : null}

      {activeTab === 'settings' ? (
        <form
          className="card knowledge-settings form-stack knowledge-tab-panel"
          onSubmit={(event) => void submit(event)}
        >
          <header className="card-header">
            <div>
              <h2>知识库设置</h2>
              <p>维护名称、生命周期状态和部门可见范围。</p>
            </div>
          </header>
          <div className="form-grid two">
            <label>
              <span>知识库名称</span>
              <input value={name} onChange={(event) => setName(event.target.value)} />
            </label>
            <label>
              <span>状态</span>
              <select
                value={status}
                onChange={(event) => setStatus(event.target.value as typeof status)}
              >
                <option value="DRAFT">草稿</option>
                <option value="ACTIVE">启用</option>
                <option value="ARCHIVED">归档</option>
              </select>
            </label>
          </div>
          <label>
            <span>说明</span>
            <textarea
              rows={2}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>
          {activationBlocked ? (
            <Notice tone="info">
              企业就绪度门禁未通过，不能启用知识库。请先完成文档处理、当前模型向量覆盖及 Reranker
              配置，并确保实体关系与来源证据满足强关系检索门禁。
            </Notice>
          ) : enterpriseReadiness ? (
            <Notice tone="info">
              当前有 {enterpriseReadiness.documents.ready} 篇就绪文档、
              {enterpriseReadiness.publishedChunkCount} 个已发布切片，语义覆盖率为{' '}
              {Math.round(enterpriseReadiness.semanticCoverage * 100)}%；关系图谱包含{' '}
              {enterpriseGraphOverview?.entityCount ?? 0} 个实体和{' '}
              {enterpriseGraphOverview?.relationCount ?? 0} 条关系。
            </Notice>
          ) : null}
          <ScopePicker
            units={units}
            scopes={orgUnitScopes}
            mode={visibilityMode}
            disabled={!organizationReady}
            onModeChange={setVisibilityMode}
            onChange={setOrgUnitScopes}
          />
          <FieldError message={error} />
          <div className="editor-footer align-end">
            <button
              className="button primary"
              type="submit"
              disabled={submitting || activationBlocked || !organizationReady}
            >
              {submitting ? <Spinner label="正在保存…" /> : '保存知识库设置'}
            </button>
          </div>
        </form>
      ) : null}
    </div>
  );
}

function CreateDocumentModal({
  knowledgeBase,
  onClose,
  onCreated,
}: {
  knowledgeBase: KnowledgeBase;
  onClose: () => void;
  onCreated: (message: string) => void;
}): ReactNode {
  const [title, setTitle] = useState('');
  const [contentText, setContentText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await createKnowledgeDocument(knowledgeBase.id, {
        title,
        sourceType: 'TEXT',
        status: 'DRAFT',
        contentText,
      });
      onCreated('文本资料草稿已保存；完成质检和发布后才会进入员工检索。');
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <Modal
      title="粘贴文本资料"
      description={`这是“${knowledgeBase.name}”的辅助录入方式；正式资料建议使用文件上传。`}
      onClose={onClose}
      size="wide"
    >
      <form className="form-stack" onSubmit={(event) => void submit(event)}>
        <label>
          <span>资料标题</span>
          <input
            autoFocus
            required
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="例如 售后服务处理规范"
          />
        </label>
        <label>
          <span>文档正文</span>
          <textarea
            className="content-editor"
            rows={15}
            value={contentText}
            onChange={(event) => setContentText(event.target.value)}
            placeholder="粘贴需要纳入知识库的正文内容…"
          />
        </label>
        <div className="content-counter">
          {contentText.length.toLocaleString()} / 2,000,000 字符
        </div>
        <FieldError message={error} />
        <div className="modal-actions">
          <button className="button secondary" type="button" onClick={onClose}>
            取消
          </button>
          <button className="button primary" type="submit" disabled={submitting}>
            {submitting ? <Spinner label="正在保存…" /> : '保存文本草稿'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function EditDocumentModal({
  document,
  draft,
  onClose,
  onChanged,
}: {
  document: KnowledgeDocument;
  draft: KnowledgeDocumentVersionDetail | null;
  onClose: () => void;
  onChanged: (message: string) => void;
}): ReactNode {
  const [title, setTitle] = useState(document.title);
  const [contentText, setContentText] = useState(draft?.contentText ?? document.contentText ?? '');
  const [status, setStatus] = useState<'DRAFT' | 'READY' | 'ARCHIVED'>(
    draft !== null
      ? 'DRAFT'
      : document.status === 'READY' || document.status === 'ARCHIVED' || document.status === 'DRAFT'
        ? document.status
        : 'DRAFT',
  );
  const [submitting, setSubmitting] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await updateKnowledgeDocument(document.knowledgeBaseId, document.id, {
        title,
        contentText,
        status,
        expectedVersion: document.documentVersion,
      });
      onChanged(
        status === 'DRAFT'
          ? '知识文档草稿已保存，尚未发布。'
          : '新版本已提交处理，解析、切片和索引完成后将自动发布。',
      );
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setSubmitting(false);
    }
  };

  const archive = async (): Promise<void> => {
    if (!window.confirm(`确认归档“${document.title}”吗？`)) return;
    setArchiving(true);
    setError(null);
    try {
      await archiveKnowledgeDocument(
        document.knowledgeBaseId,
        document.id,
        document.documentVersion,
      );
      onChanged('知识文档已归档。');
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setArchiving(false);
    }
  };

  return (
    <Modal
      title="编辑知识文档"
      description={`${document.sourceType === 'MARKDOWN' ? 'Markdown' : '纯文本'} · ${draft ? `继续编辑草稿 v${draft.versionNumber}` : `当前发布版本 ${document.documentVersion}`}`}
      onClose={onClose}
      size="wide"
    >
      <form className="form-stack" onSubmit={(event) => void submit(event)}>
        {draft ? (
          <Notice tone="info">
            已载入较新的草稿 v{draft.versionNumber}，不会用当前发布正文覆盖未完成内容。
          </Notice>
        ) : null}
        <div className="form-grid document-edit-fields">
          <label>
            <span>文档标题</span>
            <input
              autoFocus
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              disabled={document.status === 'ARCHIVED'}
            />
          </label>
          <label>
            <span>状态</span>
            <select
              value={status}
              onChange={(event) => setStatus(event.target.value as typeof status)}
              disabled={document.status === 'ARCHIVED'}
            >
              <option value="DRAFT">草稿</option>
              <option value="READY">可用</option>
              <option value="ARCHIVED">归档</option>
            </select>
          </label>
        </div>
        <label>
          <span>文档正文</span>
          <textarea
            className="content-editor"
            rows={16}
            value={contentText}
            onChange={(event) => setContentText(event.target.value)}
            disabled={document.status === 'ARCHIVED'}
          />
        </label>
        <div className="content-counter">
          {contentText.length.toLocaleString()} / 2,000,000 字符
        </div>
        <FieldError message={error} />
        <div className="editor-footer">
          {document.status !== 'ARCHIVED' ? (
            <button
              className="button danger-ghost"
              type="button"
              disabled={archiving || submitting}
              onClick={() => void archive()}
            >
              {archiving ? '正在归档…' : '归档文档'}
            </button>
          ) : (
            <span />
          )}
          <button
            className="button primary"
            type="submit"
            disabled={document.status === 'ARCHIVED' || submitting || archiving}
          >
            {submitting ? <Spinner label="正在保存…" /> : '保存新版本'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
