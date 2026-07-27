import { useState } from 'react';
import type { DesktopAuthState } from '../../../../shared/desktop-api';

type AuthMode = 'login' | 'register';

interface AuthScreenProps {
  authState: DesktopAuthState;
  modal?: boolean;
  onCancel?: () => void;
  onAuthenticated: (state: DesktopAuthState) => Promise<void> | void;
}

export function AuthScreen({
  authState,
  modal = false,
  onCancel,
  onAuthenticated,
}: AuthScreenProps): React.JSX.Element {
  const [mode, setMode] = useState<AuthMode>('login');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setPending(true);
    setError(null);
    const data = new FormData(event.currentTarget);
    try {
      const state =
        mode === 'login'
          ? await window.enterpriseDesktop.login({
              tenantSlug: String(data.get('tenantSlug') ?? ''),
              email: String(data.get('email') ?? ''),
              password: String(data.get('password') ?? ''),
              sessionLabel: '桌面应用',
            })
          : await window.enterpriseDesktop.registerTenant({
              tenantName: String(data.get('tenantName') ?? ''),
              tenantSlug: String(data.get('tenantSlug') ?? ''),
              organizationName: String(data.get('organizationName') ?? ''),
              displayName: String(data.get('displayName') ?? ''),
              email: String(data.get('email') ?? ''),
              password: String(data.get('password') ?? ''),
              sessionLabel: '桌面应用',
            });
      await onAuthenticated(state);
    } catch (cause) {
      setError(readableAuthError(cause));
    } finally {
      setPending(false);
    }
  };

  const openPasswordRecovery = async (): Promise<void> => {
    setError(null);
    try {
      await window.enterpriseDesktop.openPasswordRecovery();
    } catch (cause) {
      setError(readableAuthError(cause));
    }
  };

  return (
    <div className={modal ? 'auth-shell modal' : 'auth-shell'} role={modal ? 'dialog' : undefined}>
      <section className="auth-brand-panel">
        <div className="auth-logo">E</div>
        <p className="eyebrow">ENTERPRISE AI COLLABORATION</p>
        <h1>一个企业，一个安全的协同空间</h1>
        <p>登录后进入通讯录和即时消息；组织与知识库由独立管理后台维护。</p>
        <ul>
          <li>支持同一台电脑保存并切换多个企业账号</li>
          <li>刷新凭证经系统加密后仅保存在桌面主进程</li>
          <li>企业成员由管理员创建，不开放任意加入</li>
        </ul>
      </section>
      <section className="auth-form-panel">
        {modal && (
          <button type="button" className="auth-close" onClick={onCancel} aria-label="关闭">
            ×
          </button>
        )}
        <div className="auth-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'login'}
            onClick={() => setMode('login')}
          >
            登录企业
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'register'}
            onClick={() => setMode('register')}
          >
            创建企业
          </button>
        </div>
        <header>
          <p className="eyebrow">{mode === 'login' ? 'WELCOME BACK' : 'NEW WORKSPACE'}</p>
          <h2>{mode === 'login' ? '登录你的工作空间' : '创建企业与首位管理员'}</h2>
          <p>
            {mode === 'login'
              ? '需要企业标识、邮箱和密码。'
              : '此入口只创建新企业；已有企业的成员请联系管理员。'}
          </p>
        </header>
        <form className="auth-form" onSubmit={(event) => void submit(event)}>
          {mode === 'register' && (
            <>
              <label>
                <span>企业名称</span>
                <input
                  name="tenantName"
                  required
                  maxLength={200}
                  placeholder="例如：未来协作科技"
                />
              </label>
              <label>
                <span>组织名称</span>
                <input
                  name="organizationName"
                  required
                  maxLength={200}
                  placeholder="例如：未来协作科技有限公司"
                />
              </label>
              <label>
                <span>管理员姓名</span>
                <input name="displayName" required maxLength={120} autoComplete="name" />
              </label>
            </>
          )}
          <label>
            <span>企业标识</span>
            <input
              name="tenantSlug"
              required
              minLength={mode === 'register' ? 3 : 1}
              maxLength={80}
              pattern={mode === 'register' ? '[a-z0-9]+(?:-[a-z0-9]+)*' : undefined}
              placeholder="future-collaboration"
              autoCapitalize="none"
            />
          </label>
          <label>
            <span>邮箱</span>
            <input name="email" required type="email" maxLength={320} autoComplete="username" />
          </label>
          <label>
            <span>密码</span>
            <input
              name="password"
              required
              type="password"
              minLength={mode === 'register' ? 10 : 1}
              maxLength={128}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            />
            {mode === 'register' && <small>至少 10 位，建议使用密码管理器生成。</small>}
          </label>
          {mode === 'login' && (
            <button
              type="button"
              className="auth-recovery-link"
              disabled={pending}
              onClick={() => void openPasswordRecovery()}
            >
              忘记密码？
            </button>
          )}
          {error && (
            <div className="auth-error" role="alert">
              {error}
            </div>
          )}
          <button type="submit" className="primary-button auth-submit" disabled={pending}>
            {pending ? '正在验证…' : mode === 'login' ? '登录并进入' : '创建企业并进入'}
          </button>
        </form>
        <p className="auth-storage-note">
          {authState.persistentStorageAvailable
            ? '本机系统加密存储可用，可在重启后继续切换账号。'
            : '系统安全存储不可用：账号仅在本次运行期间保留。'}
        </p>
      </section>
    </div>
  );
}

function readableAuthError(error: unknown): string {
  if (!(error instanceof Error)) return '认证失败，请稍后重试。';
  return error.message.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');
}
