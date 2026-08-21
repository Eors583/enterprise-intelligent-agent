import { describe, expect, it } from 'vitest';

import { LexiangCredentialVault } from './lexiang-credential-vault.js';

describe('LexiangCredentialVault', () => {
  it('encrypts a secret with tenant and app-key-bound authenticated data', () => {
    const vault = new LexiangCredentialVault(
      'primary',
      new Map([['primary', Buffer.alloc(32, 7)]]),
    );
    const context = {
      tenantId: '00000000-0000-7000-8000-000000000001',
      appKey: 'lexiang-app',
    };

    const encrypted = vault.encrypt('never-return-this-secret', context);

    expect(encrypted).not.toContain('never-return-this-secret');
    expect(vault.decrypt(encrypted, context)).toBe('never-return-this-secret');
    expect(() => vault.decrypt(encrypted, { ...context, appKey: 'another-app' })).toThrow();
  });
});
