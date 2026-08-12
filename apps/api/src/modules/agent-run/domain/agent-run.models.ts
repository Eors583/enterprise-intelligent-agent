export const AGENT_RUN_REQUESTED_EVENT_TYPE = 'agent.run_requested.v1' as const;
export const AGENT_RUN_CANCEL_REQUESTED_EVENT_TYPE = 'agent.run_cancel_requested.v1' as const;
export const ROLE_ASSIGNMENT_REVOKED_AGENT_RUN_ERROR_CODE = 'ROLE_ASSIGNMENT_REVOKED' as const;

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
  readonly sourceType: 'TEXT' | 'MARKDOWN' | 'FILE' | 'WEB';
  readonly excerpt: string;
  readonly classification: import('@enterprise/contracts').AiDataClassification;
  readonly governanceHash: string;
  readonly contentHash: string;
  readonly updatedAt: string;
}

export interface AgentRunMemoryContext {
  readonly id: string;
  readonly version: number;
  readonly revision: number;
  readonly scope: 'ENTERPRISE' | 'ROLE' | 'EMPLOYEE_PRIVATE' | 'TASK' | 'CONVERSATION';
  readonly title: string;
  readonly summary: string;
  readonly summarySha256: string;
  readonly contentHash: string;
  readonly sourceType:
    | 'KNOWLEDGE'
    | 'ROLE_VERSION'
    | 'TASK'
    | 'CONVERSATION'
    | 'DELIVERABLE'
    | 'EXPERIENCE'
    | 'USER_CONFIRMED';
  readonly sourceId: string;
  readonly sourceVersion: number;
  readonly sensitivity: 'PUBLIC' | 'INTERNAL' | 'CONFIDENTIAL' | 'RESTRICTED';
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly expiresAt: string | null;
  readonly updatedAt: string;
}

export interface AgentRunMemoryContextSnapshot {
  readonly schemaVersion: 1;
  readonly purpose: 'AGENT_RUN_CONTEXT';
  readonly resolvedAt: string;
  readonly contexts: readonly AgentRunMemoryContext[];
  readonly snapshotSha256: string;
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
  readonly maxSteps?: number;
  readonly maxToolCalls?: number;
  readonly timeoutMs?: number;
  readonly maxCostMicros?: number;
  readonly messages: readonly AgentRunContextMessage[];
  readonly knowledgeSources?: readonly AgentRunKnowledgeSource[];
  readonly memoryContexts?: readonly AgentRunMemoryContext[];
  readonly knowledgeGroundingRequired?: boolean;
  readonly knowledgeEvidenceFallbackEnabled?: boolean;
  readonly controlledModelConnectivityProbe?: boolean;
  readonly modelRoute?: import('@enterprise/contracts').TrustedModelRouteSnapshot;
  readonly inputSafetyDecision?: import('@enterprise/contracts').AiSafetyDecision;
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

export type AgentRunExternalAttachment = 'attached' | 'cancellation_required';

export type AgentRunCancellationPreparation =
  | { readonly kind: 'ready'; readonly externalRunId: string }
  | { readonly kind: 'deferred'; readonly reasonCode: string; readonly availableAt?: Date }
  | { readonly kind: 'complete'; readonly externalRunId: string | null };

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

export interface AgentRunModelAttempt {
  readonly attemptNumber: number;
  readonly catalogVersionId: string;
  readonly routeKey: string;
  readonly provider: 'OPENAI_COMPATIBLE' | 'MANUS';
  readonly model: string;
  readonly outcome: 'SUCCEEDED' | 'FAILED' | 'UNKNOWN' | 'REJECTED';
  readonly reasonCode: string | null;
  readonly retrySafe: boolean;
  readonly startedAt: Date;
  readonly finishedAt: Date;
}

export type AgentRunStreamMode = 'live' | 'terminal_only';

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

export function parseAgentRunCancelRequestedEvent(event: ClaimedAgentRunEvent): string {
  if (
    event.eventType !== AGENT_RUN_CANCEL_REQUESTED_EVENT_TYPE ||
    event.aggregateId.length === 0 ||
    typeof event.payload !== 'object' ||
    event.payload === null ||
    Array.isArray(event.payload) ||
    typeof Reflect.get(event.payload, 'runId') !== 'string' ||
    Reflect.get(event.payload, 'runId') !== event.aggregateId
  ) {
    throw new Error('Agent Run cancellation outbox event validation failed.');
  }
  return event.aggregateId;
}
