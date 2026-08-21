import { useEffect, useState, type FormEvent, type ReactNode } from 'react';

import {
  acceptMemberInvitation,
  completePasswordReset,
  requestPasswordReset,
} from '@/api/auth-api';
import { messageFromError } from '@/api/client';
import { FieldError, Notice, Spinner } from '@/components/ui';

import type { RecoveryRoute } from './recovery-route';

export { parseRecoveryRoute, type RecoveryRoute } from './recovery-route';

export function RecoveryScreen({
  route,
  onReturnToLogin,
}: {
  route: RecoveryRoute;
  onReturnToLogin: () => void;
}): ReactNode {
  useEffect(() => {
    if (route.kind === 'forgot-password') return;
    // Keep the capability in component memory only after boot. This removes it
    // from subsequent screenshots, copied URLs, and browser history entries.
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${window.location.search}#/recovery-in-progress`,
    );
  }, [route.kind]);

  return (
    <main className="auth-page">
      <section className="auth-story">
        <div className="brand brand-on-dark">
          <span className="brand-mark" aria-hidden="true">
            E
          </span>
          <span>企业 AI 协同</span>
        </div>
        <div className="auth-story-copy">
          <span className="eyebrow">SECURE ACCOUNT RECOVERY</span>
          <h1>安全恢复企业账号</h1>
          <p>重置与邀请链接均为一次性凭证，使用后立即失效并撤销既有会话。</p>
        </div>
      </section>
      <section className="auth-panel">
        <div className="auth-card">
          {route.kind === 'forgot-password' ? (
            <ForgotPasswordForm onReturnToLogin={onReturnToLogin} />
          ) : (
            <SetPasswordForm route={route} onReturnToLogin={onReturnToLogin} />
          )}
        </div>
      </section>
    </main>
  );
}

function ForgotPasswordForm({ onReturnToLogin }: { onReturnToLogin: () => void }): ReactNode {
  const [tenantSlug, setTenantSlug] = useState('');
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [accepted, setAccepted] = useState(false);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await requestPasswordReset({ tenantSlug, email });
      setAccepted(true);
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <header>
        <p className="eyebrow">PASSWORD RECOVERY</p>
        <h2>忘记密码</h2>
        <p>填写企业标识和登录邮箱。无论账号是否存在，页面都会显示相同结果。</p>
      </header>
      {accepted ? (
        <div className="form-stack">
          <Notice tone="success">
            请求已受理。如果账号符合恢复条件，系统会发送一次性重置链接。
          </Notice>
          <button className="button primary large" type="button" onClick={onReturnToLogin}>
            返回登录
          </button>
        </div>
      ) : (
        <form className="form-stack" onSubmit={(event) => void submit(event)}>
          <label>
            <span>企业标识</span>
            <input
              autoFocus
              autoComplete="organization"
              value={tenantSlug}
              onChange={(event) => setTenantSlug(event.target.value.toLowerCase())}
              placeholder="例如 acme-group"
            />
          </label>
          <label>
            <span>登录邮箱</span>
            <input
              type="email"
              autoComplete="username"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="name@company.com"
            />
          </label>
          <FieldError message={error} />
          <button className="button primary large" type="submit" disabled={submitting}>
            {submitting ? <Spinner label="正在提交…" /> : '发送重置链接'}
          </button>
          <button className="button secondary" type="button" onClick={onReturnToLogin}>
            返回登录
          </button>
        </form>
      )}
    </>
  );
}

function SetPasswordForm({
  route,
  onReturnToLogin,
}: {
  route: Exclude<RecoveryRoute, { readonly kind: 'forgot-password' }>;
  onReturnToLogin: () => void;
}): ReactNode {
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [completed, setCompleted] = useState(false);
  const invited = route.kind === 'accept-invitation';

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setError(null);
    if (password !== confirmation) {
      setError('两次输入的密码不一致。');
      return;
    }
    setSubmitting(true);
    try {
      if (invited) await acceptMemberInvitation({ token: route.token, newPassword: password });
      else await completePasswordReset({ token: route.token, newPassword: password });
      setCompleted(true);
      setPassword('');
      setConfirmation('');
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <header>
        <p className="eyebrow">ONE-TIME CREDENTIAL</p>
        <h2>{invited ? '接受成员邀请' : '设置新密码'}</h2>
        <p>{invited ? '设置密码后账号将被激活。' : '完成后，其他已登录会话将立即失效。'}</p>
      </header>
      {completed ? (
        <div className="form-stack">
          <Notice tone="success">
            {invited ? '邀请已接受，账号已激活。' : '密码已更新，既有会话已撤销。'}
          </Notice>
          <button className="button primary large" type="button" onClick={onReturnToLogin}>
            前往登录
          </button>
        </div>
      ) : (
        <form className="form-stack" onSubmit={(event) => void submit(event)}>
          <label>
            <span>新密码</span>
            <input
              autoFocus
              type="password"
              autoComplete="new-password"
              minLength={10}
              maxLength={128}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="至少 10 位"
            />
          </label>
          <label>
            <span>确认新密码</span>
            <input
              type="password"
              autoComplete="new-password"
              minLength={10}
              maxLength={128}
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
            />
          </label>
          <FieldError message={error} />
          <button className="button primary large" type="submit" disabled={submitting}>
            {submitting ? <Spinner label="正在提交…" /> : invited ? '接受邀请' : '更新密码'}
          </button>
          <button className="button secondary" type="button" onClick={onReturnToLogin}>
            返回登录
          </button>
        </form>
      )}
    </>
  );
}
