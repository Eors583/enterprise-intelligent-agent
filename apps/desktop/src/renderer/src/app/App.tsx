import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { DesktopAuthState } from '../../../shared/desktop-api';
import { AuthScreen } from '../features/auth/AuthScreen';
import { AccountSwitcher } from '../features/auth/AccountSwitcher';
import { PasswordChangeScreen } from '../features/auth/PasswordChangeScreen';
import { BootstrapError, fetchBootstrap } from '../features/directory/bootstrap';
import { DirectoryWorkspace } from '../features/directory/DirectoryWorkspace';
import { setExpectedDesktopSessionId } from '../shared/api/client';

export function App(): React.JSX.Element {
  const queryClient = useQueryClient();
  const [authState, setAuthState] = useState<DesktopAuthState | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [showAddAccount, setShowAddAccount] = useState(false);
  const [showPasswordChange, setShowPasswordChange] = useState(false);

  const acceptAuthState = useCallback(
    async (next: DesktopAuthState): Promise<void> => {
      setExpectedDesktopSessionId(next.activeSessionId);
      await queryClient.cancelQueries();
      queryClient.clear();
      setAuthState(next);
      setShowAddAccount(false);
      setShowPasswordChange(false);
    },
    [queryClient],
  );

  useEffect(() => {
    const unsubscribe = window.enterpriseDesktop.onAuthStateChanged((next) => {
      void acceptAuthState(next);
    });
    void window.enterpriseDesktop
      .getAuthState()
      .then(acceptAuthState)
      .catch((error: unknown) => setAuthError(readableError(error)));
    return () => {
      unsubscribe();
      setExpectedDesktopSessionId(null);
    };
  }, [acceptAuthState]);

  const activeAccount = useMemo(
    () => authState?.accounts.find((item) => item.sessionId === authState.activeSessionId) ?? null,
    [authState],
  );

  const bootstrap = useQuery({
    queryKey: ['desktop-bootstrap', authState?.activeSessionId],
    queryFn: ({ signal }) => fetchBootstrap(signal),
    enabled: activeAccount !== null && !activeAccount.passwordChangeRequired,
    staleTime: 60_000,
  });

  if (authError) {
    return (
      <FailureScreen
        error={new BootstrapError('configuration', authError)}
        isRetrying={false}
        onRetry={() => window.location.reload()}
      />
    );
  }
  if (!authState) return <LoadingScreen copy="正在读取本机账号保险箱…" />;
  if (!activeAccount) {
    return <AuthScreen authState={authState} onAuthenticated={acceptAuthState} />;
  }
  if (activeAccount.passwordChangeRequired) {
    return <PasswordChangeScreen account={activeAccount} forced onChanged={acceptAuthState} />;
  }
  if (bootstrap.isPending) return <LoadingScreen copy={`正在进入 ${activeAccount.tenantName}…`} />;

  if (bootstrap.isError) {
    const error =
      bootstrap.error instanceof BootstrapError
        ? bootstrap.error
        : new BootstrapError('network', '桌面端初始化失败，请重试。', {
            cause: bootstrap.error,
          });

    return (
      <>
        <AccountSwitcher
          state={authState}
          onStateChange={acceptAuthState}
          onAddAccount={() => setShowAddAccount(true)}
          onChangePassword={() => setShowPasswordChange(true)}
        />
        <FailureScreen
          error={error}
          isRetrying={bootstrap.isFetching}
          onRetry={() => void bootstrap.refetch()}
        />
        {showAddAccount && (
          <AuthScreen
            authState={authState}
            modal
            onCancel={() => setShowAddAccount(false)}
            onAuthenticated={acceptAuthState}
          />
        )}
        {showPasswordChange && (
          <PasswordChangeScreen
            account={activeAccount}
            onCancel={() => setShowPasswordChange(false)}
            onChanged={acceptAuthState}
          />
        )}
      </>
    );
  }

  return (
    <>
      <DirectoryWorkspace payload={bootstrap.data} />
      <AccountSwitcher
        state={authState}
        onStateChange={acceptAuthState}
        onAddAccount={() => setShowAddAccount(true)}
        onChangePassword={() => setShowPasswordChange(true)}
      />
      {showAddAccount && (
        <AuthScreen
          authState={authState}
          modal
          onCancel={() => setShowAddAccount(false)}
          onAuthenticated={acceptAuthState}
        />
      )}
      {showPasswordChange && (
        <PasswordChangeScreen
          account={activeAccount}
          onCancel={() => setShowPasswordChange(false)}
          onChanged={acceptAuthState}
        />
      )}
    </>
  );
}

function LoadingScreen({ copy }: { copy: string }): React.JSX.Element {
  return (
    <main className="state-screen" aria-busy="true" aria-live="polite">
      <div className="state-card loading-card">
        <BrandMark />
        <div className="loading-copy">
          <strong>{copy}</strong>
          <span>账号凭证只保存在桌面主进程的系统加密存储中。</span>
        </div>
        <div className="loading-bar" aria-hidden="true">
          <span />
        </div>
      </div>
    </main>
  );
}

interface FailureScreenProps {
  error: BootstrapError;
  isRetrying: boolean;
  onRetry: () => void;
}

function FailureScreen({ error, isRetrying, onRetry }: FailureScreenProps): React.JSX.Element {
  const headingByKind: Record<BootstrapError['kind'], string> = {
    'stale-account': '账号已切换，请重试',
    configuration: '桌面端尚未完成配置',
    network: '暂时无法连接企业服务',
    http: error.status === 401 ? '账号登录状态已失效' : '企业服务请求失败',
    contract: '客户端与服务端版本不兼容',
  };

  return (
    <main className="state-screen" role="alert">
      <section className="state-card error-card">
        <BrandMark />
        <div className="error-icon" aria-hidden="true">
          !
        </div>
        <div>
          <p className="eyebrow">连接未完成</p>
          <h1>{headingByKind[error.kind]}</h1>
          <p className="error-message">{error.message}</p>
        </div>
        <dl className="error-details">
          {error.status !== undefined && (
            <div>
              <dt>HTTP 状态</dt>
              <dd>{error.status}</dd>
            </div>
          )}
          {error.requestId && (
            <div>
              <dt>请求 ID</dt>
              <dd>{error.requestId}</dd>
            </div>
          )}
        </dl>
        <button className="primary-button retry-button" onClick={onRetry} disabled={isRetrying}>
          {isRetrying ? '正在重试…' : '重新连接'}
        </button>
      </section>
    </main>
  );
}

function BrandMark(): React.JSX.Element {
  return (
    <div className="brand-mark" aria-label="企业 AI 协同">
      <span>E</span>
      <i />
    </div>
  );
}

function readableError(error: unknown): string {
  return error instanceof Error ? error.message : '桌面认证模块初始化失败。';
}
