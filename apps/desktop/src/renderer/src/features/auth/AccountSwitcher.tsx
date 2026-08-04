import { useEffect, useRef, useState } from 'react';
import { ArrowsLeftRight } from '@phosphor-icons/react/ArrowsLeftRight';
import { CaretUp } from '@phosphor-icons/react/CaretUp';
import { Check } from '@phosphor-icons/react/Check';
import { GearSix } from '@phosphor-icons/react/GearSix';
import { LockKey } from '@phosphor-icons/react/LockKey';
import { SignOut } from '@phosphor-icons/react/SignOut';
import { UserPlus } from '@phosphor-icons/react/UserPlus';
import type { AuthAccount } from '@enterprise/contracts';
import type { DesktopAuthState } from '../../../../shared/desktop-api';

export type AccountMenuDestination = 'workbench' | 'messages' | 'directory' | 'my';

interface AccountSwitcherProps {
  state: DesktopAuthState;
  openRequest?: number | undefined;
  onStateChange: (state: DesktopAuthState) => Promise<void> | void;
  onAddAccount: () => void;
  onChangePassword: () => void;
  onNavigate?: ((destination: AccountMenuDestination) => void) | undefined;
}

export function AccountSwitcher({
  state,
  openRequest = 0,
  onStateChange,
  onAddAccount,
  onChangePassword,
  onNavigate = () => undefined,
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

  useEffect(() => {
    if (openRequest > 0) setOpen(true);
  }, [openRequest]);

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

  const navigate = (destination: AccountMenuDestination): void => {
    setOpen(false);
    onNavigate(destination);
  };

  if (!active) return <></>;
  return (
    <div className="account-switcher" ref={container}>
      <button
        type="button"
        className="account-trigger"
        aria-label="账号菜单"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span>{initials(active.displayName)}</span>
        <i>
          <strong>{active.displayName}</strong>
          <small>
            {active.tenantName} · {active.role === 'ADMIN' ? '管理员' : '成员'}
          </small>
        </i>
        <CaretUp size={15} weight="bold" aria-hidden="true" />
      </button>
      {open && (
        <div className="account-menu" role="menu" aria-label="账号与设置">
          <header>
            <span>{initials(active.displayName)}</span>
            <div>
              <strong>{active.displayName}</strong>
              <small>{active.email}</small>
            </div>
          </header>
          <div className="account-menu-actions">
            <button type="button" role="menuitem" onClick={() => navigate('my')}>
              <GearSix size={18} aria-hidden="true" />
              <span>设置</span>
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onChangePassword();
              }}
            >
              <LockKey size={18} aria-hidden="true" />
              <span>账号与安全</span>
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onAddAccount();
              }}
            >
              <UserPlus size={18} aria-hidden="true" />
              <span>添加账号</span>
            </button>
          </div>
          <div className="account-menu-section-label">
            <ArrowsLeftRight size={15} aria-hidden="true" />
            <span>切换账号</span>
          </div>
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
                  {pending === account.sessionId ? (
                    '…'
                  ) : account.sessionId === active.sessionId ? (
                    <Check size={16} weight="bold" aria-label="当前账号" />
                  ) : (
                    ''
                  )}
                </b>
              </button>
            ))}
          </div>
          {error && <p className="account-error">{error}</p>}
          <footer>
            <button
              type="button"
              role="menuitem"
              onClick={() => void logout()}
              disabled={pending !== null}
            >
              <SignOut size={18} aria-hidden="true" />
              <span>退出登录</span>
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
