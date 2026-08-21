import type { Conversation } from '@enterprise/contracts';
import { createElement, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderInTestDom } from '../../test/dom-test-utils';

vi.mock('./hooks', () => ({
  useAgentRunActions: () => ({ abandon: mutation(), cancel: mutation(), retry: mutation() }),
  useAgentRunStream: () => ({ runId: null, content: '', cursor: 0, phase: 'idle', error: null }),
  useConversationMessages: () => ({
    data: { items: [], runs: [] },
    isPending: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  }),
  useConversationSearch: mutation,
  useConversationStateActions: mutation,
  useImRealtimeSync: vi.fn(),
  useLoadOlderMessages: mutation,
  useSendTextMessage: mutation,
  useAnswerFeedback: vi.fn(),
  useUpsertAnswerFeedback: vi.fn(),
}));

import { ConversationWorkspace } from './MessagingWorkspace';

const currentUserId = '00000000-0000-7000-8000-000000000100';
const conversation: Conversation = {
  id: '00000000-0000-7000-8000-000000000401',
  type: 'direct',
  title: '纪腾达',
  participants: [
    { type: 'user', id: currentUserId, name: '我' },
    { type: 'user', id: '00000000-0000-7000-8000-000000000101', name: '纪腾达' },
    { type: 'agent', id: '00000000-0000-7000-8000-000000000201', name: '纪腾达的智能体' },
  ],
  lastMessageAt: null,
  createdAt: '2026-08-20T01:00:00.000Z',
  updatedAt: '2026-08-20T01:00:00.000Z',
};

describe('ConversationWorkspace response target', () => {
  it('会话数据在发送后刷新时保持当前选择的智能体', async () => {
    const dom = await renderInTestDom(createElement(Harness));

    try {
      const agentButton = buttonNamed(dom.container, '询问 纪腾达的智能体');
      await dom.click(agentButton);
      expect(agentButton.getAttribute('aria-pressed')).toBe('true');

      await dom.click(buttonNamed(dom.container, '模拟发送后的会话刷新'));

      expect(buttonNamed(dom.container, '询问 纪腾达的智能体').getAttribute('aria-pressed')).toBe(
        'true',
      );
      expect(buttonNamed(dom.container, '发给 纪腾达').getAttribute('aria-pressed')).toBe('false');
    } finally {
      await dom.cleanup();
    }
  });
});

function Harness(): React.JSX.Element {
  const [value, setValue] = useState(conversation);
  return createElement(
    'div',
    null,
    createElement(
      'button',
      {
        type: 'button',
        onClick: () => setValue((current) => ({ ...current, updatedAt: new Date().toISOString() })),
      },
      '模拟发送后的会话刷新',
    ),
    createElement(ConversationWorkspace, { conversation: value, currentUserId }),
  );
}

function mutation() {
  return {
    mutate: vi.fn(),
    reset: vi.fn(),
    isPending: false,
    isError: false,
    error: null,
    data: undefined,
  };
}

function buttonNamed(container: HTMLElement, name: string): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')].find((candidate) =>
    candidate.textContent?.includes(name),
  );
  if (button?.tagName !== 'BUTTON') throw new Error(`未找到按钮：${name}`);
  return button as HTMLButtonElement;
}
