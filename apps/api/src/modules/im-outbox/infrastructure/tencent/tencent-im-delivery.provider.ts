import {
  ImDeliveryError,
  ImDeliveryProvider,
  type ImDeliveryContext,
  type ImDeliveryResult,
  type MessageCreatedDelivery,
} from '../../domain/im-delivery.provider.js';
import { deriveTencentMessageNumbers, mapTencentAccountId } from './tencent-identifiers.js';
import { TencentUserSigCache } from './tencent-user-sig.js';

const DEFAULT_ENDPOINT = 'https://console.tim.qq.com';
const DEFAULT_USER_SIG_TTL_SECONDS = 60 * 24 * 60 * 60;
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const MAX_MESSAGE_BODY_BYTES = 12 * 1_024;

/** Tencent's 120-second C2C de-duplication lifetime minus a safety margin. */
export const TENCENT_IM_SAFE_RETRY_WINDOW_MS = 110_000;

/**
 * Runtime configuration must restrict production endpoints to this allowlist
 * to prevent SSRF. Constructor URL validation remains intentionally generic so
 * an injected fetch can target a controlled test endpoint.
 */
export const TENCENT_IM_OFFICIAL_API_HOSTS = new Set([
  'console.tim.qq.com',
  'adminapisgp.im.qcloud.com',
  'adminapikr.im.qcloud.com',
  'adminapijpn.im.qcloud.com',
  'adminapiger.im.qcloud.com',
  'adminapiusa.im.qcloud.com',
  'adminapiidn.im.qcloud.com',
  'adminapiksa.im.qcloud.com',
  'adminapi.my-imcloud.com',
  'adminapisgp.my-imcloud.com',
  'adminapikr.my-imcloud.com',
  'adminapijpn.my-imcloud.com',
  'adminapiger.my-imcloud.com',
  'adminapiusa.my-imcloud.com',
  'adminapiidn.my-imcloud.com',
  'adminapiksa.my-imcloud.com',
]);

export type TencentFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface TencentImDeliveryProviderOptions {
  readonly sdkAppId: number;
  readonly administratorUserId: string;
  readonly secretKey: string;
  readonly endpoint?: string;
  readonly userSigTtlSeconds?: number;
  readonly requestTimeoutMs?: number;
  readonly fetchImpl?: TencentFetch;
  /** Returns Unix time in milliseconds. */
  readonly now?: () => number;
}

interface TencentSendResponse {
  readonly ActionStatus: string;
  readonly ErrorCode: number;
  readonly MsgId?: string;
  readonly MsgKey?: string;
}

export class TencentImDeliveryProvider extends ImDeliveryProvider {
  readonly name = 'tencent';
  private readonly sdkAppId: number;
  private readonly administratorUserId: string;
  private readonly endpoint: URL;
  private readonly requestTimeoutMs: number;
  private readonly fetchImpl: TencentFetch;
  private readonly now: () => number;
  private readonly userSig: TencentUserSigCache;

  constructor(options: TencentImDeliveryProviderOptions) {
    super();
    this.sdkAppId = options.sdkAppId;
    this.administratorUserId = options.administratorUserId;
    this.endpoint = validateEndpoint(options.endpoint ?? DEFAULT_ENDPOINT);
    this.requestTimeoutMs = positiveInteger(
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      'request timeout',
    );
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.userSig = new TencentUserSigCache({
      sdkAppId: options.sdkAppId,
      userId: options.administratorUserId,
      secretKey: options.secretKey,
      expiresInSeconds: positiveInteger(
        options.userSigTtlSeconds ?? DEFAULT_USER_SIG_TTL_SECONDS,
        'UserSig lifetime',
      ),
      ...(options.now === undefined ? {} : { now: options.now }),
    });
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

    // A delayed event still gets its first attempt: the de-duplication window
    // starts at the first claim, not at event creation. Once a prior attempt is
    // outside Tencent's stable-key window, sending again could create a
    // duplicate, so preserve the uncertain outcome for operator reconciliation.
    if (
      context.attempt > 1 &&
      this.now() - context.firstAttemptedAt.getTime() > TENCENT_IM_SAFE_RETRY_WINDOW_MS
    ) {
      throw new ImDeliveryError(
        'TENCENT_IM_DEDUP_WINDOW_EXPIRED',
        'Tencent IM safe de-duplication retry window expired',
        false,
        'unknown',
      );
    }

    const messageIds: string[] = [];
    for (const recipient of humanRecipients) {
      messageIds.push(await this.sendToRecipient(event, recipient, context.signal));
    }

    return {
      outcome: 'accepted',
      deliveredRecipientCount: humanRecipients.length,
      ...(messageIds.length === 1 ? { providerMessageId: messageIds[0] } : {}),
    };
  }

  private async sendToRecipient(
    event: MessageCreatedDelivery,
    recipientAccountId: string,
    externalSignal: AbortSignal,
  ): Promise<string> {
    const numbers = deriveTencentMessageNumbers(event.eventId, recipientAccountId);
    const body = JSON.stringify({
      SyncOtherMachine: 1,
      From_Account: mapTencentAccountId(event.tenantId, event.sender),
      To_Account: recipientAccountId,
      MsgSeq: numbers.msgSeq,
      MsgRandom: numbers.msgRandom,
      MsgBody: [
        {
          MsgType: 'TIMTextElem',
          MsgContent: { Text: event.content.text },
        },
      ],
      CloudCustomData: JSON.stringify({
        v: 1,
        eventId: event.eventId,
        messageId: event.messageId,
      }),
    });
    if (Buffer.byteLength(body, 'utf8') > MAX_MESSAGE_BODY_BYTES) {
      throw new ImDeliveryError(
        'TENCENT_IM_MESSAGE_TOO_LARGE',
        'Tencent IM message body exceeds 12 KiB',
        false,
      );
    }

    const url = new URL('/v4/openim/sendmsg', this.endpoint);
    url.searchParams.set('sdkappid', String(this.sdkAppId));
    url.searchParams.set('identifier', this.administratorUserId);
    url.searchParams.set('usersig', this.userSig.get());
    url.searchParams.set('random', String(numbers.requestRandom));
    url.searchParams.set('contenttype', 'json');

    const response = await this.request(url, body, externalSignal);
    if (!response.ok) {
      throw new ImDeliveryError(
        `TENCENT_IM_HTTP_${response.status}`,
        `Tencent IM returned HTTP ${response.status}`,
        [408, 425, 429].includes(response.status) || response.status >= 500,
      );
    }

    const payload = await parseTencentResponse(response);
    if (payload.ActionStatus !== 'OK' || payload.ErrorCode !== 0) {
      const error = classifyTencentError(payload.ErrorCode);
      if (error.code === 'TENCENT_IM_AUTH_ERROR') this.userSig.invalidate();
      throw error;
    }

    const providerMessageId = firstValidMessageId(payload.MsgId, payload.MsgKey);
    if (providerMessageId === undefined) {
      throw invalidResponse();
    }
    return providerMessageId;
  }

  private async request(url: URL, body: string, externalSignal: AbortSignal): Promise<Response> {
    if (externalSignal.aborted) throw abortedError();

    const controller = new AbortController();
    let timedOut = false;
    let externallyAborted = false;
    let rejectAbort: ((reason: ImDeliveryError) => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject;
    });
    const onExternalAbort = (): void => {
      externallyAborted = true;
      const error = abortedError();
      controller.abort(error);
      rejectAbort?.(error);
    };
    externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      const error = timeoutError();
      controller.abort(error);
      rejectAbort?.(error);
    }, this.requestTimeoutMs);
    timeout.unref();

    const request = Promise.resolve()
      .then(() =>
        this.fetchImpl(url, {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
          },
          body,
          signal: controller.signal,
        }),
      )
      .catch((_error: unknown) => {
        if (timedOut) throw timeoutError();
        if (externallyAborted || externalSignal.aborted) throw abortedError();
        throw new ImDeliveryError(
          'TENCENT_IM_NETWORK_ERROR',
          'Tencent IM network request failed',
          true,
          'unknown',
        );
      });

    try {
      return await Promise.race([request, aborted]);
    } finally {
      clearTimeout(timeout);
      externalSignal.removeEventListener('abort', onExternalAbort);
    }
  }
}

function uniqueHumanRecipients(event: MessageCreatedDelivery): string[] {
  return [
    ...new Set(
      event.recipients
        .filter((recipient) => recipient.type === 'user')
        .map((recipient) => mapTencentAccountId(event.tenantId, recipient)),
    ),
  ];
}

async function parseTencentResponse(response: Response): Promise<TencentSendResponse> {
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw invalidResponse();
  }

  if (
    !isRecord(value) ||
    typeof value.ActionStatus !== 'string' ||
    !Number.isSafeInteger(value.ErrorCode)
  ) {
    throw invalidResponse();
  }

  return {
    ActionStatus: value.ActionStatus,
    ErrorCode: value.ErrorCode as number,
    ...(typeof value.MsgId === 'string' ? { MsgId: value.MsgId } : {}),
    ...(typeof value.MsgKey === 'string' ? { MsgKey: value.MsgKey } : {}),
  };
}

function classifyTencentError(errorCode: number): ImDeliveryError {
  if ([20002, 60004, 60005].includes(errorCode)) {
    return new ImDeliveryError(
      'TENCENT_IM_AUTH_ERROR',
      `Tencent IM authentication failed (code ${errorCode})`,
      true,
    );
  }
  if ([20004, 20005, 60008, 60007, 60011, 60018, 60019, 90992, 91000].includes(errorCode)) {
    return new ImDeliveryError(
      `TENCENT_IM_UPSTREAM_${errorCode}`,
      `Tencent IM temporarily rejected the request (code ${errorCode})`,
      true,
    );
  }
  if ([20003, 90012, 90048].includes(errorCode)) {
    return new ImDeliveryError(
      'TENCENT_IM_ACCOUNT_NOT_FOUND',
      `Tencent IM account is not provisioned (code ${errorCode})`,
      false,
    );
  }
  return new ImDeliveryError(
    `TENCENT_IM_UPSTREAM_${errorCode}`,
    `Tencent IM rejected the request (code ${errorCode})`,
    false,
  );
}

function firstValidMessageId(...values: readonly (string | undefined)[]): string | undefined {
  return values.find(
    (value): value is string =>
      value !== undefined && value.length > 0 && value.length <= 256 && !/[\r\n]/.test(value),
  );
}

function validateEndpoint(value: string): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new TypeError('Tencent IM endpoint must be a valid URL.');
  }
  if (endpoint.protocol !== 'https:' || endpoint.username !== '' || endpoint.password !== '') {
    throw new TypeError('Tencent IM endpoint must use HTTPS without embedded credentials.');
  }
  return endpoint;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`Tencent IM ${label} must be a positive integer.`);
  }
  return value;
}

function timeoutError(): ImDeliveryError {
  return new ImDeliveryError(
    'TENCENT_IM_TIMEOUT',
    'Tencent IM request exceeded its timeout',
    true,
    'unknown',
  );
}

function abortedError(): ImDeliveryError {
  return new ImDeliveryError('TENCENT_IM_ABORTED', 'Tencent IM delivery was aborted', true);
}

function invalidResponse(): ImDeliveryError {
  return new ImDeliveryError(
    'TENCENT_IM_INVALID_RESPONSE',
    'Tencent IM returned an invalid response',
    true,
    'unknown',
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
