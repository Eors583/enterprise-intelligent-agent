import { useState, type FormEvent, type ReactNode } from 'react';

import { importKnowledgeWebDocument } from '@/api/admin-api';
import { messageFromError } from '@/api/client';
import { FieldError, Modal, Spinner } from '@/components/ui';

export function KnowledgeWebImportModal({
  knowledgeBaseId,
  onClose,
  onImported,
}: {
  readonly knowledgeBaseId: string;
  readonly onClose: () => void;
  readonly onImported: () => void;
}): ReactNode {
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [changeSummary, setChangeSummary] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await importKnowledgeWebDocument(knowledgeBaseId, {
        url: url.trim(),
        ...(title.trim() === '' ? {} : { title: title.trim() }),
        ...(changeSummary.trim() === '' ? {} : { changeSummary: changeSummary.trim() }),
      });
      onImported();
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="导入 HTTPS 网页"
      description="系统只连接管理员允许的公开 HTTPS 主机，不跟随跳转；原始 HTML 仅写入对象存储，不在管理端回显。"
      onClose={onClose}
      dismissible={!busy}
    >
      <form className="form-stack" onSubmit={(event) => void submit(event)}>
        <label>
          网页地址
          <input
            type="url"
            inputMode="url"
            required
            maxLength={2048}
            placeholder="https://docs.example.com/policies/security"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            disabled={busy}
          />
        </label>
        <label>
          文档标题（可选）
          <input
            maxLength={300}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            disabled={busy}
          />
        </label>
        <label>
          变更说明（可选）
          <textarea
            maxLength={500}
            value={changeSummary}
            onChange={(event) => setChangeSummary(event.target.value)}
            disabled={busy}
          />
        </label>
        <FieldError message={error} />
        <div className="modal-actions">
          <button className="button secondary" type="button" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button className="button primary" type="submit" disabled={busy || url.trim() === ''}>
            {busy ? <Spinner label="安全抓取中…" /> : '安全导入'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
