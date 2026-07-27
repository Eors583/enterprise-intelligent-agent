import { Injectable, Logger } from '@nestjs/common';

import {
  ImDeliveryProvider,
  type ImDeliveryContext,
  type ImDeliveryResult,
  type MessageCreatedDelivery,
} from '../../domain/im-delivery.provider.js';

/**
 * Development-only sink. It proves the outbox lifecycle without pretending to
 * implement a vendor protocol. Environment validation rejects it for an
 * enabled production worker.
 */
@Injectable()
export class LocalImDeliveryProvider extends ImDeliveryProvider {
  readonly name = 'local';
  private readonly logger = new Logger(LocalImDeliveryProvider.name);

  async deliver(
    event: MessageCreatedDelivery,
    context: ImDeliveryContext,
  ): Promise<ImDeliveryResult> {
    if (context.signal.aborted) {
      throw context.signal.reason instanceof Error
        ? context.signal.reason
        : new Error('IM delivery was aborted.');
    }

    const humanRecipients = event.recipients.filter((recipient) => recipient.type === 'user');
    if (humanRecipients.length === 0) {
      this.logger.log(
        `Skipped message event ${event.eventId}: no human IM recipients were present.`,
      );
      return {
        outcome: 'skipped',
        deliveredRecipientCount: 0,
        reason: 'no_human_recipients',
      };
    }

    this.logger.log(
      `Accepted message event ${event.eventId} for conversation ${event.conversationId} ` +
        `and ${humanRecipients.length} local recipient(s) ` +
        `(idempotencyKey=${context.idempotencyKey}).`,
    );
    return {
      outcome: 'accepted',
      deliveredRecipientCount: humanRecipients.length,
      providerMessageId: event.eventId,
    };
  }
}
