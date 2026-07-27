import { useEffect, useRef, useState } from 'react';
import type { AuthAccount } from '@enterprise/contracts';
import type { DesktopAuthState } from '../../../../shared/desktop-api';

interface AccountSwitcherProps {
  state: DesktopAuthState;
  onStateChange: (state: DesktopAuthState) => Promise<void> | void;
  onAddAccount: () => void;
  onChangePassword: () => void;
}

export function AccountSwitcher({
  state,
  onStateChange,
  onAddAccount,
  onChangePassword,
}: AccountSwitcherProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const container = useRef<HTMLDivElement>(null);
  const active = state.accounts.find((item) => item.sessionId === state.activeSessionId);

  useEffect(() => {
    const close = (event: MouseEvent): void => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, []);

  const switchTo = async (account: AuthAccount): Promise<void> => {
    if (account.sessionId === state.activeSessionId) return;
    setPending(account.sessionId);
    setError(null);
    try {
      await onStateChange(await window.enterpriseDesktop.switchAccount(account.sessionId));
      setOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '账号切换失败。');
    } finally {
      setPending(null);
    }
  };

  const logout = async (): Promise<void> => {
    if (!active) return;
    setPending(active.sessionId);
    try {
      await onStateChange(await window.enterpriseDesktop.logout(active.sessionId));
      setOpen(false);
    } finally {
      setPending(null);
    }
  };

  if (!active) return <></>;
  return (
    <div className="account-switcher" ref={container}>
      <button type="button" className="account-trigger" onClick={() => setOpen((value) => !value)}>
        <span>{initials(active.displayName)}</span>
        <i>
          <strong>{active.displayName}</strong>
          <small>{active.tenantName}</small>
        </i>
        <b aria-hidden="true">⌄</b>
      </button>
      {open && (
        <div className="account-menu">
          <header>
            <strong>切换账号</strong>
            <small>凭证由系统加密存储</small>
          </header>
          <div className="account-list">
            {state.accounts.map((account) => (
              <button
                type="button"
                key={account.sessionId}
                className={account.sessionId === active.sessionId ? 'active' : ''}
                disabled={pending !== null}
                onClick={() => void switchTo(account)}
              >
                <span>{initials(account.displayName)}</span>
                <i>
                  <strong>{account.displayName}</strong>
                  <small>
                    {account.tenantName} · {account.email}
                  </small>
                </i>
                <b>
                  {pending === account.sessionId
                    ? '…'
                    : account.sessionId === active.sessionId
                      ? '✓'
                      : ''}
                </b>
              </button>
            ))}
          </div>
          {error && <p className="account-error">{error}</p>}
          <footer>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onChangePassword();
              }}
            >
              修改密码
            </button>
            <button type="button" onClick={onAddAccount}>
              ＋ 添加账号
            </button>
            <button type="button" onClick={() => void logout()} disabled={pending !== null}>
              退出当前账号
            </button>
          </footer>
        </div>
      )}
    </div>
  );
}

function initials(name: string): string {
  return [...name.trim()].slice(-2).join('').toUpperCase() || '?';
}
