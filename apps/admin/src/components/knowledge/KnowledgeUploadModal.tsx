import {
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
  type ReactNode,
} from 'react';
import type {
  AdminOrganizationResponse,
  KnowledgeBase,
  KnowledgeBaseOrgUnitScope,
  KnowledgeDocument,
  KnowledgeDocumentSummary,
  KnowledgeUploadInspection,
} from '@enterprise/contracts';

import {
  inspectKnowledgeUpload,
  updateKnowledgeBase,
  uploadKnowledgeDocument,
  uploadKnowledgeDocumentVersion,
} from '@/api/admin-api';
import { messageFromError } from '@/api/client';
import { FieldError, Modal, Spinner } from '@/components/ui';
import {
  KnowledgeAccessPicker,
  knowledgeAccessError,
  knowledgeAccessMode,
  type KnowledgeAccessMode,
} from '@/features/knowledge/KnowledgeAccessPicker';

import { knowledgeVersionFailure, latestKnowledgeVersion } from './knowledge-ingestion-outcome';

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

function extensionOf(fileName: string): string {
  return fileName.split('.').pop()?.toLowerCase() ?? '';
}

function titleFromFile(fileName: string): string {
  return fileName
    .replace(/\.[^.]+$/, '')
    .trim()
    .slice(0, 300);
}

function fileProblem(file: File): string | null {
  if (!ALLOWED_EXTENSIONS.has(extensionOf(file.name))) {
    return '仅支持 PDF、DOCX、XLSX、PPT、PPTX、常见图片、TXT 和 Markdown 文件。';
  }
  if (file.size === 0) return '文件内容为空，请重新选择。';
  return null;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function KnowledgeUploadModal({
  knowledgeBase,
  organization,
  organizationReady,
  document,
  folderId,
  onClose,
  onUploaded,
}: {
  knowledgeBase: Pick<KnowledgeBase, 'id' | 'name' | 'version' | 'orgUnitScopes' | 'memberUserIds'>;
  organization: AdminOrganizationResponse | null;
  organizationReady: boolean;
  document?: KnowledgeDocumentSummary;
  folderId?: string | null;
  onClose: () => void;
  onUploaded: (result: KnowledgeDocument) => void;
}): ReactNode {
  const inputRef = useRef<HTMLInputElement>(null);
  const automaticTitleRef = useRef('');
  const inspectionSequenceRef = useRef(0);
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState(document?.title ?? '');
  const [changeSummary, setChangeSummary] = useState('');
  const [dragging, setDragging] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [inspecting, setInspecting] = useState(false);
  const [inspection, setInspection] = useState<KnowledgeUploadInspection | null>(null);
  const [useMatchedDocument, setUseMatchedDocument] = useState(true);
  const [accessMode, setAccessMode] = useState<KnowledgeAccessMode>(() =>
    knowledgeAccessMode(knowledgeBase.orgUnitScopes, knowledgeBase.memberUserIds),
  );
  const [orgUnitScopes, setOrgUnitScopes] = useState<KnowledgeBaseOrgUnitScope[]>([
    ...knowledgeBase.orgUnitScopes,
  ]);
  const [memberUserIds, setMemberUserIds] = useState<string[]>([...knowledgeBase.memberUserIds]);
  const [error, setError] = useState<string | null>(null);

  const chooseFile = (next: File | null): void => {
    if (!next) return;
    const problem = fileProblem(next);
    if (problem) {
      inspectionSequenceRef.current += 1;
      setFile(null);
      setInspection(null);
      setInspecting(false);
      setError(problem);
      return;
    }
    setFile(next);
    setInspection(null);
    setInspecting(true);
    setUseMatchedDocument(true);
    if (document === undefined) {
      const automaticTitle = titleFromFile(next.name);
      setTitle((current) =>
        current.trim().length === 0 || current === automaticTitleRef.current
          ? automaticTitle
          : current,
      );
      automaticTitleRef.current = automaticTitle;
    }
    setError(null);
    const sequence = ++inspectionSequenceRef.current;
    void sha256File(next)
      .then((sha256) =>
        inspectKnowledgeUpload(knowledgeBase.id, {
          fileName: next.name,
          size: next.size,
          sha256,
          ...(document === undefined ? {} : { documentId: document.id }),
          ...(document === undefined ? { folderId: folderId ?? null } : {}),
        }),
      )
      .then((result) => {
        if (inspectionSequenceRef.current === sequence) setInspection(result);
      })
      .catch((caught: unknown) => {
        if (inspectionSequenceRef.current === sequence) {
          setError(`重复与版本检查失败：${messageFromError(caught)}`);
        }
      })
      .finally(() => {
        if (inspectionSequenceRef.current === sequence) setInspecting(false);
      });
  };

  const onInputChange = (event: ChangeEvent<HTMLInputElement>): void => {
    chooseFile(event.target.files?.[0] ?? null);
    event.target.value = '';
  };

  const onDrop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    setDragging(false);
    chooseFile(event.dataTransfer.files[0] ?? null);
  };

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!file) {
      setError('请先选择需要导入的文件。');
      return;
    }
    if (!organizationReady) {
      setError('组织与成员尚未读取完成，暂时不能确认知识库访问范围。');
      return;
    }
    const accessProblem = knowledgeAccessError(accessMode, orgUnitScopes, memberUserIds);
    if (accessProblem !== null) {
      setError(accessProblem);
      return;
    }
    if (document === undefined && !title.trim()) {
      setError('请输入文档标题。');
      return;
    }
    if (inspecting || inspection === null) {
      setError('请等待文件重复与版本检查完成。');
      return;
    }
    if (inspection.decision === 'EXACT_DUPLICATE') {
      setError('这个文件与知识库中的已有版本完全相同，无需重复上传。');
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      if (
        !sameKnowledgeAccess(
          knowledgeBase.orgUnitScopes,
          knowledgeBase.memberUserIds,
          orgUnitScopes,
          memberUserIds,
        )
      ) {
        await updateKnowledgeBase(knowledgeBase.id, {
          orgUnitScopes,
          memberUserIds,
          expectedVersion: knowledgeBase.version,
        });
      }
      const uploaded =
        document === undefined
          ? inspection.decision === 'NEW_VERSION_CANDIDATE' &&
            inspection.matchingDocument !== null &&
            useMatchedDocument
            ? await uploadKnowledgeDocumentVersion(
                knowledgeBase.id,
                inspection.matchingDocument.id,
                {
                  file,
                  ...(changeSummary.trim() ? { changeSummary } : {}),
                },
              )
            : await uploadKnowledgeDocument(knowledgeBase.id, {
                file,
                title,
                folderId: folderId ?? null,
                ...(changeSummary.trim() ? { changeSummary } : {}),
              })
          : await uploadKnowledgeDocumentVersion(knowledgeBase.id, document.id, {
              file,
              ...(changeSummary.trim() ? { changeSummary } : {}),
            });
      const failure = knowledgeVersionFailure(latestKnowledgeVersion(uploaded));
      if (failure !== null) {
        setError(failure);
        return;
      }
      onUploaded(uploaded);
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title={document === undefined ? '上传知识文件' : '上传文件新版本'}
      description={
        document === undefined
          ? `上传到“${knowledgeBase.name}”，系统会自动解析、切片并建立检索索引。`
          : `为“${document.title}”上传新版本；处理成功后仍沿用当前文档入口。`
      }
      onClose={onClose}
      size="wide"
      dismissible={!submitting}
    >
      <form className="form-stack" onSubmit={(event) => void submit(event)}>
        <KnowledgeAccessPicker
          organization={organization}
          mode={accessMode}
          orgUnitScopes={orgUnitScopes}
          memberUserIds={memberUserIds}
          disabled={!organizationReady || submitting}
          onModeChange={setAccessMode}
          onOrgUnitScopesChange={setOrgUnitScopes}
          onMemberUserIdsChange={setMemberUserIds}
        />
        <p className="form-hint">
          这里设置的是“{knowledgeBase.name}
          ”的统一访问范围，本次文件、已有资料和后续新版本都会按该范围接受服务端检索校验。
        </p>
        <input
          ref={inputRef}
          className="visually-hidden"
          type="file"
          accept=".pdf,.docx,.xlsx,.ppt,.pptx,.png,.jpg,.jpeg,.tif,.tiff,.bmp,.webp,.txt,.md,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation,image/*,text/plain,text/markdown"
          onChange={onInputChange}
        />
        <div
          className={`knowledge-drop-zone ${dragging ? 'dragging' : ''}`}
          role="button"
          tabIndex={0}
          onClick={() => inputRef.current?.click()}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') inputRef.current?.click();
          }}
          onDragEnter={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <span className="knowledge-upload-symbol" aria-hidden="true">
            ↑
          </span>
          {file ? (
            <>
              <strong>{file.name}</strong>
              <small>{formatFileSize(file.size)} · 点击重新选择</small>
            </>
          ) : (
            <>
              <strong>拖放文件到这里，或点击选择</strong>
              <small>支持 PDF、DOCX、XLSX、PPT、PPTX、常见图片、TXT、MD</small>
            </>
          )}
        </div>
        <div className={`form-grid ${document === undefined ? 'two' : ''}`}>
          {document === undefined ? (
            <label>
              <span>文档标题</span>
              <input
                value={title}
                maxLength={300}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="用于检索结果和引用展示"
              />
            </label>
          ) : null}
          <label>
            <span>版本说明（可选）</span>
            <input
              value={changeSummary}
              maxLength={500}
              onChange={(event) => setChangeSummary(event.target.value)}
              placeholder={document === undefined ? '例如：首次导入' : '例如：更新至 2026 版制度'}
            />
          </label>
        </div>
        <p className="form-hint">
          上传后会依次执行安全检查、内容解析、切片和索引。解析失败时可在文档列表查看原因并重试。
        </p>
        {inspecting ? <Spinner label="正在检查重复文件和历史版本…" /> : null}
        {inspection?.decision === 'EXACT_DUPLICATE' && inspection.matchingDocument !== null ? (
          <div className="knowledge-upload-duplicate" role="status">
            <strong>无需重复上传</strong>
            <p>
              与“{inspection.matchingDocument.title}”v
              {inspection.matchingDocument.matchedVersion} 完全相同。
            </p>
          </div>
        ) : null}
        {document === undefined &&
        inspection?.decision === 'NEW_VERSION_CANDIDATE' &&
        inspection.matchingDocument !== null ? (
          <fieldset className="knowledge-upload-version-choice">
            <legend>检测到同名历史文档</legend>
            <label>
              <input
                type="radio"
                name="upload-version-choice"
                checked={useMatchedDocument}
                onChange={() => setUseMatchedDocument(true)}
              />
              作为“{inspection.matchingDocument.title}”的新版本上传（推荐）
            </label>
            <label>
              <input
                type="radio"
                name="upload-version-choice"
                checked={!useMatchedDocument}
                onChange={() => setUseMatchedDocument(false)}
              />
              仍然创建一份独立文档
            </label>
          </fieldset>
        ) : null}
        <FieldError message={error} />
        <div className="modal-actions">
          <button
            className="button secondary"
            type="button"
            onClick={onClose}
            disabled={submitting}
          >
            取消
          </button>
          <button
            className="button primary"
            type="submit"
            disabled={
              submitting ||
              inspecting ||
              !file ||
              inspection === null ||
              inspection.decision === 'EXACT_DUPLICATE'
            }
          >
            {submitting ? (
              <Spinner label="正在上传并解析…" />
            ) : document === undefined ? (
              '上传并建立索引'
            ) : (
              '上传新版本'
            )}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function sameKnowledgeAccess(
  currentScopes: readonly KnowledgeBaseOrgUnitScope[],
  currentMembers: readonly string[],
  nextScopes: readonly KnowledgeBaseOrgUnitScope[],
  nextMembers: readonly string[],
): boolean {
  const normalizeScopes = (scopes: readonly KnowledgeBaseOrgUnitScope[]): string[] =>
    scopes
      .map((scope) => `${scope.orgUnitId}:${scope.includeChildren ? '1' : '0'}`)
      .sort((left, right) => left.localeCompare(right));
  const normalizeMembers = (members: readonly string[]): string[] => [...members].sort();
  return (
    JSON.stringify(normalizeScopes(currentScopes)) ===
      JSON.stringify(normalizeScopes(nextScopes)) &&
    JSON.stringify(normalizeMembers(currentMembers)) ===
      JSON.stringify(normalizeMembers(nextMembers))
  );
}

async function sha256File(file: File): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}
