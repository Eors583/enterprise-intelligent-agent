import type { Conversation } from '@enterprise/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ApiClientError } from '../../shared/api/client';
import {
  AgentRunFailureNotice,
  AgentRunStreamingBubble,
  agentRunQueueMessage,
  agentRunStatusLabel,
  agentRunStreamPhaseLabel,
  agentRunWaitingMessage,
  answerFeedbackUnavailable,
  answerFeedbackReasonLabel,
  agentRunFailureMessage,
  citationDisplayMetadata,
  conversationHasAgentPair,
  conversationHasSharedMemberAgent,
  conversationTitle,
  findAwaitingAgentRun,
  findBlockingUnknownAgentRun,
  findLatestAgentRunForMessage,
  MessageCitationCard,
  MessageRichText,
  normalizeMessageMarkdown,
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

  it('uses user-facing progress labels instead of internal queue states', () => {
    expect(agentRunStatusLabel('QUEUED')).toBe('正在准备');
    expect(agentRunStatusLabel('DISPATCHING')).toBe('正在连接');
    expect(agentRunStatusLabel('RUNNING')).toBe('正在回答');
  });

  it('shows an honest wait state before a terminal-only provider completes', () => {
    expect(agentRunWaitingMessage({ streamMode: 'terminal_only' })).toContain('等待供应商终态');
    expect(agentRunWaitingMessage({ streamMode: 'terminal_only' })).toContain('不提供增量输出');
    expect(agentRunWaitingMessage({ streamMode: 'live' })).not.toContain('供应商终态');
    expect(agentRunWaitingMessage({ streamMode: null })).not.toContain('供应商终态');
  });

  it('describes preparation without exposing internal queue terminology', () => {
    expect(agentRunQueueMessage({ status: 'QUEUED', streamMode: null }, false, true)).toContain(
      '正在恢复上一条请求',
    );
    expect(agentRunQueueMessage({ status: 'QUEUED', streamMode: null }, false, true)).toContain(
      '自动开始',
    );
    expect(agentRunQueueMessage({ status: 'QUEUED', streamMode: null }, true, false)).toBe(
      '问题已接收，正在准备回答。',
    );
  });

  it('renders partial content with an explicit reconnect state instead of a fake final message', () => {
    const html = renderToStaticMarkup(
      createElement(AgentRunStreamingBubble, {
        agentName: 'Finance Agent',
        content: 'Partial **trusted** answer',
        phase: 'offline',
      }),
    );

    expect(html).toContain('data-stream-state="offline"');
    expect(html).toContain('连接中断，正在续传');
    expect(html).toContain('Partial <strong>trusted</strong> answer');
    expect(html).not.toContain('**trusted**');
    expect(html).not.toContain('供应商仅返回终态');
  });

  it('does not present an UNKNOWN result as a Run that is still generating', () => {
    const unknownRun = {
      id: '00000000-0000-7000-8000-000000000811',
      inputMessageId: '00000000-0000-7000-8000-000000000812',
      outputMessageId: null,
      agentId: '00000000-0000-7000-8000-000000000813',
      agentName: '制度助手',
      streamMode: 'terminal_only' as const,
      status: 'UNKNOWN' as const,
      errorCode: 'AI_RUNTIME_INVALID_RESPONSE',
      errorMessage: 'AI Runtime execution outcome is unknown.',
      retryable: false,
      supersededByRunId: null,
      createdAt: '2026-08-19T08:10:58.000Z',
      startedAt: '2026-08-19T08:10:58.000Z',
      finishedAt: '2026-08-19T08:10:58.000Z',
    };

    expect(findAwaitingAgentRun([unknownRun])).toBeUndefined();
    expect(findBlockingUnknownAgentRun([unknownRun])).toEqual(unknownRun);
    const queuedRun = {
      ...unknownRun,
      id: '00000000-0000-7000-8000-000000000814',
      inputMessageId: '00000000-0000-7000-8000-000000000815',
      status: 'QUEUED' as const,
      startedAt: null,
      finishedAt: null,
    };
    const supersededUnknownRun = {
      ...unknownRun,
      supersededByRunId: queuedRun.id,
    };

    expect(findAwaitingAgentRun([supersededUnknownRun, queuedRun])).toEqual(queuedRun);
    expect(findBlockingUnknownAgentRun([supersededUnknownRun, queuedRun])).toBeUndefined();
    expect(
      findAwaitingAgentRun([{ ...unknownRun, status: 'RUNNING', finishedAt: null }]),
    ).toMatchObject({ status: 'RUNNING' });
  });

  it('tracks the executing Run first and keeps retries attached to their own input message', () => {
    const queuedFirst = {
      id: '00000000-0000-7000-8000-000000000821',
      inputMessageId: '00000000-0000-7000-8000-000000000831',
      outputMessageId: null,
      agentId: '00000000-0000-7000-8000-000000000841',
      agentName: '制度助手',
      streamMode: null,
      status: 'QUEUED' as const,
      errorCode: null,
      errorMessage: null,
      retryable: false,
      createdAt: '2026-08-20T08:00:00.000Z',
      startedAt: null,
      finishedAt: null,
    };
    const queuedSecond = {
      ...queuedFirst,
      id: '00000000-0000-7000-8000-000000000822',
      inputMessageId: '00000000-0000-7000-8000-000000000832',
      createdAt: '2026-08-20T08:00:01.000Z',
    };
    const runningSecond = {
      ...queuedSecond,
      id: '00000000-0000-7000-8000-000000000823',
      status: 'RUNNING' as const,
      startedAt: '2026-08-20T08:00:02.000Z',
    };

    expect(findAwaitingAgentRun([queuedFirst, queuedSecond])).toEqual(queuedFirst);
    expect(findAwaitingAgentRun([queuedFirst, queuedSecond, runningSecond])).toEqual(runningSecond);
    expect(
      findLatestAgentRunForMessage(
        [queuedFirst, queuedSecond, runningSecond],
        queuedSecond.inputMessageId,
      ),
    ).toEqual(runningSecond);
    expect(
      findLatestAgentRunForMessage(
        [queuedFirst, queuedSecond, runningSecond],
        queuedFirst.inputMessageId,
      ),
    ).toEqual(queuedFirst);
  });
});

describe('MessageRichText', () => {
  it('把 Markdown 语义渲染为富文本，不向用户展示格式符号', () => {
    const html = renderToStaticMarkup(
      createElement(MessageRichText, {
        content:
          '**一句话：核心结论。**它需要被突出，*补充说明*也要保留。\n\n- 第一项\n- 第二项\n\n~~旧结论~~',
      }),
    );

    expect(html).toContain('<strong>一句话：核心结论。</strong>');
    expect(html).toContain('<em>补充说明</em>');
    expect(html).toContain('<ul>');
    expect(html).toContain('<del>旧结论</del>');
    expect(html).not.toContain('**一句话：核心结论。**');
  });

  it('把单独占行的编号和多余空行收拢为紧凑的有序列表', () => {
    const content =
      '华为销售管理的核心，是全过程管理。\n\n\n1.\n\n**设置专门的销售管理部门。** 负责销售目标全过程管理。[来源1]\n\n\n2、\n\n**实行准直销渠道模式。** 由代理商协同投标和履约。[来源2]';
    const normalized = normalizeMessageMarkdown(content);
    const html = renderToStaticMarkup(createElement(MessageRichText, { content }));

    expect(normalized).toContain('1. **设置专门的销售管理部门。**');
    expect(normalized).toContain('2. **实行准直销渠道模式。**');
    expect(normalized).not.toMatch(/\n{3,}/);
    expect(html).toContain('<ol>');
    expect(html.match(/<li>/g)).toHaveLength(2);
    expect(html).not.toContain('<p>1.</p>');
    expect(html).not.toContain('<p>2、</p>');
  });

  it('表格拥有独立横向滚动容器，远程图片只显示说明而不加载资源', () => {
    const html = renderToStaticMarkup(
      createElement(MessageRichText, {
        content:
          '| 项目 | 状态 |\n| --- | --- |\n| 企业知识库中的超长项目名称 | 已完成 |\n\n![流程图](https://example.com/tracking.png)',
      }),
    );

    expect(html).toContain('message-rich-text-table-scroll');
    expect(html).toContain('<table>');
    expect(html).toContain('图片：流程图');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('tracking.png');
  });

  it('不把回答中夹带的原始 HTML 当成可执行标签', () => {
    const html = renderToStaticMarkup(
      createElement(MessageRichText, {
        content: '**安全内容**<script>alert("xss")</script>',
      }),
    );

    expect(html).toContain('<strong>安全内容</strong>');
    expect(html).not.toContain('<script');
    expect(html).toContain('alert(&quot;xss&quot;)');
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

  it('把输入预算失败解释为上下文过长，而不是供应商仍在生成', () => {
    expect(agentRunFailureMessage('INPUT_TOKEN_BUDGET_PREFLIGHT_EXCEEDED')).toContain(
      '会话和知识上下文过长',
    );
    expect(agentRunFailureMessage('UNSUPPORTED_RUNTIME_INPUT')).toContain('模型输入超出');
  });

  it('引用校验失败时不展示无意义兜底回答，并允许重新生成', () => {
    const message = agentRunFailureMessage('KNOWLEDGE_GROUNDING_VALIDATION_FAILED');

    expect(message).toContain('未作为正式回答保存');
    expect(message).toContain('重新生成');
  });

  it('乐享等待和重试仍失败时展示明确错误，而不是声称没有资料', () => {
    const message = agentRunFailureMessage('LEXIANG_SEARCH_UNAVAILABLE');

    expect(message).toContain('腾讯乐享知识检索');
    expect(message).toContain('等待和自动重试后仍未完成');
    expect(message).not.toContain('没有找到');
  });

  it('Manus 创建任务被拒绝时明确指出已经越过乐享检索阶段', () => {
    const message = agentRunFailureMessage('MANUS_TASK_CREATE_INVALID_ARGUMENT', false);

    expect(message).toContain('出错步骤：Manus 模型任务创建');
    expect(message).toContain('企业知识检索已完成');
    expect(message).not.toContain('腾讯乐享知识检索失败');
  });

  it('模型执行和回答来源校验使用不同的失败步骤', () => {
    expect(agentRunFailureMessage('PROVIDER_TASK_FAILED')).toContain(
      '出错步骤：Manus 模型任务执行',
    );
    expect(agentRunFailureMessage('KNOWLEDGE_GROUNDING_VALIDATION_FAILED')).toContain(
      '出错步骤：回答来源校验',
    );
  });

  it('offers an explicit local escape hatch instead of pretending UNKNOWN is still generating', () => {
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
        isAbandoning: false,
        abandonError: null,
        onAbandon: () => undefined,
      }),
    );

    expect(html).toContain('回复状态待确认');
    expect(html).toContain('不会自动重复调用供应商');
    expect(html).toContain('远端任务仍可能完成并产生费用');
    expect(html).toContain('结束本次等待');
    expect(html).not.toContain('>重新生成</button>');
    expect(html).not.toContain('不应展示的旧重试错误');
    expect(html).toContain('<button');
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
