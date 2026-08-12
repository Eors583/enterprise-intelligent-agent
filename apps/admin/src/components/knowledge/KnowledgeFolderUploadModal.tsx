import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
import type { KnowledgeBase, KnowledgeFolder } from '@enterprise/contracts';

import {
  ensureKnowledgeFolders,
  inspectKnowledgeUpload,
  uploadKnowledgeDocument,
  uploadKnowledgeDocumentVersion,
} from '@/api/admin-api';
import { messageFromError } from '@/api/client';
import { FieldError, Modal, Spinner } from '@/components/ui';

const MAX_FILE_COUNT = 10_000;
const FOLDER_ENSURE_BATCH_SIZE = 1_000;
const ALLOWED_EXTENSIONS = new Set([
  'pdf',
  'docx',
  'xlsx',
  'ppt',
  'pptx',
  'png',
  'jpg',
  'jpeg',
  'tif',
  'tiff',
  'bmp',
  'webp',
  'txt',
  'md',
]);

interface FolderFile {
  readonly file: File;
  readonly folderPath: string;
  readonly problem: string | null;
}

interface FolderUploadIssue {
  readonly entry: FolderFile;
  readonly kind: 'SKIPPED' | 'FAILED';
  readonly reason: string;
}

function relativePath(file: File): string {
  return (file.webkitRelativePath || file.name).replaceAll('\\', '/');
}

function fileProblem(file: File): string | null {
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  if (!ALLOWED_EXTENSIONS.has(extension)) return '格式不支持';
  if (file.size === 0) return '文件为空';
  return null;
}

function titleFromFile(fileName: string): string {
  return fileName
    .replace(/\.[^.]+$/u, '')
    .trim()
    .slice(0, 300);
}

async function sha256(file: File): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

export function KnowledgeFolderUploadModal({
  knowledgeBase,
  files,
  onClose,
  onUploaded,
}: {
  knowledgeBase: KnowledgeBase;
  files: readonly File[];
  onClose: () => void;
  onUploaded: (message: string) => void;
}): ReactNode {
  const entries = useMemo<FolderFile[]>(
    () =>
      files.map((file) => {
        const parts = relativePath(file).split('/').filter(Boolean);
        return { file, folderPath: parts.slice(0, -1).join('/'), problem: fileProblem(file) };
      }),
    [files],
  );
  const validEntries = entries.filter((entry) => entry.problem === null);
  const folderPaths = [...new Set(validEntries.map((entry) => entry.folderPath).filter(Boolean))];
  const initialSkipped = useMemo<FolderUploadIssue[]>(
    () =>
      entries
        .filter((entry) => entry.problem !== null)
        .map((entry) => ({ entry, kind: 'SKIPPED', reason: entry.problem ?? '无法上传' })),
    [entries],
  );
  const [running, setRunning] = useState(false);
  const [processed, setProcessed] = useState(0);
  const [activeTotal, setActiveTotal] = useState(validEntries.length);
  const [uploaded, setUploaded] = useState(0);
  const [issues, setIssues] = useState<FolderUploadIssue[]>(initialSkipped);
  const [completed, setCompleted] = useState(false);
  const [error, setError] = useState<string | null>(
    files.length > MAX_FILE_COUNT ? `一次最多上传 ${MAX_FILE_COUNT} 个文件。` : null,
  );

  const runUpload = async (targets: readonly FolderFile[], retrying: boolean): Promise<void> => {
    if (running || files.length > MAX_FILE_COUNT || targets.length === 0) return;
    setRunning(true);
    setCompleted(false);
    setProcessed(0);
    setActiveTotal(targets.length);
    setError(null);
    const retainedIssues = retrying
      ? issues.filter((issue) => issue.kind !== 'FAILED')
      : initialSkipped;
    setIssues(retainedIssues);
    const batchIssues: FolderUploadIssue[] = [];
    let uploadedCount = retrying ? uploaded : 0;
    try {
      const targetFolderPaths = [
        ...new Set(targets.map((entry) => entry.folderPath).filter(Boolean)),
      ];
      const ensuredFolders: KnowledgeFolder[] = [];
      for (let offset = 0; offset < targetFolderPaths.length; offset += FOLDER_ENSURE_BATCH_SIZE) {
        const ensured = await ensureKnowledgeFolders(knowledgeBase.id, {
          paths: targetFolderPaths.slice(offset, offset + FOLDER_ENSURE_BATCH_SIZE),
        });
        ensuredFolders.push(...ensured.items);
      }
      const folderIds = new Map(ensuredFolders.map((folder) => [folder.path, folder.id]));
      for (let index = 0; index < targets.length; index += 1) {
        const entry = targets[index]!;
        try {
          const folderId = entry.folderPath ? folderIds.get(entry.folderPath) : null;
          if (entry.folderPath && folderId === undefined) throw new Error('目录创建失败');
          const inspection = await inspectKnowledgeUpload(knowledgeBase.id, {
            fileName: entry.file.name,
            size: entry.file.size,
            sha256: await sha256(entry.file),
            folderId: folderId ?? null,
          });
          if (inspection.decision === 'EXACT_DUPLICATE') {
            batchIssues.push({
              entry,
              kind: 'SKIPPED',
              reason: '与知识库中已有文件版本完全相同',
            });
          } else if (
            inspection.decision === 'NEW_VERSION_CANDIDATE' &&
            inspection.matchingDocument !== null
          ) {
            await uploadKnowledgeDocumentVersion(knowledgeBase.id, inspection.matchingDocument.id, {
              file: entry.file,
              changeSummary: '文件夹批量上传的新版本',
            });
            uploadedCount += 1;
          } else {
            await uploadKnowledgeDocument(knowledgeBase.id, {
              file: entry.file,
              title: titleFromFile(entry.file.name),
              folderId: folderId ?? null,
            });
            uploadedCount += 1;
          }
        } catch (caught) {
          batchIssues.push({ entry, kind: 'FAILED', reason: messageFromError(caught) });
        }
        setProcessed(index + 1);
        setUploaded(uploadedCount);
      }
      const nextIssues = [...retainedIssues, ...batchIssues];
      setIssues(nextIssues);
      setCompleted(true);
      if (nextIssues.length === 0) {
        onUploaded(`文件夹上传完成：新增或更新 ${uploadedCount} 个。`);
      }
    } catch (caught) {
      const reason = messageFromError(caught);
      const failedBatch = targets.map<FolderUploadIssue>((entry) => ({
        entry,
        kind: 'FAILED',
        reason,
      }));
      setIssues([...retainedIssues, ...failedBatch]);
      setProcessed(targets.length);
      setCompleted(true);
      setError('文件夹或上传服务准备失败，以下文件可以重新上传。');
    } finally {
      setRunning(false);
    }
  };

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    await runUpload(validEntries, false);
  };

  const skippedIssues = issues.filter((issue) => issue.kind === 'SKIPPED');
  const failedIssues = issues.filter((issue) => issue.kind === 'FAILED');

  return (
    <Modal
      title="上传文件夹"
      description="保留所选文件夹及其子目录结构；文件会继续执行安全检查、解析、切片和索引。"
      size="wide"
      onClose={onClose}
    >
      <form className="knowledge-folder-upload" onSubmit={(event) => void submit(event)}>
        <div className="knowledge-folder-upload-summary">
          <span>
            <strong>{files.length}</strong> 个文件
          </span>
          <span>
            <strong>{folderPaths.length}</strong> 个目录
          </span>
          <span>
            <strong>{entries.length - validEntries.length}</strong> 个将跳过
          </span>
        </div>
        {running || processed > 0 ? (
          <div className="knowledge-folder-upload-progress" aria-live="polite">
            <div>
              <span>
                已处理 {processed} / {activeTotal}
              </span>
              <strong>
                {activeTotal === 0 ? 0 : Math.round((processed / activeTotal) * 100)}%
              </strong>
            </div>
            <progress max={activeTotal || 1} value={processed} />
          </div>
        ) : null}
        <div className="knowledge-folder-upload-preview">
          {entries.slice(0, 12).map((entry) => (
            <div key={`${relativePath(entry.file)}-${entry.file.size}`}>
              <span>{relativePath(entry.file)}</span>
              <small>{entry.problem ?? '准备上传'}</small>
            </div>
          ))}
          {entries.length > 12 ? <p>另有 {entries.length - 12} 个文件未在预览中展开。</p> : null}
        </div>
        {skippedIssues.length > 0 ? (
          <section className="knowledge-folder-upload-issues" aria-label="被跳过的文件">
            <strong>被跳过（{skippedIssues.length}）</strong>
            <p>这些文件没有进入知识库，请检查原因后重新选择文件夹。</p>
            <div>
              {skippedIssues.map((issue, index) => (
                <span key={`skipped-${relativePath(issue.entry.file)}-${index}`}>
                  <b>{relativePath(issue.entry.file)}</b>
                  <small>{issue.reason}</small>
                </span>
              ))}
            </div>
          </section>
        ) : null}
        {failedIssues.length > 0 ? (
          <section className="knowledge-folder-upload-issues failed" role="alert">
            <strong>上传失败（{failedIssues.length}）</strong>
            <p>已成功的文件不会重复上传；可只重试下面的失败项。</p>
            <div>
              {failedIssues.map((issue, index) => (
                <span key={`failed-${relativePath(issue.entry.file)}-${index}`}>
                  <b>{relativePath(issue.entry.file)}</b>
                  <small>{issue.reason}</small>
                </span>
              ))}
            </div>
          </section>
        ) : null}
        <FieldError message={error} />
        <footer className="modal-actions">
          <button className="button secondary" type="button" onClick={onClose} disabled={running}>
            {completed ? '关闭' : '取消'}
          </button>
          {failedIssues.length > 0 ? (
            <button
              className="button primary"
              type="button"
              disabled={running}
              onClick={() =>
                void runUpload(
                  failedIssues.map((issue) => issue.entry),
                  true,
                )
              }
            >
              {running ? (
                <Spinner label="正在重新上传…" />
              ) : (
                `重新上传失败项（${failedIssues.length}）`
              )}
            </button>
          ) : completed ? (
            <button
              className="button primary"
              type="button"
              onClick={() =>
                onUploaded(
                  `文件夹上传完成：新增或更新 ${uploaded} 个，跳过 ${skippedIssues.length} 个。`,
                )
              }
            >
              完成
            </button>
          ) : (
            <button
              className="button primary"
              type="submit"
              disabled={running || validEntries.length === 0 || files.length > MAX_FILE_COUNT}
            >
              {running ? <Spinner label="正在上传…" /> : `开始上传 ${validEntries.length} 个文件`}
            </button>
          )}
        </footer>
      </form>
    </Modal>
  );
}

export function KnowledgeCreateFolderModal({
  knowledgeBaseId,
  parentPath,
  onClose,
  onCreated,
}: {
  knowledgeBaseId: string;
  parentPath: string | null;
  onClose: () => void;
  onCreated: (message: string) => void;
}): ReactNode {
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const value = name.trim();
    if (!value || value === '.' || value === '..' || value.includes('/') || value.includes('\\')) {
      setError('请输入不包含斜杠的文件夹名称。');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await ensureKnowledgeFolders(knowledgeBaseId, {
        paths: [parentPath ? `${parentPath}/${value}` : value],
      });
      onCreated(`文件夹“${value}”已创建。`);
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      title="新建文件夹"
      description={parentPath ? `将在“${parentPath}”下创建。` : '将在知识库根目录创建。'}
      onClose={onClose}
    >
      <form onSubmit={(event) => void submit(event)}>
        <label className="field">
          <span>文件夹名称</span>
          <input
            autoFocus
            maxLength={200}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="例如：产品战略"
          />
        </label>
        <FieldError message={error} />
        <footer className="modal-actions">
          <button className="button secondary" type="button" onClick={onClose} disabled={saving}>
            取消
          </button>
          <button className="button primary" type="submit" disabled={saving}>
            {saving ? <Spinner label="创建中…" /> : '创建文件夹'}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
