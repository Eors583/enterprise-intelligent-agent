import type { PreparedAgentRun } from './agent-run.models.js';
import type { AgentRunUsage } from './agent-run.models.js';

export type RuntimeRunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface RuntimeRunResult {
  readonly runId: string;
  readonly status: RuntimeRunStatus;
  readonly output?: {
    readonly content: string;
    readonly model: string;
    readonly provider: string;
  };
  readonly usage?: Omit<AgentRunUsage, 'provider' | 'model'>;
  readonly error?: {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
  };
}

export class AgentRuntimeRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly outcome: 'failed' | 'unknown',
  ) {
    super(message);
    this.name = 'AgentRuntimeRequestError';
  }
}

export abstract class AgentRuntimeClient {
  abstract create(run: PreparedAgentRun, signal: AbortSignal): Promise<RuntimeRunResult>;

  abstract execute(
    run: PreparedAgentRun,
    externalRunId: string,
    signal: AbortSignal,
  ): Promise<RuntimeRunResult>;

  abstract get(
    tenantId: string,
    externalRunId: string,
    signal: AbortSignal,
  ): Promise<RuntimeRunResult>;

  abstract cancel(
    tenantId: string,
    externalRunId: string,
    signal: AbortSignal,
  ): Promise<RuntimeRunResult>;
}
