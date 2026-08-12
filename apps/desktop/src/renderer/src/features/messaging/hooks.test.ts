import type { Message } from '@enterprise/contracts';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderInTestDom } from '../../test/dom-test-utils';

const { listMessagesMock, sendTextMessageMock } = vi.hoisted(() => ({
  listMessagesMock: vi.fn(),
  sendTextMessageMock: vi.fn(),
}));

vi.mock('./api', () => ({
  cancelAgentRun: vi.fn(),
  changeGroupMembers: vi.fn(),
  createDirectConversation: vi.fn(),
  getAnswerFeedback: vi.fn(),
  listConversations: vi.fn(),
  listMessages: listMessagesMock,
  markConversationRead: vi.fn().mockResolvedValue({}),
  renameGroupConversation: vi.fn(),
  retryAgentRun: vi.fn(),
  searchConversationMessages: vi.fn(),
  sendTextMessage: sendTextMessageMock,
  updateConversationState: vi.fn(),
  upsertAnswerFeedback: vi.fn(),
}));

import { conversationQueryKeys, useSendTextMessage } from './hooks';

const CONVERSATION_ID = '00000000-0000-7000-8000-000000000401';
const AGENT_ID = '00000000-0000-7000-8000-000000000402';
const MESSAGE: Message = {
  id: '00000000-0000-7000-8000-000000000403',
  conversationId: CONVERSATION_ID,
  sender: {
    type: 'user',
    id: '00000000-0000-7000-8000-000000000404',
    name: 'Requester',
  },
  clientMessageId: '00000000-0000-7000-8000-000000000405',
  content: { type: 'text', text: '请回答。' },
  responseTarget: { type: 'agent', agentId: AGENT_ID },
  createdAt: '2026-08-12T01:00:00.000Z',
};

beforeEach(() => {
  listMessagesMock.mockReset();
  sendTextMessageMock.mockReset();
  listMessagesMock.mockResolvedValue({ items: [MESSAGE], runs: [] });
  sendTextMessageMock.mockResolvedValue(MESSAGE);
});

describe('messaging send synchronization', () => {
  it('refreshes the active message snapshot immediately after the server creates its Agent Run', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const dom = await renderInTestDom(
      createElement(QueryClientProvider, { client: queryClient }, createElement(SendHarness)),
    );

    try {
      await dom.flush();
      expect(listMessagesMock).toHaveBeenCalledTimes(1);
      const callsBeforeSend = listMessagesMock.mock.calls.length;

      const button = dom.container.querySelector('button');
      expect(button).not.toBeNull();
      if (button) await dom.click(button);
      await dom.flush();
      await dom.flush();

      expect(sendTextMessageMock).toHaveBeenCalledTimes(1);
      expect(listMessagesMock.mock.calls.length).toBeGreaterThan(callsBeforeSend);
    } finally {
      queryClient.clear();
      await dom.cleanup();
    }
  });
});

function SendHarness(): React.JSX.Element {
  useQuery({
    queryKey: conversationQueryKeys.messages(CONVERSATION_ID),
    queryFn: () => listMessagesMock(),
  });
  const send = useSendTextMessage(CONVERSATION_ID);
  return createElement(
    'button',
    {
      type: 'button',
      onClick: () =>
        send.mutate({
          clientMessageId: MESSAGE.clientMessageId,
          content: MESSAGE.content,
          responseTarget: { type: 'agent', agentId: AGENT_ID },
        }),
    },
    'send',
  );
}
