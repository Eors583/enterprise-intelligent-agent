import { createCipheriv, createHash, randomBytes } from 'node:crypto';

import type { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';

import type { EnvironmentVariables } from '../../../config/environment.js';
import { FeishuCredentialVault } from './feishu-credential-vault.js';

const TENANT_ID = '00000000-0000-7000-8000-000000000001';
const APP_ID = 'cli_enterprise_test';
const CONTEXT = { tenantId: TENANT_ID, appId: APP_ID } as const;
const PEPPER = 'unit-test-authentication-pepper-that-is-not-a-connector-key';
const KEY_1 = Buffer.alloc(32, 0x11).toString('base64url');
const KEY_2 = Buffer.alloc(32, 0x22).toString('base64url');

describe('FeishuCredentialVault', () => {
  it('writes a context-bound v2 envelope without exposing plaintext', () => {
    const vault = createVault({
      CONNECTOR_CREDENTIAL_KEYRING: { primary: KEY_1 },
      CONNECTOR_CREDENTIAL_ACTIVE_KEY_ID: 'primary',
    });

    const envelope = vault.encrypt('feishu-app-secret', CONTEXT);

    expect(envelope).toMatch(/^v2\.primary\./);
    expect(envelope).not.toContain('feishu-app-secret');
    expect(vault.decrypt(envelope, CONTEXT)).toBe('feishu-app-secret');
    expect(() =>
      vault.decrypt(envelope, { ...CONTEXT, tenantId: '00000000-0000-7000-8000-000000000002' }),
    ).toThrow();
    expect(() => vault.decrypt(envelope, { ...CONTEXT, appId: 'cli_other_app' })).toThrow();
  });

  it('keeps retired keys readable while new writes use the active key', () => {
    const oldVault = createVault({
      CONNECTOR_CREDENTIAL_KEYRING: { old: KEY_1 },
      CONNECTOR_CREDENTIAL_ACTIVE_KEY_ID: 'old',
    });
    const oldEnvelope = oldVault.encrypt('old-secret', CONTEXT);
    const rotatedVault = createVault({
      CONNECTOR_CREDENTIAL_KEYRING: { old: KEY_1, current: KEY_2 },
      CONNECTOR_CREDENTIAL_ACTIVE_KEY_ID: 'current',
    });

    expect(rotatedVault.decrypt(oldEnvelope, CONTEXT)).toBe('old-secret');
    expect(rotatedVault.encrypt('new-secret', CONTEXT)).toMatch(/^v2\.current\./);
  });

  it('reads legacy v1 envelopes during a controlled key migration', () => {
    const vault = createVault({
      CONNECTOR_CREDENTIAL_KEYRING: { primary: KEY_1 },
      CONNECTOR_CREDENTIAL_ACTIVE_KEY_ID: 'primary',
    });

    expect(vault.decrypt(createLegacyEnvelope('legacy-secret'), CONTEXT)).toBe('legacy-secret');
  });

  it('fails closed when an envelope references an unavailable key', () => {
    const writer = createVault({
      CONNECTOR_CREDENTIAL_KEYRING: { retired: KEY_1 },
      CONNECTOR_CREDENTIAL_ACTIVE_KEY_ID: 'retired',
    });
    const reader = createVault({
      CONNECTOR_CREDENTIAL_KEYRING: { current: KEY_2 },
      CONNECTOR_CREDENTIAL_ACTIVE_KEY_ID: 'current',
    });

    expect(() => reader.decrypt(writer.encrypt('secret', CONTEXT), CONTEXT)).toThrow(
      'key is unavailable',
    );
  });
});

function createVault(
  values: Pick<
    EnvironmentVariables,
    'CONNECTOR_CREDENTIAL_KEYRING' | 'CONNECTOR_CREDENTIAL_ACTIVE_KEY_ID'
  >,
): FeishuCredentialVault {
  const environment = {
    AUTH_TOKEN_PEPPER: PEPPER,
    ...values,
  } as Pick<
    EnvironmentVariables,
    'AUTH_TOKEN_PEPPER' | 'CONNECTOR_CREDENTIAL_KEYRING' | 'CONNECTOR_CREDENTIAL_ACTIVE_KEY_ID'
  >;
  const config = {
    get(key: keyof typeof environment): (typeof environment)[keyof typeof environment] {
      return environment[key];
    },
  } as ConfigService<EnvironmentVariables, true>;
  return new FeishuCredentialVault(config);
}

function createLegacyEnvelope(secret: string): string {
  const key = createHash('sha256')
    .update('enterprise-agent:feishu-connector:v1\0')
    .update(PEPPER)
    .digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return ['v1', iv, cipher.getAuthTag(), ciphertext]
    .map((part) => (typeof part === 'string' ? part : part.toString('base64url')))
    .join('.');
}
