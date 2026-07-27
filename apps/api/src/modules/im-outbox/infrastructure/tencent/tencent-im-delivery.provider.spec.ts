import { createHmac } from 'node:crypto';
import { inflateSync } from 'node:zlib';

import {
  ImDeliveryError,
  type ImDeliveryContext,
  type MessageCreatedDelivery,
} from '../../domain/im-delivery.provider.js';
import { mapTencentAccountId } from './tencent-identifiers.js';
import { TencentImDeliveryProvider, type TencentFetch } from './tencent-im-delivery.provider.js';
import { generateTencentUserSig, TencentUserSigCache } from './tencent-user-sig.js';

const SDK_APP_ID = 1_400_000_001;
const ADMIN = 'administrator';
const SECRET = 'top-secret-signing-key';
const FIXED_NOW_MS = Date.parse('2026-07-15T00:00:00.000Z');

describe('TencentImDeliveryProvider', () => {
  it('sends a text message to the human recipient and returns the Tencent receipt', async () => {
    const fetchImpl = vi.fn<TencentFetch>(async () => successResponse());
    const provider = createProvider(fetchImpl);

    const result = await provider.deliver(messageEvent(), deliveryContext());

    expect(result).toEqual({
      outcome: 'accepted',
      deliveredRecipientCount: 1,
      providerMessageId: 'tencent-message-id',
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [request, init] = fetchImpl.mock.calls[0] ?? [];
    const url = new URL(String(request));
    expect(url.origin + url.pathname).toBe('https://console.tim.qq.com/v4/openim/sendmsg');
    expect(url.searchParams.get('sdkappid')).toBe(String(SDK_APP_ID));
    expect(url.searchParams.get('identifier')).toBe(ADMIN);
    expect(url.searchParams.get('contenttype')).toBe('json');
    expect(url.searchParams.get('usersig')).toBeTruthy();
    expect(init?.method).toBe('POST');

    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      SyncOtherMachine: 1,
      From_Account: mapTencentAccountId(messageEvent().tenantId, messageEvent().sender),
      To_Account: mapTencentAccountId(messageEvent().tenantId, {
        type: 'user',
        id: 'user-recipient',
      }),
      MsgBody: [
        {
          MsgType: 'TIMTextElem',
          MsgContent: { Text: 'confidential message text' },
        },
      ],
    });
  });

  it('treats an HTTP 200 Tencent business failure as a safe delivery error', async () => {
    const fetchImpl = vi.fn<TencentFetch>(async () =>
      jsonResponse({
        ActionStatus: 'FAIL',
        ErrorCode: 90001,
        ErrorInfo: `upstream echoed ${SECRET} and confidential message text`,
      }),
    );
    const provider = createProvider(fetchImpl);

    const error = await captureError(() => provider.deliver(messageEvent(), deliveryContext()));

    expect(error).toBeInstanceOf(ImDeliveryError);
    expect(error).toMatchObject({ code: 'TENCENT_IM_UPSTREAM_90001', retryable: false });
    expect(String(error)).not.toContain(SECRET);
    expect(String(error)).not.toContain('confidential message text');
    expect(String(error)).not.toContain('upstream echoed');
  });

  it('aborts a request that exceeds the adapter timeout', async () => {
    const fetchImpl = vi.fn<TencentFetch>(
      async (_request, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new Error('request URL with credentials must not escape')),
            { once: true },
          );
        }),
    );
    const provider = createProvider(fetchImpl, { requestTimeoutMs: 5 });

    const error = await captureError(() => provider.deliver(messageEvent(), deliveryContext()));

    expect(error).toMatchObject({
      code: 'TENCENT_IM_TIMEOUT',
      retryable: true,
      terminalOutcome: 'unknown',
    });
    expect(String(error)).not.toContain('credentials');
  });

  it('classifies an indeterminate network failure as UNKNOWN after retries are exhausted', async () => {
    const fetchImpl = vi.fn<TencentFetch>(async () => {
      throw new Error(`${SECRET}: confidential message text`);
    });
    const provider = createProvider(fetchImpl);

    const error = await captureError(() => provider.deliver(messageEvent(), deliveryContext()));

    expect(error).toMatchObject({
      code: 'TENCENT_IM_NETWORK_ERROR',
      retryable: true,
      terminalOutcome: 'unknown',
    });
    expect(String(error)).not.toContain(SECRET);
    expect(String(error)).not.toContain('confidential message text');
  });

  it('classifies an invalid HTTP success response as an indeterminate outcome', async () => {
    const fetchImpl = vi.fn<TencentFetch>(async () =>
      jsonResponse({ ActionStatus: 'OK', ErrorCode: 0 }),
    );
    const provider = createProvider(fetchImpl);

    const error = await captureError(() => provider.deliver(messageEvent(), deliveryContext()));

    expect(error).toMatchObject({
      code: 'TENCENT_IM_INVALID_RESPONSE',
      retryable: true,
      terminalOutcome: 'unknown',
    });
  });

  it('allows a backlogged event to make its first request regardless of event age', async () => {
    const fetchImpl = vi.fn<TencentFetch>(async () => successResponse());
    const provider = createProvider(fetchImpl);

    await expect(
      provider.deliver(
        messageEvent(),
        deliveryContext({
          attempt: 1,
          firstAttemptedAt: new Date(FIXED_NOW_MS - 10 * 60_000),
        }),
      ),
    ).resolves.toMatchObject({ outcome: 'accepted' });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('allows a retry while the stable Tencent de-duplication key is still safe', async () => {
    const fetchImpl = vi.fn<TencentFetch>(async () => successResponse());
    const provider = createProvider(fetchImpl);

    await expect(
      provider.deliver(
        messageEvent(),
        deliveryContext({
          attempt: 2,
          firstAttemptedAt: new Date(FIXED_NOW_MS - 110_000),
        }),
      ),
    ).resolves.toMatchObject({ outcome: 'accepted' });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('stops an old retry as UNKNOWN before contacting Tencent again', async () => {
    const fetchImpl = vi.fn<TencentFetch>(async () => successResponse());
    const provider = createProvider(fetchImpl);

    const error = await captureError(() =>
      provider.deliver(
        messageEvent(),
        deliveryContext({
          attempt: 2,
          firstAttemptedAt: new Date(FIXED_NOW_MS - 110_001),
        }),
      ),
    );

    expect(error).toMatchObject({
      code: 'TENCENT_IM_DEDUP_WINDOW_EXPIRED',
      retryable: false,
      terminalOutcome: 'unknown',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([408, 425, 429, 500, 503])(
    'classifies HTTP %s as retryable without reading an unsafe response body',
    async (status) => {
      const fetchImpl = vi.fn<TencentFetch>(
        async () => new Response(`${SECRET}: confidential message text`, { status }),
      );
      const provider = createProvider(fetchImpl);

      const error = await captureError(() => provider.deliver(messageEvent(), deliveryContext()));

      expect(error).toMatchObject({ code: `TENCENT_IM_HTTP_${status}`, retryable: true });
      expect(String(error)).not.toContain(SECRET);
      expect(String(error)).not.toContain('confidential message text');
    },
  );

  it('derives stable idempotency numbers and opaque 32-byte account IDs', async () => {
    const requests: { readonly url: URL; readonly body: Record<string, unknown> }[] = [];
    const fetchImpl = vi.fn<TencentFetch>(async (request, init) => {
      requests.push({
        url: new URL(String(request)),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return successResponse();
    });
    const provider = createProvider(fetchImpl);

    await provider.deliver(messageEvent(), deliveryContext());
    await provider.deliver(messageEvent(), deliveryContext());

    expect(requests).toHaveLength(2);
    expect(requests[0]?.url.searchParams.get('random')).toBe(
      requests[1]?.url.searchParams.get('random'),
    );
    expect(requests[0]?.url.searchParams.get('usersig')).toBe(
      requests[1]?.url.searchParams.get('usersig'),
    );
    expect(requests[0]?.body.MsgSeq).toBe(requests[1]?.body.MsgSeq);
    expect(requests[0]?.body.MsgRandom).toBe(requests[1]?.body.MsgRandom);
    expect(requests[0]?.body.To_Account).toBe(requests[1]?.body.To_Account);
    expect(Buffer.byteLength(String(requests[0]?.body.To_Account), 'utf8')).toBeLessThanOrEqual(32);
    expect(String(requests[0]?.body.To_Account)).toMatch(/^u_[A-Za-z0-9_-]{30}$/);
  });

  it('skips an agent-only event without contacting Tencent', async () => {
    const fetchImpl = vi.fn<TencentFetch>(async () => successResponse());
    const provider = createProvider(fetchImpl);
    const event = messageEvent({
      recipients: [{ type: 'agent', id: 'agent-recipient' }],
    });

    await expect(provider.deliver(event, deliveryContext())).resolves.toEqual({
      outcome: 'skipped',
      deliveredRecipientCount: 0,
      reason: 'no_human_recipients',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects an oversized body without exposing its message text', async () => {
    const fetchImpl = vi.fn<TencentFetch>(async () => successResponse());
    const provider = createProvider(fetchImpl);
    const event = messageEvent({
      content: { type: 'text', text: `private-prefix-${'x'.repeat(13_000)}` },
    });

    const error = await captureError(() => provider.deliver(event, deliveryContext()));

    expect(error).toMatchObject({ code: 'TENCENT_IM_MESSAGE_TOO_LARGE', retryable: false });
    expect(String(error)).not.toContain('private-prefix');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('generateTencentUserSig', () => {
  it('produces a TLS 2.0 document with the official HMAC-SHA256 signature', () => {
    const issuedAtSeconds = Math.floor(FIXED_NOW_MS / 1_000);
    const expiresInSeconds = 5_184_000;
    const userSig = generateTencentUserSig({
      sdkAppId: SDK_APP_ID,
      userId: ADMIN,
      secretKey: SECRET,
      expiresInSeconds,
      issuedAtSeconds,
    });
    const document = decodeUserSig(userSig);
    const signedContent =
      `TLS.identifier:${ADMIN}\n` +
      `TLS.sdkappid:${SDK_APP_ID}\n` +
      `TLS.time:${issuedAtSeconds}\n` +
      `TLS.expire:${expiresInSeconds}\n`;
    const expectedSignature = createHmac('sha256', SECRET)
      .update(signedContent, 'utf8')
      .digest('base64');

    expect(document).toEqual({
      'TLS.ver': '2.0',
      'TLS.identifier': ADMIN,
      'TLS.sdkappid': SDK_APP_ID,
      'TLS.time': issuedAtSeconds,
      'TLS.expire': expiresInSeconds,
      'TLS.sig': expectedSignature,
    });
    expect(userSig).not.toContain(SECRET);
  });

  it('caches a UserSig until its pre-expiry refresh boundary', () => {
    let now = FIXED_NOW_MS;
    const cache = new TencentUserSigCache({
      sdkAppId: SDK_APP_ID,
      userId: ADMIN,
      secretKey: SECRET,
      expiresInSeconds: 86_400,
      now: () => now,
    });

    const first = cache.get();
    now += 1_000;
    expect(cache.get()).toBe(first);

    cache.invalidate();
    expect(cache.get()).not.toBe(first);
  });
});

function createProvider(
  fetchImpl: TencentFetch,
  overrides: Partial<ConstructorParameters<typeof TencentImDeliveryProvider>[0]> = {},
): TencentImDeliveryProvider {
  return new TencentImDeliveryProvider({
    sdkAppId: SDK_APP_ID,
    administratorUserId: ADMIN,
    secretKey: SECRET,
    endpoint: 'https://console.tim.qq.com',
    requestTimeoutMs: 1_000,
    userSigTtlSeconds: 5_184_000,
    fetchImpl,
    now: () => FIXED_NOW_MS,
    ...overrides,
  });
}

function messageEvent(overrides: Partial<MessageCreatedDelivery> = {}): MessageCreatedDelivery {
  return {
    eventId: '018f5fc1-34e8-7d72-bd0d-a134f956b9fe',
    tenantId: '00000000-0000-7000-8000-000000000001',
    eventType: 'message.created.v1',
    messageId: '00000000-0000-7000-8000-000000000501',
    conversationId: '00000000-0000-7000-8000-000000000401',
    sender: { type: 'user', id: 'user-sender' },
    recipients: [
      { type: 'user', id: 'user-recipient' },
      { type: 'agent', id: 'agent-recipient' },
    ],
    content: { type: 'text', text: 'confidential message text' },
    createdAt: '2026-07-15T00:00:00.000Z',
    ...overrides,
  };
}

function deliveryContext(overrides: Partial<ImDeliveryContext> = {}): ImDeliveryContext {
  return {
    idempotencyKey: '018f5fc1-34e8-7d72-bd0d-a134f956b9fe',
    attempt: 1,
    firstAttemptedAt: new Date(FIXED_NOW_MS),
    signal: new AbortController().signal,
    ...overrides,
  };
}

function successResponse(): Response {
  return jsonResponse({
    ActionStatus: 'OK',
    ErrorCode: 0,
    ErrorInfo: '',
    MsgTime: 1_752_537_600,
    MsgKey: '123_456_1752537600',
    MsgId: 'tencent-message-id',
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function captureError(action: () => Promise<unknown>): Promise<ImDeliveryError> {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(ImDeliveryError);
    return error as ImDeliveryError;
  }
  throw new Error('Expected action to reject.');
}

function decodeUserSig(value: string): Record<string, unknown> {
  const encoded = value.replace(/\*/g, '+').replace(/-/g, '/').replace(/_/g, '=');
  return JSON.parse(inflateSync(Buffer.from(encoded, 'base64')).toString('utf8')) as Record<
    string,
    unknown
  >;
}
