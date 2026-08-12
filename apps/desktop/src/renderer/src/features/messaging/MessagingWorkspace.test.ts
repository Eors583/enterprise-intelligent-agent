import type { Conversation } from '@enterprise/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ApiClientError } from '../../shared/api/client';
import {
  AgentRunFailureNotice,
  AgentRunStreamingBubble,
  agentRunStreamPhaseLabel,
  agentRunWaitingMessage,
  answerFeedbackUnavailable,
  answerFeedbackReasonLabel,
  agentRunFailureMessage,
  citationDisplayMetadata,
  conversationHasAgentPair,
  conversationHasSharedMemberAgent,
  conversationTitle,
  MessageCitationCard,
} from './MessagingWorkspace';

const currentUserId = '00000000-0000-7000-8000-000000000100';
const otherUserId = '00000000-0000-7000-8000-000000000101';

describe('conversationTitle', () => {
  it('无服务端标题时排除当前用户，仅展示对方真人身份', () => {
    const conversation: Conversation = {
      id: '00000000-0000-7000-8000-000000000401',
      type: 'direct',
      title: null,
      participants: [
        { type: 'user', id: currentUserId, name: '我' },
        { type: 'user', id: otherUserId, name: '林晓' },
      ],
      lastMessageAt: null,
      createdAt: '2026-07-15T01:00:00.000Z',
      updatedAt: '2026-07-15T01:00:00.000Z',
    };

    expect(conversationTitle(conversation, currentUserId)).toBe('林晓');
  });

  it('识别两个智能体参与的受控协作会话，并在无标题时显示双方名称', () => {
    const conversation: Conversation = {
      id: '00000000-0000-7000-8000-000000000402',
      type: 'direct',
      title: null,
      participants: [
        { type: 'user', id: currentUserId, name: '我' },
        { type: 'agent', id: '00000000-0000-7000-8000-000000000201', name: '产品智能体' },
        { type: 'agent', id: '00000000-0000-7000-8000-000000000202', name: '研发智能体' },
      ],
      lastMessageAt: null,
      createdAt: '2026-07-15T01:00:00.000Z',
      updatedAt: '2026-07-15T01:00:00.000Z',
    };

    expect(conversationHasAgentPair(conversation)).toBe(true);
    expect(conversationTitle(conversation, currentUserId)).toBe('产品智能体、研发智能体');
  });

  it('识别成员与其智能体共用的会话，并保持成员作为会话标题', () => {
    const conversation: Conversation = {
      id: '00000000-0000-7000-8000-000000000403',
      type: 'direct',
      title: '周睿',
      participants: [
        { type: 'user', id: currentUserId, name: '我' },
        { type: 'user', id: otherUserId, name: '周睿' },
        { type: 'agent', id: '00000000-0000-7000-8000-000000000203', name: '周睿的智能体' },
      ],
      lastMessageAt: null,
      createdAt: '2026-08-04T01:00:00.000Z',
      updatedAt: '2026-08-04T01:00:00.000Z',
    };

    expect(conversationHasSharedMemberAgent(conversation, currentUserId)).toBe(true);
    expect(conversationHasAgentPair(conversation)).toBe(false);
    expect(conversationTitle(conversation, currentUserId)).toBe('周睿');
  });
});

describe('Agent Run streaming labels', () => {
  it('distinguishes live, replaying, offline recovery, and honest terminal-only output', () => {
    expect(agentRunStreamPhaseLabel('live')).toBe('正在实时生成');
    expect(agentRunStreamPhaseLabel('replaying')).toBe('正在恢复实时事件');
    expect(agentRunStreamPhaseLabel('offline')).toContain('正在续传');
    expect(agentRunStreamPhaseLabel('terminal_only')).toBe('供应商仅返回终态');
  });

  it('shows an honest wait state before a terminal-only provider completes', () => {
    expect(agentRunWaitingMessage({ streamMode: 'terminal_only' })).toContain('等待供应商终态');
    expect(agentRunWaitingMessage({ streamMode: 'terminal_only' })).toContain('不提供增量输出');
    expect(agentRunWaitingMessage({ streamMode: 'live' })).not.toContain('供应商终态');
    expect(agentRunWaitingMessage({ streamMode: null })).not.toContain('供应商终态');
  });

  it('renders partial content with an explicit reconnect state instead of a fake final message', () => {
    const html = renderToStaticMarkup(
      createElement(AgentRunStreamingBubble, {
        agentName: 'Finance Agent',
        content: 'Partial trusted answer',
        phase: 'offline',
      }),
    );

    expect(html).toContain('data-stream-state="offline"');
    expect(html).toContain('连接中断，正在续传');
    expect(html).toContain('Partial trusted answer');
    expect(html).not.toContain('供应商仅返回终态');
  });
});

describe('citationDisplayMetadata', () => {
  it('展示知识来源的章节路径、文件类型和更新时间', () => {
    const metadata = citationDisplayMetadata({
      documentId: '00000000-0000-7000-8000-000000000501',
      documentVersionId: '00000000-0000-7000-8000-000000000502',
      chunkId: '00000000-0000-7000-8000-000000000503',
      knowledgeBaseId: '00000000-0000-7000-8000-000000000504',
      knowledgeBaseName: '企业制度库',
      title: '请假制度',
      documentVersion: 3,
      headingPath: ['人事制度', '年假'],
      sourceType: 'FILE',
      excerpt: '摘要',
      updatedAt: '2026-07-20T02:00:00.000Z',
      verificationStatus: 'LINEAGE_VERIFIED',
    });

    expect(metadata.heading).toBe('人事制度 / 年假');
    expect(metadata.sourceType).toBe('文件');
    expect(metadata.updatedAt).toContain('2026');
  });

  it('未提取到标题时明确显示未标注章节', () => {
    expect(
      citationDisplayMetadata({
        documentId: '00000000-0000-7000-8000-000000000511',
        documentVersionId: '00000000-0000-7000-8000-000000000512',
        chunkId: '00000000-0000-7000-8000-000000000513',
        knowledgeBaseId: '00000000-0000-7000-8000-000000000514',
        knowledgeBaseName: '企业制度库',
        title: '无标题文档',
        documentVersion: 1,
        headingPath: [],
        sourceType: 'TEXT',
        excerpt: '摘要',
        updatedAt: '2026-07-20T02:00:00.000Z',
        verificationStatus: 'LINEAGE_VERIFIED',
      }).heading,
    ).toBe('未标注章节');
  });

  it('对缺失版本谱系的历史引用明确显示不可完整核验', () => {
    const metadata = citationDisplayMetadata({
      documentId: '00000000-0000-7000-8000-000000000521',
      documentVersionId: null,
      chunkId: null,
      knowledgeBaseId: '00000000-0000-7000-8000-000000000524',
      knowledgeBaseName: null,
      title: '历史制度',
      documentVersion: null,
      headingPath: [],
      sourceType: null,
      excerpt: '历史摘要',
      updatedAt: null,
      verificationStatus: 'LEGACY',
    });

    expect(metadata).toEqual({
      heading: '历史记录未保存章节',
      sourceType: '旧引用',
      updatedAt: '不可完整核验',
    });
  });
});

describe('MessageCitationCard', () => {
  it('为可核验引用提供按需查看原文入口', () => {
    const html = renderToStaticMarkup(
      createElement(MessageCitationCard, {
        messageId: '00000000-0000-7000-8000-000000000530',
        index: 0,
        citation: {
          documentId: '00000000-0000-7000-8000-000000000531',
          documentVersionId: '00000000-0000-7000-8000-000000000532',
          chunkId: '00000000-0000-7000-8000-000000000533',
          knowledgeBaseId: '00000000-0000-7000-8000-000000000534',
          knowledgeBaseName: '企业制度库',
          title: '请假制度',
          documentVersion: 3,
          headingPath: ['人事制度', '年假'],
          sourceType: 'MARKDOWN',
          excerpt: '年假申请摘要',
          updatedAt: '2026-07-20T02:00:00.000Z',
          verificationStatus: 'LINEAGE_VERIFIED',
        },
      }),
    );

    expect(html).toContain('查看原文');
    expect(html).toContain('来源链路已核验（非内容真实性判定）');
    expect(html).not.toContain('无法查看原文');
  });

  it('旧引用明确提示不可完整核验并禁用原文入口', () => {
    const html = renderToStaticMarkup(
      createElement(MessageCitationCard, {
        messageId: '00000000-0000-7000-8000-000000000540',
        index: 0,
        citation: {
          documentId: '00000000-0000-7000-8000-000000000541',
          documentVersionId: null,
          chunkId: null,
          knowledgeBaseId: '00000000-0000-7000-8000-000000000544',
          knowledgeBaseName: null,
          title: '历史制度',
          documentVersion: null,
          headingPath: [],
          sourceType: null,
          excerpt: '历史摘要',
          updatedAt: null,
          verificationStatus: 'LEGACY',
        },
      }),
    );

    expect(html).toContain('旧引用 · 不可完整核验');
    expect(html).toContain('无法查看原文');
    expect(html).toContain('disabled');
  });
});

describe('answer feedback presentation', () => {
  it.each([
    ['INCORRECT', '内容不正确'],
    ['IRRELEVANT_CITATION', '引用与回答无关'],
    ['OUTDATED', '信息已过期'],
    ['MISSING_KNOWLEDGE', '缺少关键知识'],
    ['OTHER', '其他原因'],
  ] as const)('maps %s to a clear employee-facing reason', (reason, label) => {
    expect(answerFeedbackReasonLabel(reason)).toBe(label);
  });

  it('treats an unrated historical answer as unavailable instead of exposing a technical error', () => {
    expect(
      answerFeedbackUnavailable(
        new ApiClientError('http', 'The Agent answer was not found or cannot be rated.', {
          status: 404,
        }),
      ),
    ).toBe(true);
    expect(answerFeedbackUnavailable({ kind: 'http', status: 404 })).toBe(true);
    expect(
      answerFeedbackUnavailable(
        new Error('The Agent answer was not found or cannot be rated.（请求 ID：legacy）'),
      ),
    ).toBe(true);
    expect(
      answerFeedbackUnavailable(
        new ApiClientError('http', 'Service unavailable.', { status: 503 }),
      ),
    ).toBe(false);
  });
});

describe('Agent Run failure presentation', () => {
  const failedRun = {
    id: '00000000-0000-7000-8000-000000000801',
    inputMessageId: '00000000-0000-7000-8000-000000000802',
    outputMessageId: null,
    agentId: '00000000-0000-7000-8000-000000000803',
    agentName: '制度助手',
    streamMode: null,
    status: 'FAILED' as const,
    errorCode: 'PROVIDER_INVALID_RESPONSE',
    errorMessage: 'Provider returned an invalid response.',
    retryable: true,
    createdAt: '2026-07-21T06:00:00.000Z',
    startedAt: '2026-07-21T06:00:01.000Z',
    finishedAt: '2026-07-21T06:00:05.000Z',
  };

  it('explains that an invalid provider response can be regenerated', () => {
    expect(agentRunFailureMessage('PROVIDER_INVALID_RESPONSE', true)).toContain('重新生成');

    const html = renderToStaticMarkup(
      createElement(AgentRunFailureNotice, {
        run: failedRun,
        isRetrying: false,
        retryError: null,
        onRetry: () => undefined,
      }),
    );

    expect(html).toContain('模型服务返回的结果暂时无法解析');
    expect(html).toContain('重新生成');
  });

  it('does not promise a retry control when the failed Run is terminal', () => {
    expect(agentRunFailureMessage('PROVIDER_INVALID_RESPONSE', false)).not.toContain('重新生成');

    const html = renderToStaticMarkup(
      createElement(AgentRunFailureNotice, {
        run: { ...failedRun, retryable: false },
        isRetrying: false,
        retryError: null,
        onRetry: () => undefined,
      }),
    );

    expect(html).toContain('请联系管理员检查模型服务');
    expect(html).not.toContain('<button');
  });

  it('does not offer retry when the remote Run result is still unknown', () => {
    const html = renderToStaticMarkup(
      createElement(AgentRunFailureNotice, {
        run: {
          ...failedRun,
          status: 'UNKNOWN',
          retryable: true,
          errorCode: 'PROVIDER_INVALID_RESPONSE',
        },
        isRetrying: false,
        retryError: new ApiClientError('http', '不应展示的旧重试错误。'),
        onRetry: () => undefined,
      }),
    );

    expect(html).toContain('回复状态待确认');
    expect(html).toContain('请稍后刷新消息或联系管理员，避免重复执行');
    expect(html).not.toContain('重新生成');
    expect(html).not.toContain('不应展示的旧重试错误');
    expect(html).not.toContain('<button');
  });

  it('shows the retry API error and request ID while allowing another attempt', () => {
    const html = renderToStaticMarkup(
      createElement(AgentRunFailureNotice, {
        run: failedRun,
        isRetrying: false,
        retryError: new ApiClientError('http', '当前 Run 已有进行中的重试。', {
          requestId: 'req-retry-123',
          status: 409,
        }),
        onRetry: () => undefined,
      }),
    );

    expect(html).toContain('重新生成请求失败');
    expect(html).toContain('当前 Run 已有进行中的重试。');
    expect(html).toContain('req-retry-123');
    expect(html).not.toContain('disabled=""');
  });

  it('disables the retry control while a request is in flight', () => {
    const html = renderToStaticMarkup(
      createElement(AgentRunFailureNotice, {
        run: failedRun,
        isRetrying: true,
        retryError: null,
        onRetry: () => undefined,
      }),
    );

    expect(html).toContain('正在重新生成…');
    expect(html).toContain('disabled=""');
  });
});
