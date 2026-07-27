export interface ClaimedOutboxEvent {
  readonly id: string;
  readonly tenantId: string;
  readonly eventType: string;
  readonly payload: unknown;
  /** Incremented atomically when the event is claimed. */
  readonly attempts: number;
  /** Set once by the first successful claim and preserved across retries. */
  readonly firstAttemptedAt: Date;
  readonly createdAt: Date;
}

export abstract class OutboxDeliveryRepository {
  abstract claimMessageEvents(input: {
    readonly workerId: string;
    readonly batchSize: number;
    readonly claimTtlMs: number;
  }): Promise<readonly ClaimedOutboxEvent[]>;

  abstract markPublished(input: {
    readonly eventId: string;
    readonly workerId: string;
    readonly providerName: string;
    readonly providerReceipt: {
      readonly outcome: 'accepted' | 'skipped';
      readonly deliveredRecipientCount: number;
      readonly providerMessageId?: string;
      readonly reason?: string;
    };
  }): Promise<boolean>;

  abstract releaseForRetry(input: {
    readonly eventId: string;
    readonly workerId: string;
    readonly availableAt: Date;
    readonly error: string;
  }): Promise<boolean>;

  abstract markFailed(input: {
    readonly eventId: string;
    readonly workerId: string;
    readonly error: string;
  }): Promise<boolean>;

  abstract markUnknown(input: {
    readonly eventId: string;
    readonly workerId: string;
    readonly providerName: string;
    readonly error: string;
  }): Promise<boolean>;
}
