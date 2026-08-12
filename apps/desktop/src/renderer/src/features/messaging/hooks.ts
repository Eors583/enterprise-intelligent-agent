import type {
  AnswerFeedback,
  Conversation,
  ConversationAgentRun,
  CreateConversationRequest,
  CreateMessageRequest,
  Message,
  MessageListResponse,
  UpdateConversationStateRequest,
  UpsertAnswerFeedbackRequest,
} from '@enterprise/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import {
  cancelAgentRun,
  changeGroupMembers,
  createDirectConversation,
  getAnswerFeedback,
  listConversations,
  listMessages,
  markConversationRead,
  renameGroupConversation,
  retryAgentRun,
  searchConversationMessages,
  sendTextMessage,
  updateConversationState,
  upsertAnswerFeedback,
} from './api';
import { getExpectedDesktopSessionId } from '../../shared/api/client';
import { messagingSyncOptions, type WindowActivity } from './sync-policy';
import {
  applyAgentRunStreamPage,
  type AgentRunStreamAccumulator,
  type AgentRunStreamPhase,
} from './stream-state';
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
  const queryClient = useQueryClient();
  const queryEnabled = enabled && conversationId !== null;
  const query = useQuery({
    queryKey: conversationQueryKeys.messages(conversationId ?? 'none'),
    queryFn: ({ signal }) => listMessages(conversationId!, signal),
    enabled: queryEnabled,
    staleTime: 5_000,
    ...messagingSyncOptions('messages', activity, queryEnabled),
  });
  useImmediateRefetchOnFocus(activity, queryEnabled, query.refetch);
  const latestMessageId = query.data?.items.at(-1)?.id;
  const markedReadRef = useRef<string | null>(null);
  useEffect(() => {
    if (
      activity !== 'focused' ||
      conversationId === null ||
      latestMessageId === undefined ||
      markedReadRef.current === `${conversationId}:${latestMessageId}`
    ) {
      return;
    }
    markedReadRef.current = `${conversationId}:${latestMessageId}`;
    void markConversationRead(conversationId, latestMessageId)
      .then(() => queryClient.invalidateQueries({ queryKey: conversationQueryKeys.all }))
      .catch(() => {
        markedReadRef.current = null;
      });
  }, [activity, conversationId, latestMessageId, queryClient]);
  return query;
}

export function useLoadOlderMessages(conversationId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (before: string) =>
      listMessages(conversationId!, undefined, undefined, { before, limit: 50 }),
    onSuccess: (older) => {
      if (conversationId === null) return;
      queryClient.setQueryData<MessageListResponse>(
        conversationQueryKeys.messages(conversationId),
        (current = { items: [], runs: [] }) => ({
          ...current,
          items: [
            ...older.items,
            ...current.items.filter(
              (message) => !older.items.some((olderMessage) => olderMessage.id === message.id),
            ),
          ],
          runs: [
            ...older.runs,
            ...current.runs.filter((run) => !older.runs.some((olderRun) => olderRun.id === run.id)),
          ],
          nextCursor: older.nextCursor ?? null,
          hasMore: older.hasMore ?? false,
        }),
      );
    },
  });
}

export function useConversationSearch(conversationId: string | null) {
  return useMutation({
    mutationFn: (query: string) => searchConversationMessages(conversationId!, query),
  });
}

export function useConversationStateActions() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      conversationId,
      request,
    }: {
      conversationId: string;
      request: UpdateConversationStateRequest;
    }) => updateConversationState(conversationId, request),
    onSuccess: (conversation) => {
      queryClient.setQueryData<Conversation[]>(conversationQueryKeys.all, (current = []) =>
        current.map((item) => (item.id === conversation.id ? conversation : item)),
      );
      void queryClient.invalidateQueries({ queryKey: conversationQueryKeys.all });
    },
  });
}

export function useGroupActions(conversationId: string | null) {
  const queryClient = useQueryClient();
  const commit = (conversation: Conversation): void => {
    queryClient.setQueryData<Conversation[]>(conversationQueryKeys.all, (current = []) =>
      current.map((item) => (item.id === conversation.id ? conversation : item)),
    );
  };
  const rename = useMutation({
    mutationFn: (title: string) => renameGroupConversation(conversationId!, { title }),
    onSuccess: commit,
  });
  const members = useMutation({
    mutationFn: (request: Parameters<typeof changeGroupMembers>[1]) =>
      changeGroupMembers(conversationId!, request),
    onSuccess: commit,
  });
  return { rename, members };
}

/**
 * WuKongIM supplies low-latency wake-ups while PostgreSQL remains the trusted
 * read model. Every notification causes a contract-validated API refresh;
 * payload data from the transport is never rendered as authoritative content.
 */
export function useImRealtimeSync(enabled = true): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!enabled) return undefined;
    const expectedSessionId = getExpectedDesktopSessionId();
    if (
      expectedSessionId === null ||
      typeof window.enterpriseDesktop?.subscribeImRealtime !== 'function'
    ) {
      return undefined;
    }
    return window.enterpriseDesktop.subscribeImRealtime({ expectedSessionId }, (update) => {
      if (update.kind !== 'message') return;
      void queryClient.invalidateQueries({ queryKey: conversationQueryKeys.all, exact: true });
      if (update.conversationId !== null) {
        void queryClient.invalidateQueries({
          queryKey: conversationQueryKeys.messages(update.conversationId),
          exact: true,
        });
      } else {
        void queryClient.invalidateQueries({ queryKey: ['conversations'] });
      }
    });
  }, [enabled, queryClient]);
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
      // The message transaction also creates the Agent Run. Refresh this active
      // conversation immediately so streaming does not wait for the next poll.
      void queryClient.invalidateQueries({
        queryKey: conversationQueryKeys.messages(conversationId),
        exact: true,
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

export type { AgentRunStreamPhase } from './stream-state';

export interface AgentRunStreamView {
  readonly runId: string | null;
  readonly content: string;
  readonly cursor: number;
  readonly phase: AgentRunStreamPhase;
  readonly error: string | null;
}

const EMPTY_STREAM: AgentRunStreamView = {
  runId: null,
  content: '',
  cursor: 0,
  phase: 'idle',
  error: null,
};

export function useAgentRunStream(
  conversationId: string | null,
  run: ConversationAgentRun | undefined,
): AgentRunStreamView {
  const queryClient = useQueryClient();
  const [view, setView] = useState<AgentRunStreamView>(EMPTY_STREAM);

  useEffect(() => {
    if (conversationId === null || run === undefined) {
      setView(EMPTY_STREAM);
      return undefined;
    }
    let accumulator: AgentRunStreamAccumulator = {
      cursor: 0,
      content: '',
      caughtUp: false,
    };
    let active = true;
    setView({
      runId: run.id,
      content: accumulator.content,
      cursor: accumulator.cursor,
      phase: 'replaying',
      error: null,
    });
    const expectedSessionId = getExpectedDesktopSessionId();
    if (
      expectedSessionId === null ||
      typeof window.enterpriseDesktop?.subscribeAgentRunStream !== 'function'
    ) {
      setView({
        runId: run.id,
        content: '',
        cursor: 0,
        phase: 'offline',
        error: '桌面端实时事件桥接尚未就绪，请重启或更新客户端。',
      });
      return undefined;
    }
    const unsubscribe = window.enterpriseDesktop.subscribeAgentRunStream(
      {
        conversationId,
        runId: run.id,
        expectedSessionId,
        cursor: accumulator.cursor,
      },
      (update) => {
        if (!active) return;
        if (update.kind === 'event') {
          const terminal = update.event.type !== 'delta' && update.event.status !== 'UNKNOWN';
          try {
            const applied = applyAgentRunStreamPage(accumulator, {
              items: [update.event],
              nextCursor: update.event.sequence,
              terminal,
            });
            accumulator = applied.state;
            setView({
              runId: run.id,
              content: accumulator.content,
              cursor: accumulator.cursor,
              phase: applied.phase,
              error: null,
            });
            if (terminal) {
              void queryClient.invalidateQueries({
                queryKey: conversationQueryKeys.messages(conversationId),
              });
            }
          } catch (error) {
            setView({
              runId: run.id,
              content: accumulator.content,
              cursor: accumulator.cursor,
              phase: 'offline',
              error: error instanceof Error ? error.message : '实时事件校验失败。',
            });
          }
          return;
        }
        if (update.state === 'closed' && update.error === undefined) return;
        setView({
          runId: run.id,
          content: accumulator.content,
          cursor: accumulator.cursor,
          phase:
            update.state === 'reconnecting' || (update.state === 'closed' && update.error)
              ? 'offline'
              : accumulator.caughtUp
                ? 'live'
                : 'replaying',
          error:
            update.error ??
            (update.state === 'reconnecting' ? '实时连接中断，正在安全续传。' : null),
        });
      },
    );
    return () => {
      active = false;
      unsubscribe();
    };
  }, [conversationId, queryClient, run?.id]);

  return view;
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
