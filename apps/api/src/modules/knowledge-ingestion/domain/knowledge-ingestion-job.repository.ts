export interface ClaimedKnowledgeIngestionJob {
  readonly id: string;
  readonly tenantId: string;
  readonly documentVersionId: string;
  readonly attempts: number;
  readonly failureAttempts: number;
  readonly leaseExpiresAt: Date;
  readonly createdAt: Date;
}

export abstract class KnowledgeIngestionJobRepository {
  abstract claim(input: {
    readonly workerId: string;
    readonly batchSize: number;
    readonly claimTtlMs: number;
  }): Promise<readonly ClaimedKnowledgeIngestionJob[]>;

  abstract renewLease(input: {
    readonly jobId: string;
    readonly workerId: string;
    readonly claimTtlMs: number;
  }): Promise<boolean>;

  abstract ownsLease(input: {
    readonly jobId: string;
    readonly workerId: string;
  }): Promise<boolean>;

  abstract releaseForRetry(input: {
    readonly jobId: string;
    readonly workerId: string;
    readonly availableAt: Date;
    readonly errorCode: string;
    readonly errorMessage: string;
  }): Promise<boolean>;
}
