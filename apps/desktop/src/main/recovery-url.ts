const PASSWORD_RECOVERY_FRAGMENT = '#/forgot-password';

export function createPasswordRecoveryUrl(configuredOrigin: string, isPackaged: boolean): string {
  let parsed: URL;
  try {
    parsed = new URL(configuredOrigin);
  } catch {
    throw new Error('Password recovery is not configured for this desktop application.');
  }

  const localHost =
    parsed.hostname === 'localhost' ||
    parsed.hostname === '127.0.0.1' ||
    parsed.hostname === '[::1]';
  const secureProtocol = parsed.protocol === 'https:';
  const localDevelopmentProtocol = !isPackaged && parsed.protocol === 'http:' && localHost;

  if (
    (!secureProtocol && !localDevelopmentProtocol) ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    (parsed.pathname !== '' && parsed.pathname !== '/')
  ) {
    throw new Error(
      'Password recovery requires an HTTPS origin (local HTTP is allowed only when unpackaged).',
    );
  }

  return `${parsed.origin}/${PASSWORD_RECOVERY_FRAGMENT}`;
}
