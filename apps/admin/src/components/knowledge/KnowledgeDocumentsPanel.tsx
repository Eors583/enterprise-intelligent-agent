import type {
  KnowledgeBase,
  KnowledgeBaseIndexReadiness,
  KnowledgeDocumentSummary,
  KnowledgeDocumentVersionSummary,
} from '@enterprise/contracts';
import { useState, type ReactNode } from 'react';

import {
  archiveKnowledgeDocument,
  publishKnowledgeDocumentVersion,
  rebuildKnowledgeDocumentEmbeddings,
  rebuildKnowledgeDocumentGraph,
  retryKnowledgeDocumentIngestion,
  rollbackKnowledgeDocumentVersion,
} from '@/api/admin-api';
import { messageFromError } from '@/api/client';
import { Icon } from '@/components/Icons';
import { EmptyState, FieldError, Modal, Spinner, StatusPill } from '@/components/ui';
import { PassingEvaluationRunSelect } from '@/features/ai-evaluation/PassingEvaluationRunSelect';

import { KnowledgeUploadModal } from './KnowledgeUploadModal';
import { KnowledgeChunkPreviewModal } from './KnowledgeChunkPreviewModal';
import { KnowledgeGovernanceModal } from './KnowledgeGovernanceModal';
import { KnowledgeIntegrityEvaluationWizard } from './KnowledgeIntegrityEvaluationWizard';
import { KnowledgeParseReviewPanel } from './KnowledgeParseReviewPanel';
import { KnowledgePublicationJourney } from './KnowledgePublicationJourney';
import { KnowledgeWebImportModal } from './KnowledgeWebImportModal';
import {
  currentPublishedKnowledgeVersion,
  knowledgeVersionAction,
  knowledgeVersionFailure,
  latestKnowledgeVersion,
} from './knowledge-ingestion-outcome';
import {
  filterKnowledgeDocuments,
  previewableKnowledgeVersion,
  type KnowledgeDocumentSourceFilter,
  type KnowledgeDocumentStatusFilter,
} from './knowledge-view-model';
import type { KnowledgePublicationAction } from './knowledge-publication-journey';

interface ChunkPreviewTarget {
  readonly document: KnowledgeDocumentSummary;
  readonly version: KnowledgeDocumentVersionSummary;
}

type PublicationTarget = ChunkPreviewTarget;

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

function stageLabel(stage: string): string {
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
      ARCHIVED: '已归档',
    }[status] ?? status
  );
}

export function KnowledgeDocumentsPanel({
  item,
  readiness = null,
  onCreateDocument,
  onEditDocument,
  onChanged,
}: {
  item: KnowledgeBase;
  readiness?: KnowledgeBaseIndexReadiness | null;
  onCreateDocument: () => void;
  onEditDocument: (document: KnowledgeDocumentSummary) => void;
  onChanged: (message: string) => void;
}): ReactNode {
  const [uploadTarget, setUploadTarget] = useState<KnowledgeDocumentSummary | 'new' | null>(null);
  const [webImportOpen, setWebImportOpen] = useState(false);
  const [retryingVersionId, setRetryingVersionId] = useState<string | null>(null);
  const [changingVersionId, setChangingVersionId] = useState<string | null>(null);
  const [rebuildingVersionId, setRebuildingVersionId] = useState<string | null>(null);
  const [rebuildingGraphVersionId, setRebuildingGraphVersionId] = useState<string | null>(null);
  const [archivingDocumentId, setArchivingDocumentId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [sourceFilter, setSourceFilter] = useState<KnowledgeDocumentSourceFilter>('ALL');
  const [statusFilter, setStatusFilter] = useState<KnowledgeDocumentStatusFilter>('ALL');
  const [chunkPreviewTarget, setChunkPreviewTarget] = useState<ChunkPreviewTarget | null>(null);
  const [governanceTarget, setGovernanceTarget] = useState<ChunkPreviewTarget | null>(null);
  const [evaluationWizardTarget, setEvaluationWizardTarget] = useState<ChunkPreviewTarget | null>(
    null,
  );
  const [publicationTarget, setPublicationTarget] = useState<PublicationTarget | null>(null);
  const [evaluationRunId, setEvaluationRunId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const filteredDocuments = filterKnowledgeDocuments(
    item.documents,
    query,
    sourceFilter,
    statusFilter,
  );

  const retry = async (
    document: KnowledgeDocumentSummary,
    version: KnowledgeDocumentVersionSummary,
  ): Promise<void> => {
    setRetryingVersionId(version.id);
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
      setError(messageFromError(caught));
    } finally {
      setRetryingVersionId(null);
    }
  };

  const archive = async (document: KnowledgeDocumentSummary): Promise<void> => {
    if (!window.confirm(`确认归档“${document.title}”吗？`)) return;
    setArchivingDocumentId(document.id);
    setError(null);
    try {
      await archiveKnowledgeDocument(item.id, document.id, document.documentVersion);
      onChanged(`“${document.title}”已归档。`);
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setArchivingDocumentId(null);
    }
  };

  const publish = async (
    document: KnowledgeDocumentSummary,
    version: KnowledgeDocumentVersionSummary,
    referencedEvaluationRunId: string,
  ): Promise<void> => {
    setChangingVersionId(version.id);
    setError(null);
    try {
      const result = await publishKnowledgeDocumentVersion(item.id, document.id, version.id, {
        evaluationRunId: referencedEvaluationRunId,
      });
      const publishedVersion = result.versions.find((candidate) => candidate.id === version.id);
      const failure = knowledgeVersionFailure(publishedVersion);
      if (failure !== null) {
        setError(`“${document.title}”${failure}`);
        return;
      }
      if (result.currentVersionId !== version.id || publishedVersion?.status !== 'READY') {
        setError('发布未切换为当前版本，请刷新后重试。');
        return;
      }
      setPublicationTarget(null);
      setEvaluationRunId('');
      onChanged(`“${document.title}”v${version.versionNumber} 已发布。`);
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setChangingVersionId(null);
    }
  };

  const rollback = async (
    document: KnowledgeDocumentSummary,
    version: KnowledgeDocumentVersionSummary,
  ): Promise<void> => {
    if (document.currentVersionId === null) {
      setError('当前没有已发布版本，无法执行回滚。');
      return;
    }
    if (
      !window.confirm(
        `确认基于“${document.title}”的 v${version.versionNumber} 创建回滚候选版本吗？候选版本需重新评测并显式发布，当前版本不会立即切换。`,
      )
    ) {
      return;
    }
    setChangingVersionId(version.id);
    setError(null);
    try {
      const result = await rollbackKnowledgeDocumentVersion(item.id, document.id, version.id, {
        expectedCurrentVersionId: document.currentVersionId,
      });
      const rollbackCandidate = result.versions.find(
        (candidate) =>
          candidate.versionNumber > document.documentVersion &&
          candidate.status === 'READY' &&
          candidate.publishedAt === null,
      );
      if (
        result.currentVersionId !== document.currentVersionId ||
        rollbackCandidate === undefined
      ) {
        setError('回滚候选版本未正确创建，请刷新后重试。');
        return;
      }
      onChanged(
        `“${document.title}”已基于 v${version.versionNumber} 创建待评测的回滚候选版本 v${rollbackCandidate.versionNumber}。`,
      );
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setChangingVersionId(null);
    }
  };

  const rebuildEmbeddings = async (
    document: KnowledgeDocumentSummary,
    version: KnowledgeDocumentVersionSummary,
  ): Promise<void> => {
    setRebuildingVersionId(version.id);
    setError(null);
    try {
      const result = await rebuildKnowledgeDocumentEmbeddings(item.id, document.id, version.id);
      onChanged(
        `“${document.title}”v${version.versionNumber} 已用 ${result.embeddingModel} 重建 ${result.chunkCount} 个向量。`,
      );
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setRebuildingVersionId(null);
    }
  };

  const rebuildGraph = async (
    document: KnowledgeDocumentSummary,
    version: KnowledgeDocumentVersionSummary,
  ): Promise<void> => {
    setRebuildingGraphVersionId(version.id);
    setError(null);
    try {
      const result = await rebuildKnowledgeDocumentGraph(item.id, document.id, version.id);
      onChanged(
        `“${document.title}”v${version.versionNumber} 已重建关系索引：${result.entityCount} 个实体、${result.relationCount} 条关系、${result.evidenceCount} 条证据。`,
      );
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setRebuildingGraphVersionId(null);
    }
  };

  const handlePublicationAction = (
    action: KnowledgePublicationAction,
    document: KnowledgeDocumentSummary,
    version: KnowledgeDocumentVersionSummary,
  ): void => {
    if (action === 'RETRY_INGESTION') {
      void retry(document, version);
      return;
    }
    if (action === 'OPEN_PARSE_REVIEW') {
      documentView('knowledge-parse-review-queue')?.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
      });
      return;
    }
    if (action === 'OPEN_GOVERNANCE') {
      setGovernanceTarget({ document, version });
      return;
    }
    if (action === 'OPEN_EVALUATION') {
      setEvaluationWizardTarget({ document, version });
      return;
    }
    if (action === 'OPEN_REVIEW') {
      window.location.hash = 'ai-evaluation';
      return;
    }
    if (action === 'OPEN_PUBLISH') {
      setEvaluationRunId('');
      setPublicationTarget({ document, version });
      return;
    }
    if (action === 'REBUILD_INDEX') {
      void rebuildEmbeddings(document, version);
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
            <details className="knowledge-source-more">
              <summary>更多录入方式</summary>
              <button
                className="button secondary compact"
                type="button"
                onClick={onCreateDocument}
                disabled={item.status === 'ARCHIVED'}
              >
                <Icon name="plus" size={16} /> 粘贴文本
              </button>
            </details>
          </div>
        </header>
        {item.documents.length > 0 ? (
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
                <option value="READY">已发布</option>
                <option value="DRAFT">草稿</option>
                <option value="PROCESSING">处理中</option>
                <option value="FAILED">处理失败</option>
                <option value="ARCHIVED">已归档</option>
              </select>
            </label>
            <span className="knowledge-filter-count">
              显示 {filteredDocuments.length} / {item.documents.length}
            </span>
          </div>
        ) : null}
        <FieldError message={error} />
        {item.documents.length === 0 ? (
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
        ) : filteredDocuments.length === 0 ? (
          <EmptyState
            title="没有匹配的知识文档"
            description="请调整标题关键词、来源或处理状态筛选条件。"
          />
        ) : (
          <div className="document-list knowledge-document-list">
            {filteredDocuments.map((document) => {
              const latest = latestKnowledgeVersion(document);
              const currentPublished = currentPublishedKnowledgeVersion(document);
              const previewVersion = previewableKnowledgeVersion(document);
              const job = latest?.ingestionJob ?? null;
              const inProgress =
                latest?.status === 'PROCESSING' ||
                job?.status === 'PENDING' ||
                job?.status === 'RUNNING';
              const failed = latest?.status === 'FAILED' || job?.status === 'FAILED';
              const editable =
                (document.sourceType === 'TEXT' || document.sourceType === 'MARKDOWN') &&
                !inProgress &&
                document.status !== 'ARCHIVED';

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
                      <StatusPill
                        value={
                          document.status === 'ARCHIVED'
                            ? 'ARCHIVED'
                            : currentPublished
                              ? 'READY'
                              : 'DRAFT'
                        }
                        label={
                          document.status === 'ARCHIVED'
                            ? '已归档'
                            : currentPublished
                              ? `当前发布 v${currentPublished.versionNumber}`
                              : '当前未发布'
                        }
                      />
                      {latest ? (
                        <StatusPill
                          value={latest.status}
                          label={`最新 v${latest.versionNumber} · ${documentStatusLabel(latest.status)}`}
                        />
                      ) : null}
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
                    {document.sourceType === 'FILE' && document.status !== 'ARCHIVED' ? (
                      <div className="knowledge-document-row-actions">
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
                        <button
                          className="button danger-ghost compact"
                          type="button"
                          disabled={inProgress || archivingDocumentId === document.id}
                          onClick={() => void archive(document)}
                        >
                          {archivingDocumentId === document.id ? (
                            <Spinner label="归档中…" />
                          ) : (
                            '归档'
                          )}
                        </button>
                      </div>
                    ) : null}
                  </div>

                  {inProgress && job ? (
                    <div className="knowledge-ingestion-state" aria-live="polite">
                      <div>
                        <span>{stageLabel(job.stage)}</span>
                        <strong>{job.progress}%</strong>
                      </div>
                      <progress max={100} value={job.progress} />
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
                                  <em>当前发布</em>
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
                                {version.sourceType === 'FILE' || version.sourceType === 'WEB' ? (
                                  <StatusPill
                                    value={version.parseReviewStatus}
                                    label={
                                      {
                                        NOT_REQUIRED: '无需质检',
                                        PENDING: '解析待审',
                                        APPROVED: '解析已批准',
                                        REJECTED: '解析已驳回',
                                      }[version.parseReviewStatus]
                                    }
                                  />
                                ) : null}
                                <StatusPill
                                  value={version.governance.reviewStatus}
                                  label={
                                    {
                                      PENDING: '治理待审',
                                      APPROVED: '治理已批准',
                                      REJECTED: '治理已驳回',
                                      MIGRATED: '历史迁移策略',
                                    }[version.governance.reviewStatus]
                                  }
                                />
                                <button
                                  className="button secondary compact"
                                  type="button"
                                  onClick={() => setGovernanceTarget({ document, version })}
                                >
                                  治理策略
                                </button>
                                <button
                                  className="button secondary compact"
                                  type="button"
                                  disabled={version.chunkCount === 0}
                                  title={
                                    version.chunkCount > 0
                                      ? `查看 v${version.versionNumber} 的解析切片`
                                      : '当前版本没有切片'
                                  }
                                  onClick={() => setChunkPreviewTarget({ document, version })}
                                >
                                  查看切片
                                </button>
                                {version.chunkCount > 0 &&
                                (version.status === 'READY' || version.status === 'ARCHIVED') ? (
                                  <>
                                    <button
                                      className="button secondary compact"
                                      type="button"
                                      disabled={
                                        rebuildingVersionId !== null ||
                                        rebuildingGraphVersionId !== null ||
                                        inProgress ||
                                        item.status === 'ARCHIVED' ||
                                        document.status === 'ARCHIVED'
                                      }
                                      onClick={() => void rebuildGraph(document, version)}
                                    >
                                      {rebuildingGraphVersionId === version.id ? (
                                        <Spinner label="关系重建中…" />
                                      ) : (
                                        '重建关系'
                                      )}
                                    </button>
                                    <button
                                      className="button secondary compact"
                                      type="button"
                                      disabled={
                                        rebuildingVersionId !== null ||
                                        rebuildingGraphVersionId !== null ||
                                        inProgress ||
                                        item.status === 'ARCHIVED' ||
                                        document.status === 'ARCHIVED'
                                      }
                                      onClick={() => void rebuildEmbeddings(document, version)}
                                    >
                                      {rebuildingVersionId === version.id ? (
                                        <Spinner label="向量重建中…" />
                                      ) : (
                                        '重建向量'
                                      )}
                                    </button>
                                  </>
                                ) : null}
                                {knowledgeVersionAction(document, version) === 'publish' ? (
                                  <button
                                    className="button primary compact"
                                    type="button"
                                    disabled={
                                      changingVersionId !== null ||
                                      inProgress ||
                                      item.status === 'ARCHIVED' ||
                                      document.status === 'ARCHIVED' ||
                                      ((version.sourceType === 'FILE' ||
                                        version.sourceType === 'WEB') &&
                                        version.parseReviewStatus !== 'APPROVED') ||
                                      version.governance.reviewStatus !== 'APPROVED'
                                    }
                                    onClick={() => {
                                      setEvaluationRunId('');
                                      setPublicationTarget({ document, version });
                                    }}
                                  >
                                    {changingVersionId === version.id ? (
                                      <Spinner label="发布中…" />
                                    ) : (
                                      '发布'
                                    )}
                                  </button>
                                ) : null}
                                {knowledgeVersionAction(document, version) === 'rollback' ? (
                                  <button
                                    className="button secondary compact"
                                    type="button"
                                    disabled={
                                      changingVersionId !== null ||
                                      inProgress ||
                                      item.status === 'ARCHIVED' ||
                                      document.status === 'ARCHIVED'
                                    }
                                    onClick={() => void rollback(document, version)}
                                  >
                                    {changingVersionId === version.id ? (
                                      <Spinner label="回滚中…" />
                                    ) : (
                                      '回滚到此版本'
                                    )}
                                  </button>
                                ) : null}
                              </div>
                              <KnowledgePublicationJourney
                                document={document}
                                version={version}
                                readiness={readiness}
                                onAction={(action) =>
                                  handlePublicationAction(action, document, version)
                                }
                              />
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

      <KnowledgeParseReviewPanel item={item} onChanged={onChanged} />

      {uploadTarget !== null ? (
        <KnowledgeUploadModal
          knowledgeBaseId={item.id}
          knowledgeBaseName={item.name}
          {...(uploadTarget === 'new' ? {} : { document: uploadTarget })}
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
      {webImportOpen ? (
        <KnowledgeWebImportModal
          knowledgeBaseId={item.id}
          onClose={() => setWebImportOpen(false)}
          onImported={() => {
            setWebImportOpen(false);
            onChanged('网页已安全抓取并进入解析队列，解析完成后需由另一位管理员质检。');
          }}
        />
      ) : null}
      {chunkPreviewTarget ? (
        <KnowledgeChunkPreviewModal
          knowledgeBaseId={item.id}
          document={chunkPreviewTarget.document}
          version={chunkPreviewTarget.version}
          onClose={() => setChunkPreviewTarget(null)}
        />
      ) : null}
      {governanceTarget ? (
        <KnowledgeGovernanceModal
          knowledgeBaseId={item.id}
          document={governanceTarget.document}
          version={governanceTarget.version}
          onClose={() => setGovernanceTarget(null)}
          onChanged={onChanged}
        />
      ) : null}
      {evaluationWizardTarget ? (
        <KnowledgeIntegrityEvaluationWizard
          knowledgeBaseId={item.id}
          document={evaluationWizardTarget.document}
          version={evaluationWizardTarget.version}
          onClose={() => setEvaluationWizardTarget(null)}
          onChanged={onChanged}
        />
      ) : null}
      {publicationTarget ? (
        <Modal
          title={`发布“${publicationTarget.document.title}” v${publicationTarget.version.versionNumber}`}
          description="发布前必须引用与此知识版本、版本号及索引快照完全一致的已通过评测运行。"
          onClose={() => setPublicationTarget(null)}
          dismissible={changingVersionId === null}
        >
          <form
            className="form-stack"
            onSubmit={(event) => {
              event.preventDefault();
              void publish(
                publicationTarget.document,
                publicationTarget.version,
                evaluationRunId.trim(),
              );
            }}
          >
            <PassingEvaluationRunSelect
              subjectType="KNOWLEDGE_VERSION"
              subjectId={publicationTarget.version.id}
              subjectVersion={publicationTarget.version.versionNumber}
              value={evaluationRunId}
              onChange={setEvaluationRunId}
              disabled={changingVersionId !== null}
            />
            <div className="modal-actions">
              <button
                className="button secondary"
                type="button"
                onClick={() => setPublicationTarget(null)}
                disabled={changingVersionId !== null}
              >
                取消
              </button>
              <button
                className="button primary"
                type="submit"
                disabled={changingVersionId !== null || evaluationRunId.trim() === ''}
              >
                {changingVersionId === publicationTarget.version.id ? (
                  <Spinner label="发布中…" />
                ) : (
                  '验证并发布'
                )}
              </button>
            </div>
          </form>
        </Modal>
      ) : null}
    </>
  );
}

function documentView(id: string): HTMLElement | null {
  return globalThis.document?.getElementById(id) ?? null;
}
