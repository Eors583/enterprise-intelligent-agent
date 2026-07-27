import {
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
  type ReactNode,
} from 'react';
import type { KnowledgeDocument, KnowledgeDocumentSummary } from '@enterprise/contracts';

import { uploadKnowledgeDocument, uploadKnowledgeDocumentVersion } from '@/api/admin-api';
import { messageFromError } from '@/api/client';
import { FieldError, Modal, Spinner } from '@/components/ui';

import { knowledgeVersionFailure, latestKnowledgeVersion } from './knowledge-ingestion-outcome';

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set(['pdf', 'docx', 'txt', 'md']);

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
    return '仅支持 PDF、Word（.docx）、纯文本（.txt）和 Markdown（.md）文件。';
  }
  if (file.size === 0) return '文件内容为空，请重新选择。';
  if (file.size > MAX_FILE_BYTES) return '文件不能超过 20 MB。';
  return null;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function KnowledgeUploadModal({
  knowledgeBaseId,
  knowledgeBaseName,
  document,
  onClose,
  onUploaded,
}: {
  knowledgeBaseId: string;
  knowledgeBaseName: string;
  document?: KnowledgeDocumentSummary;
  onClose: () => void;
  onUploaded: (result: KnowledgeDocument) => void;
}): ReactNode {
  const inputRef = useRef<HTMLInputElement>(null);
  const automaticTitleRef = useRef('');
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState(document?.title ?? '');
  const [changeSummary, setChangeSummary] = useState('');
  const [dragging, setDragging] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const chooseFile = (next: File | null): void => {
    if (!next) return;
    const problem = fileProblem(next);
    if (problem) {
      setFile(null);
      setError(problem);
      return;
    }
    setFile(next);
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
    if (document === undefined && !title.trim()) {
      setError('请输入文档标题。');
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const uploaded =
        document === undefined
          ? await uploadKnowledgeDocument(knowledgeBaseId, {
              file,
              title,
              ...(changeSummary.trim() ? { changeSummary } : {}),
            })
          : await uploadKnowledgeDocumentVersion(knowledgeBaseId, document.id, {
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
          ? `上传到“${knowledgeBaseName}”，系统会自动解析、切片并建立检索索引。`
          : `为“${document.title}”上传新版本；处理成功后仍沿用当前文档入口。`
      }
      onClose={onClose}
      size="wide"
      dismissible={!submitting}
    >
      <form className="form-stack" onSubmit={(event) => void submit(event)}>
        <input
          ref={inputRef}
          className="visually-hidden"
          type="file"
          accept=".pdf,.docx,.txt,.md,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown"
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
              <small>支持 PDF、DOCX、TXT、MD，单个文件最大 20 MB</small>
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
          <button className="button primary" type="submit" disabled={submitting || !file}>
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
