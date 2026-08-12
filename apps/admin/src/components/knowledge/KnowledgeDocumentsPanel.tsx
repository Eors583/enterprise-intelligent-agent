import type {
  AdminOrganizationResponse,
  KnowledgeBase,
  KnowledgeDocumentSummary,
  KnowledgeDocumentVersionSummary,
} from '@enterprise/contracts';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { archiveKnowledgeDocument, retryKnowledgeDocumentIngestion } from '@/api/admin-api';
import { messageFromError } from '@/api/client';
import { Icon } from '@/components/Icons';
import { EmptyState, FieldError, Modal, Spinner, StatusPill } from '@/components/ui';

import { KnowledgeUploadModal } from './KnowledgeUploadModal';
import {
  KnowledgeCreateFolderModal,
  KnowledgeFolderUploadModal,
} from './KnowledgeFolderUploadModal';
import { KnowledgeDocumentAccessModal } from './KnowledgeDocumentAccessModal';
import { KnowledgeChunkPreviewModal } from './KnowledgeChunkPreviewModal';
import { KnowledgeWebImportModal } from './KnowledgeWebImportModal';
import { KnowledgeSourceConnectorsPanel } from './KnowledgeSourceConnectorsPanel';
import {
  knowledgeFolderProcessingSummary,
  type KnowledgeFolderProcessingSummary,
} from '@/features/knowledge/knowledge-folder-processing';
import {
  currentPublishedKnowledgeVersion,
  knowledgeVersionFailure,
  latestKnowledgeVersion,
} from './knowledge-ingestion-outcome';
import {
  filterKnowledgeDocuments,
  previewableKnowledgeVersion,
  type KnowledgeDocumentSourceFilter,
  type KnowledgeDocumentStatusFilter,
} from './knowledge-view-model';

interface ChunkPreviewTarget {
  readonly document: KnowledgeDocumentSummary;
  readonly version: KnowledgeDocumentVersionSummary;
}

interface DocumentAccessTarget {
  readonly document: KnowledgeDocumentSummary;
  readonly version: KnowledgeDocumentVersionSummary;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function sourceLabel(document: KnowledgeDocumentSummary): string {
  if (document.sourceType === 'MARKDOWN') return 'Markdown';
  if (document.sourceType === 'TEXT') return '纯文本';
  if (document.sourceType === 'WEB') return 'HTTPS 网页';
  const extension = document.fileName?.split('.').pop()?.toUpperCase();
  return extension || document.mimeType || '文件';
}

function sourceGlyph(document: KnowledgeDocumentSummary): string {
  if (document.sourceType === 'MARKDOWN') return 'MD';
  if (document.sourceType === 'TEXT') return 'TXT';
  if (document.sourceType === 'WEB') return 'WEB';
  return document.fileName?.split('.').pop()?.slice(0, 4).toUpperCase() || 'FILE';
}

function stageLabel(stage: string, progress: number): string {
  if (stage === 'INDEXING') {
    if (progress < 78) return '生成向量';
    if (progress < 90) return '写入检索索引';
    return '保存切片与向量';
  }
  return (
    {
      UPLOADED: '已上传',
      SECURITY_CHECK: '安全检查',
      PARSING: '解析内容',
      CHUNKING: '文档切片',
      INDEXING: '建立索引',
      READY: '处理完成',
    }[stage] ?? stage
  );
}

function documentStatusLabel(status: string): string {
  return (
    {
      DRAFT: '草稿',
      PROCESSING: '处理中',
      READY: '可用',
      FAILED: '处理失败',
      ARCHIVED: '已删除',
    }[status] ?? status
  );
}

export function KnowledgeDocumentsPanel({
  item,
  organization,
  organizationReady,
  onCreateDocument,
  onEditDocument,
  onChanged,
}: {
  item: KnowledgeBase;
  organization: AdminOrganizationResponse | null;
  organizationReady: boolean;
  onCreateDocument: () => void;
  onEditDocument: (document: KnowledgeDocumentSummary) => void;
  onChanged: (message: string) => void;
}): ReactNode {
  const [uploadTarget, setUploadTarget] = useState<KnowledgeDocumentSummary | 'new' | null>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const [folderUploadFiles, setFolderUploadFiles] = useState<readonly File[] | null>(null);
  const [createFolderOpen, setCreateFolderOpen] = useState(false);
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(null);
  const [webImportOpen, setWebImportOpen] = useState(false);
  const [sourceConnectorsOpen, setSourceConnectorsOpen] = useState(false);
  const [retryingVersionId, setRetryingVersionId] = useState<string | null>(null);
  const [optimisticRetryVersionId, setOptimisticRetryVersionId] = useState<string | null>(null);
  const [archivingDocumentId, setArchivingDocumentId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [sourceFilter, setSourceFilter] = useState<KnowledgeDocumentSourceFilter>('ALL');
  const [statusFilter, setStatusFilter] = useState<KnowledgeDocumentStatusFilter>('ALL');
  const [chunkPreviewTarget, setChunkPreviewTarget] = useState<ChunkPreviewTarget | null>(null);
  const [documentAccessTarget, setDocumentAccessTarget] = useState<DocumentAccessTarget | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const folders = item.folders ?? [];
  const currentFolder = folders.find((folder) => folder.id === currentFolderId) ?? null;
  const childFolders = folders.filter((folder) => folder.parentId === currentFolderId);
  const directoryDocuments = item.documents.filter(
    (document) => document.folderId === currentFolderId,
  );
  const filteredDocuments = filterKnowledgeDocuments(
    directoryDocuments,
    query,
    sourceFilter,
    statusFilter,
  );

  useEffect(() => {
    if (optimisticRetryVersionId === null) return;
    const serverVersion = item.documents
      .flatMap((document) => document.versions)
      .find((version) => version.id === optimisticRetryVersionId);
    if (serverVersion !== undefined && serverVersion.status !== 'FAILED') {
      setOptimisticRetryVersionId(null);
    }
  }, [item.documents, optimisticRetryVersionId]);

  const retry = async (
    document: KnowledgeDocumentSummary,
    version: KnowledgeDocumentVersionSummary,
  ): Promise<void> => {
    setRetryingVersionId(version.id);
    setOptimisticRetryVersionId(version.id);
    setError(null);
    try {
      const result = await retryKnowledgeDocumentIngestion(item.id, document.id, version.id);
      const retriedVersion = result.versions.find((candidate) => candidate.id === version.id);
      const failure = knowledgeVersionFailure(retriedVersion);
      if (failure !== null) {
        setError(`“${document.title}”${failure}`);
        return;
      }
      onChanged(`“${document.title}”已重新提交解析。`);
    } catch (caught) {
      setOptimisticRetryVersionId(null);
      setError(messageFromError(caught));
    } finally {
      setRetryingVersionId(null);
    }
  };

  const archive = async (document: KnowledgeDocumentSummary): Promise<void> => {
    if (
      !window.confirm(
        `确认删除“${document.title}”吗？删除后不会再参与智能体检索，但历史版本和审计记录仍会保留。`,
      )
    )
      return;
    setArchivingDocumentId(document.id);
    setError(null);
    try {
      await archiveKnowledgeDocument(item.id, document.id, document.documentVersion);
      onChanged(`“${document.title}”已删除，不再参与智能体检索。`);
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setArchivingDocumentId(null);
    }
  };

  return (
    <>
      <section className="card documents-card knowledge-tab-panel">
        <header className="card-header">
          <div>
            <h2>知识文档</h2>
            <p>当前 {item.documents.length} 篇；文件会自动完成解析、切片和索引。</p>
          </div>
          <div className="knowledge-document-actions">
            <input
              className="visually-hidden"
              ref={(node) => {
                folderInputRef.current = node;
                node?.setAttribute('webkitdirectory', '');
              }}
              type="file"
              multiple
              aria-label="选择需要上传的文件夹"
              onChange={(event) => {
                const selected = [...(event.target.files ?? [])];
                event.target.value = '';
                if (selected.length > 0) setFolderUploadFiles(selected);
              }}
            />
            <button
              className="button primary compact"
              type="button"
              onClick={() => folderInputRef.current?.click()}
              disabled={item.status === 'ARCHIVED'}
            >
              <span aria-hidden="true">↑</span> 导入文件夹
            </button>
            <button
              className="button secondary compact"
              type="button"
              onClick={() => setCreateFolderOpen(true)}
              disabled={item.status === 'ARCHIVED'}
            >
              <Icon name="plus" size={16} /> 新建文件夹
            </button>
            <button
              className="button secondary compact"
              type="button"
              onClick={() => setWebImportOpen(true)}
              disabled={item.status === 'ARCHIVED'}
            >
              导入网页
            </button>
            <button
              className="button primary compact"
              type="button"
              onClick={() => setUploadTarget('new')}
              disabled={item.status === 'ARCHIVED'}
            >
              <span aria-hidden="true">↑</span> 上传文件
            </button>
            <button
              className="button secondary compact"
              type="button"
              onClick={() => setSourceConnectorsOpen(true)}
              disabled={item.status === 'ARCHIVED'}
            >
              其他来源接入
            </button>
            <button
              className="button secondary compact"
              type="button"
              onClick={onCreateDocument}
              disabled={item.status === 'ARCHIVED'}
            >
              <Icon name="plus" size={16} /> 粘贴文本
            </button>
          </div>
        </header>
        {item.documents.length > 0 || folders.length > 0 ? (
          <nav className="knowledge-folder-breadcrumb" aria-label="当前文件夹路径">
            <button type="button" onClick={() => setCurrentFolderId(null)}>
              全部资料
            </button>
            {currentFolder?.path.split('/').map((segment, index, segments) => {
              const path = segments.slice(0, index + 1).join('/');
              const folder = folders.find((candidate) => candidate.path === path);
              return folder ? (
                <button type="button" key={folder.id} onClick={() => setCurrentFolderId(folder.id)}>
                  <span aria-hidden="true">/</span>
                  {segment}
                </button>
              ) : null;
            })}
          </nav>
        ) : null}
        {item.documents.length > 0 || folders.length > 0 ? (
          <div className="knowledge-document-toolbar">
            <label className="search-input">
              <span aria-hidden="true">⌕</span>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索标题或文件名"
                aria-label="搜索知识文档"
              />
            </label>
            <label>
              <span className="visually-hidden">按来源筛选</span>
              <select
                aria-label="按来源筛选"
                value={sourceFilter}
                onChange={(event) =>
                  setSourceFilter(event.target.value as KnowledgeDocumentSourceFilter)
                }
              >
                <option value="ALL">全部来源</option>
                <option value="FILE">上传文件</option>
                <option value="WEB">HTTPS 网页</option>
                <option value="MARKDOWN">Markdown</option>
                <option value="TEXT">纯文本</option>
              </select>
            </label>
            <label>
              <span className="visually-hidden">按状态筛选</span>
              <select
                aria-label="按状态筛选"
                value={statusFilter}
                onChange={(event) =>
                  setStatusFilter(event.target.value as KnowledgeDocumentStatusFilter)
                }
              >
                <option value="ALL">全部状态</option>
                <option value="READY">可用</option>
                <option value="DRAFT">草稿</option>
                <option value="PROCESSING">处理中</option>
                <option value="FAILED">处理失败</option>
              </select>
            </label>
            <span className="knowledge-filter-count">
              显示 {childFolders.length} 个文件夹、{filteredDocuments.length} /{' '}
              {directoryDocuments.length} 篇文档
            </span>
          </div>
        ) : null}
        <FieldError message={error} />
        {childFolders.length > 0 ? (
          <div className="knowledge-folder-grid">
            {childFolders.map((folder) => (
              <KnowledgeFolderCard
                key={folder.id}
                folder={folder}
                processing={knowledgeFolderProcessingSummary(folder, item.documents)}
                onOpen={() => setCurrentFolderId(folder.id)}
              />
            ))}
          </div>
        ) : null}
        {item.documents.length === 0 && folders.length === 0 ? (
          <EmptyState
            title="还没有文档"
            description="优先上传 PDF、Word、Excel、TXT 或 Markdown 文件；网页和粘贴文本作为辅助来源。"
            action={
              <button
                className="button primary"
                type="button"
                onClick={() => setUploadTarget('new')}
                disabled={item.status === 'ARCHIVED'}
              >
                上传第一份资料
              </button>
            }
          />
        ) : filteredDocuments.length === 0 && childFolders.length === 0 ? (
          <EmptyState
            title={currentFolder ? '这个文件夹还是空的' : '没有匹配的知识文档'}
            description={
              currentFolder
                ? '可以上传文件、上传子文件夹，或新建空文件夹。'
                : '请调整标题关键词、来源或处理状态筛选条件。'
            }
          />
        ) : (
          <div className="document-list knowledge-document-list">
            {filteredDocuments.map((document) => {
              const latest = latestKnowledgeVersion(document);
              const currentPublished = currentPublishedKnowledgeVersion(document);
              const previewVersion = previewableKnowledgeVersion(document);
              const job = latest?.ingestionJob ?? null;
              const retryQueued = optimisticRetryVersionId === latest?.id;
              const inProgress =
                retryQueued ||
                latest?.status === 'PROCESSING' ||
                job?.status === 'PENDING' ||
                job?.status === 'RUNNING';
              const failed =
                !retryQueued && (latest?.status === 'FAILED' || job?.status === 'FAILED');
              const editable =
                (document.sourceType === 'TEXT' || document.sourceType === 'MARKDOWN') &&
                !inProgress &&
                document.status !== 'ARCHIVED';
              const displayedStatus =
                document.status === 'ARCHIVED'
                  ? { value: 'ARCHIVED', label: '已删除' }
                  : retryQueued && latest
                    ? {
                        value: 'PROCESSING',
                        label: `最新 v${latest.versionNumber} · 等待处理`,
                      }
                    : latest && (inProgress || failed || currentPublished === null)
                      ? {
                          value: latest.status,
                          label: `最新 v${latest.versionNumber} · ${documentStatusLabel(latest.status)}`,
                        }
                      : currentPublished
                        ? {
                            value: 'READY',
                            label: `当前可用 v${currentPublished.versionNumber}`,
                          }
                        : { value: 'DRAFT', label: '当前不可用' };

              return (
                <article className="knowledge-document-entry" key={document.id}>
                  <div className="knowledge-document-row">
                    <span className="document-icon">{sourceGlyph(document)}</span>
                    <button
                      className="document-copy knowledge-document-open"
                      type="button"
                      disabled={!editable && previewVersion === null}
                      onClick={() => {
                        if (editable) onEditDocument(document);
                        else if (previewVersion)
                          setChunkPreviewTarget({ document, version: previewVersion });
                      }}
                      title={
                        editable
                          ? '编辑文档'
                          : previewVersion
                            ? '查看文件解析切片'
                            : '当前版本还没有可查看的解析切片'
                      }
                    >
                      <strong>{document.title}</strong>
                      <small>
                        {sourceLabel(document)} · 最新 v
                        {latest?.versionNumber ?? document.documentVersion} ·{' '}
                        {formatDate(document.updatedAt)}
                      </small>
                    </button>
                    <div className="knowledge-document-status-stack">
                      <StatusPill value={displayedStatus.value} label={displayedStatus.label} />
                    </div>
                    {failed && latest ? (
                      <button
                        className="button secondary compact"
                        type="button"
                        disabled={retryingVersionId === latest.id}
                        onClick={() => void retry(document, latest)}
                      >
                        {retryingVersionId === latest.id ? <Spinner label="重试中…" /> : '重试'}
                      </button>
                    ) : null}
                    {document.status !== 'ARCHIVED' ? (
                      <div className="knowledge-document-row-actions">
                        <button
                          className="button secondary compact"
                          type="button"
                          disabled={
                            currentPublished === null ||
                            currentPublished.versionNumber !== document.documentVersion ||
                            organization === null ||
                            !organizationReady ||
                            archivingDocumentId === document.id
                          }
                          onClick={() => {
                            if (currentPublished !== null) {
                              setDocumentAccessTarget({ document, version: currentPublished });
                            }
                          }}
                        >
                          权限变更
                        </button>
                        {document.sourceType === 'FILE' ? (
                          <button
                            className="button secondary compact"
                            type="button"
                            disabled={
                              inProgress ||
                              archivingDocumentId === document.id ||
                              item.status === 'ARCHIVED'
                            }
                            onClick={() => setUploadTarget(document)}
                          >
                            上传新版本
                          </button>
                        ) : null}
                        <button
                          className="button danger-ghost compact"
                          type="button"
                          disabled={inProgress || archivingDocumentId === document.id}
                          onClick={() => void archive(document)}
                        >
                          {archivingDocumentId === document.id ? (
                            <Spinner label="删除中…" />
                          ) : (
                            '删除'
                          )}
                        </button>
                      </div>
                    ) : null}
                  </div>

                  {inProgress && job && !retryQueued ? (
                    <div className="knowledge-ingestion-state" aria-live="polite">
                      <div>
                        <span>{stageLabel(job.stage, job.progress)}</span>
                        <strong>{job.progress}%</strong>
                      </div>
                      <progress max={100} value={job.progress} />
                    </div>
                  ) : null}

                  {retryQueued ? (
                    <div className="knowledge-ingestion-state" aria-live="polite">
                      <div>
                        <span>已提交，等待处理</span>
                        <strong>0%</strong>
                      </div>
                      <progress max={100} value={0} />
                    </div>
                  ) : null}

                  {failed ? (
                    <div className="knowledge-ingestion-error" role="alert">
                      <strong>处理失败{job?.errorCode ? ` · ${job.errorCode}` : ''}</strong>
                      <span>{job?.errorMessage ?? '文档处理未完成，请重试或重新上传文件。'}</span>
                    </div>
                  ) : null}

                  {document.versions.length > 0 ? (
                    <details className="knowledge-version-history">
                      <summary>版本记录（{document.versions.length}）</summary>
                      <div>
                        {[...document.versions]
                          .sort((left, right) => right.versionNumber - left.versionNumber)
                          .map((version) => (
                            <div className="knowledge-version-row" key={version.id}>
                              <span>
                                <strong>v{version.versionNumber}</strong>
                                {document.currentVersionId === version.id ? (
                                  <em>当前可用</em>
                                ) : null}
                              </span>
                              <small>
                                {version.fileName ?? sourceLabel(document)} · {version.chunkCount}{' '}
                                个切片 · {formatDate(version.createdAt)}
                              </small>
                              <div className="knowledge-version-actions">
                                <StatusPill
                                  value={version.status}
                                  label={documentStatusLabel(version.status)}
                                />
                              </div>
                            </div>
                          ))}
                      </div>
                    </details>
                  ) : null}
                </article>
              );
            })}
          </div>
        )}
      </section>

      {uploadTarget !== null ? (
        <KnowledgeUploadModal
          knowledgeBase={item}
          organization={organization}
          organizationReady={organizationReady}
          {...(uploadTarget === 'new' ? {} : { document: uploadTarget })}
          {...(uploadTarget === 'new' ? { folderId: currentFolderId } : {})}
          onClose={() => setUploadTarget(null)}
          onUploaded={() => {
            const message =
              uploadTarget === 'new'
                ? '文件已上传，解析和索引状态可在文档列表查看。'
                : `“${uploadTarget.title}”的新版本已上传并完成处理。`;
            setUploadTarget(null);
            onChanged(message);
          }}
        />
      ) : null}
      {folderUploadFiles !== null ? (
        <KnowledgeFolderUploadModal
          knowledgeBase={item}
          files={folderUploadFiles}
          onClose={() => setFolderUploadFiles(null)}
          onUploaded={(message) => {
            setFolderUploadFiles(null);
            onChanged(message);
          }}
        />
      ) : null}
      {createFolderOpen ? (
        <KnowledgeCreateFolderModal
          knowledgeBaseId={item.id}
          parentPath={currentFolder?.path ?? null}
          onClose={() => setCreateFolderOpen(false)}
          onCreated={(message) => {
            setCreateFolderOpen(false);
            onChanged(message);
          }}
        />
      ) : null}

      {documentAccessTarget !== null && organization !== null ? (
        <KnowledgeDocumentAccessModal
          knowledgeBase={item}
          document={documentAccessTarget.document}
          version={documentAccessTarget.version}
          organization={organization}
          onClose={() => setDocumentAccessTarget(null)}
          onChanged={(message) => {
            setDocumentAccessTarget(null);
            onChanged(message);
          }}
        />
      ) : null}
      {webImportOpen ? (
        <KnowledgeWebImportModal
          knowledgeBaseId={item.id}
          onClose={() => setWebImportOpen(false)}
          onImported={() => {
            setWebImportOpen(false);
            onChanged('网页已安全抓取并进入处理队列，解析和索引完成后会自动可用。');
          }}
        />
      ) : null}
      {sourceConnectorsOpen ? (
        <Modal
          title="其他来源接入"
          description="连接企业网盘或文档源，需要时同步资料；日常文档列表只保留上传和管理操作。"
          size="wide"
          onClose={() => setSourceConnectorsOpen(false)}
        >
          <KnowledgeSourceConnectorsPanel
            knowledgeBaseId={item.id}
            disabled={item.status === 'ARCHIVED'}
            onChanged={onChanged}
          />
        </Modal>
      ) : null}
      {chunkPreviewTarget ? (
        <KnowledgeChunkPreviewModal
          knowledgeBaseId={item.id}
          document={chunkPreviewTarget.document}
          version={chunkPreviewTarget.version}
          onClose={() => setChunkPreviewTarget(null)}
        />
      ) : null}
    </>
  );
}

function KnowledgeFolderCard({
  folder,
  processing,
  onOpen,
}: {
  folder: KnowledgeBase['folders'][number];
  processing: KnowledgeFolderProcessingSummary;
  onOpen: () => void;
}): ReactNode {
  const statusText =
    processing.state === 'EMPTY'
      ? '暂无文档'
      : processing.state === 'READY'
        ? `已完成 ${processing.completedDocuments}/${processing.totalDocuments} · ${processing.chunkCount} 个切片`
        : processing.state === 'FAILED'
          ? `完成 ${processing.completedDocuments}/${processing.totalDocuments} · ${processing.chunkCount} 个切片 · ${processing.failedDocuments} 个异常`
          : `完成 ${processing.completedDocuments}/${processing.totalDocuments} · ${processing.chunkCount} 个切片 · ${processing.processingDocuments} 个处理中`;
  const progressLabel = processing.state === 'EMPTY' ? '尚未开始' : `${processing.progress}%`;

  return (
    <button
      className={`knowledge-folder-card ${processing.state.toLowerCase()}`}
      type="button"
      onClick={onOpen}
      aria-label={`${folder.name}，${statusText}，切片与索引进度${progressLabel}`}
    >
      <span className="knowledge-folder-icon" aria-hidden="true">
        ▰
      </span>
      <span className="knowledge-folder-card-content">
        <span className="knowledge-folder-card-heading">
          <strong>{folder.name}</strong>
          {processing.failedDocuments > 0 ? <em>{processing.failedDocuments} 个异常</em> : null}
        </span>
        <small>
          {folder.directChildCount} 个子文件夹 · {processing.totalDocuments} 篇文档（含子目录）
        </small>
        {processing.state !== 'EMPTY' ? (
          <span className="knowledge-folder-processing">
            <span>
              <small>切片与索引</small>
              <strong>{processing.progress}%</strong>
            </span>
            <progress max={100} value={processing.progress} />
            <small>{statusText}</small>
          </span>
        ) : (
          <small className="knowledge-folder-processing-empty">尚未上传可处理的文档</small>
        )}
      </span>
    </button>
  );
}
