import { createHash } from 'node:crypto';

export interface WuKongAccountSource {
  readonly type: 'user' | 'agent';
  readonly id: string;
}

/**
 * Produces a stable, tenant-scoped identifier without disclosing internal UUIDs.
 * The output uses only WuKongIM-safe ASCII characters and stays below its
 * cross-SDK 64-byte interoperability ceiling.
 */
export function mapWuKongAccountId(tenantId: string, account: WuKongAccountSource): string {
  const prefix = account.type === 'user' ? 'u_' : 'a_';
  const digest = createHash('sha256')
    .update('enterprise-im/wukong/account/v1\0', 'utf8')
    .update(tenantId, 'utf8')
    .update('\0', 'utf8')
    .update(account.type, 'utf8')
    .update('\0', 'utf8')
    .update(account.id, 'utf8')
    .digest('base64url');
  return prefix + digest;
}

/** Stable per event and recipient so every Outbox retry reuses the same key. */
export function mapWuKongClientMessageNumber(eventId: string, recipientUid: string): string {
  const digest = createHash('sha256')
    .update('enterprise-im/wukong/message/v1\0', 'utf8')
    .update(eventId, 'utf8')
    .update('\0', 'utf8')
    .update(recipientUid, 'utf8')
    .digest('base64url');
  return `m_${digest}`;
}

/** Stable tenant-scoped group channel identifier. */
export function mapWuKongGroupChannelId(tenantId: string, conversationId: string): string {
  const digest = createHash('sha256')
    .update('enterprise-im/wukong/group/v1\0', 'utf8')
    .update(tenantId, 'utf8')
    .update('\0', 'utf8')
    .update(conversationId, 'utf8')
    .digest('base64url');
  return `g_${digest}`;
}
