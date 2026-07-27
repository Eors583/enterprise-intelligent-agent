import { useEffect, useState, type ReactNode } from 'react';

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

  if (!session || !isSessionRoleAllowed(session)) return <AuthScreen />;
  return <AdminShell session={session} />;
}
