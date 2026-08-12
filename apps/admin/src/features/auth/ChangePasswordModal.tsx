import {
  changePasswordRequestSchema,
  type AuthAccount,
  type ChangePasswordRequest,
} from '@enterprise/contracts';
import { useState, type FormEvent, type ReactNode } from 'react';

import { changePassword } from '@/api/auth-api';
import { messageFromError } from '@/api/client';
import { FieldError, Modal, Notice, Spinner } from '@/components/ui';

export interface PasswordChangeForm {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
}

export type PasswordChangeErrors = Partial<Record<keyof PasswordChangeForm | 'form', string>>;

const INITIAL_FORM: PasswordChangeForm = {
  currentPassword: '',
  newPassword: '',
  confirmPassword: '',
};

function lengthError(label: string, value: string): string | undefined {
  if (value.length === 0) return `请输入${label}。`;
  if (value.length < 10 || value.length > 128) return `${label}长度应为 10–128 位。`;
  return undefined;
}

export function validatePasswordChangeForm(form: PasswordChangeForm): PasswordChangeErrors {
  const errors: PasswordChangeErrors = {};
  const currentPasswordError = lengthError('当前密码', form.currentPassword);
  const newPasswordError = lengthError('新密码', form.newPassword);
  const confirmPasswordError = lengthError('确认密码', form.confirmPassword);

  if (currentPasswordError) errors.currentPassword = currentPasswordError;
  if (newPasswordError) errors.newPassword = newPasswordError;
  if (confirmPasswordError) errors.confirmPassword = confirmPasswordError;
  else if (form.confirmPassword !== form.newPassword)
    errors.confirmPassword = '两次输入的新密码不一致。';

  if (Object.keys(errors).length === 0) {
    const parsed = changePasswordRequestSchema.safeParse({
      currentPassword: form.currentPassword,
      newPassword: form.newPassword,
    });
    if (!parsed.success) errors.form = parsed.error.issues[0]?.message ?? '请检查密码格式。';
  }

  return errors;
}

export function ChangePasswordModal({
  required,
  onClose,
  onChanged,
}: {
  required: boolean;
  onClose: () => void;
  onChanged: (account: AuthAccount) => void;
}): ReactNode {
  const [form, setForm] = useState<PasswordChangeForm>(INITIAL_FORM);
  const [errors, setErrors] = useState<PasswordChangeErrors>({});
  const [submitting, setSubmitting] = useState(false);

  const setValue = (field: keyof PasswordChangeForm, value: string): void => {
    setForm((current) => ({ ...current, [field]: value }));
    setErrors((current) => {
      const next = { ...current };
      delete next[field];
      delete next.form;
      return next;
    });
  };

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const nextErrors = validatePasswordChangeForm(form);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    const input: ChangePasswordRequest = {
      currentPassword: form.currentPassword,
      newPassword: form.newPassword,
    };
    setSubmitting(true);
    try {
      const result = await changePassword(input);
      onChanged(result.account);
    } catch (caught) {
      setErrors({ form: messageFromError(caught) });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title={required ? '首次登录，请修改密码' : '修改登录密码'}
      description={
        required
          ? '为保护账号安全，完成密码修改后才能继续使用管理后台。'
          : '修改后当前会话保持登录，其他设备上的会话将被安全退出。'
      }
      onClose={onClose}
      dismissible={!required && !submitting}
    >
      <form className="form-stack password-change-form" onSubmit={(event) => void submit(event)}>
        {required ? (
          <Notice tone="info">该账号使用初始密码登录，请设置仅你本人知晓的新密码。</Notice>
        ) : null}
        <label>
          <span>当前密码</span>
          <input
            autoFocus
            type="password"
            autoComplete="current-password"
            minLength={10}
            maxLength={128}
            value={form.currentPassword}
            onChange={(event) => setValue('currentPassword', event.target.value)}
            aria-invalid={Boolean(errors.currentPassword)}
          />
          <FieldError message={errors.currentPassword ?? null} />
        </label>
        <label>
          <span>新密码</span>
          <input
            type="password"
            autoComplete="new-password"
            minLength={10}
            maxLength={128}
            placeholder="10–128 位"
            value={form.newPassword}
            onChange={(event) => setValue('newPassword', event.target.value)}
            aria-invalid={Boolean(errors.newPassword)}
          />
          <FieldError message={errors.newPassword ?? null} />
        </label>
        <label>
          <span>确认新密码</span>
          <input
            type="password"
            autoComplete="new-password"
            minLength={10}
            maxLength={128}
            placeholder="再次输入新密码"
            value={form.confirmPassword}
            onChange={(event) => setValue('confirmPassword', event.target.value)}
            aria-invalid={Boolean(errors.confirmPassword)}
          />
          <FieldError message={errors.confirmPassword ?? null} />
        </label>
        <FieldError message={errors.form ?? null} />
        <div className="modal-actions">
          {!required ? (
            <button
              className="button secondary"
              type="button"
              disabled={submitting}
              onClick={onClose}
            >
              取消
            </button>
          ) : null}
          <button className="button primary" type="submit" disabled={submitting}>
            {submitting ? <Spinner label="正在修改…" /> : '确认修改'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
