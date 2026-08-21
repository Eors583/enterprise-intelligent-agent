import { describe, expect, it, vi } from 'vitest';

import { ImDeliveryError, type MessageCreatedDelivery } from '../../domain/im-delivery.provider.js';
import {
  mapWuKongAccountId,
  mapWuKongClientMessageNumber,
  mapWuKongGroupChannelId,
} from './wukong-identifiers.js';
import { WuKongImDeliveryProvider, type WuKongFetch } from './wukong-im-delivery.provider.js';

describe('WuKongImDeliveryProvider', () => {
  it('delivers a tenant-scoped personal message with a stable idempotency key', async () => {
    const fetchImpl = vi.fn<WuKongFetch>(async () =>
      Response.json({ message_id: 123, message_seq: 7, reason: 1 }),
    );
    const provider = createProvider(fetchImpl);

    await expect(provider.deliver(messageEvent(), deliveryContext())).resolves.toEqual({
      outcome: 'accepted',
      deliveredRecipientCount: 1,
      providerMessageId: '123',
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe('http://127.0.0.1:5501/message/send');
    expect(init?.headers).toMatchObject({ token: 'internal-api-token-value' });
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const recipientUid = mapWuKongAccountId(messageEvent().tenantId, {
      type: 'user',
      id: '00000000-0000-7000-8000-000000000202',
    });
    expect(body).toMatchObject({
      from_uid: mapWuKongAccountId(messageEvent().tenantId, messageEvent().sender),
      channel_id: recipientUid,
      channel_type: 1,
      client_msg_no: mapWuKongClientMessageNumber(messageEvent().eventId, recipientUid),
    });
    const payload = JSON.parse(Buffer.from(String(body.payload), 'base64').toString('utf8'));
    expect(payload).toEqual({
      type: 1,
      content: 'hello',
      enterprise: {
        version: 1,
        eventId: messageEvent().eventId,
        messageId: messageEvent().messageId,
        conversationId: messageEvent().conversationId,
      },
    });
  });

  it('deduplicates human recipients and ignores agent-only recipients', async () => {
    const fetchImpl = vi.fn<WuKongFetch>(async () =>
      Response.json({ message_idstr: '9223372036854775807', message_seq: 8, reason: 1 }),
    );
    const event = messageEvent({
      recipients: [
        { type: 'user', id: '00000000-0000-7000-8000-000000000202' },
        { type: 'user', id: '00000000-0000-7000-8000-000000000202' },
        { type: 'agent', id: '00000000-0000-7000-8000-000000000303' },
      ],
    });
    await expect(createProvider(fetchImpl).deliver(event, deliveryContext())).resolves.toEqual({
      outcome: 'accepted',
      deliveredRecipientCount: 1,
      providerMessageId: '9223372036854775807',
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('upserts one native group channel and sends one message for all group recipients', async () => {
    const fetchImpl = vi.fn<WuKongFetch>(async (input) =>
      String(input).endsWith('/channel')
        ? Response.json({ status: 200 })
        : Response.json({ message_idstr: '2084470779122028544', message_seq: 10, reason: 1 }),
    );
    const event = messageEvent({
      conversationType: 'group',
      recipients: [
        { type: 'user', id: '00000000-0000-7000-8000-000000000202' },
        { type: 'user', id: '00000000-0000-7000-8000-000000000203' },
      ],
    });
    await expect(createProvider(fetchImpl).deliver(event, deliveryContext())).resolves.toEqual({
      outcome: 'accepted',
      deliveredRecipientCount: 2,
      providerMessageId: '2084470779122028544',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const channelId = mapWuKongGroupChannelId(event.tenantId, event.conversationId);
    const channelBody = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as {
      subscribers: string[];
    };
    expect(channelBody).toMatchObject({ channel_id: channelId, channel_type: 2, reset: 1 });
    expect(channelBody.subscribers).toHaveLength(3);
    const sendBody = JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body));
    expect(sendBody).toMatchObject({
      channel_id: channelId,
      channel_type: 2,
      client_msg_no: mapWuKongClientMessageNumber(event.eventId, channelId),
    });
  });

  it('preserves a Snowflake message id that exceeds JavaScript safe integers', async () => {
    const provider = createProvider(
      vi.fn<WuKongFetch>(
        async () =>
          new Response('{"message_id":2084467375268171776,"message_seq":9,"reason":1}', {
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
    await expect(provider.deliver(messageEvent(), deliveryContext())).resolves.toMatchObject({
      providerMessageId: '2084467375268171776',
    });
  });

  it('classifies rate limits as retryable and permission failures as terminal', async () => {
    const limited = createProvider(
      vi.fn<WuKongFetch>(async () => Response.json({ message_id: 0, message_seq: 0, reason: 22 })),
    );
    const denied = createProvider(
      vi.fn<WuKongFetch>(async () => Response.json({ message_id: 0, message_seq: 0, reason: 11 })),
    );
    await expect(limited.deliver(messageEvent(), deliveryContext())).rejects.toMatchObject({
      code: 'WUKONG_IM_REASON_22',
      retryable: true,
      terminalOutcome: 'unknown',
    });
    await expect(denied.deliver(messageEvent(), deliveryContext())).rejects.toMatchObject({
      code: 'WUKONG_IM_REASON_11',
      retryable: false,
      terminalOutcome: 'failed',
    });
  });

  it('bounds upstream responses and does not leak their contents', async () => {
    const provider = createProvider(
      vi.fn<WuKongFetch>(async () => new Response('x'.repeat(16 * 1024 + 1))),
    );
    const error = await provider
      .deliver(messageEvent(), deliveryContext())
      .catch((caught) => caught);
    expect(error).toBeInstanceOf(ImDeliveryError);
    expect(error).toMatchObject({ code: 'WUKONG_IM_RESPONSE_TOO_LARGE' });
    expect(String(error)).not.toContain('xxxxx');
  });

  it('maps the same identity deterministically while isolating tenants and actor types', () => {
    const user = { type: 'user' as const, id: '00000000-0000-7000-8000-000000000101' };
    const first = mapWuKongAccountId('00000000-0000-7000-8000-000000000001', user);
    expect(mapWuKongAccountId('00000000-0000-7000-8000-000000000001', user)).toBe(first);
    expect(mapWuKongAccountId('00000000-0000-7000-8000-000000000002', user)).not.toBe(first);
    expect(
      mapWuKongAccountId('00000000-0000-7000-8000-000000000001', {
        ...user,
        type: 'agent',
      }),
    ).not.toBe(first);
    expect(first).toMatch(/^u_[A-Za-z0-9_-]{43}$/);
  });
});

function createProvider(fetchImpl: WuKongFetch): WuKongImDeliveryProvider {
  return new WuKongImDeliveryProvider({
    endpoint: 'http://127.0.0.1:5501',
    apiToken: 'internal-api-token-value',
    requestTimeoutMs: 1_000,
    fetchImpl,
  });
}

function deliveryContext() {
  return {
    idempotencyKey: '00000000-0000-7000-8000-000000000901',
    attempt: 1,
    firstAttemptedAt: new Date('2026-08-04T00:00:00.000Z'),
    signal: new AbortController().signal,
  } as const;
}

function messageEvent(overrides: Partial<MessageCreatedDelivery> = {}): MessageCreatedDelivery {
  return {
    eventId: '00000000-0000-7000-8000-000000000901',
    tenantId: '00000000-0000-7000-8000-000000000001',
    eventType: 'message.created.v1',
    conversationType: 'direct',
    messageId: '00000000-0000-7000-8000-000000000801',
    conversationId: '00000000-0000-7000-8000-000000000701',
    sender: { type: 'user', id: '00000000-0000-7000-8000-000000000101' },
    recipients: [{ type: 'user', id: '00000000-0000-7000-8000-000000000202' }],
    content: { type: 'text', text: 'hello' },
    createdAt: '2026-08-04T00:00:00.000Z',
    ...overrides,
  };
}
