import type { PreparedAgentRun } from './agent-run.models.js';
import type { AgentRunModelAttempt, AgentRunUsage } from './agent-run.models.js';

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
  readonly modelAttempts?: readonly AgentRunModelAttempt[];
  readonly outputSafetyDecision?: import('@enterprise/contracts').AiSafetyDecision;
  readonly error?: {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
  };
}

export type RuntimeStreamEvent =
  | {
      readonly type: 'delta';
      readonly sequence: number;
      readonly eventId: string;
      readonly delta: string;
      readonly deltaHash: string;
      readonly createdAt: Date;
    }
  | {
      readonly type: 'terminal' | 'terminal_only';
      readonly sequence: number;
      readonly eventId: string;
      readonly result: RuntimeRunResult;
      readonly createdAt: Date;
    };

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

  async *stream(
    run: PreparedAgentRun,
    externalRunId: string,
    cursor: number,
    signal: AbortSignal,
  ): AsyncIterable<RuntimeStreamEvent> {
    if (cursor !== 0) {
      throw new AgentRuntimeRequestError(
        'AI_RUNTIME_STREAM_RESUME_UNSUPPORTED',
        'The configured Runtime client cannot safely resume streaming.',
        'unknown',
      );
    }
    const result = await this.execute(run, externalRunId, signal);
    yield {
      type: 'terminal_only',
      sequence: 1,
      eventId: `${externalRunId}:1`,
      result,
      createdAt: new Date(),
    };
  }

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
