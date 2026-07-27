import { useState } from 'react';
import type { AuthAccount } from '@enterprise/contracts';
import type { DesktopAuthState } from '../../../../shared/desktop-api';

interface PasswordChangeScreenProps {
  account: AuthAccount;
  forced?: boolean;
  onCancel?: () => void;
  onChanged: (state: DesktopAuthState) => Promise<void> | void;
}

export function PasswordChangeScreen({
  account,
  forced = false,
  onCancel,
  onChanged,
}: PasswordChangeScreenProps): React.JSX.Element {
  const [pending, setPending] = useState<'change' | 'logout' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const currentPassword = String(data.get('currentPassword') ?? '');
    const newPassword = String(data.get('newPassword') ?? '');
    const confirmation = String(data.get('confirmation') ?? '');
    const validationError = validatePasswordChange(currentPassword, newPassword, confirmation);
    if (validationError) {
      setError(validationError);
      return;
    }

    setPending('change');
    setError(null);
    try {
      const result = await window.enterpriseDesktop.changePassword({
        currentPassword,
        newPassword,
      });
      await onChanged(result.state);
    } catch (cause) {
      setError(readablePasswordError(cause));
    } finally {
      setPending(null);
    }
  };

  const logout = async (): Promise<void> => {
    setPending('logout');
    setError(null);
    try {
      await onChanged(await window.enterpriseDesktop.logout(account.sessionId));
    } catch (cause) {
      setError(readablePasswordError(cause));
    } finally {
      setPending(null);
    }
  };

  return (
    <div
      className={
        forced ? 'auth-shell password-change-shell' : 'auth-shell modal password-change-shell'
      }
      role={forced ? undefined : 'dialog'}
      aria-modal={forced ? undefined : true}
      aria-labelledby="password-change-title"
    >
      <section className="auth-brand-panel password-brand-panel">
        <div className="auth-logo">E</div>
        <p className="eyebrow">ACCOUNT SECURITY</p>
        <h1>{forced ? '首次登录，请先设置你的专属密码' : '定期更新密码，保护企业账号'}</h1>
        <p>
          {forced
            ? '当前账号使用管理员分配的初始密码。完成修改后，才能进入通讯录、消息和知识库。'
            : '密码修改只影响当前企业账号；本机保存的登录会话会安全更新。'}
        </p>
        <ul>
          <li>新密码长度为 10–128 个字符</li>
          <li>不要复用邮箱、社交账号或其他企业系统的密码</li>
          <li>建议使用密码管理器生成并保存独立密码</li>
        </ul>
      </section>
      <section className="auth-form-panel">
        {!forced && (
          <button
            type="button"
            className="auth-close"
            onClick={onCancel}
            disabled={pending !== null}
            aria-label="关闭修改密码窗口"
          >
            ×
          </button>
        )}
        <header>
          <p className="eyebrow">{forced ? 'PASSWORD CHANGE REQUIRED' : 'CHANGE PASSWORD'}</p>
          <h2 id="password-change-title">{forced ? '必须修改初始密码' : '修改登录密码'}</h2>
          <p>
            当前账号：{account.displayName} · {account.tenantName}
          </p>
        </header>
        <form className="auth-form password-change-form" onSubmit={(event) => void submit(event)}>
          <label>
            <span>当前密码</span>
            <input
              name="currentPassword"
              required
              type="password"
              minLength={1}
              maxLength={128}
              autoComplete="current-password"
              autoFocus
            />
            {forced && <small>请输入管理员提供的初始密码。</small>}
          </label>
          <label>
            <span>新密码</span>
            <input
              name="newPassword"
              required
              type="password"
              minLength={10}
              maxLength={128}
              autoComplete="new-password"
            />
            <small>至少 10 个字符，且不能与当前密码相同。</small>
          </label>
          <label>
            <span>再次输入新密码</span>
            <input
              name="confirmation"
              required
              type="password"
              minLength={10}
              maxLength={128}
              autoComplete="new-password"
            />
          </label>
          {error && (
            <div className="auth-error" role="alert">
              {error}
            </div>
          )}
          <button type="submit" className="primary-button auth-submit" disabled={pending !== null}>
            {pending === 'change'
              ? '正在更新密码…'
              : forced
                ? '修改密码并进入应用'
                : '确认修改密码'}
          </button>
          {forced && (
            <button
              type="button"
              className="secondary-button password-forced-logout"
              disabled={pending !== null}
              onClick={() => void logout()}
            >
              {pending === 'logout' ? '正在退出…' : '退出当前账号'}
            </button>
          )}
        </form>
      </section>
    </div>
  );
}

export function validatePasswordChange(
  currentPassword: string,
  newPassword: string,
  confirmation: string,
): string | null {
  if (!currentPassword || currentPassword.length > 128) return '请输入有效的当前密码。';
  if (newPassword.length < 10 || newPassword.length > 128) {
    return '新密码长度必须为 10–128 个字符。';
  }
  if (newPassword !== confirmation) return '两次输入的新密码不一致。';
  if (newPassword === currentPassword) return '新密码不能与当前密码相同。';
  return null;
}

function readablePasswordError(error: unknown): string {
  if (!(error instanceof Error)) return '密码修改失败，请稍后重试。';
  return error.message.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');
}
