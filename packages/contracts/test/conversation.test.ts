import { describe, expect, it } from 'vitest';

import {
  conversationAgentRunSchema,
  createConversationRequestSchema,
  createMessageRequestSchema,
  knowledgeCitationDetailSchema,
  knowledgeCitationOriginalQuerySchema,
  textMessageContentSchema,
  upsertAnswerFeedbackRequestSchema,
} from '../src/conversation.js';

const USER_ID = '00000000-0000-7000-8000-000000000102';
const AGENT_ID = '00000000-0000-7000-8000-000000000301';
const SECOND_AGENT_ID = '00000000-0000-7000-8000-000000000302';

describe('conversation Agent Run read contracts', () => {
  const run = {
    id: '00000000-0000-7000-8000-000000000401',
    inputMessageId: '00000000-0000-7000-8000-000000000402',
    outputMessageId: null,
    agentId: AGENT_ID,
    agentName: '制度助手',
    status: 'RUNNING',
    errorCode: null,
    errorMessage: null,
    retryable: false,
    createdAt: '2026-07-29T06:00:00.000Z',
    startedAt: '2026-07-29T06:00:01.000Z',
    finishedAt: null,
  };

  it.each(['live', 'terminal_only', null] as const)(
    'accepts the explicit %s stream capability',
    (streamMode) => {
      expect(conversationAgentRunSchema.parse({ ...run, streamMode }).streamMode).toBe(streamMode);
    },
  );

  it('requires the API to state whether the stream capability is known', () => {
    expect(conversationAgentRunSchema.safeParse(run).success).toBe(false);
    expect(
      conversationAgentRunSchema.safeParse({ ...run, streamMode: 'simulated_stream' }).success,
    ).toBe(false);
  });
});

describe('conversation write contracts', () => {
  it.each([
    { type: 'direct', target: { type: 'human', userId: USER_ID } },
    { type: 'direct', target: { type: 'agent', agentId: AGENT_ID } },
    {
      type: 'direct',
      target: { type: 'agent_pair', agentIds: [AGENT_ID, SECOND_AGENT_ID] },
    },
  ])('accepts a supported direct target', (request) => {
    expect(createConversationRequestSchema.safeParse(request).success).toBe(true);
  });

  it('defaults relay conversations to four turns and bounds explicit limits', () => {
    const parsed = createConversationRequestSchema.parse({
      type: 'direct',
      target: { type: 'agent_pair', agentIds: [AGENT_ID, SECOND_AGENT_ID] },
    });
    expect(parsed.target).toMatchObject({ type: 'agent_pair', turnLimit: 4 });

    for (const turnLimit of [2, 8]) {
      expect(
        createConversationRequestSchema.safeParse({
          type: 'direct',
          target: { type: 'agent_pair', agentIds: [AGENT_ID, SECOND_AGENT_ID], turnLimit },
        }).success,
      ).toBe(true);
    }
    for (const turnLimit of [1, 9]) {
      expect(
        createConversationRequestSchema.safeParse({
          type: 'direct',
          target: { type: 'agent_pair', agentIds: [AGENT_ID, SECOND_AGENT_ID], turnLimit },
        }).success,
      ).toBe(false);
    }
    expect(
      createConversationRequestSchema.safeParse({
        type: 'direct',
        target: { type: 'agent_pair', agentIds: [AGENT_ID, AGENT_ID] },
      }).success,
    ).toBe(false);
  });

  it('rejects invalid identifiers and additional write fields', () => {
    expect(
      createConversationRequestSchema.safeParse({
        type: 'direct',
        target: { type: 'human', userId: 'not-a-uuid' },
      }).success,
    ).toBe(false);
    expect(
      createConversationRequestSchema.safeParse({
        type: 'direct',
        target: { type: 'agent', agentId: AGENT_ID, admin: true },
      }).success,
    ).toBe(false);
    expect(
      createConversationRequestSchema.safeParse({
        type: 'direct',
        target: { type: 'human', userId: USER_ID },
        tenantId: USER_ID,
      }).success,
    ).toBe(false);
  });

  it('accepts text messages and trims the text', () => {
    expect(
      createMessageRequestSchema.parse({
        clientMessageId: 'desktop-0001',
        content: { type: 'text', text: '  hello  ' },
      }).content.text,
    ).toBe('hello');
  });

  it.each(['', '   ', 'x'.repeat(20_001)])('rejects invalid message text', (text) => {
    expect(
      createMessageRequestSchema.safeParse({
        clientMessageId: 'desktop-0001',
        content: { type: 'text', text },
      }).success,
    ).toBe(false);
  });

  it('rejects additional message and content fields', () => {
    expect(
      createMessageRequestSchema.safeParse({
        clientMessageId: 'desktop-0001',
        content: { type: 'text', text: 'hello', html: '<b>hello</b>' },
        senderUserId: USER_ID,
      }).success,
    ).toBe(false);
  });
});

describe('conversation citation read contracts', () => {
  const citation = {
    documentId: '00000000-0000-7000-8000-000000000501',
    documentVersionId: '00000000-0000-7000-8000-000000000502',
    chunkId: '00000000-0000-7000-8000-000000000503',
    knowledgeBaseId: '00000000-0000-7000-8000-000000000504',
    knowledgeBaseName: '企业制度库',
    title: '请假制度',
    documentVersion: 3,
    headingPath: ['人事制度', '年假'],
    sourceType: 'MARKDOWN',
    excerpt: '年假申请需提前发起。',
    updatedAt: '2026-07-20T02:00:00.000Z',
  } as const;

  it('接受可溯源到知识库、文档版本和 chunk 的完整引用', () => {
    expect(
      textMessageContentSchema.parse({ type: 'text', text: '答案 [来源1]', citations: [citation] }),
    ).toMatchObject({ citations: [{ ...citation, verificationStatus: 'LINEAGE_VERIFIED' }] });
  });

  it('兼容旧历史引用并显式标记为不可完整核验', () => {
    const legacyCitation = {
      documentId: citation.documentId,
      knowledgeBaseId: citation.knowledgeBaseId,
      title: citation.title,
      excerpt: citation.excerpt,
    };

    expect(
      textMessageContentSchema.parse({
        type: 'text',
        text: '历史答案 [来源1]',
        citations: [legacyCitation],
      }),
    ).toMatchObject({
      citations: [
        {
          ...legacyCitation,
          documentVersionId: null,
          chunkId: null,
          knowledgeBaseName: null,
          documentVersion: null,
          headingPath: [],
          sourceType: null,
          updatedAt: null,
          verificationStatus: 'LEGACY',
        },
      ],
    });
  });

  it.each(['documentVersionId', 'chunkId', 'knowledgeBaseName'])(
    '拒绝缺失 %s 的不完整引用',
    (field) => {
      const incompleteCitation = { ...citation } as Record<string, unknown>;
      delete incompleteCitation[field];
      expect(
        textMessageContentSchema.safeParse({
          type: 'text',
          text: '答案 [来源1]',
          citations: [incompleteCitation],
        }).success,
      ).toBe(false);
    },
  );

  it('校验员工侧引用原文详情的完整版本谱系', () => {
    expect(
      knowledgeCitationDetailSchema.parse({
        knowledgeBaseId: citation.knowledgeBaseId,
        knowledgeBaseName: citation.knowledgeBaseName,
        documentId: citation.documentId,
        documentTitle: citation.title,
        documentVersionId: citation.documentVersionId,
        documentVersion: citation.documentVersion,
        chunkId: citation.chunkId,
        headingPath: citation.headingPath,
        sourceType: citation.sourceType,
        content: '年假申请需至少提前一天发起，并由直属负责人审批。',
        updatedAt: citation.updatedAt,
      }),
    ).toMatchObject({
      documentVersionId: citation.documentVersionId,
      chunkId: citation.chunkId,
    });
  });

  it('要求引用原文请求绑定产生该引用的消息', () => {
    expect(
      knowledgeCitationOriginalQuerySchema.safeParse({
        messageId: '00000000-0000-7000-8000-000000000701',
      }).success,
    ).toBe(true);
    expect(knowledgeCitationOriginalQuerySchema.safeParse({}).success).toBe(false);
  });
});

describe('answer feedback contracts', () => {
  it('accepts helpful feedback and normalizes optional fields', () => {
    expect(upsertAnswerFeedbackRequestSchema.parse({ rating: 'HELPFUL' })).toEqual({
      rating: 'HELPFUL',
      reason: null,
      comment: null,
    });
  });

  it.each(['INCORRECT', 'IRRELEVANT_CITATION', 'OUTDATED', 'MISSING_KNOWLEDGE', 'OTHER'] as const)(
    'accepts NOT_HELPFUL reason %s',
    (reason) => {
      expect(
        upsertAnswerFeedbackRequestSchema.parse({
          rating: 'NOT_HELPFUL',
          reason,
          comment: '  补充说明  ',
        }),
      ).toEqual({ rating: 'NOT_HELPFUL', reason, comment: '补充说明' });
    },
  );

  it('requires a reason for NOT_HELPFUL and rejects comments over 500 characters', () => {
    expect(upsertAnswerFeedbackRequestSchema.safeParse({ rating: 'NOT_HELPFUL' }).success).toBe(
      false,
    );
    expect(
      upsertAnswerFeedbackRequestSchema.safeParse({
        rating: 'NOT_HELPFUL',
        reason: 'OTHER',
        comment: 'x'.repeat(501),
      }).success,
    ).toBe(false);
  });
});
