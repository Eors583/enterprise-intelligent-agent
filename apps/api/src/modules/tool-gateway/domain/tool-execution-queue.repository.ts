import type { ClaimedToolExecutionEvent } from './tool-execution.models.js';

export abstract class ToolExecutionQueueRepository {
  abstract claim(input: {
    readonly workerId: string;
    readonly batchSize: number;
    readonly claimTtlMs: number;
  }): Promise<readonly ClaimedToolExecutionEvent[]>;

  abstract markPublished(input: {
    readonly eventId: string;
    readonly workerId: string;
    readonly providerRequestId: string | null;
    readonly outcome: 'executed' | 'skipped' | 'failed';
    readonly reasonCode: string;
  }): Promise<boolean>;

  abstract markUnknown(input: {
    readonly eventId: string;
    readonly workerId: string;
    readonly providerRequestId: string | null;
    readonly reasonCode: string;
  }): Promise<boolean>;

  abstract markFailed(input: {
    readonly eventId: string;
    readonly workerId: string;
    readonly reasonCode: string;
  }): Promise<boolean>;

  abstract defer(input: {
    readonly eventId: string;
    readonly workerId: string;
    readonly availableAt: Date;
    readonly reasonCode: string;
  }): Promise<boolean>;
}
