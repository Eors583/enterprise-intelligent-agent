import {
  ImDeliveryError,
  ImDeliveryProvider,
  type ImDeliveryContext,
  type ImDeliveryResult,
  type MessageCreatedDelivery,
} from '../../domain/im-delivery.provider.js';
import {
  mapWuKongAccountId,
  mapWuKongClientMessageNumber,
  mapWuKongGroupChannelId,
} from './wukong-identifiers.js';

const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const MAX_REQUEST_BYTES = 64 * 1_024;
const MAX_RESPONSE_BYTES = 16 * 1_024;
const WUKONG_REASON_SUCCESS = 1;
const WUKONG_REASON_SYSTEM_ERROR = 15;
const WUKONG_REASON_RATE_LIMIT = 22;

export type WuKongFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface WuKongImDeliveryProviderOptions {
  readonly endpoint: string;
  readonly apiToken?: string;
  readonly requestTimeoutMs?: number;
  readonly fetchImpl?: WuKongFetch;
}

interface WuKongSendResponse {
  readonly messageId: string;
  readonly messageSeq: number;
  readonly reason: number;
}

/**
 * Clean-room adapter for WuKongIM's documented internal REST API. The provider
 * is deliberately delivery-only: authorization and durable business writes
 * stay in the NestJS/PostgreSQL transaction before an Outbox event reaches it.
 */
export class WuKongImDeliveryProvider extends ImDeliveryProvider {
  readonly name = 'wukong';
  private readonly endpoint: URL;
  private readonly apiToken: string | undefined;
  private readonly requestTimeoutMs: number;
  private readonly fetchImpl: WuKongFetch;

  constructor(options: WuKongImDeliveryProviderOptions) {
    super();
    this.endpoint = validateEndpoint(options.endpoint);
    this.apiToken = options.apiToken;
    this.requestTimeoutMs = positiveInteger(
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      'request timeout',
    );
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  async deliver(
    event: MessageCreatedDelivery,
    context: ImDeliveryContext,
  ): Promise<ImDeliveryResult> {
    if (context.signal.aborted) throw abortedError();

    const humanRecipients = uniqueHumanRecipients(event);
    if (humanRecipients.length === 0) {
      return {
        outcome: 'skipped',
        deliveredRecipientCount: 0,
        reason: 'no_human_recipients',
      };
    }

    if (event.conversationType === 'group') {
      const channelId = mapWuKongGroupChannelId(event.tenantId, event.conversationId);
      const senderUid = mapWuKongAccountId(event.tenantId, event.sender);
      await this.ensureGroupChannel(channelId, [senderUid, ...humanRecipients], context.signal);
      const receipt = await this.sendToChannel(
        event,
        channelId,
        2,
        mapWuKongClientMessageNumber(event.eventId, channelId),
        context.signal,
      );
      return {
        outcome: 'accepted',
        deliveredRecipientCount: humanRecipients.length,
        providerMessageId: receipt,
      };
    }

    const receipts: string[] = [];
    for (const recipientUid of humanRecipients) {
      receipts.push(
        await this.sendToChannel(
          event,
          recipientUid,
          1,
          mapWuKongClientMessageNumber(event.eventId, recipientUid),
          context.signal,
        ),
      );
    }
    return {
      outcome: 'accepted',
      deliveredRecipientCount: humanRecipients.length,
      ...(receipts.length === 1 ? { providerMessageId: receipts[0] } : {}),
    };
  }

  private async ensureGroupChannel(
    channelId: string,
    subscribers: readonly string[],
    signal: AbortSignal,
  ): Promise<void> {
    const body = JSON.stringify({
      channel_id: channelId,
      channel_type: 2,
      reset: 1,
      large: 0,
      ban: 0,
      disband: 0,
      send_ban: 0,
      allow_stranger: 0,
      subscribers: [...new Set(subscribers)],
    });
    if (Buffer.byteLength(body, 'utf8') > MAX_REQUEST_BYTES) {
      throw new ImDeliveryError(
        'WUKONG_IM_GROUP_TOO_LARGE',
        'WuKongIM group channel body exceeds the enterprise transport limit',
        false,
      );
    }
    const response = await this.request(new URL('/channel', this.endpoint), body, signal);
    if (!response.ok) {
      throw new ImDeliveryError(
        `WUKONG_IM_CHANNEL_HTTP_${response.status}`,
        `WuKongIM group channel returned HTTP ${response.status}`,
        [408, 425, 429].includes(response.status) || response.status >= 500,
        response.status >= 500 ? 'unknown' : 'failed',
      );
    }
    try {
      const value = JSON.parse(await readBoundedText(response, MAX_RESPONSE_BYTES)) as unknown;
      if (!isRecord(value) || value.status !== 200) throw new Error('invalid channel receipt');
    } catch (error) {
      if (error instanceof ImDeliveryError) throw error;
      throw new ImDeliveryError(
        'WUKONG_IM_INVALID_CHANNEL_RESPONSE',
        'WuKongIM returned an invalid group channel receipt',
        true,
        'unknown',
      );
    }
  }

  private async sendToChannel(
    event: MessageCreatedDelivery,
    channelId: string,
    channelType: 1 | 2,
    clientMessageNumber: string,
    signal: AbortSignal,
  ): Promise<string> {
    const payload = Buffer.from(
      JSON.stringify({
        type: 1,
        content: event.content.text,
        enterprise: {
          version: 1,
          eventId: event.eventId,
          messageId: event.messageId,
          conversationId: event.conversationId,
        },
      }),
      'utf8',
    ).toString('base64');
    const body = JSON.stringify({
      header: { no_persist: 0, red_dot: 1, sync_once: 0 },
      from_uid: mapWuKongAccountId(event.tenantId, event.sender),
      channel_id: channelId,
      channel_type: channelType,
      client_msg_no: clientMessageNumber,
      payload,
    });
    if (Buffer.byteLength(body, 'utf8') > MAX_REQUEST_BYTES) {
      throw new ImDeliveryError(
        'WUKONG_IM_MESSAGE_TOO_LARGE',
        'WuKongIM message body exceeds the enterprise transport limit',
        false,
      );
    }

    const response = await this.request(new URL('/message/send', this.endpoint), body, signal);
    if (!response.ok) {
      throw new ImDeliveryError(
        `WUKONG_IM_HTTP_${response.status}`,
        `WuKongIM returned HTTP ${response.status}`,
        [408, 425, 429].includes(response.status) || response.status >= 500,
        response.status >= 500 ? 'unknown' : 'failed',
      );
    }

    const receipt = await parseWuKongResponse(response);
    if (receipt.reason !== WUKONG_REASON_SUCCESS) {
      const retryable = [WUKONG_REASON_SYSTEM_ERROR, WUKONG_REASON_RATE_LIMIT].includes(
        receipt.reason,
      );
      throw new ImDeliveryError(
        `WUKONG_IM_REASON_${receipt.reason}`,
        `WuKongIM rejected the message with reason ${receipt.reason}`,
        retryable,
        retryable ? 'unknown' : 'failed',
      );
    }
    return receipt.messageId;
  }

  private async request(url: URL, body: string, externalSignal: AbortSignal): Promise<Response> {
    if (externalSignal.aborted) throw abortedError();
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = (): void => controller.abort(externalSignal.reason);
    externalSignal.addEventListener('abort', onAbort, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(timeoutError());
    }, this.requestTimeoutMs);
    timeout.unref();
    try {
      return await this.fetchImpl(url, {
        method: 'POST',
        cache: 'no-store',
        redirect: 'error',
        signal: controller.signal,
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          ...(this.apiToken === undefined ? {} : { token: this.apiToken }),
        },
        body,
      });
    } catch {
      if (timedOut) throw timeoutError();
      if (externalSignal.aborted) throw abortedError();
      throw new ImDeliveryError(
        'WUKONG_IM_NETWORK_ERROR',
        'WuKongIM network request failed',
        true,
        'unknown',
      );
    } finally {
      clearTimeout(timeout);
      externalSignal.removeEventListener('abort', onAbort);
    }
  }
}

function uniqueHumanRecipients(event: MessageCreatedDelivery): string[] {
  return [
    ...new Set(
      event.recipients
        .filter((recipient) => recipient.type === 'user')
        .map((recipient) => mapWuKongAccountId(event.tenantId, recipient)),
    ),
  ];
}

async function parseWuKongResponse(response: Response): Promise<WuKongSendResponse> {
  let text: string;
  let value: unknown;
  try {
    text = await readBoundedText(response, MAX_RESPONSE_BYTES);
    value = JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof ImDeliveryError) throw error;
    throw invalidResponse();
  }
  if (!isRecord(value) || !Number.isSafeInteger(value.reason)) throw invalidResponse();
  const messageId = readMessageId(value, text);
  const messageSeq = readSafeInteger(value.message_seq);
  if (messageId === undefined || messageSeq === undefined) throw invalidResponse();
  return { messageId, messageSeq, reason: value.reason as number };
}

function readMessageId(value: Record<string, unknown>, rawJson: string): string | undefined {
  const direct = value.message_idstr;
  if (typeof direct === 'string' && /^[0-9]{1,30}$/.test(direct)) return direct;
  const numeric = readSafeInteger(value.message_id);
  if (numeric !== undefined) return String(numeric);
  // WuKongIM's Snowflake IDs exceed JavaScript's safe integer range and some
  // server revisions expose only message_id (not message_idstr). Preserve the
  // exact decimal token from the already-bounded, successfully parsed JSON.
  const match = /"message_id"\s*:\s*([0-9]{1,30})(?=\s*[,}])/u.exec(rawJson);
  return match?.[1];
}

function readSafeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
}

async function readBoundedText(response: Response, limit: number): Promise<string> {
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > limit) {
        throw new ImDeliveryError(
          'WUKONG_IM_RESPONSE_TOO_LARGE',
          'WuKongIM response exceeded the safety limit',
          true,
          'unknown',
        );
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

function validateEndpoint(value: string): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new TypeError('WuKongIM endpoint must be a valid URL.');
  }
  if (
    !['http:', 'https:'].includes(endpoint.protocol) ||
    endpoint.username !== '' ||
    endpoint.password !== '' ||
    endpoint.search !== '' ||
    endpoint.hash !== ''
  ) {
    throw new TypeError('WuKongIM endpoint must be an HTTP(S) URL without credentials.');
  }
  return endpoint;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`WuKongIM ${label} must be a positive integer.`);
  }
  return value;
}

function timeoutError(): ImDeliveryError {
  return new ImDeliveryError(
    'WUKONG_IM_TIMEOUT',
    'WuKongIM request exceeded its timeout',
    true,
    'unknown',
  );
}

function abortedError(): ImDeliveryError {
  return new ImDeliveryError('WUKONG_IM_ABORTED', 'WuKongIM delivery was aborted', true);
}

function invalidResponse(): ImDeliveryError {
  return new ImDeliveryError(
    'WUKONG_IM_INVALID_RESPONSE',
    'WuKongIM returned an invalid response',
    true,
    'unknown',
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
