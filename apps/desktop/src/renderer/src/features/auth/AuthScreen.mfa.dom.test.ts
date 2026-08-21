import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DesktopAuthState, DesktopBridge } from '../../../../shared/desktop-api';
import { renderInTestDom } from '../../test/dom-test-utils';
import { AuthScreen } from './AuthScreen';

const EMPTY_STATE: DesktopAuthState = {
  accounts: [],
  activeSessionId: null,
  persistentStorageAvailable: true,
};

describe('desktop MFA login', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('uses the active account tenant as the real add-account form value', async () => {
    const authState: DesktopAuthState = {
      accounts: [
        {
          sessionId: '10000000-0000-7000-8000-000000000001',
          tenantId: '10000000-0000-7000-8000-000000000002',
          tenantSlug: 'future-collaboration',
          tenantName: '未来协作科技',
          userId: '10000000-0000-7000-8000-000000000003',
          email: 'owner@example.test',
          displayName: '测试账号',
          role: 'OWNER',
          passwordChangeRequired: false,
          accessExpiresAt: '2031-01-01T00:05:00.000Z',
          refreshExpiresAt: '2031-01-02T00:05:00.000Z',
        },
      ],
      activeSessionId: '10000000-0000-7000-8000-000000000001',
      persistentStorageAvailable: true,
    };
    const dom = await renderInTestDom(
      createElement(AuthScreen, {
        authState,
        modal: true,
        onAuthenticated: vi.fn(),
      }),
    );
    try {
      const tenant = dom.container.querySelector('[name="tenantSlug"]');
      expect(tenant).toBeInstanceOf(HTMLInputElement);
      expect((tenant as HTMLInputElement).value).toBe('future-collaboration');
    } finally {
      await dom.cleanup();
    }
  });

  it('renders TOTP and recovery-code choices and verifies before authenticating', async () => {
    const challenge = {
      kind: 'MFA_REQUIRED' as const,
      challenge: `ea_mfa_${'c'.repeat(52)}`,
      expiresAt: '2031-01-01T00:05:00.000Z',
      methods: ['TOTP', 'RECOVERY_CODE'] as const,
    };
    const authenticated: DesktopAuthState = {
      accounts: [],
      activeSessionId: '10000000-0000-7000-8000-000000000001',
      persistentStorageAvailable: true,
    };
    const bridge = {
      login: vi.fn().mockResolvedValue(challenge),
      verifyMfaLogin: vi.fn().mockResolvedValue(authenticated),
      openPasswordRecovery: vi.fn(),
    } as unknown as DesktopBridge;
    const onAuthenticated = vi.fn();
    const dom = await renderInTestDom(
      createElement(AuthScreen, {
        authState: EMPTY_STATE,
        onAuthenticated,
      }),
    );
    Object.defineProperty(window, 'enterpriseDesktop', {
      configurable: true,
      value: bridge,
    });

    const loginForm = dom.container.querySelector('form');
    if (!loginForm) throw new Error('login form missing');
    for (const [name, value] of [
      ['tenantSlug', 'example'],
      ['email', 'member@example.test'],
      ['password', 'password'],
    ] as const) {
      const input = loginForm.querySelector(`[name="${name}"]`);
      if (!(input instanceof HTMLInputElement)) throw new Error(`${name} input missing`);
      await dom.change(input, value);
    }
    await dom.submit(loginForm as HTMLFormElement);
    await dom.flush();

    expect(dom.container.textContent).toContain('完成多因素认证');
    expect(dom.container.textContent).toContain('身份验证器');
    expect(dom.container.textContent).toContain('一次性恢复码');
    expect(onAuthenticated).not.toHaveBeenCalled();

    const mfaForm = dom.container.querySelector('form');
    const code = mfaForm?.querySelector('[name="code"]');
    if (!mfaForm || !(code instanceof HTMLInputElement)) {
      throw new Error('MFA form missing');
    }
    await dom.change(code, '123456');
    await dom.submit(mfaForm as HTMLFormElement);
    await dom.flush();

    expect(bridge.verifyMfaLogin).toHaveBeenCalledWith({
      challenge: challenge.challenge,
      code: '123456',
      method: 'TOTP',
      sessionLabel: '桌面应用',
    });
    expect(onAuthenticated).toHaveBeenCalledWith(authenticated);
    await dom.cleanup();
  });

  it('discovers published OIDC providers and delegates login to the isolated main-process window', async () => {
    const authenticated: DesktopAuthState = {
      accounts: [],
      activeSessionId: '10000000-0000-7000-8000-000000000001',
      persistentStorageAvailable: true,
    };
    const bridge = {
      listOidcProviders: vi.fn().mockResolvedValue({
        items: [{ key: 'work-sso', displayName: 'Work SSO', protocol: 'OIDC' }],
      }),
      loginWithOidc: vi.fn().mockResolvedValue(authenticated),
      openPasswordRecovery: vi.fn(),
    } as unknown as DesktopBridge;
    const onAuthenticated = vi.fn();
    const dom = await renderInTestDom(
      createElement(AuthScreen, {
        authState: EMPTY_STATE,
        onAuthenticated,
      }),
    );
    Object.defineProperty(window, 'enterpriseDesktop', {
      configurable: true,
      value: bridge,
    });
    const tenant = dom.container.querySelector('[name="tenantSlug"]');
    if (!(tenant instanceof HTMLInputElement)) throw new Error('tenant input missing');
    await dom.change(tenant, 'example');
    await dom.flush();
    const discover = [...dom.container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('查找企业 OIDC 登录'),
    );
    if (!discover) throw new Error('OIDC discovery button missing');
    await dom.click(discover);
    await dom.flush();
    await dom.flush();

    expect(bridge.listOidcProviders).toHaveBeenCalledWith('example');
    expect(dom.container.textContent).toContain('使用 Work SSO 登录');
    const login = [...dom.container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('使用 Work SSO 登录'),
    );
    if (!login) throw new Error('OIDC login button missing');
    await dom.click(login);
    await dom.flush();

    expect(bridge.loginWithOidc).toHaveBeenCalledWith({
      tenantSlug: 'example',
      providerKey: 'work-sso',
    });
    expect(onAuthenticated).toHaveBeenCalledWith(authenticated);
    await dom.cleanup();
  });
});
