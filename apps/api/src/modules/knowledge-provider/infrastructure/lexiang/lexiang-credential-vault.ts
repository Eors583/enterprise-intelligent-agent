import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;

export interface LexiangCredentialContext {
  readonly tenantId: string;
  readonly appKey: string;
}

export class LexiangCredentialVault {
  constructor(
    private readonly activeKeyId: string,
    private readonly keys: ReadonlyMap<string, Buffer>,
  ) {
    const key = keys.get(activeKeyId);
    if (key?.length !== 32) throw new Error('Active connector credential key is unavailable.');
  }

  encrypt(secret: string, context: LexiangCredentialContext): string {
    const key = this.keys.get(this.activeKeyId)!;
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, key, iv);
    cipher.setAAD(contextAad(context));
    const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    return ['v1', this.activeKeyId, iv, cipher.getAuthTag(), ciphertext]
      .map((value) => (typeof value === 'string' ? value : value.toString('base64url')))
      .join('.');
  }

  decrypt(envelope: string, context: LexiangCredentialContext): string {
    const [version, keyId, ivValue, tagValue, ciphertextValue, ...rest] = envelope.split('.');
    const key = keyId === undefined ? undefined : this.keys.get(keyId);
    if (
      version !== 'v1' ||
      key === undefined ||
      key.length !== 32 ||
      !ivValue ||
      !tagValue ||
      !ciphertextValue ||
      rest.length > 0
    ) {
      throw new Error('Stored Lexiang credential is unavailable.');
    }
    const iv = Buffer.from(ivValue, 'base64url');
    const tag = Buffer.from(tagValue, 'base64url');
    const ciphertext = Buffer.from(ciphertextValue, 'base64url');
    if (iv.length !== IV_BYTES || tag.length !== 16 || ciphertext.length === 0) {
      throw new Error('Stored Lexiang credential is invalid.');
    }
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAAD(contextAad(context));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  }
}

function contextAad(context: LexiangCredentialContext): Buffer {
  return Buffer.from(
    `enterprise-agent:knowledge-provider-credential:v1\0${JSON.stringify({
      appKey: context.appKey,
      provider: 'LEXIANG',
      tenantId: context.tenantId,
    })}`,
  );
}
