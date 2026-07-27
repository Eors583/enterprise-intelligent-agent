import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { EnvironmentVariables } from '../../../config/environment.js';

const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;

@Injectable()
export class FeishuCredentialVault {
  private readonly key: Buffer;

  constructor(@Inject(ConfigService) config: ConfigService<EnvironmentVariables, true>) {
    const pepper = config.get('AUTH_TOKEN_PEPPER', { infer: true });
    this.key = createHash('sha256')
      .update('enterprise-agent:feishu-connector:v1\0')
      .update(pepper)
      .digest();
  }

  encrypt(secret: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [VERSION, iv, tag, ciphertext]
      .map((part) => (typeof part === 'string' ? part : part.toString('base64url')))
      .join('.');
  }

  decrypt(envelope: string): string {
    const [version, ivValue, tagValue, ciphertextValue, ...rest] = envelope.split('.');
    if (version !== VERSION || !ivValue || !tagValue || !ciphertextValue || rest.length > 0) {
      throw new Error('Stored Feishu credential has an invalid format.');
    }
    const iv = Buffer.from(ivValue, 'base64url');
    const tag = Buffer.from(tagValue, 'base64url');
    const ciphertext = Buffer.from(ciphertextValue, 'base64url');
    if (iv.length !== IV_BYTES || tag.length !== 16 || ciphertext.length === 0) {
      throw new Error('Stored Feishu credential has an invalid payload.');
    }
    const decipher = createDecipheriv(ALGORITHM, this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  }
}
