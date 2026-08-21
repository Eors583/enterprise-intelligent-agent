import type { AgentRunStreamPage } from '@enterprise/contracts';

export interface AppendAgentRunDelta {
  readonly tenantId: string;
  readonly runId: string;
  readonly sequence: number;
  readonly eventId: string;
  readonly delta: string;
  readonly deltaHash: string;
  readonly createdAt: Date;
}

export abstract class AgentRunStreamRepository {
  abstract cursor(tenantId: string, runId: string): Promise<number>;

  abstract appendDelta(input: AppendAgentRunDelta): Promise<void>;

  abstract listForParticipant(input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly conversationId: string;
    readonly runId: string;
    readonly cursor: number;
    readonly limit: number;
  }): Promise<AgentRunStreamPage | null>;
}
