import type { ClaimedToolReconciliationEvent } from './tool-reconciliation.models.js';

export abstract class ToolReconciliationQueueRepository {
  abstract claim(input: {
    readonly workerId: string;
    readonly batchSize: number;
    readonly claimTtlMs: number;
  }): Promise<readonly ClaimedToolReconciliationEvent[]>;

  abstract markProcessed(input: {
    readonly eventId: string;
    readonly workerId: string;
    readonly providerRequestId: string | null;
    readonly outcome: 'reconciled' | 'inconclusive' | 'skipped';
    readonly reasonCode: string;
  }): Promise<boolean>;

  abstract markFailed(input: {
    readonly eventId: string;
    readonly workerId: string;
    readonly reasonCode: string;
  }): Promise<boolean>;
}
