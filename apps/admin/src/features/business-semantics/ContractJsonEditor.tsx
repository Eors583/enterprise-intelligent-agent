import { useState, type FormEvent, type ReactNode } from 'react';
import { ZodError } from 'zod';

import { messageFromError } from '@/api/client';
import { FieldError, Modal, Notice } from '@/components/ui';

export interface ContractJsonEditorConfig {
  title: string;
  description: string;
  initialValue: unknown;
  submitLabel: string;
  parse: (value: unknown) => unknown;
  submit: (value: unknown) => Promise<unknown>;
}

export function ContractJsonEditor({
  config,
  onClose,
  onSaved,
}: {
  config: ContractJsonEditorConfig;
  onClose: () => void;
  onSaved: () => void;
}): ReactNode {
  const [source, setSource] = useState(() => JSON.stringify(config.initialValue, null, 2));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      let decoded: unknown;
      try {
        decoded = JSON.parse(source) as unknown;
      } catch (caught) {
        throw new Error(`JSON 格式错误：${caught instanceof Error ? caught.message : '无法解析'}`);
      }
      const parsed = config.parse(decoded);
      await config.submit(parsed);
      onSaved();
    } catch (caught) {
      setError(contractEditorError(caught));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title={config.title}
      description={config.description}
      onClose={onClose}
      dismissible={!submitting}
      size="wide"
    >
      <form className="form-stack semantic-json-editor" onSubmit={(event) => void submit(event)}>
        <Notice tone="info">
          所有字段会先通过共享契约校验；跨实体存在性、权限与并发修订由服务端再次校验。
        </Notice>
        <label>
          <span>结构化请求 JSON</span>
          <textarea
            aria-label={`${config.title}请求 JSON`}
            value={source}
            spellCheck={false}
            rows={20}
            disabled={submitting}
            onChange={(event) => setSource(event.target.value)}
          />
        </label>
        <FieldError message={error} />
        <footer className="modal-actions">
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
            disabled={submitting || source.trim().length === 0}
          >
            {submitting ? '等待服务端确认…' : config.submitLabel}
          </button>
        </footer>
      </form>
    </Modal>
  );
}

function contractEditorError(error: unknown): string {
  if (error instanceof ZodError) {
    const issue = error.issues[0];
    const path = issue?.path.length ? `${issue.path.join('.')}：` : '';
    return `${path}${issue?.message ?? '请求不符合共享契约。'}`;
  }
  return messageFromError(error);
}
