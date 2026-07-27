import { createHmac } from 'node:crypto';
import { deflateSync } from 'node:zlib';

const USER_SIG_VERSION = '2.0';

export interface TencentUserSigInput {
  readonly sdkAppId: number;
  readonly userId: string;
  readonly secretKey: string;
  readonly expiresInSeconds: number;
  readonly issuedAtSeconds: number;
}

/**
 * Tencent's TLS 2.0 UserSig implementation. This intentionally uses only
 * Node built-ins so the application does not need to ship a second copy of
 * the vendor's signing helper.
 */
export function generateTencentUserSig(input: TencentUserSigInput): string {
  validateSigningInput(input);

  const document = {
    'TLS.ver': USER_SIG_VERSION,
    'TLS.identifier': input.userId,
    'TLS.sdkappid': input.sdkAppId,
    'TLS.time': input.issuedAtSeconds,
    'TLS.expire': input.expiresInSeconds,
    'TLS.sig': createSignature(input),
  };

  return toTencentBase64(deflateSync(Buffer.from(JSON.stringify(document), 'utf8')));
}

export interface TencentUserSigCacheOptions {
  readonly sdkAppId: number;
  readonly userId: string;
  readonly secretKey: string;
  readonly expiresInSeconds: number;
  /** Returns Unix time in milliseconds. */
  readonly now?: () => number;
}

/** Caches a server-side administrator UserSig and refreshes it before expiry. */
export class TencentUserSigCache {
  private readonly now: () => number;
  private cached:
    | {
        readonly value: string;
        readonly refreshAtSeconds: number;
      }
    | undefined;

  constructor(private readonly options: TencentUserSigCacheOptions) {
    validateSigningInput({
      sdkAppId: options.sdkAppId,
      userId: options.userId,
      secretKey: options.secretKey,
      expiresInSeconds: options.expiresInSeconds,
      issuedAtSeconds: 0,
    });
    this.now = options.now ?? Date.now;
  }

  get(): string {
    const issuedAtSeconds = Math.floor(this.now() / 1_000);
    if (this.cached !== undefined && issuedAtSeconds < this.cached.refreshAtSeconds) {
      return this.cached.value;
    }

    const value = generateTencentUserSig({
      sdkAppId: this.options.sdkAppId,
      userId: this.options.userId,
      secretKey: this.options.secretKey,
      expiresInSeconds: this.options.expiresInSeconds,
      issuedAtSeconds,
    });
    const refreshLeadSeconds = Math.max(
      1,
      Math.min(3_600, Math.floor(this.options.expiresInSeconds / 10)),
    );
    this.cached = {
      value,
      refreshAtSeconds: issuedAtSeconds + this.options.expiresInSeconds - refreshLeadSeconds,
    };
    return value;
  }

  invalidate(): void {
    this.cached = undefined;
  }
}

function createSignature(input: TencentUserSigInput): string {
  const content =
    `TLS.identifier:${input.userId}\n` +
    `TLS.sdkappid:${input.sdkAppId}\n` +
    `TLS.time:${input.issuedAtSeconds}\n` +
    `TLS.expire:${input.expiresInSeconds}\n`;
  return createHmac('sha256', input.secretKey).update(content, 'utf8').digest('base64');
}

function toTencentBase64(value: Buffer): string {
  return value.toString('base64').replace(/\+/g, '*').replace(/\//g, '-').replace(/=/g, '_');
}

function validateSigningInput(input: TencentUserSigInput): void {
  if (!Number.isSafeInteger(input.sdkAppId) || input.sdkAppId <= 0) {
    throw new TypeError('Tencent IM SDKAppID must be a positive safe integer.');
  }
  if (!isTencentAccountId(input.userId)) {
    throw new TypeError('Tencent IM administrator UserID is invalid.');
  }
  if (input.secretKey.length === 0) {
    throw new TypeError('Tencent IM secret key is required.');
  }
  if (!Number.isSafeInteger(input.expiresInSeconds) || input.expiresInSeconds <= 0) {
    throw new TypeError('Tencent IM UserSig lifetime must be a positive integer.');
  }
  if (!Number.isSafeInteger(input.issuedAtSeconds) || input.issuedAtSeconds < 0) {
    throw new TypeError('Tencent IM UserSig issue time is invalid.');
  }
}

function isTencentAccountId(value: string): boolean {
  return (
    value.length > 0 && Buffer.byteLength(value, 'utf8') <= 32 && /^[A-Za-z0-9_-]+$/.test(value)
  );
}
