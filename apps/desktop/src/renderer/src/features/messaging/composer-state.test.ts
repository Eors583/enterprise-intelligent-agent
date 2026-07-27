import type { CreateMessageRequest } from '@enterprise/contracts';
import { describe, expect, it } from 'vitest';
import { composerReducer, createClientMessageId, initialComposerState } from './composer-state';

const request: CreateMessageRequest = {
  clientMessageId: '018f54d0-58f4-7d10-9f87-7bf5cd772401',
  content: { type: 'text', text: '请同步项目进展' },
};

describe('composerReducer', () => {
  it('使用运行环境的安全 UUID 生成消息幂等键', () => {
    expect(createClientMessageId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it('发送失败后保留同一个幂等请求供重试', () => {
    const editing = composerReducer(initialComposerState, {
      type: 'draftChanged',
      value: '请同步项目进展',
    });
    const failed = composerReducer(editing, { type: 'sendFailed', request });

    expect(failed.draft).toBe('请同步项目进展');
    expect(failed.failedRequest).toBe(request);
    expect(failed.failedRequest?.clientMessageId).toBe(request.clientMessageId);
  });

  it('服务端确认当前文本后清空输入框', () => {
    const editing = { draft: '  请同步项目进展  ', failedRequest: request };
    expect(composerReducer(editing, { type: 'sendSucceeded', request })).toEqual(
      initialComposerState,
    );
  });
});
