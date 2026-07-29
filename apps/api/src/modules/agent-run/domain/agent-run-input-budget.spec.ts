import { describe, expect, it } from 'vitest';

import type { AgentRunKnowledgeSource, PreparedAgentRun } from './agent-run.models.js';
import {
  conservativeAgentRunInputUpperBound,
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

  it('keeps RAG sources in retrieval order before optional conversation history', () => {
    const current = message('current question');
    const firstSource = knowledgeSource('1', 'highest-ranked source');
    const secondSource = knowledgeSource('2', 'lower-ranked source');
    const requiredWithFirstSource = preparedRun({
      messages: [current],
      knowledgeSources: [firstSource],
    });
    const candidate = preparedRun({
      messages: [message('older history'), message('newer history'), current],
      knowledgeSources: [firstSource, secondSource],
      maxInputTokens: conservativeAgentRunInputUpperBound(requiredWithFirstSource),
    });

    const result = packConservativeAgentRunInput(candidate);

    expect(result).toMatchObject({ kind: 'packed' });
    if (result.kind !== 'packed') return;
    expect(result.run.knowledgeSources).toEqual([firstSource]);
    expect(result.run.messages).toEqual([current]);
  });

  it('adds optional history newest-first while preserving chronological output order', () => {
    const older = message('older history');
    const newer = message('newer history');
    const current = message('current question');
    const source = knowledgeSource('1', 'trusted source');
    const requiredWithNewer = preparedRun({
      messages: [newer, current],
      knowledgeSources: [source],
    });
    const candidate = preparedRun({
      messages: [older, newer, current],
      knowledgeSources: [source],
      maxInputTokens: conservativeAgentRunInputUpperBound(requiredWithNewer),
    });

    const result = packConservativeAgentRunInput(candidate);

    expect(result).toMatchObject({ kind: 'packed' });
    if (result.kind !== 'packed') return;
    expect(result.run.knowledgeSources).toEqual([source]);
    expect(result.run.messages).toEqual([newer, current]);
  });

  it('counts purpose-bound memory and packs it before optional history', () => {
    const current = message('current question');
    const memory = memoryContext('remembered preference');
    const requiredWithMemory = preparedRun({
      messages: [current],
      knowledgeSources: [],
      memoryContexts: [memory],
    });
    const candidate = preparedRun({
      messages: [message('older history '.repeat(100)), current],
      knowledgeSources: [],
      memoryContexts: [memory],
      maxInputTokens: conservativeAgentRunInputUpperBound(requiredWithMemory),
    });

    const result = packConservativeAgentRunInput(candidate);

    expect(result).toMatchObject({ kind: 'packed' });
    if (result.kind !== 'packed') return;
    expect(result.run.memoryContexts).toEqual([memory]);
    expect(result.run.messages).toEqual([current]);
  });

  it('retains all optional context when the conservative bound has room', () => {
    const candidate = preparedRun({
      messages: [message('history'), message('current question')],
      knowledgeSources: [knowledgeSource('1', 'source one'), knowledgeSource('2', 'source two')],
    });

    const result = packConservativeAgentRunInput(candidate);

    expect(result).toEqual({ kind: 'packed', run: candidate });
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
