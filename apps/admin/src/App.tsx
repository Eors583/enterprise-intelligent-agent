import { useEffect, useState, type ReactNode } from 'react';

import { currentBrowserSession } from '@/api/admin-api';
import { AdminShell } from '@/app/AdminShell';
import { isSessionRoleAllowed, readSession, subscribeSession, writeSession } from '@/auth/session';
import { AuthScreen } from '@/features/auth/AuthScreen';
import {
  parseRecoveryRoute,
  RecoveryScreen,
  type RecoveryRoute,
} from '@/features/auth/RecoveryScreen';

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
      <RecoveryScreen
        key={
          recoveryRoute.kind === 'forgot-password'
            ? recoveryRoute.kind
            : `${recoveryRoute.kind}:${recoveryRoute.token}`
        }
        route={recoveryRoute}
        onReturnToLogin={() => {
          writeSession(null);
          window.history.replaceState(null, '', window.location.pathname + window.location.search);
          setRecoveryRoute(null);
        }}
      />
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

  if (!session || !isSessionRoleAllowed(session)) return <AuthScreen />;
  return <AdminShell session={session} />;
}
