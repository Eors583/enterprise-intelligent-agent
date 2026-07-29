import { Buffer } from 'node:buffer';

import type { PreparedAgentRun } from './agent-run.models.js';

const CONSERVATIVE_PROTOCOL_ALLOWANCE_BYTES = 2_048;

export type ConservativeAgentRunPackingResult =
  | { readonly kind: 'packed'; readonly run: PreparedAgentRun }
  | { readonly kind: 'required_input_exceeds_budget' };

/**
 * Packs optional Agent context with a provider-independent, fail-closed UTF-8
 * upper bound. This conservative estimator is not a model tokenizer.
 *
 * The system prompt and current question are mandatory. Trusted RAG sources are
 * considered in retrieval order, followed by purpose-bound memory and then
 * conversation history from newest to oldest. Returned messages remain in
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
  };
  if (exceedsConservativeInputBudget(packed)) {
    return { kind: 'required_input_exceeds_budget' };
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

  for (let index = run.messages.length - 2; index >= 0; index -= 1) {
    const candidate: PreparedAgentRun = {
      ...packed,
      messages: [run.messages[index]!, ...packed.messages],
    };
    if (!exceedsConservativeInputBudget(candidate)) packed = candidate;
  }

  return { kind: 'packed', run: packed };
}

export function exceedsConservativeInputBudget(run: PreparedAgentRun): boolean {
  return conservativeAgentRunInputUpperBound(run) > run.maxInputTokens;
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
  });
  // JSON size includes escaping and dynamic labels. The fixed allowance covers
  // prompt boilerplate and chat-protocol framing before Runtime independently
  // checks the final message envelope.
  return Buffer.byteLength(serialized, 'utf8') + CONSERVATIVE_PROTOCOL_ALLOWANCE_BYTES;
}
