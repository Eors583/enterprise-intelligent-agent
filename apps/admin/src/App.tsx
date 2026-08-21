import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';

import { currentBrowserSession } from '@/api/session-api';
import { AdminShell } from '@/app/AdminShell';
import { isSessionRoleAllowed, readSession, subscribeSession, writeSession } from '@/auth/session';
import { parseRecoveryRoute, type RecoveryRoute } from '@/features/auth/recovery-route';

const AuthScreen = lazy(() =>
  import('@/features/auth/AuthScreen').then((module) => ({ default: module.AuthScreen })),
);
const RecoveryScreen = lazy(() =>
  import('@/features/auth/RecoveryScreen').then((module) => ({ default: module.RecoveryScreen })),
);

export function App(): ReactNode {
  const [session, setSession] = useState(readSession);
  const [sessionHydrated, setSessionHydrated] = useState(false);
  const [recoveryRoute, setRecoveryRoute] = useState<RecoveryRoute | null>(() =>
    typeof window === 'undefined' ? null : parseRecoveryRoute(window.location.hash),
  );

  useEffect(() => {
    const unsubscribe = subscribeSession(setSession);
    const onHashChange = (): void => setRecoveryRoute(parseRecoveryRoute(window.location.hash));
    window.addEventListener('hashchange', onHashChange);
    return () => {
      unsubscribe();
      window.removeEventListener('hashchange', onHashChange);
    };
  }, []);

  useEffect(() => {
    let active = true;
    const sessionAtStart = readSession();
    void currentBrowserSession()
      .then((restored) => {
        if (active && readSession() === sessionAtStart) writeSession(restored);
      })
      .catch(() => {
        if (active && readSession() === sessionAtStart) writeSession(null);
      })
      .finally(() => {
        if (active) setSessionHydrated(true);
      });
    return () => {
      active = false;
    };
  }, []);

  // One-time recovery routes must win over an existing admin session. This
  // lets an already-signed-in administrator consume their own reset link and
  // prevents AdminShell from interpreting the sensitive fragment as a page id.
  if (recoveryRoute) {
    return (
      <Suspense fallback={<SessionLoading label="正在打开账号恢复页面" />}>
        <RecoveryScreen
          key={
            recoveryRoute.kind === 'forgot-password'
              ? recoveryRoute.kind
              : `${recoveryRoute.kind}:${recoveryRoute.token}`
          }
          route={recoveryRoute}
          onReturnToLogin={() => {
            writeSession(null);
            window.history.replaceState(
              null,
              '',
              window.location.pathname + window.location.search,
            );
            setRecoveryRoute(null);
          }}
        />
      </Suspense>
    );
  }

  if (!sessionHydrated && session === null) {
    return (
      <main className="auth-page" aria-busy="true" aria-label="正在恢复管理会话">
        <section className="auth-panel">
          <div className="auth-card">正在安全恢复管理会话…</div>
        </section>
      </main>
    );
  }

  if (!session || !isSessionRoleAllowed(session)) {
    return (
      <Suspense fallback={<SessionLoading label="正在打开登录页面" />}>
        <AuthScreen />
      </Suspense>
    );
  }
  return <AdminShell session={session} />;
}

function SessionLoading({ label }: { label: string }): ReactNode {
  return (
    <main className="auth-page" aria-busy="true" aria-label={label}>
      <section className="auth-panel">
        <div className="auth-card">{label}…</div>
      </section>
    </main>
  );
}
