import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { DesktopAuthState } from '../../../../shared/desktop-api';
import { renderInTestDom } from '../../test/dom-test-utils';
import { AccountSwitcher } from './AccountSwitcher';

const AUTH_STATE: DesktopAuthState = {
  accounts: [
    {
      sessionId: '00000000-0000-7000-8000-000000000001',
      tenantId: '00000000-0000-7000-8000-000000000002',
      tenantSlug: 'future',
      tenantName: '未来协作',
      userId: '00000000-0000-7000-8000-000000000003',
      email: 'employee@example.test',
      displayName: '林晓',
      role: 'MEMBER',
      passwordChangeRequired: false,
      accessExpiresAt: '2026-07-29T10:00:00.000Z',
      refreshExpiresAt: '2026-08-29T10:00:00.000Z',
    },
  ],
  activeSessionId: '00000000-0000-7000-8000-000000000001',
  persistentStorageAvailable: true,
};

describe('AccountSwitcher avatar menu', () => {
  it('opens from the App request and keeps switch, password and add-account actions together', async () => {
    const onNavigate = vi.fn();
    const dom = await renderInTestDom(
      createElement(AccountSwitcher, {
        state: AUTH_STATE,
        openRequest: 1,
        onStateChange: vi.fn(),
        onAddAccount: vi.fn(),
        onChangePassword: vi.fn(),
        onNavigate,
      }),
    );
    try {
      const trigger = dom.container.querySelector('[aria-label="账号菜单"]');
      expect(trigger?.getAttribute('aria-expanded')).toBe('true');
      expect(dom.container.querySelector('.account-switcher')).not.toBeNull();
      expect(dom.container.querySelector('.account-menu')?.textContent).toContain('切换账号');
      expect(dom.container.querySelector('.account-menu')?.textContent).toContain('账号与安全');
      expect(dom.container.querySelector('.account-menu')?.textContent).toContain('添加账号');
      expect(dom.container.querySelector('.account-menu')?.textContent).toContain('设置');
      expect(dom.container.querySelector('.account-menu')?.textContent).toContain('退出登录');
      expect(dom.container.querySelector('.account-quick-navigation')).toBeNull();

      const settings = [...dom.container.querySelectorAll('[role="menuitem"]')].find(
        (item) => item.textContent === '设置',
      );
      expect(settings).not.toBeUndefined();
      if (settings) await dom.click(settings);
      expect(onNavigate).toHaveBeenCalledWith('my');
    } finally {
      await dom.cleanup();
    }
  });
});
