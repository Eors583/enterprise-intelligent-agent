export const AGENT_RUN_REQUESTED_EVENT_TYPE = 'agent.run_requested.v1' as const;

export type StoredAgentRunStatus =
  'QUEUED' | 'DISPATCHING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'UNKNOWN' | 'CANCELLED';

export interface ClaimedAgentRunEvent {
  readonly id: string;
  readonly tenantId: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly payload: unknown;
  readonly attempts: number;
  readonly firstAttemptedAt: Date;
  readonly leaseExpiresAt: Date;
  readonly createdAt: Date;
}

export interface AgentRunContextMessage {
  readonly senderType: 'USER' | 'AGENT';
  readonly senderId: string;
  readonly senderName: string;
  readonly text: string;
}

export interface AgentRunKnowledgeSource {
  readonly documentId: string;
  readonly documentVersionId: string;
  readonly chunkId: string;
  readonly knowledgeBaseId: string;
  readonly knowledgeBaseName: string;
  readonly title: string;
  readonly documentVersion: number;
  readonly headingPath: readonly string[];
  readonly sourceType: 'TEXT' | 'MARKDOWN' | 'FILE';
  readonly excerpt: string;
  readonly updatedAt: string;
}

export interface PreparedAgentRun {
  readonly id: string;
  readonly tenantId: string;
  readonly conversationId: string;
  readonly requesterUserId: string;
  readonly requesterRole: string;
  readonly agentId: string;
  readonly agentName: string;
  readonly agentVersionId: string;
  readonly agentVersion: number;
  readonly systemPrompt: string;
  readonly externalRunId: string | null;
  readonly turnIndex: number;
  readonly turnLimit: number;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly messages: readonly AgentRunContextMessage[];
  readonly knowledgeSources?: readonly AgentRunKnowledgeSource[];
  readonly knowledgeGroundingRequired?: boolean;
}

export type AgentRunPreparation =
  | { readonly kind: 'ready'; readonly run: PreparedAgentRun }
  | { readonly kind: 'deferred'; readonly reasonCode: string; readonly availableAt?: Date }
  | {
      readonly kind: 'terminal';
      readonly status: Extract<
        StoredAgentRunStatus,
        'SUCCEEDED' | 'FAILED' | 'UNKNOWN' | 'CANCELLED'
      >;
      readonly externalRunId: string | null;
      readonly errorCode: string | null;
    }
  | { readonly kind: 'ambiguous_dispatch' };

export interface AgentRunUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly toolCalls: number;
  readonly costMicros: number;
  readonly tokensReported: boolean;
  readonly costReported: boolean;
  readonly provider: string | null;
  readonly model: string | null;
}

export function parseAgentRunRequestedEvent(event: ClaimedAgentRunEvent): string {
  if (
    event.eventType !== AGENT_RUN_REQUESTED_EVENT_TYPE ||
    event.aggregateId.length === 0 ||
    typeof event.payload !== 'object' ||
    event.payload === null ||
    Array.isArray(event.payload) ||
    typeof Reflect.get(event.payload, 'runId') !== 'string' ||
    Reflect.get(event.payload, 'runId') !== event.aggregateId
  ) {
    throw new Error('Agent Run outbox event validation failed.');
  }
  return event.aggregateId;
}
