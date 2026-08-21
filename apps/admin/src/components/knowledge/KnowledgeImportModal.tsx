import type {
  AdminOrganizationResponse,
  KnowledgeBase,
  KnowledgeBaseOrgUnitScope,
} from '@enterprise/contracts';
import {
  KnowledgeAccessPicker,
  knowledgeAccessError,
  type KnowledgeAccessMode,
} from '@/features/knowledge/KnowledgeAccessPicker';
import {
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
  type ReactNode,
} from 'react';

import { createKnowledgeBase, uploadKnowledgeDocument } from '@/api/admin-api';
import { messageFromError } from '@/api/client';
import { FieldError, Modal, Spinner } from '@/components/ui';
import {
  companyKnowledgeSpaceDraft,
  KnowledgeSpacePicker,
  knowledgeSpaceDraftError,
  knowledgeSpaceSelectionFromDraft,
  type KnowledgeSpaceDraft,
} from '@/features/knowledge/KnowledgeSpacePicker';

import { knowledgeVersionFailure, latestKnowledgeVersion } from './knowledge-ingestion-outcome';

const MAXIMUM_FILES = 20;
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

type ImportFileStatus = 'QUEUED' | 'UPLOADING' | 'SUCCEEDED' | 'FAILED';

interface ImportFile {
  readonly id: string;
  readonly file: File;
  readonly status: ImportFileStatus;
  readonly error: string | null;
}

export interface KnowledgeImportResult {
  readonly knowledgeBase: KnowledgeBase;
  readonly uploadedCount: number;
  readonly failedCount: number;
  readonly createdKnowledgeBase: boolean;
}

export function KnowledgeImportModal({
  currentUserId,
  currentUserName,
  organization,
  knowledgeBases = [],
  targetKnowledgeBase,
  onClose,
  onImported,
}: {
  currentUserId: string;
  currentUserName: string;
  organization?: AdminOrganizationResponse | null;
  knowledgeBases?: readonly KnowledgeBase[];
  targetKnowledgeBase?: KnowledgeBase;
  onClose: () => void;
  onImported: (result: KnowledgeImportResult) => void;
}): ReactNode {
  const inputRef = useRef<HTMLInputElement>(null);
  const nextFileId = useRef(0);
  const [files, setFiles] = useState<ImportFile[]>([]);
  const [dragging, setDragging] = useState(false);
  const [space, setSpace] = useState<KnowledgeSpaceDraft>(() =>
    companyKnowledgeSpaceDraft(organization),
  );
  const [accessMode, setAccessMode] = useState<KnowledgeAccessMode>('ENTERPRISE');
  const [orgUnitScopes, setOrgUnitScopes] = useState<KnowledgeBaseOrgUnitScope[]>([]);
  const [memberUserIds, setMemberUserIds] = useState<string[]>([]);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const completedCount = useMemo(
    () => files.filter((item) => item.status === 'SUCCEEDED' || item.status === 'FAILED').length,
    [files],
  );
  const uploadedCount = useMemo(
    () => files.filter((item) => item.status === 'SUCCEEDED').length,
    [files],
  );
  const failedCount = useMemo(
    () => files.filter((item) => item.status === 'FAILED').length,
    [files],
  );

  const addFiles = (selected: Iterable<File>): void => {
    if (importing) return;
    const candidates = [...selected];
    if (candidates.length === 0) return;

    const available = Math.max(0, MAXIMUM_FILES - files.length);
    const accepted: ImportFile[] = [];
    const problems: string[] = [];
    for (const file of candidates.slice(0, available)) {
      const problem = fileProblem(file, targetKnowledgeBase?.storageProvider === 'LEXIANG');
      if (problem !== null) {
        problems.push(`${file.name}：${problem}`);
        continue;
      }
      nextFileId.current += 1;
      accepted.push({
        id: `knowledge-import-${nextFileId.current}`,
        file,
        status: 'QUEUED',
        error: null,
      });
    }
    if (candidates.length > available) {
      problems.push(`每次最多导入 ${MAXIMUM_FILES} 个文件，超出的文件未加入清单。`);
    }
    setFiles((current) => [...current, ...accepted]);
    setError(problems.length === 0 ? null : problems.join('；'));
  };

  const chooseFiles = (event: ChangeEvent<HTMLInputElement>): void => {
    addFiles(event.target.files ?? []);
    event.target.value = '';
  };

  const dropFiles = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    setDragging(false);
    addFiles(event.dataTransfer.files);
  };

  const updateFile = (
    id: string,
    status: ImportFileStatus,
    fileError: string | null = null,
  ): void => {
    setFiles((current) =>
      current.map((item) => (item.id === id ? { ...item, status, error: fileError } : item)),
    );
  };

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (files.length === 0) {
      setError('请先选择需要导入的文件。');
      return;
    }
    if (targetKnowledgeBase === undefined) {
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
    }

    setImporting(true);
    setError(null);
    setFiles((current) =>
      current.map((item) => ({ ...item, status: 'QUEUED' as const, error: null })),
    );

    let knowledgeBase = targetKnowledgeBase;
    if (knowledgeBase === undefined) {
      try {
        knowledgeBase = await createKnowledgeBase({
          key: createRandomKnowledgeBaseKey(),
          name: knowledgeBaseNameFromFile(files[0]!.file.name),
          description: null,
          status: 'DRAFT',
          space: knowledgeSpaceSelectionFromDraft(space),
          orgUnitIds: [],
          orgUnitScopes,
          memberUserIds,
        });
      } catch (caught) {
        setError(messageFromError(caught));
        setImporting(false);
        return;
      }
    }

    let succeeded = 0;
    let failed = 0;
    for (const item of files) {
      updateFile(item.id, 'UPLOADING');
      try {
        const document = await uploadKnowledgeDocument(knowledgeBase.id, {
          file: item.file,
          title: item.file.name.trim(),
        });
        const failure = knowledgeVersionFailure(latestKnowledgeVersion(document));
        if (failure !== null) throw new Error(failure);
        succeeded += 1;
        updateFile(item.id, 'SUCCEEDED');
      } catch (caught) {
        failed += 1;
        updateFile(item.id, 'FAILED', messageFromError(caught));
      }
    }

    setImporting(false);
    onImported({
      knowledgeBase,
      uploadedCount: succeeded,
      failedCount: failed,
      createdKnowledgeBase: targetKnowledgeBase === undefined,
    });
  };

  return (
    <Modal
      title={
        targetKnowledgeBase === undefined
          ? '选择存放位置并导入知识'
          : `向“${targetKnowledgeBase.name}”上传文件`
      }
      description={
        targetKnowledgeBase === undefined
          ? '归属账号自动使用当前登录账号。这里只选择资料存放在公司、部门、项目还是成员知识中。'
          : '文件只会写入当前知识库，不会创建新的知识库。需要保留目录层级时，请使用文档管理区的“导入文件夹”。'
      }
      onClose={onClose}
      size="wide"
      dismissible={!importing}
    >
      <form className="form-stack" onSubmit={(event) => void submit(event)}>
        {targetKnowledgeBase === undefined ? (
          <>
            <KnowledgeSpacePicker
              currentUserId={currentUserId}
              currentUserName={currentUserName}
              organization={organization}
              knowledgeBases={knowledgeBases}
              value={space}
              disabled={importing}
              onChange={setSpace}
            />
            <KnowledgeAccessPicker
              organization={organization ?? null}
              mode={accessMode}
              orgUnitScopes={orgUnitScopes}
              memberUserIds={memberUserIds}
              disabled={importing || organization === undefined || organization === null}
              onModeChange={setAccessMode}
              onOrgUnitScopesChange={setOrgUnitScopes}
              onMemberUserIdsChange={setMemberUserIds}
            />
          </>
        ) : null}
        <input
          ref={inputRef}
          className="visually-hidden"
          type="file"
          multiple
          disabled={importing || files.length >= MAXIMUM_FILES}
          accept=".pdf,.docx,.xlsx,.ppt,.pptx,.png,.jpg,.jpeg,.tif,.tiff,.bmp,.webp,.txt,.md,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation,image/*,text/plain,text/markdown"
          onChange={chooseFiles}
        />
        <div
          className={`knowledge-drop-zone ${dragging ? 'dragging' : ''}`}
          role="button"
          tabIndex={importing ? -1 : 0}
          aria-disabled={importing || files.length >= MAXIMUM_FILES}
          onClick={() => {
            if (!importing && files.length < MAXIMUM_FILES) inputRef.current?.click();
          }}
          onKeyDown={(event) => {
            if (
              !importing &&
              files.length < MAXIMUM_FILES &&
              (event.key === 'Enter' || event.key === ' ')
            ) {
              event.preventDefault();
              inputRef.current?.click();
            }
          }}
          onDragEnter={(event) => {
            event.preventDefault();
            if (!importing) setDragging(true);
          }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={() => setDragging(false)}
          onDrop={dropFiles}
        >
          <span className="knowledge-upload-symbol" aria-hidden="true">
            ↑
          </span>
          <strong>拖放多个文件到这里，或点击选择</strong>
          <small>
            {targetKnowledgeBase?.storageProvider === 'LEXIANG'
              ? '乐享支持 PDF、DOCX、XLSX、PPT、PPTX、常见图片和 TXT；最多 20 个'
              : '支持 PDF、DOCX、XLSX、PPT、PPTX、常见图片、TXT、MD；最多 20 个'}
          </small>
        </div>

        {files.length > 0 ? (
          <section aria-label="待导入文件">
            <p className="form-hint" aria-live="polite">
              已选择 {files.length} / {MAXIMUM_FILES} 个文件
              {importing ? `；已处理 ${completedCount} / ${files.length}` : ''}
            </p>
            {importing ? (
              <div className="knowledge-ingestion-state">
                <div>
                  <span>批量上传进度</span>
                  <strong>
                    {completedCount} / {files.length}
                  </strong>
                </div>
                <progress max={files.length} value={completedCount} />
              </div>
            ) : null}
            <div className="document-list knowledge-document-list">
              {files.map((item) => (
                <article className="knowledge-document-entry" key={item.id}>
                  <div className="knowledge-document-row">
                    <span className="document-icon">
                      {extensionOf(item.file.name).toUpperCase()}
                    </span>
                    <span className="document-copy">
                      <strong>{item.file.name}</strong>
                      <small>{formatFileSize(item.file.size)}</small>
                    </span>
                    <span aria-live="polite">{fileStatusLabel(item.status)}</span>
                    {!importing && item.status === 'QUEUED' ? (
                      <button
                        className="button secondary compact"
                        type="button"
                        onClick={() =>
                          setFiles((current) =>
                            current.filter((candidate) => candidate.id !== item.id),
                          )
                        }
                      >
                        移除
                      </button>
                    ) : null}
                  </div>
                  {item.error ? (
                    <div className="knowledge-ingestion-error" role="alert">
                      <strong>上传失败</strong>
                      <span>{item.error}</span>
                    </div>
                  ) : null}
                </article>
              ))}
            </div>
          </section>
        ) : null}

        {completedCount > 0 ? (
          <p className="form-hint" aria-live="polite">
            已成功 {uploadedCount} 个，失败 {failedCount} 个。
          </p>
        ) : null}
        <FieldError message={error} />
        <p className="form-hint">
          {targetKnowledgeBase === undefined
            ? '知识库将以草稿状态创建。本批文件共享上面选择的访问范围；后续添加到该知识库的文件会继承同一范围。'
            : `文件将写入现有知识库“${targetKnowledgeBase.name}”，并继承该库当前的访问范围。`}
        </p>
        <div className="modal-actions">
          <button className="button secondary" type="button" onClick={onClose} disabled={importing}>
            取消
          </button>
          <button
            className="button primary"
            type="submit"
            disabled={importing || files.length === 0}
          >
            {importing ? (
              <Spinner label="正在批量导入…" />
            ) : targetKnowledgeBase === undefined ? (
              `创建草稿并导入 ${files.length} 个文件`
            ) : (
              `上传到当前库（${files.length} 个文件）`
            )}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function fileProblem(file: File, managedByLexiang: boolean): string | null {
  if (file.name.trim().length === 0 || file.name.length > 300) {
    return '文件名长度必须在 1 到 300 个字符之间';
  }
  if (!ALLOWED_EXTENSIONS.has(extensionOf(file.name))) {
    return '仅支持 PDF、DOCX、XLSX、PPT、PPTX、常见图片、TXT 和 Markdown 文件';
  }
  if (managedByLexiang && ['md', 'tif'].includes(extensionOf(file.name))) {
    return '腾讯乐享不支持该文件格式';
  }
  if (file.size === 0) return '文件内容为空';
  return null;
}

function extensionOf(fileName: string): string {
  return fileName.split('.').pop()?.toLowerCase() ?? '';
}

function baseNameFromFileName(fileName: string): string {
  return (
    fileName
      .replace(/\.[^.]+$/u, '')
      .trim()
      .slice(0, 300) || '未命名知识文档'
  );
}

function knowledgeBaseNameFromFile(fileName: string): string {
  const title = baseNameFromFileName(fileName);
  return `${title.slice(0, 190)} 知识库`;
}

function createRandomKnowledgeBaseKey(): string {
  const randomValues = new Uint32Array(2);
  globalThis.crypto.getRandomValues(randomValues);
  const randomPart = [...randomValues].map((value) => value.toString(36)).join('-');
  return `import-${Date.now().toString(36)}-${randomPart}`.slice(0, 100);
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function fileStatusLabel(status: ImportFileStatus): string {
  return {
    QUEUED: '等待上传',
    UPLOADING: '正在上传…',
    SUCCEEDED: '上传成功',
    FAILED: '上传失败',
  }[status];
}
