import { createHash } from 'node:crypto';

export interface TencentAccountSource {
  readonly type: 'user' | 'agent';
  readonly id: string;
}

export interface TencentMessageNumbers {
  readonly requestRandom: number;
  readonly msgSeq: number;
  readonly msgRandom: number;
}

/**
 * Maps an internal tenant-scoped identity to an opaque, stable Tencent UserID.
 * The result is exactly 32 ASCII bytes and uses only Tencent-supported chars.
 */
export function mapTencentAccountId(tenantId: string, account: TencentAccountSource): string {
  const prefix = account.type === 'user' ? 'u_' : 'a_';
  const digest = createHash('sha256')
    .update('enterprise-im/tencent/account/v1\0', 'utf8')
    .update(tenantId, 'utf8')
    .update('\0', 'utf8')
    .update(account.type, 'utf8')
    .update('\0', 'utf8')
    .update(account.id, 'utf8')
    .digest('base64url');
  return prefix + digest.slice(0, 30);
}

/** Stable per event and recipient so an outbox retry reuses Tencent's key. */
export function deriveTencentMessageNumbers(
  eventId: string,
  recipientAccountId: string,
): TencentMessageNumbers {
  const digest = createHash('sha256')
    .update('enterprise-im/tencent/message/v1\0', 'utf8')
    .update(eventId, 'utf8')
    .update('\0', 'utf8')
    .update(recipientAccountId, 'utf8')
    .digest();

  return {
    requestRandom: digest.readUInt32BE(0),
    msgSeq: digest.readUInt32BE(4),
    msgRandom: digest.readUInt32BE(8),
  };
}
