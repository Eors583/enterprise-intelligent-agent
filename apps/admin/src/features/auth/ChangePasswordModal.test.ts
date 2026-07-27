import { describe, expect, it } from 'vitest';

import { validatePasswordChangeForm } from './ChangePasswordModal';

describe('change password form validation', () => {
  it('requires every password field', () => {
    expect(
      validatePasswordChangeForm({ currentPassword: '', newPassword: '', confirmPassword: '' }),
    ).toEqual({
      currentPassword: '请输入当前密码。',
      newPassword: '请输入新密码。',
      confirmPassword: '请输入确认密码。',
    });
  });

  it('enforces the 10 to 128 character policy', () => {
    const errors = validatePasswordChangeForm({
      currentPassword: 'short',
      newPassword: 'n'.repeat(129),
      confirmPassword: 'n'.repeat(129),
    });

    expect(errors.currentPassword).toBe('当前密码长度应为 10–128 位。');
    expect(errors.newPassword).toBe('新密码长度应为 10–128 位。');
    expect(errors.confirmPassword).toBe('确认密码长度应为 10–128 位。');
  });

  it('rejects a mismatched confirmation', () => {
    expect(
      validatePasswordChangeForm({
        currentPassword: '1234567890',
        newPassword: 'new-password-123',
        confirmPassword: 'new-password-456',
      }),
    ).toEqual({ confirmPassword: '两次输入的新密码不一致。' });
  });

  it('accepts a valid password change', () => {
    expect(
      validatePasswordChangeForm({
        currentPassword: '1234567890',
        newPassword: 'new-password-123',
        confirmPassword: 'new-password-123',
      }),
    ).toEqual({});
  });
});
