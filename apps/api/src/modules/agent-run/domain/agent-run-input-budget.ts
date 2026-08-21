import { Buffer } from 'node:buffer';

import type { PreparedAgentRun } from './agent-run.models.js';

// Covers the runtime identity, grounding/security instructions and chat wire
// envelope that are added after this domain-level context packer runs.
const CONSERVATIVE_PROTOCOL_ALLOWANCE_BYTES = 4_096;
const MAX_OPTIONAL_HISTORY_MESSAGES = 6;
const WINDOW_MEMORY_MESSAGES = 2;
const WINDOW_MEMORY_MESSAGE_CHARACTERS = 600;
const CONTEXTUAL_RECALL_PART_CHARACTERS = 1_000;
// Manus task.create currently rejects otherwise valid requests once the single
// text prompt grows into the observed 12-13 KB range, although its public v2
// schema does not publish a text limit. Keep the conservative packed envelope
// below that boundary while preserving retrieval order. The fixed protocol
// allowance above means the final provider text remains comfortably smaller.
const MANUS_TASK_CREATE_CONSERVATIVE_BUDGET_BYTES = 10_000;

export type ConservativeAgentRunPackingResult =
  | { readonly kind: 'packed'; readonly run: PreparedAgentRun }
  | { readonly kind: 'required_input_exceeds_budget' };

/**
 * Packs optional Agent context with a provider-independent, fail-closed UTF-8
 * upper bound. This conservative estimator is not a model tokenizer.
 *
 * The system prompt and current question are mandatory. The latest conversation
 * exchange is reserved before purpose-filtered collaboration evidence, trusted RAG
 * sources, persisted memory and older history. Returned messages remain in
 * chronological order.
 */
export function packConservativeAgentRunInput(
  run: PreparedAgentRun,
): ConservativeAgentRunPackingResult {
  const currentQuestion = run.messages.at(-1);
  if (currentQuestion === undefined) {
    throw new Error('Prepared Agent Run requires a current input message.');
  }

  let packed: PreparedAgentRun = {
    ...run,
    messages: [currentQuestion],
    knowledgeSources: [],
    ...(run.memoryContexts === undefined ? {} : { memoryContexts: [] }),
    ...(run.collaborationContext === undefined
      ? {}
      : { collaborationContext: { ...run.collaborationContext, sources: [] } }),
  };
  if (exceedsConservativeInputBudget(packed)) {
    return { kind: 'required_input_exceeds_budget' };
  }

  const optionalHistory = compactOptionalHistory(run.messages.slice(0, -1));
  const windowHistory = optionalHistory.slice(-WINDOW_MEMORY_MESSAGES);
  const compactedWindowHistory = windowHistory.map(compactWindowMemoryMessage);
  const completeWindowCandidate: PreparedAgentRun = {
    ...packed,
    messages: [...compactedWindowHistory, currentQuestion],
  };
  if (!exceedsConservativeInputBudget(completeWindowCandidate)) {
    packed = completeWindowCandidate;
  } else {
    for (let index = compactedWindowHistory.length - 1; index >= 0; index -= 1) {
      const candidate: PreparedAgentRun = {
        ...packed,
        messages: [compactedWindowHistory[index]!, ...packed.messages],
      };
      if (!exceedsConservativeInputBudget(candidate)) packed = candidate;
    }
  }

  for (const source of run.collaborationContext?.sources ?? []) {
    if (packed.collaborationContext === undefined) break;
    const candidate: PreparedAgentRun = {
      ...packed,
      collaborationContext: {
        ...packed.collaborationContext,
        sources: [...packed.collaborationContext.sources, source],
      },
    };
    if (!exceedsConservativeInputBudget(candidate)) packed = candidate;
  }

  for (const source of run.knowledgeSources ?? []) {
    const candidate: PreparedAgentRun = {
      ...packed,
      knowledgeSources: [...(packed.knowledgeSources ?? []), source],
    };
    if (!exceedsConservativeInputBudget(candidate)) packed = candidate;
  }

  for (const memory of run.memoryContexts ?? []) {
    const candidate: PreparedAgentRun = {
      ...packed,
      memoryContexts: [...(packed.memoryContexts ?? []), memory],
    };
    if (!exceedsConservativeInputBudget(candidate)) packed = candidate;
  }

  const olderHistory = optionalHistory.slice(0, optionalHistory.length - windowHistory.length);
  for (let index = olderHistory.length - 1; index >= 0; index -= 1) {
    const candidate: PreparedAgentRun = {
      ...packed,
      messages: [olderHistory[index]!, ...packed.messages],
    };
    if (!exceedsConservativeInputBudget(candidate)) packed = candidate;
  }

  return { kind: 'packed', run: packed };
}

function compactWindowMemoryMessage(
  message: PreparedAgentRun['messages'][number],
): PreparedAgentRun['messages'][number] {
  const characters = Array.from(message.text);
  if (characters.length <= WINDOW_MEMORY_MESSAGE_CHARACTERS) return message;
  return {
    ...message,
    text: `${characters.slice(0, WINDOW_MEMORY_MESSAGE_CHARACTERS).join('')}\n[窗口记忆已截断]`,
  };
}

export function contextualRecallQuery(
  messages: readonly PreparedAgentRun['messages'][number][],
): string {
  const current = messages.at(-1)?.text.trim() ?? '';
  if (!isContextualFollowUp(current)) return current;
  const previousUserMessage = messages
    .slice(0, -1)
    .reverse()
    .find(({ senderType, text }) => senderType === 'USER' && text.trim() !== current);
  if (previousUserMessage === undefined) return current;
  return `${truncateCharacters(
    previousUserMessage.text.trim(),
    CONTEXTUAL_RECALL_PART_CHARACTERS,
  )}\n${truncateCharacters(current, CONTEXTUAL_RECALL_PART_CHARACTERS)}`;
}

function isContextualFollowUp(text: string): boolean {
  return /^(?:那|那么|这个|这种|这些|那个|它|上面|上述|刚才|前面|还是|继续|再(?:说|讲|解释|展开)|请再)|(?:没懂|大白话|换句话|说简单点|详细一点|展开说)/u.test(
    text,
  );
}

function truncateCharacters(text: string, maximum: number): string {
  return Array.from(text).slice(0, maximum).join('');
}

function compactOptionalHistory(
  history: readonly PreparedAgentRun['messages'][number][],
): readonly PreparedAgentRun['messages'][number][] {
  const newestFirst: PreparedAgentRun['messages'][number][] = [];
  const seen = new Set<string>();
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index]!;
    const normalizedText = message.text.replace(/\s+/gu, ' ').trim();
    const signature = `${message.senderType}\u0000${message.senderId}\u0000${normalizedText}`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    newestFirst.push(message);
    if (newestFirst.length === MAX_OPTIONAL_HISTORY_MESSAGES) break;
  }
  return newestFirst.reverse();
}

export function exceedsConservativeInputBudget(run: PreparedAgentRun): boolean {
  return conservativeAgentRunInputUpperBound(run) > conservativeInputBudget(run);
}

function conservativeInputBudget(run: PreparedAgentRun): number {
  const usesManus =
    run.modelRoute?.candidates.some(({ provider }) => provider === 'MANUS') ?? false;
  return usesManus
    ? Math.min(run.maxInputTokens, MANUS_TASK_CREATE_CONSERVATIVE_BUDGET_BYTES)
    : run.maxInputTokens;
}

export function conservativeAgentRunInputUpperBound(run: PreparedAgentRun): number {
  const serialized = JSON.stringify({
    systemPrompt: run.systemPrompt,
    agentName: run.agentName,
    messages: run.messages.map((message) => ({
      senderType: message.senderType,
      senderName: message.senderName,
      text: message.text,
    })),
    knowledgeSources: (run.knowledgeSources ?? []).map((source) => ({
      chunkId: source.chunkId,
      title: source.title,
      documentVersion: source.documentVersion,
      headingPath: source.headingPath,
      excerpt: source.excerpt,
    })),
    memoryContexts: (run.memoryContexts ?? []).map((memory) => ({
      id: memory.id,
      version: memory.version,
      scope: memory.scope,
      title: memory.title,
      sensitivity: memory.sensitivity,
      summary: memory.summary,
    })),
    collaborationContext:
      run.collaborationContext === undefined
        ? undefined
        : {
            requesterUserId: run.collaborationContext.requesterUserId,
            representedEmployeeId: run.collaborationContext.representedEmployeeId,
            purpose: run.collaborationContext.purpose,
            relationship: run.collaborationContext.relationship,
            policyHash: run.collaborationContext.policyHash,
            sources: run.collaborationContext.sources.map((source) => ({
              sourceId: source.sourceId,
              sourceType: source.sourceType,
              sourceVersion: source.sourceVersion,
              title: source.title,
              content: source.content,
            })),
          },
  });
  // JSON size includes escaping and dynamic labels. The fixed allowance covers
  // prompt boilerplate and chat-protocol framing before Runtime independently
  // checks the final message envelope.
  return Buffer.byteLength(serialized, 'utf8') + CONSERVATIVE_PROTOCOL_ALLOWANCE_BYTES;
}
