import { authSessionResponseSchema, type AuthSessionResponse } from '@enterprise/contracts';

const SESSION_KEY = 'enterprise-admin.auth-session.v1';

type Listener = (session: AuthSessionResponse | null) => void;
const listeners = new Set<Listener>();

function browserStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function parseStoredSession(raw: string): AuthSessionResponse | null {
  try {
    const value: unknown = JSON.parse(raw);
    let candidate = value;

    if (value && typeof value === 'object') {
      const account = Reflect.get(value, 'account');
      if (
        account &&
        typeof account === 'object' &&
        !Reflect.has(account, 'passwordChangeRequired')
      ) {
        candidate = {
          ...value,
          account: { ...account, passwordChangeRequired: false },
        };
      }
    }

    const parsed = authSessionResponseSchema.safeParse(candidate);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function readSession(): AuthSessionResponse | null {
  const storage = browserStorage();
  const raw = storage?.getItem(SESSION_KEY);
  if (!raw) return null;

  const session = parseStoredSession(raw);
  if (session) return session;
  storage?.removeItem(SESSION_KEY);
  return null;
}

export function writeSession(session: AuthSessionResponse | null): void {
  const storage = browserStorage();
  if (session) storage?.setItem(SESSION_KEY, JSON.stringify(session));
  else storage?.removeItem(SESSION_KEY);
  listeners.forEach((listener) => listener(session));
}

export function subscribeSession(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function isSessionRoleAllowed(session: AuthSessionResponse): boolean {
  return ['OWNER', 'ADMIN', 'KNOWLEDGE_ADMIN'].includes(session.account.role);
}
