import { ConfigService } from '@nestjs/config';

import type { EnvironmentVariables } from '../../config/environment.js';
import { IdentitySecretVault } from './identity-secret-vault.js';

const CONTEXT = {
  tenantId: '00000000-0000-7000-8000-000000000001',
  resourceId: '00000000-0000-7000-8000-000000000101',
  purpose: 'MFA_TOTP_SEED' as const,
};
const OLD_KEY = Buffer.alloc(32, 3).toString('base64url');
const NEW_KEY = Buffer.alloc(32, 7).toString('base64url');

describe('IdentitySecretVault', () => {
  it('binds ciphertext to the tenant, resource, and purpose without leaking plaintext', () => {
    const vault = createVault('old', { old: OLD_KEY });
    const encrypted = vault.encrypt('JBSWY3DPEHPK3PXP', CONTEXT);
    expect(encrypted.ciphertext.toString('utf8')).not.toContain('JBSWY3DPEHPK3PXP');
    expect(vault.decrypt(encrypted.ciphertext, CONTEXT)).toBe('JBSWY3DPEHPK3PXP');
    expect(() =>
      vault.decrypt(encrypted.ciphertext, {
        ...CONTEXT,
        tenantId: '00000000-0000-7000-8000-000000000002',
      }),
    ).toThrow('could not be authenticated');
  });

  it('decrypts old envelopes after active-key rotation and writes only the new key id', () => {
    const oldVault = createVault('old', { old: OLD_KEY });
    const oldEnvelope = oldVault.encrypt('provider-secret', {
      ...CONTEXT,
      purpose: 'OIDC_CLIENT_SECRET',
    });
    const rotated = createVault('new', { old: OLD_KEY, new: NEW_KEY });
    expect(
      rotated.decrypt(oldEnvelope.ciphertext, {
        ...CONTEXT,
        purpose: 'OIDC_CLIENT_SECRET',
      }),
    ).toBe('provider-secret');
    expect(
      rotated.encrypt('rotated-secret', {
        ...CONTEXT,
        purpose: 'OIDC_CLIENT_SECRET',
      }).keyId,
    ).toBe('new');
  });
});

function createVault(
  active: string,
  keyring: Readonly<Record<string, string>>,
): IdentitySecretVault {
  return new IdentitySecretVault(
    new ConfigService<EnvironmentVariables, true>({
      NODE_ENV: 'test',
      AUTH_TOKEN_PEPPER: 'test-pepper',
      IDENTITY_SECRET_KEYRING: keyring,
      IDENTITY_SECRET_ACTIVE_KEY_ID: active,
    } as EnvironmentVariables),
  );
}
