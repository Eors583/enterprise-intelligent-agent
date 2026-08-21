import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react';

export function Spinner({ label = '正在加载' }: { label?: string }): ReactNode {
  return (
    <span className="spinner-wrap" role="status">
      <span className="spinner" aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}

export function LoadingPanel({ label = '正在加载数据…' }: { label?: string }): ReactNode {
  return (
    <div className="state-panel" aria-live="polite">
      <Spinner label={label} />
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}): ReactNode {
  return (
    <div className="state-panel empty-state">
      <span className="empty-symbol" aria-hidden="true">
        ◇
      </span>
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}

export function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}): ReactNode {
  return (
    <div className="state-panel error-state" role="alert">
      <strong>数据加载失败</strong>
      <p>{message}</p>
      {onRetry ? (
        <button className="button secondary" type="button" onClick={onRetry}>
          重新加载
        </button>
      ) : null}
    </div>
  );
}

export function Notice({
  tone,
  children,
  onClose,
}: {
  tone: 'success' | 'error' | 'info';
  children: ReactNode;
  onClose?: () => void;
}): ReactNode {
  return (
    <div className={`notice ${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <span>{children}</span>
      {onClose ? (
        <button type="button" className="icon-button" aria-label="关闭提示" onClick={onClose}>
          ×
        </button>
      ) : null}
    </div>
  );
}

export function Modal({
  title,
  description,
  children,
  onClose,
  size = 'normal',
  dismissible = true,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  onClose: () => void;
  size?: 'normal' | 'wide';
  dismissible?: boolean;
}): ReactNode {
  const dialogRef = useRef<HTMLElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusTarget = dialog.querySelector<HTMLElement>(
      '[autofocus], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
    );
    (focusTarget ?? dialog).focus();
    return () => previouslyFocused?.focus();
  }, []);

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (dismissible && event.key === 'Escape') {
      event.preventDefault();
      onClose();
    }
  };

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={dismissible ? onClose : undefined}
    >
      <section
        ref={dialogRef}
        className={`modal ${size === 'wide' ? 'wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal-header">
          <div>
            <h2 id={titleId}>{title}</h2>
            {description ? <p id={descriptionId}>{description}</p> : null}
          </div>
          {dismissible ? (
            <button type="button" className="icon-button close" aria-label="关闭" onClick={onClose}>
              ×
            </button>
          ) : null}
        </header>
        <div className="modal-body">{children}</div>
      </section>
    </div>
  );
}

export function FieldError({ message }: { message?: string | null }): ReactNode {
  return message ? <p className="field-error">{message}</p> : null;
}

export function StatusPill({ value, label }: { value: string; label?: string }): ReactNode {
  const labels: Record<string, string> = {
    ACTIVE: '启用',
    INACTIVE: '停用',
    LOCKED: '锁定',
    ARCHIVED: '已归档',
    DRAFT: '草稿',
    READY: '可用',
    PENDING: '待生效',
    SUSPENDED: '已暂停',
    TERMINATED: '已离职',
    NOT_CONFIGURED: '未配置',
    RUNNING: '进行中',
    SUCCEEDED: '成功',
    FAILED: '失败',
  };
  return (
    <span className={`status-pill status-${value.toLowerCase()}`}>
      {label ?? labels[value] ?? value}
    </span>
  );
}

export function roleLabel(role: string): string {
  return (
    {
      OWNER: '企业所有者',
      ADMIN: '企业管理员',
      KNOWLEDGE_ADMIN: '知识管理员',
      MEMBER: '普通成员',
    }[role] ?? role
  );
}
