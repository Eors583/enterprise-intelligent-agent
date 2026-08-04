export const MESSAGE_CREATED_EVENT_TYPE = 'message.created.v1' as const;

export interface MessageCreatedDelivery {
  readonly eventId: string;
  readonly tenantId: string;
  readonly eventType: typeof MESSAGE_CREATED_EVENT_TYPE;
  readonly messageId: string;
  readonly conversationId: string;
  readonly conversationType: 'direct' | 'group';
  readonly sender: {
    readonly type: 'user' | 'agent';
    readonly id: string;
  };
  readonly recipients: readonly {
    readonly type: 'user' | 'agent';
    readonly id: string;
  }[];
  readonly content: {
    readonly type: 'text';
    readonly text: string;
  };
  readonly createdAt: string;
}

export interface ImDeliveryContext {
  /** Stable across retries; production providers must forward it as their idempotency key. */
  readonly idempotencyKey: string;
  /** Atomically incremented delivery attempt, starting at one. */
  readonly attempt: number;
  /** Durable timestamp of the first claim, not the event creation time. */
  readonly firstAttemptedAt: Date;
  readonly signal: AbortSignal;
}

export type ImDeliveryResult =
  | {
      readonly outcome: 'accepted';
      readonly deliveredRecipientCount: number;
      /** Vendor-issued message identifier when the provider exposes one. */
      readonly providerMessageId?: string;
    }
  | {
      readonly outcome: 'skipped';
      readonly deliveredRecipientCount: 0;
      readonly reason: 'no_human_recipients';
    };

export abstract class ImDeliveryProvider {
  abstract readonly name: string;

  abstract deliver(
    event: MessageCreatedDelivery,
    context: ImDeliveryContext,
  ): Promise<ImDeliveryResult>;
}

/**
 * Provider adapters may expose a safe operational error without leaking an
 * upstream response body, credential, or message content into the database.
 */
export class ImDeliveryError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    /** Terminal state to use when this error is permanent or retries are exhausted. */
    readonly terminalOutcome: 'failed' | 'unknown' = 'failed',
  ) {
    super(message);
    this.name = 'ImDeliveryError';
  }
}

export function parseMessageCreatedDelivery(source: {
  readonly id: string;
  readonly tenantId: string;
  readonly eventType: string;
  readonly payload: unknown;
  readonly createdAt: Date;
}): MessageCreatedDelivery {
  if (source.eventType !== MESSAGE_CREATED_EVENT_TYPE || !isRecord(source.payload)) {
    throw malformedEvent();
  }

  const sender = source.payload.sender;
  const recipients = source.payload.recipients;
  const content = source.payload.content;
  if (
    !isNonEmptyString(source.payload.messageId) ||
    !isNonEmptyString(source.payload.conversationId) ||
    (source.payload.conversationType !== undefined &&
      source.payload.conversationType !== 'direct' &&
      source.payload.conversationType !== 'group') ||
    !isRecord(sender) ||
    (sender.type !== 'user' && sender.type !== 'agent') ||
    !isNonEmptyString(sender.id) ||
    !Array.isArray(recipients) ||
    recipients.length === 0 ||
    !recipients.every(isRecipient) ||
    !isRecord(content) ||
    content.type !== 'text' ||
    typeof content.text !== 'string'
  ) {
    throw malformedEvent();
  }

  return {
    eventId: source.id,
    tenantId: source.tenantId,
    eventType: MESSAGE_CREATED_EVENT_TYPE,
    messageId: source.payload.messageId,
    conversationId: source.payload.conversationId,
    conversationType: source.payload.conversationType === 'group' ? 'group' : 'direct',
    sender: { type: sender.type, id: sender.id },
    recipients: recipients.map((recipient) => ({
      type: recipient.type,
      id: recipient.id,
    })),
    content: { type: 'text', text: content.text },
    createdAt: source.createdAt.toISOString(),
  };
}

function malformedEvent(): ImDeliveryError {
  return new ImDeliveryError(
    'MALFORMED_OUTBOX_EVENT',
    'message.created.v1 payload failed validation',
    false,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isRecipient(
  value: unknown,
): value is { readonly type: 'user' | 'agent'; readonly id: string } {
  return (
    isRecord(value) &&
    (value.type === 'user' || value.type === 'agent') &&
    isNonEmptyString(value.id)
  );
}
