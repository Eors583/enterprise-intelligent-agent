import type {
  AnswerFeedback,
  Conversation,
  CreateConversationRequest,
  CreateMessageRequest,
  Message,
  MessageListResponse,
  UpsertAnswerFeedbackRequest,
} from '@enterprise/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import {
  cancelAgentRun,
  createDirectConversation,
  getAnswerFeedback,
  listConversations,
  listMessages,
  retryAgentRun,
  sendTextMessage,
  upsertAnswerFeedback,
} from './api';
import { messagingSyncOptions, type WindowActivity } from './sync-policy';
import { useWindowActivity } from './use-window-activity';

export const conversationQueryKeys = {
  all: ['conversations'] as const,
  messages: (conversationId: string) => ['conversations', conversationId, 'messages'] as const,
  feedback: (messageId: string) => ['messages', messageId, 'feedback'] as const,
};

export function useConversations(enabled = true) {
  const activity = useWindowActivity();
  const query = useQuery({
    queryKey: conversationQueryKeys.all,
    queryFn: ({ signal }) => listConversations(signal),
    enabled,
    staleTime: 15_000,
    ...messagingSyncOptions('conversations', activity, enabled),
  });
  useImmediateRefetchOnFocus(activity, enabled, query.refetch);
  return query;
}

export function useConversationMessages(conversationId: string | null, enabled = true) {
  const activity = useWindowActivity();
  const queryEnabled = enabled && conversationId !== null;
  const query = useQuery({
    queryKey: conversationQueryKeys.messages(conversationId ?? 'none'),
    queryFn: ({ signal }) => listMessages(conversationId!, signal),
    enabled: queryEnabled,
    staleTime: 5_000,
    ...messagingSyncOptions('messages', activity, queryEnabled),
  });
  useImmediateRefetchOnFocus(activity, queryEnabled, query.refetch);
  return query;
}

export function useCreateDirectConversation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (request: CreateConversationRequest) => createDirectConversation(request),
    onSuccess: async (conversation) => {
      await queryClient.cancelQueries({ queryKey: conversationQueryKeys.all, exact: true });
      queryClient.setQueryData<Conversation[]>(conversationQueryKeys.all, (current = []) => [
        conversation,
        ...current.filter((item) => item.id !== conversation.id),
      ]);
      void queryClient.invalidateQueries({ queryKey: conversationQueryKeys.all });
    },
  });
}

export function useSendTextMessage(conversationId: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (request: CreateMessageRequest) => sendTextMessage(conversationId!, request),
    onSuccess: async (message) => {
      if (!conversationId) return;
      await queryClient.cancelQueries({
        queryKey: conversationQueryKeys.messages(conversationId),
        exact: true,
      });
      queryClient.setQueryData<MessageListResponse>(
        conversationQueryKeys.messages(conversationId),
        (current = { items: [], runs: [] }) => ({
          ...current,
          items: current.items.some(
            (item) => item.id === message.id || item.clientMessageId === message.clientMessageId,
          )
            ? current.items.map((item) =>
                item.id === message.id || item.clientMessageId === message.clientMessageId
                  ? message
                  : item,
              )
            : [...current.items, message],
        }),
      );
      queryClient.setQueryData<Conversation[]>(conversationQueryKeys.all, (current = []) => {
        const updated = current.find((item) => item.id === conversationId);
        if (!updated) return current;
        return [
          { ...updated, lastMessageAt: message.createdAt, updatedAt: message.createdAt },
          ...current.filter((item) => item.id !== conversationId),
        ];
      });
      void queryClient.invalidateQueries({ queryKey: conversationQueryKeys.all });
    },
  });
}

export function useAgentRunActions(conversationId: string | null) {
  const queryClient = useQueryClient();
  const invalidate = async (): Promise<void> => {
    if (conversationId) {
      await queryClient.invalidateQueries({
        queryKey: conversationQueryKeys.messages(conversationId),
      });
    }
  };
  const cancel = useMutation({
    mutationFn: (runId: string) => cancelAgentRun(conversationId!, runId),
    onSuccess: invalidate,
  });
  const retry = useMutation({
    mutationFn: (runId: string) => retryAgentRun(conversationId!, runId),
    onSuccess: invalidate,
  });
  return { cancel, retry };
}

export function useAnswerFeedback(messageId: string, enabled = true) {
  return useQuery({
    queryKey: conversationQueryKeys.feedback(messageId),
    queryFn: ({ signal }) => getAnswerFeedback(messageId, signal),
    enabled,
    staleTime: 60_000,
    retry: false,
  });
}

export function useUpsertAnswerFeedback(messageId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request: UpsertAnswerFeedbackRequest) => upsertAnswerFeedback(messageId, request),
    onSuccess: (feedback: AnswerFeedback) => {
      queryClient.setQueryData(conversationQueryKeys.feedback(messageId), { feedback });
    },
  });
}

function useImmediateRefetchOnFocus(
  activity: WindowActivity,
  enabled: boolean,
  refetch: () => Promise<unknown>,
): void {
  const wasFocused = useRef(activity === 'focused');

  useEffect(() => {
    const regainedFocus = activity === 'focused' && !wasFocused.current;
    wasFocused.current = activity === 'focused';
    if (enabled && regainedFocus) void refetch();
  }, [activity, enabled, refetch]);
}
