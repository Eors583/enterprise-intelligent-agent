import { describe, expect, it } from 'vitest';

import type { AgentRunKnowledgeSource, PreparedAgentRun } from './agent-run.models.js';
import {
  conservativeAgentRunInputUpperBound,
  contextualRecallQuery,
  packConservativeAgentRunInput,
} from './agent-run-input-budget.js';

describe('packConservativeAgentRunInput', () => {
  it('fails only when the mandatory system prompt and current question exceed the bound', () => {
    const required = preparedRun({
      systemPrompt: 'strict policy '.repeat(100),
      messages: [message('current question')],
      knowledgeSources: [],
    });
    const result = packConservativeAgentRunInput({
      ...required,
      maxInputTokens: conservativeAgentRunInputUpperBound(required) - 1,
    });

    expect(result).toEqual({ kind: 'required_input_exceeds_budget' });
  });

  it('keeps the latest complete exchange before lower-priority RAG sources', () => {
    const current = message('current question');
    const previousQuestion = message('previous question');
    const previousAnswer = agentMessage('previous answer');
    const firstSource = knowledgeSource('1', 'highest-ranked source');
    const secondSource = knowledgeSource('2', 'lower-ranked source');
    const requiredWindowWithFirstSource = preparedRun({
      messages: [previousQuestion, previousAnswer, current],
      knowledgeSources: [firstSource],
    });
    const candidate = preparedRun({
      messages: [previousQuestion, previousAnswer, current],
      knowledgeSources: [firstSource, secondSource],
      maxInputTokens: conservativeAgentRunInputUpperBound(requiredWindowWithFirstSource),
    });

    const result = packConservativeAgentRunInput(candidate);

    expect(result).toMatchObject({ kind: 'packed' });
    if (result.kind !== 'packed') return;
    expect(result.run.knowledgeSources).toEqual([firstSource]);
    expect(result.run.messages).toEqual([previousQuestion, previousAnswer, current]);
  });

  it('adds optional history newest-first while preserving chronological output order', () => {
    const older = message('older history');
    const newer = message('newer history');
    const current = message('current question');
    const source = knowledgeSource('1', 'trusted source');
    const requiredWithWindow = preparedRun({
      messages: [older, newer, current],
      knowledgeSources: [source],
    });
    const candidate = preparedRun({
      messages: [older, newer, current],
      knowledgeSources: [source],
      maxInputTokens: conservativeAgentRunInputUpperBound(requiredWithWindow),
    });

    const result = packConservativeAgentRunInput(candidate);

    expect(result).toMatchObject({ kind: 'packed' });
    if (result.kind !== 'packed') return;
    expect(result.run.knowledgeSources).toEqual([source]);
    expect(result.run.messages).toEqual([older, newer, current]);
  });

  it('counts purpose-bound memory after reserving window history', () => {
    const current = message('current question');
    const memory = memoryContext('remembered preference');
    const requiredWithMemory = preparedRun({
      messages: [message('recent history'), current],
      knowledgeSources: [],
      memoryContexts: [memory],
    });
    const candidate = preparedRun({
      messages: [message('recent history'), current],
      knowledgeSources: [],
      memoryContexts: [memory],
      maxInputTokens: conservativeAgentRunInputUpperBound(requiredWithMemory),
    });

    const result = packConservativeAgentRunInput(candidate);

    expect(result).toMatchObject({ kind: 'packed' });
    if (result.kind !== 'packed') return;
    expect(result.run.memoryContexts).toEqual([memory]);
    expect(result.run.messages).toEqual([message('recent history'), current]);
  });

  it('retains all optional context when the conservative bound has room', () => {
    const candidate = preparedRun({
      messages: [message('history'), message('current question')],
      knowledgeSources: [knowledgeSource('1', 'source one'), knowledgeSource('2', 'source two')],
    });

    const result = packConservativeAgentRunInput(candidate);

    expect(result).toEqual({ kind: 'packed', run: candidate });
  });

  it('drops repeated retries and bounds old history before provider dispatch', () => {
    const history = [
      message('same question'),
      message('old 1'),
      message('same   question'),
      message('old 2'),
      message('old 3'),
      message('old 4'),
      message('old 5'),
      message('old 6'),
      message('same question'),
    ];
    const current = message('new question');

    const result = packConservativeAgentRunInput(
      preparedRun({ messages: [...history, current], maxInputTokens: 1_000_000 }),
    );

    expect(result).toMatchObject({ kind: 'packed' });
    if (result.kind !== 'packed') return;
    expect(result.run.messages).toHaveLength(7);
    expect(result.run.messages.at(-1)).toEqual(current);
    expect(
      result.run.messages.filter(({ text }) => text.replace(/\s+/gu, ' ') === 'same question'),
    ).toHaveLength(1);
    expect(result.run.messages.some(({ text }) => text === 'old 1')).toBe(false);
  });

  it('keeps Manus task creation below its observed request boundary', () => {
    const sources = Array.from({ length: 8 }, (_, index) =>
      knowledgeSource(String(index + 1), '华为战略管理证据'.repeat(80)),
    );
    const candidate = preparedRun({
      messages: [message('旧问题'.repeat(200)), message('当前问题')],
      knowledgeSources: sources,
      modelRoute: {
        schemaVersion: 1,
        policyVersionId: '00000000-0000-7000-8000-000000000010',
        policyVersion: 1,
        policyHash: 'c'.repeat(64),
        taskClass: 'GENERAL',
        maximumClassification: 'INTERNAL',
        requiredCapabilities: [],
        maximumAttempts: 1,
        circuitFailureThreshold: 3,
        circuitOpenSeconds: 60,
        candidates: [
          {
            ordinal: 1,
            catalogVersionId: '00000000-0000-7000-8000-000000000011',
            routeKey: 'GENERAL.PRIMARY',
            provider: 'MANUS',
            model: 'manus-1.6-lite',
            credentialReference: 'vault://manus/general',
          },
        ],
      },
    });

    const result = packConservativeAgentRunInput(candidate);

    expect(result).toMatchObject({ kind: 'packed' });
    if (result.kind !== 'packed') return;
    expect(conservativeAgentRunInputUpperBound(result.run)).toBeLessThanOrEqual(10_000);
    expect(result.run.knowledgeSources).not.toHaveLength(0);
    expect(result.run.knowledgeSources!.length).toBeLessThan(sources.length);
    expect(result.run.knowledgeSources).toEqual(
      sources.slice(0, result.run.knowledgeSources!.length),
    );
  });

  it('keeps the previous question and answer for a contextual Manus follow-up', () => {
    const previousQuestion = message('华为的 BLM 讲了什么？');
    const previousAnswer = agentMessage('BLM 把战略制定和战略执行连接起来。');
    const current = message('还是没懂，能用大白话解释吗？');
    const result = packConservativeAgentRunInput(
      preparedRun({
        messages: [previousQuestion, previousAnswer, current],
        knowledgeSources: Array.from({ length: 8 }, (_, index) =>
          knowledgeSource(String(index + 1), '华为战略管理证据'.repeat(80)),
        ),
        modelRoute: manusRoute(),
      }),
    );

    expect(result).toMatchObject({ kind: 'packed' });
    if (result.kind !== 'packed') return;
    expect(result.run.messages).toEqual([previousQuestion, previousAnswer, current]);
    expect(result.run.knowledgeSources!.length).toBeGreaterThan(0);
    expect(conservativeAgentRunInputUpperBound(result.run)).toBeLessThanOrEqual(10_000);
  });

  it('keeps a bounded window memory when the previous answer is very long', () => {
    const previousQuestion = message('解释一下 BLM。');
    const previousAnswer = agentMessage('很长的上一轮回答。'.repeat(500));
    const current = message('能用大白话再说一遍吗？');
    const result = packConservativeAgentRunInput(
      preparedRun({
        messages: [previousQuestion, previousAnswer, current],
        knowledgeSources: [knowledgeSource('1', 'BLM 证据'.repeat(100))],
        modelRoute: manusRoute(),
      }),
    );

    expect(result).toMatchObject({ kind: 'packed' });
    if (result.kind !== 'packed') return;
    expect(result.run.messages).toHaveLength(3);
    expect(result.run.messages[0]).toEqual(previousQuestion);
    expect(result.run.messages[1]?.text).toContain('[窗口记忆已截断]');
    expect(result.run.messages[2]).toEqual(current);
    expect(result.run.knowledgeSources).toHaveLength(1);
  });
});

describe('contextualRecallQuery', () => {
  it('adds the previous user question to a dependent follow-up', () => {
    expect(
      contextualRecallQuery([
        message('华为的 BLM 讲了什么？'),
        agentMessage('BLM 连接战略制定和执行。'),
        message('还是没懂，能用大白话解释吗？'),
      ]),
    ).toBe('华为的 BLM 讲了什么？\n还是没懂，能用大白话解释吗？');
  });

  it('keeps an independent question unchanged', () => {
    expect(
      contextualRecallQuery([
        message('华为的 BLM 讲了什么？'),
        agentMessage('BLM 连接战略制定和执行。'),
        message('华为销售是如何管理的？'),
      ]),
    ).toBe('华为销售是如何管理的？');
  });
});

function preparedRun(overrides: Partial<PreparedAgentRun> = {}): PreparedAgentRun {
  return {
    id: '00000000-0000-7000-8000-000000000001',
    tenantId: '00000000-0000-7000-8000-000000000002',
    conversationId: '00000000-0000-7000-8000-000000000003',
    requesterUserId: '00000000-0000-7000-8000-000000000004',
    requesterRole: 'MEMBER',
    agentId: '00000000-0000-7000-8000-000000000005',
    agentName: 'Policy assistant',
    agentVersionId: '00000000-0000-7000-8000-000000000006',
    agentVersion: 1,
    systemPrompt: 'Answer safely.',
    externalRunId: null,
    turnIndex: 1,
    turnLimit: 1,
    maxInputTokens: 1_000_000,
    maxOutputTokens: 4_000,
    messages: [message('current question')],
    knowledgeSources: [],
    knowledgeGroundingRequired: true,
    ...overrides,
  };
}

function message(text: string): PreparedAgentRun['messages'][number] {
  return {
    senderType: 'USER',
    senderId: '00000000-0000-7000-8000-000000000004',
    senderName: 'Requester',
    text,
  };
}

function agentMessage(text: string): PreparedAgentRun['messages'][number] {
  return {
    senderType: 'AGENT',
    senderId: '00000000-0000-7000-8000-000000000005',
    senderName: 'Policy assistant',
    text,
  };
}

function manusRoute(): NonNullable<PreparedAgentRun['modelRoute']> {
  return {
    schemaVersion: 1,
    policyVersionId: '00000000-0000-7000-8000-000000000010',
    policyVersion: 1,
    policyHash: 'c'.repeat(64),
    taskClass: 'GENERAL',
    maximumClassification: 'INTERNAL',
    requiredCapabilities: [],
    maximumAttempts: 1,
    circuitFailureThreshold: 3,
    circuitOpenSeconds: 60,
    candidates: [
      {
        ordinal: 1,
        catalogVersionId: '00000000-0000-7000-8000-000000000011',
        routeKey: 'GENERAL.PRIMARY',
        provider: 'MANUS',
        model: 'manus-1.6-lite',
        credentialReference: 'vault://manus/general',
      },
    ],
  };
}

function knowledgeSource(suffix: string, excerpt: string): AgentRunKnowledgeSource {
  const normalized = suffix.padStart(12, '0');
  return {
    documentId: `00000000-0000-7000-8000-${normalized}`,
    documentVersionId: `00000000-0000-7000-8001-${normalized}`,
    chunkId: `00000000-0000-7000-8002-${normalized}`,
    knowledgeBaseId: `00000000-0000-7000-8003-${normalized}`,
    knowledgeBaseName: 'Policies',
    title: `Policy ${suffix}`,
    documentVersion: 1,
    headingPath: ['Policy'],
    sourceType: 'TEXT',
    excerpt,
    classification: 'INTERNAL',
    governanceHash: 'a'.repeat(64),
    contentHash: 'b'.repeat(64),
    updatedAt: '2026-07-22T00:00:00.000Z',
  };
}

function memoryContext(summary: string): NonNullable<PreparedAgentRun['memoryContexts']>[number] {
  return {
    id: '00000000-0000-7000-8000-000000000021',
    version: 1,
    revision: 1,
    scope: 'EMPLOYEE_PRIVATE',
    title: 'Preference',
    summary,
    summarySha256: 'a'.repeat(64),
    contentHash: 'b'.repeat(64),
    sourceType: 'USER_CONFIRMED',
    sourceId: '00000000-0000-7000-8000-000000000022',
    sourceVersion: 1,
    sensitivity: 'CONFIDENTIAL',
    effectiveFrom: '2026-07-28T00:00:00.000Z',
    effectiveTo: null,
    expiresAt: null,
    updatedAt: '2026-07-28T00:00:00.000Z',
  };
}
