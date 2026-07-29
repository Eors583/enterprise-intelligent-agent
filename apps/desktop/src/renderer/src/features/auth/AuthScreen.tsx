import { useRef, useState } from 'react';
import type {
  MfaLoginChallengeResponse,
  OidcPublicProviderListResponse,
} from '@enterprise/contracts';
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
  const [mfaChallenge, setMfaChallenge] = useState<MfaLoginChallengeResponse | null>(null);
  const tenantSlugInput = useRef<HTMLInputElement>(null);
  const [oidcProviders, setOidcProviders] = useState<OidcPublicProviderListResponse['items']>([]);

  const submit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setPending(true);
    setError(null);
    const data = new FormData(event.currentTarget);
    try {
      if (mfaChallenge) {
        const state = await window.enterpriseDesktop.verifyMfaLogin({
          challenge: mfaChallenge.challenge,
          code: String(data.get('code') ?? ''),
          method: String(data.get('method') ?? 'TOTP') as 'TOTP' | 'RECOVERY_CODE',
          sessionLabel: '桌面应用',
        });
        await onAuthenticated(state);
        return;
      }
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
      if ('kind' in state) {
        setMfaChallenge(state);
      } else {
        await onAuthenticated(state);
      }
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

  const discoverOidc = async (): Promise<void> => {
    setPending(true);
    setError(null);
    try {
      const providers = await window.enterpriseDesktop.listOidcProviders(
        tenantSlugInput.current?.value ?? '',
      );
      setOidcProviders(providers.items);
      if (providers.items.length === 0) {
        setError('该企业没有已验证并发布的 OIDC 登录方式。');
      }
    } catch (cause) {
      setError(readableAuthError(cause));
    } finally {
      setPending(false);
    }
  };

  const beginOidc = async (providerKey: string): Promise<void> => {
    setPending(true);
    setError(null);
    try {
      await onAuthenticated(
        await window.enterpriseDesktop.loginWithOidc({
          tenantSlug: tenantSlugInput.current?.value ?? '',
          providerKey,
        }),
      );
    } catch (cause) {
      setError(readableAuthError(cause));
    } finally {
      setPending(false);
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
            onClick={() => {
              setMode('login');
              setMfaChallenge(null);
              setError(null);
              setOidcProviders([]);
            }}
          >
            登录企业
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'register'}
            onClick={() => {
              setMode('register');
              setMfaChallenge(null);
              setError(null);
              setOidcProviders([]);
            }}
          >
            创建企业
          </button>
        </div>
        <header>
          <p className="eyebrow">
            {mfaChallenge
              ? 'SECURITY VERIFICATION'
              : mode === 'login'
                ? 'WELCOME BACK'
                : 'NEW WORKSPACE'}
          </p>
          <h2>
            {mfaChallenge
              ? '完成多因素认证'
              : mode === 'login'
                ? '登录你的工作空间'
                : '创建企业与首位管理员'}
          </h2>
          <p>
            {mfaChallenge
              ? '密码已验证；会话尚未创建。请输入身份验证器验证码或一次性恢复码。'
              : mode === 'login'
                ? '需要企业标识、邮箱和密码。'
                : '此入口只创建新企业；已有企业的成员请联系管理员。'}
          </p>
        </header>
        <form className="auth-form" onSubmit={(event) => void submit(event)}>
          {mfaChallenge ? (
            <>
              <label>
                <span>验证方式</span>
                <select name="method" defaultValue={mfaChallenge.methods[0]}>
                  {mfaChallenge.methods.includes('TOTP') && (
                    <option value="TOTP">身份验证器</option>
                  )}
                  {mfaChallenge.methods.includes('RECOVERY_CODE') && (
                    <option value="RECOVERY_CODE">一次性恢复码</option>
                  )}
                </select>
              </label>
              <label>
                <span>验证码</span>
                <input
                  name="code"
                  required
                  autoFocus
                  autoComplete="one-time-code"
                  inputMode="numeric"
                  minLength={6}
                  maxLength={64}
                />
              </label>
            </>
          ) : (
            <>
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
                  ref={tenantSlugInput}
                  required
                  minLength={mode === 'register' ? 3 : 1}
                  maxLength={80}
                  pattern={mode === 'register' ? '[a-z0-9]+(?:-[a-z0-9]+)*' : undefined}
                  placeholder="future-collaboration"
                  autoCapitalize="none"
                  onChange={() => setOidcProviders([])}
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
            </>
          )}
          {mode === 'login' && !mfaChallenge && (
            <>
              <button
                type="button"
                className="auth-recovery-link"
                disabled={pending}
                onClick={() => void openPasswordRecovery()}
              >
                忘记密码？
              </button>
              <div className="auth-sso-divider">或使用企业单点登录</div>
              {oidcProviders.length === 0 ? (
                <button
                  type="button"
                  className="auth-recovery-link"
                  disabled={pending}
                  onClick={() => void discoverOidc()}
                >
                  查找企业 OIDC 登录
                </button>
              ) : (
                oidcProviders.map((provider) => (
                  <button
                    type="button"
                    className="auth-recovery-link"
                    key={provider.key}
                    disabled={pending}
                    onClick={() => void beginOidc(provider.key)}
                  >
                    使用 {provider.displayName} 登录
                  </button>
                ))
              )}
              <small>
                登录在隔离的临时窗口完成；关闭窗口即取消。SAML 未配置真实签名验证器时始终拒绝。
              </small>
            </>
          )}
          {error && (
            <div className="auth-error" role="alert">
              {error}
            </div>
          )}
          <button type="submit" className="primary-button auth-submit" disabled={pending}>
            {pending
              ? '正在验证…'
              : mfaChallenge
                ? '验证并进入'
                : mode === 'login'
                  ? '登录并进入'
                  : '创建企业并进入'}
          </button>
          {mfaChallenge && (
            <button
              type="button"
              className="auth-recovery-link"
              disabled={pending}
              onClick={() => {
                setMfaChallenge(null);
                setError(null);
              }}
            >
              返回密码登录
            </button>
          )}
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
