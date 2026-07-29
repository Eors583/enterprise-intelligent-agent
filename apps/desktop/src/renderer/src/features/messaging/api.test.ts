import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDirectConversation,
  getAnswerFeedback,
  getKnowledgeCitationOriginal,
  listAgentRunStreamEvents,
  listConversations,
  sendTextMessage,
  upsertAnswerFeedback,
} from './api';

const currentUserId = '00000000-0000-7000-8000-000000000100';
const targetUserId = '00000000-0000-7000-8000-000000000101';
const firstAgentId = '00000000-0000-7000-8000-000000000201';
const secondAgentId = '00000000-0000-7000-8000-000000000202';
const conversationId = '00000000-0000-7000-8000-000000000401';
const messageId = '00000000-0000-7000-8000-000000000501';
const clientMessageId = '018f54d0-58f4-7d10-9f87-7bf5cd772401';

const conversation = {
  id: conversationId,
  type: 'direct' as const,
  title: '林晓',
  participants: [
    { type: 'user' as const, id: currentUserId, name: '当前用户' },
    { type: 'user' as const, id: targetUserId, name: '林晓' },
  ],
  lastMessageAt: null,
  createdAt: '2026-07-15T01:00:00.000Z',
  updatedAt: '2026-07-15T01:00:00.000Z',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('conversation API', () => {
  it('reads bounded Agent Run stream deltas by cursor', async () => {
    const runId = '00000000-0000-7000-8000-000000000901';
    const page = {
      items: [
        {
          eventId: `${runId}:2`,
          sequence: 2,
          type: 'delta',
          delta: 'world',
          deltaHash: 'a'.repeat(64),
          createdAt: '2026-07-28T08:00:00.000Z',
        },
      ],
      nextCursor: 2,
      terminal: false,
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(page), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      listAgentRunStreamEvents(conversationId, runId, 1, undefined, 'http://localhost:3000'),
    ).resolves.toEqual(page);
    expect(fetchMock).toHaveBeenCalledWith(
      `http://localhost:3000/api/v1/conversations/${conversationId}/runs/${runId}/events?cursor=1&limit=128`,
      expect.objectContaining({ method: 'GET', credentials: 'include' }),
    );
  });

  it('accepts the reserved reconciliation cursor and rejects values beyond it', async () => {
    const runId = '00000000-0000-7000-8000-000000000902';
    const page = {
      items: [],
      nextCursor: 10_001,
      terminal: true,
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(page), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      listAgentRunStreamEvents(conversationId, runId, 10_001, undefined, 'http://localhost:3000'),
    ).resolves.toEqual(page);
    expect(fetchMock).toHaveBeenCalledWith(
      `http://localhost:3000/api/v1/conversations/${conversationId}/runs/${runId}/events?cursor=10001&limit=128`,
      expect.objectContaining({ method: 'GET', credentials: 'include' }),
    );

    await expect(
      listAgentRunStreamEvents(conversationId, runId, 10_002, undefined, 'http://localhost:3000'),
    ).rejects.toThrow('Agent Run stream cursor is invalid.');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('加载并校验会话列表', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ items: [conversation] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(listConversations(undefined, 'http://localhost:3000')).resolves.toEqual([
      conversation,
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:3000/api/v1/conversations',
      expect.objectContaining({ method: 'GET', credentials: 'include' }),
    );
  });

  it('按 direct target 创建或复用真人会话', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(conversation), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await createDirectConversation(
      { type: 'direct', target: { type: 'human', userId: targetUserId } },
      undefined,
      'http://localhost:3000',
    );

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(request.method).toBe('POST');
    expect(JSON.parse(String(request.body))).toEqual({
      type: 'direct',
      target: { type: 'human', userId: targetUserId },
    });
  });

  it('按受控轮次创建两个智能体的协作会话', async () => {
    const agentPairConversation = {
      ...conversation,
      title: '产品智能体 × 研发智能体',
      participants: [
        { type: 'user' as const, id: currentUserId, name: '当前用户' },
        { type: 'agent' as const, id: firstAgentId, name: '产品智能体' },
        { type: 'agent' as const, id: secondAgentId, name: '研发智能体' },
      ],
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(agentPairConversation), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await createDirectConversation(
      {
        type: 'direct',
        target: { type: 'agent_pair', agentIds: [firstAgentId, secondAgentId], turnLimit: 4 },
      },
      undefined,
      'http://localhost:3000',
    );

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).toEqual({
      type: 'direct',
      target: {
        type: 'agent_pair',
        agentIds: [firstAgentId, secondAgentId],
        turnLimit: 4,
      },
    });
  });

  it('发送文本时 body 和 Idempotency-Key 使用同一个 clientMessageId', async () => {
    const message = {
      id: messageId,
      conversationId,
      sender: { type: 'user' as const, id: currentUserId, name: '当前用户' },
      clientMessageId,
      content: { type: 'text' as const, text: '你好' },
      createdAt: '2026-07-15T01:01:00.000Z',
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(message), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await sendTextMessage(
      conversationId,
      { clientMessageId, content: { type: 'text', text: '你好' } },
      undefined,
      'http://localhost:3000',
    );

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(request.headers).toMatchObject({ 'Idempotency-Key': clientMessageId });
    expect(JSON.parse(String(request.body))).toMatchObject({ clientMessageId });
  });

  it('按文档版本和 chunk 精确加载引用原文并校验响应', async () => {
    const documentVersionId = '00000000-0000-7000-8000-000000000601';
    const chunkId = '00000000-0000-7000-8000-000000000602';
    const detail = {
      knowledgeBaseId: '00000000-0000-7000-8000-000000000603',
      knowledgeBaseName: '企业制度库',
      documentId: '00000000-0000-7000-8000-000000000604',
      documentTitle: '请假制度',
      documentVersionId,
      documentVersion: 3,
      chunkId,
      headingPath: ['人事制度', '年假'],
      sourceType: 'MARKDOWN',
      content: '年假申请需至少提前一天发起。',
      updatedAt: '2026-07-20T02:00:00.000Z',
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(detail), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      getKnowledgeCitationOriginal(
        messageId,
        documentVersionId,
        chunkId,
        undefined,
        'http://localhost:3000',
      ),
    ).resolves.toEqual(detail);
    expect(fetchMock).toHaveBeenCalledWith(
      `http://localhost:3000/api/v1/knowledge-citations/${documentVersionId}/chunks/${chunkId}?messageId=${messageId}`,
      expect.objectContaining({ method: 'GET', credentials: 'include' }),
    );
  });

  it('读取并更新当前用户对智能体消息的反馈', async () => {
    const feedback = {
      id: '00000000-0000-7000-8000-000000000701',
      messageId,
      rating: 'NOT_HELPFUL',
      reason: 'OUTDATED',
      comment: '信息已过期。',
      createdAt: '2026-07-20T03:00:00.000Z',
      updatedAt: '2026-07-20T03:01:00.000Z',
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ feedback }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(feedback), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(getAnswerFeedback(messageId, undefined, 'http://localhost:3000')).resolves.toEqual(
      { feedback },
    );
    await expect(
      upsertAnswerFeedback(
        messageId,
        { rating: 'NOT_HELPFUL', reason: 'OUTDATED', comment: '信息已过期。' },
        undefined,
        'http://localhost:3000',
      ),
    ).resolves.toEqual(feedback);

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `http://localhost:3000/api/v1/messages/${messageId}/feedback`,
    );
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: 'PUT' });
    expect(JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body))).toEqual({
      rating: 'NOT_HELPFUL',
      reason: 'OUTDATED',
      comment: '信息已过期。',
    });
  });
});
