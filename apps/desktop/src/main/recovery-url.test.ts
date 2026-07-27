import { describe, expect, it } from 'vitest';
import { createPasswordRecoveryUrl } from './recovery-url';

describe('createPasswordRecoveryUrl', () => {
  it('opens only the fixed password recovery fragment on an HTTPS origin', () => {
    expect(createPasswordRecoveryUrl('https://accounts.example.com', true)).toBe(
      'https://accounts.example.com/#/forgot-password',
    );
  });

  it.each(['http://127.0.0.1:4173', 'http://localhost:4173', 'http://[::1]:4173'])(
    'allows a local development origin: %s',
    (origin) => {
      expect(createPasswordRecoveryUrl(origin, false)).toBe(`${origin}/#/forgot-password`);
    },
  );

  it.each(['http://127.0.0.1:4173', 'http://localhost:4173', 'http://[::1]:4173'])(
    'rejects a local HTTP origin when packaged: %s',
    (origin) => {
      expect(() => createPasswordRecoveryUrl(origin, true)).toThrow('requires an HTTPS origin');
    },
  );

  it.each([
    '',
    'javascript:alert(1)',
    'http://accounts.example.com',
    'https://user:password@accounts.example.com',
    'https://accounts.example.com/recovery',
    'https://accounts.example.com?token=secret',
    'https://accounts.example.com/#/reset-password?token=secret',
  ])('rejects an unsafe or non-origin configuration: %s', (configuredOrigin) => {
    expect(() => createPasswordRecoveryUrl(configuredOrigin, false)).toThrow();
  });

  it('never puts a token or query string in the generated URL', () => {
    const result = new URL(createPasswordRecoveryUrl('https://accounts.example.com', true));

    expect(result.search).toBe('');
    expect(result.hash).toBe('#/forgot-password');
  });
});
