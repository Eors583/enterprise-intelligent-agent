import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { EnvironmentVariables } from '../../../config/environment.js';

const CURRENT_VERSION = 'v2';
const LEGACY_VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface FeishuCredentialContext {
  readonly tenantId: string;
  readonly appId: string;
}

@Injectable()
export class FeishuCredentialVault {
  private readonly activeKeyId: string;
  private readonly activeKey: Buffer;
  private readonly keyring = new Map<string, Buffer>();
  private readonly legacyKey: Buffer;

  constructor(@Inject(ConfigService) config: ConfigService<EnvironmentVariables, true>) {
    const pepper = config.get('AUTH_TOKEN_PEPPER', { infer: true });
    this.legacyKey = createHash('sha256')
      .update('enterprise-agent:feishu-connector:v1\0')
      .update(pepper)
      .digest();
    const configuredKeyring = config.get('CONNECTOR_CREDENTIAL_KEYRING', { infer: true });
    for (const [keyId, encodedKey] of Object.entries(configuredKeyring)) {
      this.keyring.set(keyId, Buffer.from(encodedKey, 'base64url'));
    }
    const configuredActiveKeyId = config.get('CONNECTOR_CREDENTIAL_ACTIVE_KEY_ID', {
      infer: true,
    });
    if (configuredActiveKeyId === undefined) {
      // Local/test compatibility only. Production validation requires a dedicated keyring.
      this.activeKeyId = 'development-v2';
      this.activeKey = createHash('sha256')
        .update('enterprise-agent:connector-credential:development:v2\0')
        .update(pepper)
        .digest();
      this.keyring.set(this.activeKeyId, this.activeKey);
    } else {
      const activeKey = this.keyring.get(configuredActiveKeyId);
      if (activeKey === undefined) {
        throw new Error('Active connector credential key is unavailable.');
      }
      this.activeKeyId = configuredActiveKeyId;
      this.activeKey = activeKey;
    }
  }

  encrypt(secret: string, context: FeishuCredentialContext): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.activeKey, iv);
    cipher.setAAD(contextAad(context));
    const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [CURRENT_VERSION, this.activeKeyId, iv, tag, ciphertext]
      .map((part) => (typeof part === 'string' ? part : part.toString('base64url')))
      .join('.');
  }

  decrypt(envelope: string, context: FeishuCredentialContext): string {
    const [version, ivValue, tagValue, ciphertextValue, ...rest] = envelope.split('.');
    if (version === LEGACY_VERSION) {
      return this.decryptPayload(
        this.legacyKey,
        ivValue,
        tagValue,
        ciphertextValue,
        rest,
        undefined,
      );
    }
    if (version !== CURRENT_VERSION) {
      throw new Error('Stored Feishu credential has an invalid format.');
    }
    const [keyId, v2Iv, v2Tag, v2Ciphertext, ...v2Rest] = [
      ivValue,
      tagValue,
      ciphertextValue,
      ...rest,
    ];
    if (!keyId) throw new Error('Stored Feishu credential has an invalid format.');
    const key = this.keyring.get(keyId);
    if (key === undefined) throw new Error('Stored Feishu credential key is unavailable.');
    return this.decryptPayload(key, v2Iv, v2Tag, v2Ciphertext, v2Rest, contextAad(context));
  }

  private decryptPayload(
    key: Buffer,
    ivValue: string | undefined,
    tagValue: string | undefined,
    ciphertextValue: string | undefined,
    rest: readonly string[],
    aad: Buffer | undefined,
  ): string {
    if (!ivValue || !tagValue || !ciphertextValue || rest.length > 0) {
      throw new Error('Stored Feishu credential has an invalid format.');
    }
    const iv = Buffer.from(ivValue, 'base64url');
    const tag = Buffer.from(tagValue, 'base64url');
    const ciphertext = Buffer.from(ciphertextValue, 'base64url');
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES || ciphertext.length === 0) {
      throw new Error('Stored Feishu credential has an invalid payload.');
    }
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    if (aad !== undefined) decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  }
}

function contextAad(context: FeishuCredentialContext): Buffer {
  return Buffer.from(
    `enterprise-agent:connector-credential:v2\0${JSON.stringify({
      appId: context.appId,
      provider: 'FEISHU',
      tenantId: context.tenantId,
    })}`,
    'utf8',
  );
}
