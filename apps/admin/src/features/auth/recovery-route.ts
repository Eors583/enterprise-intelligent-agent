export type RecoveryRoute =
  | { readonly kind: 'forgot-password' }
  | { readonly kind: 'reset-password'; readonly token: string }
  | { readonly kind: 'accept-invitation'; readonly token: string };

export function parseRecoveryRoute(hash: string): RecoveryRoute | null {
  const value = hash.startsWith('#') ? hash.slice(1) : hash;
  const [path, query = ''] = value.split('?', 2);
  if (path === '/forgot-password') return { kind: 'forgot-password' };
  if (path !== '/reset-password' && path !== '/accept-invitation') return null;
  const token = new URLSearchParams(query).get('token');
  if (!token) return null;
  return { kind: path === '/reset-password' ? 'reset-password' : 'accept-invitation', token };
}
