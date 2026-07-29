import {
  AGENT_RUN_STREAM_MAX_CURSOR,
  answerFeedbackSchema,
  agentRunResponseSchema,
  agentRunStreamPageSchema,
  conversationListResponseSchema,
  conversationSchema,
  createConversationRequestSchema,
  createMessageRequestSchema,
  currentAnswerFeedbackResponseSchema,
  knowledgeCitationDetailSchema,
  messageListResponseSchema,
  messageSchema,
  upsertAnswerFeedbackRequestSchema,
  type AnswerFeedback,
  type Conversation,
  type AgentRunResponse,
  type AgentRunStreamPage,
  type CreateConversationRequest,
  type CreateMessageRequest,
  type CurrentAnswerFeedbackResponse,
  type KnowledgeCitationDetail,
  type Message,
  type MessageListResponse,
  type UpsertAnswerFeedbackRequest,
} from '@enterprise/contracts';
import { z } from 'zod';
import { apiRequest } from '../../shared/api/client';

const resourceIdSchema = z.string().uuid();

export async function listConversations(
  signal?: AbortSignal,
  apiBaseUrl?: string,
): Promise<Conversation[]> {
  const response = await apiRequest('/api/v1/conversations', {
    schema: conversationListResponseSchema,
    ...(signal ? { signal } : {}),
    ...(apiBaseUrl ? { apiBaseUrl } : {}),
  });
  return response.items;
}

export async function cancelAgentRun(
  conversationId: string,
  runId: string,
  signal?: AbortSignal,
): Promise<AgentRunResponse> {
  return runAction(conversationId, runId, 'cancel', signal);
}

export async function retryAgentRun(
  conversationId: string,
  runId: string,
  signal?: AbortSignal,
): Promise<AgentRunResponse> {
  return runAction(conversationId, runId, 'retry', signal);
}

export async function listAgentRunStreamEvents(
  conversationId: string,
  runId: string,
  cursor: number,
  signal?: AbortSignal,
  apiBaseUrl?: string,
): Promise<AgentRunStreamPage> {
  const validatedConversationId = resourceIdSchema.parse(conversationId);
  const validatedRunId = resourceIdSchema.parse(runId);
  if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > AGENT_RUN_STREAM_MAX_CURSOR) {
    throw new Error('Agent Run stream cursor is invalid.');
  }
  return apiRequest(
    `/api/v1/conversations/${encodeURIComponent(validatedConversationId)}/runs/${encodeURIComponent(validatedRunId)}/events?cursor=${cursor}&limit=128`,
    {
      schema: agentRunStreamPageSchema,
      ...(signal ? { signal } : {}),
      ...(apiBaseUrl ? { apiBaseUrl } : {}),
    },
  );
}

async function runAction(
  conversationId: string,
  runId: string,
  action: 'cancel' | 'retry',
  signal?: AbortSignal,
): Promise<AgentRunResponse> {
  const validatedConversationId = resourceIdSchema.parse(conversationId);
  const validatedRunId = resourceIdSchema.parse(runId);
  return apiRequest(
    `/api/v1/conversations/${encodeURIComponent(validatedConversationId)}/runs/${encodeURIComponent(validatedRunId)}/${action}`,
    {
      method: 'POST',
      schema: agentRunResponseSchema,
      ...(signal ? { signal } : {}),
    },
  );
}

export async function createDirectConversation(
  input: CreateConversationRequest,
  signal?: AbortSignal,
  apiBaseUrl?: string,
): Promise<Conversation> {
  const body = createConversationRequestSchema.parse(input);
  return apiRequest('/api/v1/conversations', {
    method: 'POST',
    body,
    schema: conversationSchema,
    ...(signal ? { signal } : {}),
    ...(apiBaseUrl ? { apiBaseUrl } : {}),
  });
}

export async function listMessages(
  conversationId: string,
  signal?: AbortSignal,
  apiBaseUrl?: string,
): Promise<MessageListResponse> {
  const validatedId = resourceIdSchema.parse(conversationId);
  const response = await apiRequest(
    `/api/v1/conversations/${encodeURIComponent(validatedId)}/messages`,
    {
      schema: messageListResponseSchema,
      ...(signal ? { signal } : {}),
      ...(apiBaseUrl ? { apiBaseUrl } : {}),
    },
  );
  return response;
}

export async function getKnowledgeCitationOriginal(
  messageId: string,
  documentVersionId: string,
  chunkId: string,
  signal?: AbortSignal,
  apiBaseUrl?: string,
): Promise<KnowledgeCitationDetail> {
  const validatedMessageId = resourceIdSchema.parse(messageId);
  const validatedVersionId = resourceIdSchema.parse(documentVersionId);
  const validatedChunkId = resourceIdSchema.parse(chunkId);
  return apiRequest(
    `/api/v1/knowledge-citations/${encodeURIComponent(validatedVersionId)}/chunks/${encodeURIComponent(validatedChunkId)}?messageId=${encodeURIComponent(validatedMessageId)}`,
    {
      schema: knowledgeCitationDetailSchema,
      ...(signal ? { signal } : {}),
      ...(apiBaseUrl ? { apiBaseUrl } : {}),
    },
  );
}

export async function getAnswerFeedback(
  messageId: string,
  signal?: AbortSignal,
  apiBaseUrl?: string,
): Promise<CurrentAnswerFeedbackResponse> {
  const validatedMessageId = resourceIdSchema.parse(messageId);
  return apiRequest(`/api/v1/messages/${encodeURIComponent(validatedMessageId)}/feedback`, {
    schema: currentAnswerFeedbackResponseSchema,
    ...(signal ? { signal } : {}),
    ...(apiBaseUrl ? { apiBaseUrl } : {}),
  });
}

export async function upsertAnswerFeedback(
  messageId: string,
  input: UpsertAnswerFeedbackRequest,
  signal?: AbortSignal,
  apiBaseUrl?: string,
): Promise<AnswerFeedback> {
  const validatedMessageId = resourceIdSchema.parse(messageId);
  const body = upsertAnswerFeedbackRequestSchema.parse(input);
  return apiRequest(`/api/v1/messages/${encodeURIComponent(validatedMessageId)}/feedback`, {
    method: 'PUT',
    body,
    schema: answerFeedbackSchema,
    ...(signal ? { signal } : {}),
    ...(apiBaseUrl ? { apiBaseUrl } : {}),
  });
}

export async function sendTextMessage(
  conversationId: string,
  input: CreateMessageRequest,
  signal?: AbortSignal,
  apiBaseUrl?: string,
): Promise<Message> {
  const validatedId = resourceIdSchema.parse(conversationId);
  const body = createMessageRequestSchema.parse(input);
  return apiRequest(`/api/v1/conversations/${encodeURIComponent(validatedId)}/messages`, {
    method: 'POST',
    body,
    headers: { 'Idempotency-Key': body.clientMessageId },
    schema: messageSchema,
    ...(signal ? { signal } : {}),
    ...(apiBaseUrl ? { apiBaseUrl } : {}),
  });
}
