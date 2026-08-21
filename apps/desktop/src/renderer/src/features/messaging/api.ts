import {
  AGENT_RUN_STREAM_MAX_CURSOR,
  answerFeedbackSchema,
  agentRunResponseSchema,
  agentRunStreamPageSchema,
  conversationListResponseSchema,
  conversationSchema,
  conversationListQuerySchema,
  createConversationRequestSchema,
  createMessageRequestSchema,
  currentAnswerFeedbackResponseSchema,
  knowledgeCitationDetailSchema,
  messageListResponseSchema,
  messageSearchResponseSchema,
  messageSchema,
  updateConversationStateRequestSchema,
  updateGroupMembersRequestSchema,
  updateGroupRequestSchema,
  upsertAnswerFeedbackRequestSchema,
  type AnswerFeedback,
  type Conversation,
  type ConversationListQuery,
  type AgentRunResponse,
  type AgentRunStreamPage,
  type CreateConversationRequest,
  type CreateMessageRequest,
  type CurrentAnswerFeedbackResponse,
  type KnowledgeCitationDetail,
  type Message,
  type MessageSearchResponse,
  type MessageListResponse,
  type UpdateConversationStateRequest,
  type UpdateGroupMembersRequest,
  type UpdateGroupRequest,
  type UpsertAnswerFeedbackRequest,
} from '@enterprise/contracts';
import { z } from 'zod';
import { apiRequest } from '../../shared/api/client';

const resourceIdSchema = z.string().uuid();

export async function listConversations(
  signal?: AbortSignal,
  apiBaseUrl?: string,
  query: Partial<ConversationListQuery> = {},
): Promise<Conversation[]> {
  const parsed = conversationListQuerySchema.parse(query);
  const search = new URLSearchParams();
  if (parsed.query !== undefined) search.set('query', parsed.query);
  if (parsed.includeArchived) search.set('includeArchived', 'true');
  const response = await apiRequest(
    `/api/v1/conversations${search.size === 0 ? '' : `?${search.toString()}`}`,
    {
      schema: conversationListResponseSchema,
      ...(signal ? { signal } : {}),
      ...(apiBaseUrl ? { apiBaseUrl } : {}),
    },
  );
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

export async function abandonUnknownAgentRun(
  conversationId: string,
  runId: string,
  signal?: AbortSignal,
): Promise<AgentRunResponse> {
  return runAction(conversationId, runId, 'abandon', signal);
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
  action: 'abandon' | 'cancel' | 'retry',
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
  page: { readonly before?: string; readonly limit?: number } = {},
): Promise<MessageListResponse> {
  const validatedId = resourceIdSchema.parse(conversationId);
  const search = new URLSearchParams();
  if (page.before !== undefined) search.set('before', resourceIdSchema.parse(page.before));
  if (page.limit !== undefined) search.set('limit', String(page.limit));
  const response = await apiRequest(
    `/api/v1/conversations/${encodeURIComponent(validatedId)}/messages${search.size === 0 ? '' : `?${search.toString()}`}`,
    {
      schema: messageListResponseSchema,
      ...(signal ? { signal } : {}),
      ...(apiBaseUrl ? { apiBaseUrl } : {}),
    },
  );
  return response;
}

export async function searchConversationMessages(
  conversationId: string,
  query: string,
  signal?: AbortSignal,
): Promise<MessageSearchResponse> {
  const validatedId = resourceIdSchema.parse(conversationId);
  const search = new URLSearchParams({ query, limit: '30' });
  return apiRequest(
    `/api/v1/conversations/${encodeURIComponent(validatedId)}/messages/search?${search.toString()}`,
    {
      schema: messageSearchResponseSchema,
      ...(signal ? { signal } : {}),
    },
  );
}

export async function markConversationRead(
  conversationId: string,
  lastMessageId?: string,
): Promise<Conversation> {
  const validatedId = resourceIdSchema.parse(conversationId);
  return apiRequest(`/api/v1/conversations/${encodeURIComponent(validatedId)}/read`, {
    method: 'POST',
    body:
      lastMessageId === undefined ? {} : { lastMessageId: resourceIdSchema.parse(lastMessageId) },
    schema: conversationSchema,
  });
}

export async function updateConversationState(
  conversationId: string,
  input: UpdateConversationStateRequest,
): Promise<Conversation> {
  const validatedId = resourceIdSchema.parse(conversationId);
  return apiRequest(`/api/v1/conversations/${encodeURIComponent(validatedId)}/state`, {
    method: 'PATCH',
    body: updateConversationStateRequestSchema.parse(input),
    schema: conversationSchema,
  });
}

export async function renameGroupConversation(
  conversationId: string,
  input: UpdateGroupRequest,
): Promise<Conversation> {
  const validatedId = resourceIdSchema.parse(conversationId);
  return apiRequest(`/api/v1/conversations/${encodeURIComponent(validatedId)}/group`, {
    method: 'PATCH',
    body: updateGroupRequestSchema.parse(input),
    schema: conversationSchema,
  });
}

export async function changeGroupMembers(
  conversationId: string,
  input: UpdateGroupMembersRequest,
): Promise<Conversation> {
  const validatedId = resourceIdSchema.parse(conversationId);
  return apiRequest(`/api/v1/conversations/${encodeURIComponent(validatedId)}/group/members`, {
    method: 'PATCH',
    body: updateGroupMembersRequestSchema.parse(input),
    schema: conversationSchema,
  });
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
