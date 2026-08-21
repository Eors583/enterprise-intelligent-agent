import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { EnvironmentVariables } from '../../config/environment.js';

const ALGORITHM = 'aes-256-gcm';
const VERSION = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;

export type IdentitySecretPurpose =
  'AUTH_RECOVERY_DELIVERY' | 'MFA_TOTP_SEED' | 'OIDC_CLIENT_SECRET' | 'OIDC_PKCE_VERIFIER';

export interface IdentitySecretContext {
  readonly tenantId: string;
  readonly resourceId: string;
  readonly purpose: IdentitySecretPurpose;
}

export interface EncryptedIdentitySecret {
  readonly ciphertext: Buffer;
  readonly keyId: string;
  readonly formatVersion: 1;
}

@Injectable()
export class IdentitySecretVault {
  private readonly activeKeyId: string;
  private readonly activeKey: Buffer;
  private readonly keyring = new Map<string, Buffer>();

  constructor(@Inject(ConfigService) config: ConfigService<EnvironmentVariables, true>) {
    const configured = config.get('IDENTITY_SECRET_KEYRING', { infer: true });
    for (const [keyId, encodedKey] of Object.entries(configured)) {
      this.keyring.set(keyId, Buffer.from(encodedKey, 'base64url'));
    }
    const configuredActiveKeyId = config.get('IDENTITY_SECRET_ACTIVE_KEY_ID', {
      infer: true,
    });
    if (configuredActiveKeyId === undefined) {
      // Production validation rejects this branch. It exists solely so local
      // and unit-test environments do not need a checked-in encryption key.
      this.activeKeyId = 'development-v1';
      this.activeKey = createHash('sha256')
        .update('enterprise-agent:identity-secret:development:v1\0')
        .update(config.get('AUTH_TOKEN_PEPPER', { infer: true }))
        .digest();
      this.keyring.set(this.activeKeyId, this.activeKey);
      return;
    }
    const activeKey = this.keyring.get(configuredActiveKeyId);
    if (activeKey === undefined) {
      throw new Error('Active identity secret key is unavailable.');
    }
    this.activeKeyId = configuredActiveKeyId;
    this.activeKey = activeKey;
  }

  encrypt(secret: string, context: IdentitySecretContext): EncryptedIdentitySecret {
    if (!secret) throw new TypeError('Identity secret must not be empty.');
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.activeKey, iv);
    cipher.setAAD(contextAad(context));
    const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    const envelope = [
      VERSION,
      this.activeKeyId,
      iv.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
      encrypted.toString('base64url'),
    ].join('.');
    return {
      ciphertext: Buffer.from(envelope, 'utf8'),
      keyId: this.activeKeyId,
      formatVersion: 1,
    };
  }

  decrypt(ciphertext: Uint8Array, context: IdentitySecretContext): string {
    const [version, keyId, ivValue, tagValue, encryptedValue, ...rest] = Buffer.from(ciphertext)
      .toString('utf8')
      .split('.');
    if (
      version !== VERSION ||
      !keyId ||
      !ivValue ||
      !tagValue ||
      !encryptedValue ||
      rest.length > 0
    ) {
      throw new Error('Stored identity secret has an invalid format.');
    }
    const key = this.keyring.get(keyId);
    if (key === undefined) throw new Error('Stored identity secret key is unavailable.');
    const iv = Buffer.from(ivValue, 'base64url');
    const tag = Buffer.from(tagValue, 'base64url');
    const encrypted = Buffer.from(encryptedValue, 'base64url');
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES || encrypted.length === 0) {
      throw new Error('Stored identity secret has an invalid payload.');
    }
    try {
      const decipher = createDecipheriv(ALGORITHM, key, iv);
      decipher.setAAD(contextAad(context));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
    } catch {
      throw new Error('Stored identity secret could not be authenticated.');
    }
  }
}

function contextAad(context: IdentitySecretContext): Buffer {
  return Buffer.from(
    `enterprise-agent:identity-secret:v1\0${JSON.stringify({
      purpose: context.purpose,
      resourceId: context.resourceId,
      tenantId: context.tenantId,
    })}`,
    'utf8',
  );
}
