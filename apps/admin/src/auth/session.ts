import {
  authSessionResponseSchema,
  browserAuthSessionResponseSchema,
  canAccessAdminConsole,
  type BrowserAuthSessionResponse,
} from '@enterprise/contracts';

export type AdminBrowserSession = BrowserAuthSessionResponse;

type Listener = (session: AdminBrowserSession | null) => void;
const listeners = new Set<Listener>();
let currentSession: AdminBrowserSession | null = null;

/**
 * Compatibility parser used only to discard legacy token-bearing storage.
 * Browser credentials are never written back to Web Storage.
 */
export function parseStoredSession(raw: string): AdminBrowserSession | null {
  try {
    const value: unknown = JSON.parse(raw);
    const candidate =
      value &&
      typeof value === 'object' &&
      Reflect.get(value, 'account') &&
      typeof Reflect.get(value, 'account') === 'object' &&
      !Reflect.has(Reflect.get(value, 'account') as object, 'passwordChangeRequired')
        ? {
            ...value,
            account: {
              ...(Reflect.get(value, 'account') as object),
              passwordChangeRequired: false,
            },
          }
        : value;
    const browser = browserAuthSessionResponseSchema.safeParse(candidate);
    if (browser.success) return browser.data;
    const legacy = authSessionResponseSchema.safeParse(candidate);
    return legacy.success ? { account: legacy.data.account } : null;
  } catch {
    return null;
  }
}

export function readSession(): AdminBrowserSession | null {
  return currentSession;
}

export function writeSession(session: AdminBrowserSession | null): void {
  currentSession = session;
  listeners.forEach((listener) => listener(session));
}

export function subscribeSession(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function isSessionRoleAllowed(session: AdminBrowserSession): boolean {
  return canAccessAdminConsole(session.account.role);
}
