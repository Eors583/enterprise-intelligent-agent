import {
  loginRequestSchema,
  registerTenantRequestSchema,
  type BrowserAuthSessionResponse,
  type MfaLoginChallengeResponse,
  type OidcPublicProviderListResponse,
} from '@enterprise/contracts';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';

import {
  completeMfaLogin,
  completeOidcLogin,
  listOidcLoginProviders,
  login,
  registerTenant,
  startOidcLogin,
} from '@/api/admin-api';
import { messageFromError } from '@/api/client';
import { isSessionRoleAllowed, writeSession } from '@/auth/session';
import { FieldError, Spinner } from '@/components/ui';

type Mode = 'login' | 'register';

interface LoginForm {
  tenantSlug: string;
  email: string;
  password: string;
}

interface RegisterForm {
  tenantName: string;
  tenantSlug: string;
  organizationName: string;
  displayName: string;
  email: string;
  password: string;
}

const LOGIN_INITIAL: LoginForm = { tenantSlug: '', email: '', password: '' };
const REGISTER_INITIAL: RegisterForm = {
  tenantName: '',
  tenantSlug: '',
  organizationName: '',
  displayName: '',
  email: '',
  password: '',
};

function firstIssue(error: { issues: ReadonlyArray<{ message: string }> }): string {
  return error.issues[0]?.message ?? '请检查表单内容。';
}

function acceptSession(session: BrowserAuthSessionResponse): void {
  if (!isSessionRoleAllowed(session)) {
    throw new Error('当前账号不是管理员，无法进入管理后台。');
  }
  writeSession(session);
}

export function AuthScreen(): ReactNode {
  const [mode, setMode] = useState<Mode>('login');
  const [loginForm, setLoginForm] = useState<LoginForm>(LOGIN_INITIAL);
  const [registerForm, setRegisterForm] = useState<RegisterForm>(REGISTER_INITIAL);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [mfaChallenge, setMfaChallenge] = useState<MfaLoginChallengeResponse | null>(null);
  const [oidcProviders, setOidcProviders] = useState<OidcPublicProviderListResponse['items']>([]);
  const oidcCallbackStarted = useRef(false);

  useEffect(() => {
    if (!window.location.pathname.endsWith('/oidc/callback') || oidcCallbackStarted.current) return;
    const parameters = new URLSearchParams(window.location.search);
    const state = parameters.get('state');
    const code = parameters.get('code');
    oidcCallbackStarted.current = true;
    window.history.replaceState({}, '', '/');
    if (!state || !code) {
      setError('OIDC 回调缺少授权码或状态参数，登录已拒绝。');
      return;
    }
    setSubmitting(true);
    void completeOidcLogin({ state, code, sessionLabel: '管理后台' })
      .then(acceptSession)
      .catch((caught: unknown) => setError(messageFromError(caught)))
      .finally(() => setSubmitting(false));
  }, []);

  const switchMode = (next: Mode): void => {
    setMode(next);
    setError(null);
    setShowPassword(false);
    setMfaChallenge(null);
    setOidcProviders([]);
  };

  const submitLogin = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setError(null);
    const parsed = loginRequestSchema.safeParse({ ...loginForm, sessionLabel: '管理后台' });
    if (!parsed.success) {
      setError(firstIssue(parsed.error));
      return;
    }
    setSubmitting(true);
    try {
      const result = await login(parsed.data);
      if ('kind' in result) {
        setMfaChallenge(result);
      } else {
        acceptSession(result);
      }
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setSubmitting(false);
    }
  };

  const submitMfa = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!mfaChallenge) return;
    const form = new FormData(event.currentTarget);
    setSubmitting(true);
    setError(null);
    try {
      acceptSession(
        await completeMfaLogin({
          challenge: mfaChallenge.challenge,
          code: String(form.get('code') ?? ''),
          method: String(form.get('method') ?? 'TOTP') as 'TOTP' | 'RECOVERY_CODE',
          sessionLabel: '管理后台',
        }),
      );
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setSubmitting(false);
    }
  };

  const discoverSso = async (): Promise<void> => {
    setSubmitting(true);
    setError(null);
    try {
      const providers = await listOidcLoginProviders(loginForm.tenantSlug);
      setOidcProviders(providers.items);
      if (providers.items.length === 0) {
        setError('该企业没有已验证并发布的 OIDC 登录方式。');
      }
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setSubmitting(false);
    }
  };

  const beginSso = async (providerKey: string): Promise<void> => {
    setSubmitting(true);
    setError(null);
    try {
      const result = await startOidcLogin({
        tenantSlug: loginForm.tenantSlug,
        providerKey,
        redirectUri: new URL('/oidc/callback', window.location.origin).toString(),
        sessionLabel: '管理后台',
      });
      window.location.assign(result.authorizationUrl);
    } catch (caught) {
      setError(messageFromError(caught));
      setSubmitting(false);
    }
  };

  const submitRegister = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setError(null);
    const parsed = registerTenantRequestSchema.safeParse({
      ...registerForm,
      sessionLabel: '管理后台',
    });
    if (!parsed.success) {
      setError(firstIssue(parsed.error));
      return;
    }
    setSubmitting(true);
    try {
      acceptSession(await registerTenant(parsed.data));
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setSubmitting(false);
    }
  };

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
          <span className="eyebrow">ENTERPRISE CONTROL CENTER</span>
          <h1>
            让组织、成员与知识
            <br />
            始终保持在同一脉络
          </h1>
          <p>统一维护企业组织关系和知识资产，为桌面协同与智能体提供可信的数据底座。</p>
          <div className="story-features">
            <span>
              <i>01</i> 可调整的组织架构
            </span>
            <span>
              <i>02</i> 可审计的成员权限
            </span>
            <span>
              <i>03</i> 有范围的企业知识
            </span>
          </div>
        </div>
        <p className="auth-copyright">企业级安全边界 · 独立管理入口</p>
      </section>

      <section className="auth-panel">
        <div className="auth-card">
          <header>
            <span className="mobile-brand-mark">E</span>
            <p className="eyebrow">欢迎使用</p>
            <h2>{mode === 'login' ? '登录管理后台' : '创建你的企业'}</h2>
            <p>
              {mode === 'login'
                ? '使用企业标识和管理员账号登录。'
                : '创建企业后，你将成为首位企业所有者。'}
            </p>
          </header>

          <div className="auth-tabs" role="tablist" aria-label="认证方式">
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'login'}
              className={mode === 'login' ? 'active' : ''}
              onClick={() => switchMode('login')}
            >
              管理员登录
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'register'}
              className={mode === 'register' ? 'active' : ''}
              onClick={() => switchMode('register')}
            >
              创建企业
            </button>
          </div>

          {mode === 'login' && mfaChallenge ? (
            <form className="form-stack" onSubmit={(event) => void submitMfa(event)}>
              <div className="notice info" role="status">
                密码已验证。请使用身份验证器或一次性恢复码完成登录。
              </div>
              <label>
                <span>验证方式</span>
                <select name="method" defaultValue={mfaChallenge.methods[0]}>
                  {mfaChallenge.methods.includes('TOTP') ? (
                    <option value="TOTP">身份验证器</option>
                  ) : null}
                  {mfaChallenge.methods.includes('RECOVERY_CODE') ? (
                    <option value="RECOVERY_CODE">一次性恢复码</option>
                  ) : null}
                </select>
              </label>
              <label>
                <span>验证码</span>
                <input
                  name="code"
                  autoFocus
                  autoComplete="one-time-code"
                  inputMode="numeric"
                  required
                />
              </label>
              <FieldError message={error} />
              <button className="button primary large" type="submit" disabled={submitting}>
                {submitting ? <Spinner label="正在验证…" /> : '完成安全验证'}
              </button>
              <button
                className="button secondary"
                type="button"
                onClick={() => setMfaChallenge(null)}
              >
                返回密码登录
              </button>
            </form>
          ) : mode === 'login' ? (
            <form className="form-stack" onSubmit={(event) => void submitLogin(event)}>
              <label>
                <span>企业标识</span>
                <input
                  autoFocus
                  autoComplete="organization"
                  placeholder="例如 acme-group"
                  value={loginForm.tenantSlug}
                  onChange={(event) =>
                    setLoginForm((current) => ({ ...current, tenantSlug: event.target.value }))
                  }
                />
              </label>
              <label>
                <span>管理员邮箱</span>
                <input
                  type="email"
                  autoComplete="username"
                  placeholder="name@company.com"
                  value={loginForm.email}
                  onChange={(event) =>
                    setLoginForm((current) => ({ ...current, email: event.target.value }))
                  }
                />
              </label>
              <label>
                <span>密码</span>
                <span className="password-input">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="current-password"
                    placeholder="请输入密码"
                    value={loginForm.password}
                    onChange={(event) =>
                      setLoginForm((current) => ({ ...current, password: event.target.value }))
                    }
                  />
                  <button type="button" onClick={() => setShowPassword((value) => !value)}>
                    {showPassword ? '隐藏' : '显示'}
                  </button>
                </span>
              </label>
              <FieldError message={error} />
              <button
                className="button secondary"
                type="button"
                onClick={() => {
                  window.location.hash = '/forgot-password';
                }}
              >
                忘记密码
              </button>
              <button className="button primary large" type="submit" disabled={submitting}>
                {submitting ? <Spinner label="正在登录…" /> : '进入管理后台'}
              </button>
              <div className="form-divider">或使用企业单点登录</div>
              {oidcProviders.length === 0 ? (
                <button
                  className="button secondary"
                  type="button"
                  disabled={submitting || loginForm.tenantSlug.trim().length === 0}
                  onClick={() => void discoverSso()}
                >
                  查找企业 OIDC 登录
                </button>
              ) : (
                oidcProviders.map((provider) => (
                  <button
                    className="button secondary"
                    type="button"
                    key={provider.key}
                    disabled={submitting}
                    onClick={() => void beginSso(provider.key)}
                  >
                    使用 {provider.displayName} 登录
                  </button>
                ))
              )}
              <p className="muted">
                SAML 当前未配置真实 XML 签名验证器，所有 SAML 登录均会 fail-closed 拒绝。
              </p>
            </form>
          ) : (
            <form className="form-stack" onSubmit={(event) => void submitRegister(event)}>
              <div className="form-grid two">
                <label>
                  <span>企业名称</span>
                  <input
                    autoFocus
                    placeholder="例如 星云科技"
                    value={registerForm.tenantName}
                    onChange={(event) =>
                      setRegisterForm((current) => ({ ...current, tenantName: event.target.value }))
                    }
                  />
                </label>
                <label>
                  <span>企业标识</span>
                  <input
                    placeholder="仅小写字母、数字和连字符"
                    value={registerForm.tenantSlug}
                    onChange={(event) =>
                      setRegisterForm((current) => ({
                        ...current,
                        tenantSlug: event.target.value.toLowerCase(),
                      }))
                    }
                  />
                </label>
              </div>
              <label>
                <span>组织名称</span>
                <input
                  placeholder="例如 星云科技有限公司"
                  value={registerForm.organizationName}
                  onChange={(event) =>
                    setRegisterForm((current) => ({
                      ...current,
                      organizationName: event.target.value,
                    }))
                  }
                />
              </label>
              <div className="form-grid two">
                <label>
                  <span>管理员姓名</span>
                  <input
                    autoComplete="name"
                    placeholder="你的姓名"
                    value={registerForm.displayName}
                    onChange={(event) =>
                      setRegisterForm((current) => ({
                        ...current,
                        displayName: event.target.value,
                      }))
                    }
                  />
                </label>
                <label>
                  <span>管理员邮箱</span>
                  <input
                    type="email"
                    autoComplete="username"
                    placeholder="name@company.com"
                    value={registerForm.email}
                    onChange={(event) =>
                      setRegisterForm((current) => ({ ...current, email: event.target.value }))
                    }
                  />
                </label>
              </div>
              <label>
                <span>设置密码</span>
                <span className="password-input">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="new-password"
                    placeholder="至少 10 位，建议包含数字与符号"
                    value={registerForm.password}
                    onChange={(event) =>
                      setRegisterForm((current) => ({ ...current, password: event.target.value }))
                    }
                  />
                  <button type="button" onClick={() => setShowPassword((value) => !value)}>
                    {showPassword ? '隐藏' : '显示'}
                  </button>
                </span>
              </label>
              <FieldError message={error} />
              <button className="button primary large" type="submit" disabled={submitting}>
                {submitting ? <Spinner label="正在创建…" /> : '创建企业并进入后台'}
              </button>
              <p className="form-hint center">继续即表示你同意按企业安全规范管理成员和知识资产。</p>
            </form>
          )}
        </div>
      </section>
    </main>
  );
}
