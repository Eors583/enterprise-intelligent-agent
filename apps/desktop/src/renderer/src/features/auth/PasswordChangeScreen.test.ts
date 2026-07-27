import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AuthAccount } from '@enterprise/contracts';
import { describe, expect, it } from 'vitest';
import { PasswordChangeScreen, validatePasswordChange } from './PasswordChangeScreen';

describe('validatePasswordChange', () => {
  it('accepts a confirmed password between 10 and 128 characters', () => {
    expect(
      validatePasswordChange('1234567890', 'a-unique-new-password', 'a-unique-new-password'),
    ).toBeNull();
    expect(validatePasswordChange('1234567890', 'a'.repeat(128), 'a'.repeat(128))).toBeNull();
  });

  it('offers a logout action on the mandatory screen without a dismiss action', () => {
    const markup = renderToStaticMarkup(
      createElement(PasswordChangeScreen, {
        account: forcedAccount(),
        forced: true,
        onChanged: () => undefined,
      }),
    );

    expect(markup).toContain('退出当前账号');
    expect(markup).not.toContain('关闭修改密码窗口');
    expect(markup).toContain('修改密码并进入应用');
  });

  it('rejects invalid length, a mismatched confirmation, and password reuse', () => {
    expect(validatePasswordChange('1234567890', 'too-short', 'too-short')).toBe(
      '新密码长度必须为 10–128 个字符。',
    );
    expect(validatePasswordChange('1234567890', 'new-password-1', 'new-password-2')).toBe(
      '两次输入的新密码不一致。',
    );
    expect(validatePasswordChange('1234567890', '1234567890', '1234567890')).toBe(
      '新密码不能与当前密码相同。',
    );
  });
});

function forcedAccount(): AuthAccount {
  return {
    sessionId: '00000000-0000-7000-8000-000000000001',
    tenantId: '10000000-0000-7000-8000-000000000001',
    tenantSlug: 'workspace-1',
    tenantName: 'Workspace 1',
    userId: '20000000-0000-7000-8000-000000000001',
    email: 'user-1@example.test',
    displayName: 'User 1',
    role: 'MEMBER',
    passwordChangeRequired: true,
    accessExpiresAt: '2030-01-01T00:15:00.000Z',
    refreshExpiresAt: '2030-01-31T00:00:00.000Z',
  };
}
