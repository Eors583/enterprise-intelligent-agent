import type {
  AdminOrganizationResponse,
  KnowledgeBase,
  KnowledgeBaseIndexReadiness,
  KnowledgeBaseOrgUnitScope,
  KnowledgeDocument,
  KnowledgeDocumentSummary,
  KnowledgeDocumentVersionDetail,
  KnowledgeGraphOverview,
} from '@enterprise/contracts';
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';

import {
  archiveKnowledgeDocument,
  createKnowledgeBase,
  createKnowledgeDocument,
  deleteKnowledgeBase,
  getKnowledgeDocument,
  getKnowledgeDocumentVersion,
  getLexiangKnowledgeConnection,
  getOrganization,
  listKnowledgeBases,
  syncExternalKnowledgeBase,
  syncLexiangKnowledgeBases,
  updateKnowledgeBase,
  updateKnowledgeDocument,
} from '@/api/admin-api';
import { messageFromError } from '@/api/client';
import { Icon } from '@/components/Icons';
import { KnowledgeDocumentsPanel } from '@/components/knowledge/KnowledgeDocumentsPanel';
import { KnowledgeEmbeddingIndexPanel } from '@/components/knowledge/KnowledgeEmbeddingIndexPanel';
import { KnowledgeReadinessPanel } from '@/components/knowledge/KnowledgeReadinessPanel';
import {
  KnowledgeImportModal,
  type KnowledgeImportResult,
} from '@/components/knowledge/KnowledgeImportModal';
import { latestEditableDraft } from '@/components/knowledge/knowledge-ingestion-outcome';
import { KnowledgeRetrievalTestPanel } from '@/components/knowledge/KnowledgeRetrievalTestPanel';
import { knowledgeReadinessRefreshToken } from '@/components/knowledge/knowledge-readiness-view';
import {
  KnowledgeAccessPicker,
  knowledgeAccessError,
  knowledgeAccessMode,
  knowledgeAccessSummary,
  type KnowledgeAccessMode,
} from './KnowledgeAccessPicker';
import {
  companyKnowledgeSpaceDraft,
  KnowledgeSpacePicker,
  knowledgeSpaceDraftError,
  knowledgeSpaceDraftFromBase,
  knowledgeSpaceSelectionFromDraft,
  type KnowledgeSpaceDraft,
} from './KnowledgeSpacePicker';
import {
  buildKnowledgeSpaceTree,
  knowledgeSpaceRootLabel,
  visibleKnowledgeBases,
} from './knowledge-space-tree';
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

export function KnowledgePage({
  currentUserId,
  currentUserName,
}: {
  currentUserId: string;
  currentUserName: string;
}): ReactNode {
  const [items, setItems] = useState<KnowledgeBase[]>([]);
  const [organization, setOrganization] = useState<AdminOrganizationResponse | null>(null);
  const [organizationLoading, setOrganizationLoading] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [organizationError, setOrganizationError] = useState<string | null>(null);
  const [lexiangReady, setLexiangReady] = useState(false);
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
  const [lexiangSyncing, setLexiangSyncing] = useState(false);
  const [lexiangSyncError, setLexiangSyncError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setOrganizationLoading(true);
    void getOrganization(controller.signal)
      .then((organization) => {
        setOrganizationError(null);
        setOrganization(organization);
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
    void getLexiangKnowledgeConnection(controller.signal)
      .then(({ connection }) => {
        setLexiangReady(
          connection?.status === 'ACTIVE' &&
            connection.credentialsConfigured &&
            connection.teamId !== null &&
            connection.operatorStaffId !== null,
        );
      })
      .catch(() => setLexiangReady(false));
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void listKnowledgeBases(controller.signal)
      .then((knowledge) => {
        const visibleItems = visibleKnowledgeBases(knowledge.items);
        setItems(visibleItems);
        setSelectedId((current) => {
          if (current && visibleItems.some((item) => item.id === current)) return current;
          return visibleItems[0]?.id ?? null;
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

  const syncLexiang = async (): Promise<void> => {
    setLexiangSyncing(true);
    setLexiangSyncError(null);
    try {
      const result = await syncLexiangKnowledgeBases();
      const privacyReview =
        result.requiresPrivacyReview === 0
          ? ''
          : `；${result.requiresPrivacyReview} 个知识库仍继承乐享侧权限，已停止检索，请先在乐享设为不可见且不继承团队权限`;
      setNotice(
        `已发现 ${result.discovered} 个乐享知识库，新导入 ${result.imported} 个，更新 ${result.updated} 个；同步 ${result.foldersSynchronized} 个文件夹、发现 ${result.documentsDiscovered} 篇文档（新增 ${result.documentsImported}、更新 ${result.documentsUpdated}、归档 ${result.documentsArchived}）${privacyReview}。新导入知识库以草稿保存，默认仅当前管理员可访问，请确认本系统权限后再启用。`,
      );
      reload();
    } catch (caught) {
      setLexiangSyncError(messageFromError(caught));
    } finally {
      setLexiangSyncing(false);
    }
  };

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
  const units = organization?.orgUnits ?? [];
  const spaceTree = useMemo(() => buildKnowledgeSpaceTree(items, query), [items, query]);

  const completeImport = (result: KnowledgeImportResult): void => {
    setImportOpen(false);
    setSelectedId(result.knowledgeBase.id);
    const failureCopy =
      result.failedCount > 0
        ? `，其中 ${result.failedCount} 份处理失败，可在列表中查看原因并重试`
        : '';
    setNotice(
      result.createdKnowledgeBase
        ? `“${result.knowledgeBase.name}”已由 ${result.uploadedCount} 份文件创建为草稿知识库${failureCopy}。`
        : `已向“${result.knowledgeBase.name}”上传 ${result.uploadedCount} 份文件${failureCopy}。`,
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
            className="button secondary"
            type="button"
            onClick={() => void syncLexiang()}
            disabled={!lexiangReady || loading || lexiangSyncing}
            title={lexiangReady ? undefined : '请先在“知识来源”完成乐享验证并连接'}
          >
            <Icon name="refresh" size={17} />
            {lexiangSyncing ? '正在同步乐享…' : '同步乐享知识库'}
          </button>
          <button
            className="button primary"
            type="button"
            onClick={() => setImportOpen(true)}
            disabled={
              loading ||
              selected?.status === 'ARCHIVED' ||
              (selected?.storageProvider === 'LEXIANG' &&
                selected.externalSpace?.status !== 'ACTIVE')
            }
          >
            <span aria-hidden="true">↑</span>{' '}
            {selected === null ? '上传资料并新建库' : '上传到当前库'}
          </button>
          <button
            className="button secondary"
            type="button"
            onClick={() => setCreateOpen(true)}
            disabled={loading}
          >
            <Icon name="plus" size={17} /> 新建空库
          </button>
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
      {lexiangSyncError ? (
        <Notice tone="error" onClose={() => setLexiangSyncError(null)}>
          乐享知识库同步失败：{lexiangSyncError}
        </Notice>
      ) : null}
      {error && items.length > 0 ? (
        <Notice tone="info">刷新处理状态失败，正在保留上次结果并继续重试：{error}</Notice>
      ) : null}
      {loading && items.length === 0 ? <LoadingPanel label="正在读取知识资产…" /> : null}
      {error && items.length === 0 ? <ErrorState message={error} onRetry={reload} /> : null}

      {(!loading && !error) || items.length > 0 ? (
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
            <div className="knowledge-space-tree" role="tree" aria-label="知识空间树">
              {spaceTree.map((root) => (
                <details className="knowledge-space-root" key={root.type} open>
                  <summary>
                    <span className="knowledge-space-root-glyph" aria-hidden="true">
                      {root.glyph}
                    </span>
                    <span>
                      <strong>{root.label}</strong>
                      <small>{root.description}</small>
                    </span>
                    <span className="knowledge-space-count">{root.itemCount}</span>
                  </summary>
                  <div className="knowledge-space-groups">
                    {root.groups.map((group) => (
                      <details className="knowledge-space-group" key={group.targetId} open>
                        <summary>
                          <span>{group.targetName}</span>
                          <small>{group.items.length} 个知识库</small>
                        </summary>
                        <div className="knowledge-list">
                          {group.items.map((item) => (
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
                              <StatusPill
                                value={item.status}
                                {...(item.status === 'ARCHIVED' ? { label: '已删除' } : {})}
                              />
                            </button>
                          ))}
                        </div>
                      </details>
                    ))}
                    {root.groups.length === 0 ? (
                      <p className="knowledge-space-empty">
                        {query.trim().length > 0 ? '没有匹配内容' : '尚未创建'}
                      </p>
                    ) : null}
                  </div>
                </details>
              ))}
            </div>
          </aside>

          <section className="knowledge-detail">
            {selected ? (
              <KnowledgeBaseEditor
                key={`${selected.id}-${selected.version}`}
                currentUserId={currentUserId}
                currentUserName={currentUserName}
                item={selected}
                organization={organization}
                knowledgeBases={items}
                organizationReady={organizationReady}
                onCreateDocument={() => setDocumentCreateOpen(true)}
                onEditDocument={(document) => void openDocument(document)}
                onChanged={(message) => {
                  setNotice(message);
                  reload();
                }}
              />
            ) : (
              <EmptyState
                title={items.length === 0 ? '为四类知识空间添加第一份资料' : '请选择知识库'}
                description={
                  items.length === 0
                    ? '公司、部门、项目和成员知识是四个并列根节点。上传时选择存放位置，归属账号自动使用当前登录账号。'
                    : '从左侧分层树中选择需要维护的知识库。'
                }
                action={
                  items.length === 0 ? (
                    <div className="knowledge-empty-actions">
                      <button
                        className="button primary"
                        type="button"
                        onClick={() => setImportOpen(true)}
                      >
                        <span aria-hidden="true">↑</span> 选择存放位置并导入
                      </button>
                      <button
                        className="button secondary"
                        type="button"
                        onClick={() => setCreateOpen(true)}
                      >
                        仅新建空库
                      </button>
                    </div>
                  ) : undefined
                }
              />
            )}
          </section>
        </div>
      ) : null}

      {createOpen ? (
        <CreateKnowledgeBaseModal
          currentUserId={currentUserId}
          currentUserName={currentUserName}
          organization={organization}
          knowledgeBases={items}
          organizationReady={organizationReady}
          lexiangReady={lexiangReady}
          onClose={() => setCreateOpen(false)}
          onCreated={(created) => {
            setCreateOpen(false);
            setNotice(
              created.externalSpace?.status === 'ACTIVE'
                ? '知识库已在腾讯乐享创建并完成本地绑定。'
                : created.storageProvider === 'LEXIANG'
                  ? '本地记录已创建，但乐享同步需要重试。'
                  : '知识库已创建。',
            );
            reload();
          }}
        />
      ) : null}
      {importOpen ? (
        <KnowledgeImportModal
          currentUserId={currentUserId}
          currentUserName={currentUserName}
          organization={organization}
          knowledgeBases={items}
          {...(selected === null ? {} : { targetKnowledgeBase: selected })}
          onClose={() => setImportOpen(false)}
          onImported={completeImport}
        />
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

function CreateKnowledgeBaseModal({
  currentUserId,
  currentUserName,
  organization,
  knowledgeBases,
  organizationReady,
  lexiangReady,
  onClose,
  onCreated,
}: {
  currentUserId: string;
  currentUserName: string;
  organization: AdminOrganizationResponse | null;
  knowledgeBases: ReadonlyArray<KnowledgeBase>;
  organizationReady: boolean;
  lexiangReady: boolean;
  onClose: () => void;
  onCreated: (knowledgeBase: KnowledgeBase) => void;
}): ReactNode {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [space, setSpace] = useState<KnowledgeSpaceDraft>(() =>
    companyKnowledgeSpaceDraft(organization),
  );
  const [accessMode, setAccessMode] = useState<KnowledgeAccessMode>('ENTERPRISE');
  const [orgUnitScopes, setOrgUnitScopes] = useState<KnowledgeBaseOrgUnitScope[]>([]);
  const [memberUserIds, setMemberUserIds] = useState<string[]>([]);
  const [storageProvider, setStorageProvider] = useState<'LOCAL' | 'LEXIANG'>(() =>
    lexiangReady ? 'LEXIANG' : 'LOCAL',
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!organizationReady) {
      setError('组织架构尚未读取完成，暂不能保存知识存放位置和可见范围。');
      return;
    }
    const spaceError = knowledgeSpaceDraftError(space);
    if (spaceError !== null) {
      setError(spaceError);
      return;
    }
    const accessError = knowledgeAccessError(accessMode, orgUnitScopes, memberUserIds);
    if (accessError !== null) {
      setError(accessError);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const created = await createKnowledgeBase({
        name,
        description: description || null,
        status: 'ACTIVE',
        space: knowledgeSpaceSelectionFromDraft(space),
        orgUnitIds: [],
        orgUnitScopes,
        memberUserIds,
        storageProvider,
      });
      onCreated(created);
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
        <p className="form-hint">
          创建后上传资料；系统完成解析、切片和索引后，资料会自动对员工可用。
        </p>
        <label>
          <span>知识库存储</span>
          <select
            value={storageProvider}
            onChange={(event) => setStorageProvider(event.target.value as 'LOCAL' | 'LEXIANG')}
          >
            <option value="LOCAL">本系统知识库</option>
            <option value="LEXIANG" disabled={!lexiangReady}>
              {lexiangReady ? '腾讯乐享知识库' : '腾讯乐享（请先完成知识来源配置）'}
            </option>
          </select>
        </label>
        {storageProvider === 'LEXIANG' ? (
          <Notice tone="info">
            远端知识库将设为不可见，团队成员不继承权限；员工访问继续由本系统下方的可见范围控制。
          </Notice>
        ) : null}
        <KnowledgeSpacePicker
          currentUserId={currentUserId}
          currentUserName={currentUserName}
          organization={organization}
          knowledgeBases={knowledgeBases}
          value={space}
          disabled={!organizationReady}
          onChange={setSpace}
        />
        <KnowledgeAccessPicker
          organization={organization}
          mode={accessMode}
          orgUnitScopes={orgUnitScopes}
          memberUserIds={memberUserIds}
          disabled={!organizationReady}
          onModeChange={setAccessMode}
          onOrgUnitScopesChange={setOrgUnitScopes}
          onMemberUserIdsChange={setMemberUserIds}
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
  currentUserId,
  currentUserName,
  item,
  organization,
  knowledgeBases,
  organizationReady,
  onCreateDocument,
  onEditDocument,
  onChanged,
}: {
  currentUserId: string;
  currentUserName: string;
  item: KnowledgeBase;
  organization: AdminOrganizationResponse | null;
  knowledgeBases: ReadonlyArray<KnowledgeBase>;
  organizationReady: boolean;
  onCreateDocument: () => void;
  onEditDocument: (document: KnowledgeDocumentSummary) => void;
  onChanged: (message: string) => void;
}): ReactNode {
  const [name, setName] = useState(item.name);
  const [description, setDescription] = useState(item.description ?? '');
  const [space, setSpace] = useState<KnowledgeSpaceDraft>(() => knowledgeSpaceDraftFromBase(item));
  const [retrievalConfig, setRetrievalConfig] = useState(item.retrievalConfig);
  const [chunkingConfig, setChunkingConfig] = useState(item.chunkingConfig);
  const [accessMode, setAccessMode] = useState<KnowledgeAccessMode>(() =>
    knowledgeAccessMode(item.orgUnitScopes, item.memberUserIds),
  );
  const [orgUnitScopes, setOrgUnitScopes] = useState<KnowledgeBaseOrgUnitScope[]>([
    ...item.orgUnitScopes,
  ]);
  const [memberUserIds, setMemberUserIds] = useState<string[]>([...item.memberUserIds]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'documents' | 'retrieval' | 'readiness' | 'settings'>(
    'documents',
  );
  const [enterpriseReadiness, setEnterpriseReadiness] =
    useState<KnowledgeBaseIndexReadiness | null>(null);
  const [enterpriseGraphOverview, setEnterpriseGraphOverview] =
    useState<KnowledgeGraphOverview | null>(null);
  const readinessRefreshToken = knowledgeReadinessRefreshToken(item.documents);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!organizationReady) {
      setError('组织架构尚未读取完成，暂不能保存知识存放位置和可见范围。');
      return;
    }
    const spaceError = knowledgeSpaceDraftError(space);
    if (spaceError !== null) {
      setError(spaceError);
      return;
    }
    const accessError = knowledgeAccessError(accessMode, orgUnitScopes, memberUserIds);
    if (accessError !== null) {
      setError(accessError);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await updateKnowledgeBase(item.id, {
        name,
        description: description || null,
        space: knowledgeSpaceSelectionFromDraft(space),
        retrievalConfig,
        chunkingConfig,
        orgUnitScopes,
        memberUserIds,
        expectedVersion: item.version,
      });
      onChanged('知识库设置已更新。');
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setSubmitting(false);
    }
  };

  const removeKnowledgeBase = async (): Promise<void> => {
    const managedByLexiang = item.storageProvider === 'LEXIANG';
    if (
      !window.confirm(
        managedByLexiang
          ? `确认删除知识库“${item.name}”吗？系统会先删除腾讯乐享中的对应知识库，成功后再从本系统归档。`
          : `确认删除知识库“${item.name}”吗？知识库及其中的资料将不再显示。`,
      )
    )
      return;
    setSubmitting(true);
    setError(null);
    try {
      await deleteKnowledgeBase(item.id, item.version);
      onChanged(
        managedByLexiang ? '腾讯乐享中的对应知识库已删除，本系统记录已归档。' : '知识库已删除。',
      );
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setSubmitting(false);
    }
  };

  const retryExternalSync = async (): Promise<void> => {
    setSubmitting(true);
    setError(null);
    try {
      await syncExternalKnowledgeBase(item.id);
      onChanged('腾讯乐享知识库已重新同步。');
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
                {knowledgeSpaceRootLabel(item.space.type)} / {item.space.targetName} · 更新于{' '}
                {formatDate(item.updatedAt)}
              </p>
              <small className="knowledge-access-summary">
                {knowledgeAccessSummary(item.orgUnitScopes, item.memberUserIds)}
              </small>
            </span>
          </div>
          <StatusPill
            value={item.status}
            {...(item.status === 'ARCHIVED' ? { label: '已删除' } : {})}
          />
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
            className={activeTab === 'retrieval' ? 'active' : ''}
            onClick={() => setActiveTab('retrieval')}
          >
            检索测试
          </button>
          <button
            type="button"
            className={activeTab === 'readiness' ? 'active' : ''}
            onClick={() => setActiveTab('readiness')}
          >
            运行状态
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

      {activeTab === 'readiness' ? (
        <KnowledgeReadinessPanel
          knowledgeBaseId={item.id}
          refreshToken={readinessRefreshToken}
          onReadinessChange={setEnterpriseReadiness}
          onGraphOverviewChange={setEnterpriseGraphOverview}
          onReviewFailures={() => setActiveTab('documents')}
        />
      ) : null}

      {activeTab === 'documents' ? (
        <KnowledgeDocumentsPanel
          item={item}
          organization={organization}
          organizationReady={organizationReady}
          onCreateDocument={onCreateDocument}
          onEditDocument={onEditDocument}
          onChanged={onChanged}
        />
      ) : null}

      {activeTab === 'retrieval' ? (
        <KnowledgeRetrievalTestPanel
          knowledgeBaseId={item.id}
          knowledgeBaseStatus={item.status}
          storageProvider={item.storageProvider}
          documents={item.documents}
        />
      ) : null}

      {activeTab === 'settings' ? (
        <form
          className="card knowledge-settings form-stack knowledge-tab-panel"
          onSubmit={(event) => void submit(event)}
        >
          <header className="card-header">
            <div>
              <h2>知识库设置</h2>
              <p>维护知识存放位置、名称、生命周期状态和智能体可访问范围。</p>
            </div>
          </header>
          {item.externalSpace ? (
            <>
              <div className="integration-overview" aria-label="腾讯乐享知识库绑定信息">
                <div>
                  <span>存储位置</span>
                  <strong>腾讯乐享</strong>
                </div>
                <div>
                  <span>同步状态</span>
                  <strong>{externalSpaceStatusLabel(item.externalSpace.status)}</strong>
                </div>
                <div>
                  <span>乐享团队 ID</span>
                  <strong>{item.externalSpace.externalTeamId}</strong>
                </div>
                <div>
                  <span>乐享知识库 ID</span>
                  <strong>{item.externalSpace.externalSpaceId ?? '等待创建'}</strong>
                </div>
                <div>
                  <span>乐享根目录 ID</span>
                  <strong>{item.externalSpace.externalRootEntryId ?? '等待获取'}</strong>
                </div>
                <div>
                  <span>最近同步</span>
                  <strong>
                    {item.externalSpace.lastSyncedAt
                      ? formatDate(item.externalSpace.lastSyncedAt)
                      : '尚未完成'}
                  </strong>
                </div>
              </div>
              <Notice
                tone={
                  item.externalSpace.status === 'ACTIVE' &&
                  item.externalSpace.visibleType === 0 &&
                  item.externalSpace.managerInheritType === 'none' &&
                  item.externalSpace.memberInheritType === 'none'
                    ? 'info'
                    : 'error'
                }
              >
                乐享侧固定为私有且不继承团队权限；员工能否访问由本系统下方的组织与成员范围决定。
                {item.externalSpace.lastErrorCode
                  ? ` 最近一次同步错误：${item.externalSpace.lastErrorCode}。`
                  : ''}
              </Notice>
              {item.externalSpace.status === 'SYNC_FAILED' ||
              item.externalSpace.status === 'PROVISIONING' ? (
                <div className="page-actions">
                  <button
                    className="button secondary"
                    type="button"
                    disabled={submitting}
                    onClick={() => void retryExternalSync()}
                  >
                    重新同步乐享知识库
                  </button>
                </div>
              ) : null}
            </>
          ) : null}
          <KnowledgeEmbeddingIndexPanel
            knowledgeBase={item}
            readiness={enterpriseReadiness}
            onChanged={onChanged}
          />
          <div className="form-grid">
            <label>
              <span>知识库名称</span>
              <input value={name} onChange={(event) => setName(event.target.value)} />
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
          <KnowledgeSpacePicker
            currentUserId={currentUserId}
            currentUserName={currentUserName}
            organization={organization}
            knowledgeBases={knowledgeBases}
            value={space}
            disabled={!organizationReady}
            onChange={setSpace}
          />
          <section className="form-stack">
            <header className="card-header">
              <div>
                <h3>知识检索</h3>
                <p>默认方案兼顾关键词与语义理解，通常无需调整高级参数。</p>
              </div>
            </header>
            <div className="form-grid two">
              <label>
                <span>检索模式</span>
                <select
                  value={retrievalConfig.mode}
                  onChange={(event) =>
                    setRetrievalConfig((current) => ({
                      ...current,
                      mode: event.target.value as typeof current.mode,
                    }))
                  }
                >
                  <option value="HYBRID">混合检索（推荐）</option>
                  <option value="VECTOR">向量检索</option>
                  <option value="FULL_TEXT">全文检索</option>
                </select>
              </label>
              <label>
                <span>模型重排</span>
                <select
                  value={retrievalConfig.rerankEnabled ? 'ENABLED' : 'DISABLED'}
                  onChange={(event) =>
                    setRetrievalConfig((current) => ({
                      ...current,
                      rerankEnabled: event.target.value === 'ENABLED',
                    }))
                  }
                >
                  <option value="ENABLED">启用（推荐）</option>
                  <option value="DISABLED">停用</option>
                </select>
              </label>
            </div>
          </section>
          <details className="knowledge-advanced-settings">
            <summary>高级检索参数（通常无需修改）</summary>
            <div className="form-stack">
              <Notice tone="info">
                这些参数会影响召回数量、相关度门槛和新文档切分。没有真实评测结果时建议保留当前值。
              </Notice>
              <section className="form-stack">
                <header className="card-header">
                  <div>
                    <h3>召回与排序</h3>
                    <p>用于检索调优和问题集对比。</p>
                  </div>
                </header>
                <div className="form-grid two">
                  <label>
                    <span>最多返回切片</span>
                    <input
                      type="number"
                      min={1}
                      max={20}
                      value={retrievalConfig.topK}
                      onChange={(event) =>
                        setRetrievalConfig((current) => ({
                          ...current,
                          topK: Number(event.target.value),
                        }))
                      }
                    />
                  </label>
                  <label>
                    <span>最低相关度</span>
                    <input
                      type="number"
                      min={0}
                      max={1}
                      step={0.01}
                      value={retrievalConfig.scoreThreshold}
                      onChange={(event) =>
                        setRetrievalConfig((current) => ({
                          ...current,
                          scoreThreshold: Number(event.target.value),
                        }))
                      }
                    />
                  </label>
                  <label>
                    <span>语义权重（关键词权重自动补足）</span>
                    <input
                      type="number"
                      min={0}
                      max={1}
                      step={0.05}
                      value={retrievalConfig.semanticWeight}
                      disabled={retrievalConfig.mode !== 'HYBRID'}
                      onChange={(event) => {
                        const semanticWeight = Number(event.target.value);
                        setRetrievalConfig((current) => ({
                          ...current,
                          semanticWeight,
                          keywordWeight: Number((1 - semanticWeight).toFixed(4)),
                        }));
                      }}
                    />
                  </label>
                  <label>
                    <span>单篇文档最多切片</span>
                    <input
                      type="number"
                      min={1}
                      max={10}
                      value={retrievalConfig.maxChunksPerDocument}
                      onChange={(event) =>
                        setRetrievalConfig((current) => ({
                          ...current,
                          maxChunksPerDocument: Number(event.target.value),
                        }))
                      }
                    />
                  </label>
                </div>
              </section>
              <section className="form-stack">
                <header className="card-header">
                  <div>
                    <h3>新文档分块</h3>
                    <p>仅影响之后新建或重新索引的版本，不改写已经发布的切片。</p>
                  </div>
                </header>
                <div className="form-grid two">
                  <label>
                    <span>目标 Token 数</span>
                    <input
                      type="number"
                      min={100}
                      max={2000}
                      value={chunkingConfig.targetTokens}
                      onChange={(event) =>
                        setChunkingConfig((current) => ({
                          ...current,
                          targetTokens: Number(event.target.value),
                        }))
                      }
                    />
                  </label>
                  <label>
                    <span>相邻重叠 Token 数</span>
                    <input
                      type="number"
                      min={0}
                      max={500}
                      value={chunkingConfig.overlapTokens}
                      onChange={(event) =>
                        setChunkingConfig((current) => ({
                          ...current,
                          overlapTokens: Number(event.target.value),
                        }))
                      }
                    />
                  </label>
                </div>
              </section>
            </div>
          </details>
          {enterpriseReadiness ? (
            <Notice tone="info">
              当前有 {enterpriseReadiness.documents.ready} 篇就绪文档、
              {enterpriseReadiness.publishedChunkCount} 个已发布切片，语义覆盖率为{' '}
              {Math.round(enterpriseReadiness.semanticCoverage * 100)}%；关系图谱包含{' '}
              {enterpriseGraphOverview?.entityCount ?? 0} 个实体和{' '}
              {enterpriseGraphOverview?.relationCount ?? 0}{' '}
              条关系。这些状态仅用于诊断，不影响启用知识库。
            </Notice>
          ) : null}
          <KnowledgeAccessPicker
            organization={organization}
            mode={accessMode}
            orgUnitScopes={orgUnitScopes}
            memberUserIds={memberUserIds}
            disabled={!organizationReady}
            onModeChange={setAccessMode}
            onOrgUnitScopesChange={setOrgUnitScopes}
            onMemberUserIdsChange={setMemberUserIds}
          />
          <FieldError message={error} />
          <div className="editor-footer">
            <button
              className="button danger-ghost"
              type="button"
              disabled={submitting}
              onClick={() => void removeKnowledgeBase()}
            >
              删除知识库
            </button>
            <button
              className="button primary"
              type="submit"
              disabled={submitting || !organizationReady}
            >
              {submitting ? <Spinner label="正在保存…" /> : '保存知识库设置'}
            </button>
          </div>
        </form>
      ) : null}
    </div>
  );
}

function externalSpaceStatusLabel(
  status: NonNullable<KnowledgeBase['externalSpace']>['status'],
): string {
  switch (status) {
    case 'PROVISIONING':
      return '正在创建';
    case 'ACTIVE':
      return '同步正常';
    case 'SYNC_FAILED':
      return '同步失败';
    case 'DELETING':
      return '正在删除';
    case 'DELETE_FAILED':
      return '删除失败';
    case 'DELETED':
      return '已删除';
  }
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
        status: 'READY',
        contentText,
      });
      onCreated('文本资料已保存，系统处理完成后会自动进入员工检索。');
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
            {submitting ? <Spinner label="正在保存…" /> : '保存并启用'}
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
        status: 'READY',
        expectedVersion: document.documentVersion,
      });
      onChanged('新版本已提交处理，解析、切片和索引完成后将自动可用。');
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setSubmitting(false);
    }
  };

  const archive = async (): Promise<void> => {
    if (
      !window.confirm(
        `确认删除“${document.title}”吗？删除后不会再参与智能体检索，但历史版本和审计记录仍会保留。`,
      )
    )
      return;
    setArchiving(true);
    setError(null);
    try {
      await archiveKnowledgeDocument(
        document.knowledgeBaseId,
        document.id,
        document.documentVersion,
      );
      onChanged('知识文档已删除，不再参与智能体检索。');
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setArchiving(false);
    }
  };

  return (
    <Modal
      title="编辑知识文档"
      description={`${document.sourceType === 'MARKDOWN' ? 'Markdown' : '纯文本'} · ${draft ? `继续编辑版本 v${draft.versionNumber}` : `当前可用版本 ${document.documentVersion}`}`}
      onClose={onClose}
      size="wide"
    >
      <form className="form-stack" onSubmit={(event) => void submit(event)}>
        {draft ? (
          <Notice tone="info">
            已载入较新的编辑版本 v{draft.versionNumber}，保存后会自动替换当前可用版本。
          </Notice>
        ) : null}
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
              {archiving ? '正在删除…' : '删除文档'}
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
