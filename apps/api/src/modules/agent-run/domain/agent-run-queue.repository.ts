import type { ClaimedAgentRunEvent } from './agent-run.models.js';

export abstract class AgentRunQueueRepository {
  abstract claim(input: {
    readonly workerId: string;
    readonly batchSize: number;
    readonly claimTtlMs: number;
  }): Promise<readonly ClaimedAgentRunEvent[]>;

  abstract claimCancellations(input: {
    readonly workerId: string;
    readonly batchSize: number;
    readonly claimTtlMs: number;
  }): Promise<readonly ClaimedAgentRunEvent[]>;

  abstract renewLease(input: {
    readonly eventId: string;
    readonly workerId: string;
    readonly claimTtlMs: number;
  }): Promise<boolean>;

  abstract markPublished(input: {
    readonly eventId: string;
    readonly workerId: string;
    readonly externalRunId: string | null;
  }): Promise<boolean>;

  abstract markFailed(input: {
    readonly eventId: string;
    readonly workerId: string;
    readonly errorCode: string;
  }): Promise<boolean>;

  abstract markUnknown(input: {
    readonly eventId: string;
    readonly workerId: string;
    readonly errorCode: string;
  }): Promise<boolean>;

  abstract defer(input: {
    readonly eventId: string;
    readonly workerId: string;
    readonly availableAt: Date;
    readonly reasonCode: string;
  }): Promise<boolean>;
}
