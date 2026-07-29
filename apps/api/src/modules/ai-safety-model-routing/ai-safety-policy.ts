import { createHash } from 'node:crypto';

import type { AiDataClassification, AiSafetyDecision } from '@enterprise/contracts';

import type {
  AgentRunContextMessage,
  AgentRunKnowledgeSource,
  AgentRunMemoryContext,
} from '../agent-run/domain/agent-run.models.js';
import { maximumAiDataClassification } from './ai-data-classification.js';

const DETECTOR_VERSION = 'deterministic-minimizer-v1';
const PRIVATE_KEY_PATTERN = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/-]{20,}={0,2}\b/giu;
const GENERIC_SECRET_PATTERN =
  /\b(?:api[_ -]?key|secret|password|access[_ -]?token)\s*[:=]\s*["']?[A-Za-z0-9._~+/-]{12,}={0,2}["']?/giu;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu;
const PHONE_PATTERN = /(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)/gu;
const INJECTION_PATTERN =
  /(?:ignore|disregard|override)\s+(?:all\s+)?(?:(?:previous|prior)(?:\s+system)?|system)\s+(?:instructions?|prompts?)/iu;

export interface InputSafetyResult {
  readonly messages: readonly AgentRunContextMessage[];
  readonly knowledgeSources: readonly AgentRunKnowledgeSource[];
  readonly memoryContexts: readonly AgentRunMemoryContext[];
  readonly decision: AiSafetyDecision;
}

export function classifyTextForAiEgress(value: string): AiDataClassification {
  if (PRIVATE_KEY_PATTERN.test(value)) return 'RESTRICTED';
  return minimizeSensitiveText(value) === value ? 'INTERNAL' : 'CONFIDENTIAL';
}

export function evaluateAndMinimizeRunInput(input: {
  readonly messages: readonly AgentRunContextMessage[];
  readonly knowledgeSources: readonly AgentRunKnowledgeSource[];
  readonly memoryContexts?: readonly AgentRunMemoryContext[];
  readonly modelPolicyClassification?: AiDataClassification;
}): InputSafetyResult {
  const memoryContexts = input.memoryContexts ?? [];
  const rawCanonical = canonicalInput(input.messages, input.knowledgeSources, memoryContexts);
  if (PRIVATE_KEY_PATTERN.test(rawCanonical)) {
    return {
      messages: input.messages,
      knowledgeSources: input.knowledgeSources,
      memoryContexts,
      decision: decisionFor({
        direction: 'INPUT',
        classification: 'RESTRICTED',
        action: 'BLOCK',
        reasonCodes: ['PRIVATE_KEY_MATERIAL_DETECTED'],
        raw: rawCanonical,
        redacted: null,
      }),
    };
  }

  const minimizedMessages = input.messages.map((message) => ({
    ...message,
    text: minimizeSensitiveText(message.text),
  }));
  const minimizedSources = input.knowledgeSources.map((source) => ({
    ...source,
    excerpt: minimizeSensitiveText(source.excerpt),
  }));
  const minimizedMemories = memoryContexts.map((memory) => ({
    ...memory,
    summary: minimizeSensitiveText(memory.summary),
  }));
  const minimizedCanonical = canonicalInput(minimizedMessages, minimizedSources, minimizedMemories);
  const redacted = minimizedCanonical !== rawCanonical;
  const detectedClassification: AiDataClassification = redacted ? 'CONFIDENTIAL' : 'INTERNAL';
  const effectiveClassification = maximumAiDataClassification(
    detectedClassification,
    input.modelPolicyClassification ?? 'PUBLIC',
    ...input.knowledgeSources.map((source) => source.classification),
    ...memoryContexts.map((memory) => memory.sensitivity),
  );
  const knowledgeInjectionRisk = input.knowledgeSources.some((source) =>
    INJECTION_PATTERN.test(source.excerpt),
  );
  const memoryInjectionRisk = memoryContexts.some((memory) =>
    INJECTION_PATTERN.test(memory.summary),
  );
  const reasonCodes = [
    ...(redacted ? ['FIELD_LEVEL_MINIMIZATION_APPLIED'] : []),
    ...(knowledgeInjectionRisk ? ['UNTRUSTED_KNOWLEDGE_INSTRUCTION_DETECTED'] : []),
    ...(memoryInjectionRisk ? ['UNTRUSTED_MEMORY_INSTRUCTION_DETECTED'] : []),
    ...(effectiveClassification !== detectedClassification
      ? ['CONTEXT_CLASSIFICATION_ENFORCED']
      : []),
    ...(!redacted && !knowledgeInjectionRisk && !memoryInjectionRisk
      ? ['NO_SENSITIVE_PATTERN_DETECTED']
      : []),
  ];
  return {
    messages: minimizedMessages,
    knowledgeSources: minimizedSources,
    memoryContexts: minimizedMemories,
    decision: decisionFor({
      direction: 'INPUT',
      classification: effectiveClassification,
      action: redacted ? 'REDACT' : 'ALLOW',
      reasonCodes,
      raw: rawCanonical,
      redacted: redacted ? minimizedCanonical : null,
    }),
  };
}

function minimizeSensitiveText(value: string): string {
  return value
    .replace(BEARER_PATTERN, '[REDACTED_BEARER_TOKEN]')
    .replace(GENERIC_SECRET_PATTERN, '[REDACTED_SECRET]')
    .replace(EMAIL_PATTERN, '[REDACTED_EMAIL]')
    .replace(PHONE_PATTERN, '[REDACTED_PHONE]');
}

function decisionFor(input: {
  readonly direction: 'INPUT' | 'OUTPUT';
  readonly classification: 'PUBLIC' | 'INTERNAL' | 'CONFIDENTIAL' | 'RESTRICTED';
  readonly action: 'ALLOW' | 'REDACT' | 'BLOCK';
  readonly reasonCodes: readonly string[];
  readonly raw: string;
  readonly redacted: string | null;
}): AiSafetyDecision {
  const contentSha256 = sha256(input.raw);
  const redactedContentSha256 = input.redacted === null ? null : sha256(input.redacted);
  const core = {
    direction: input.direction,
    classification: input.classification,
    action: input.action,
    reasonCodes: [...input.reasonCodes],
    contentSha256,
    redactedContentSha256,
    detectorVersion: DETECTOR_VERSION,
  };
  return { ...core, decisionHash: sha256(JSON.stringify(core)) };
}

function canonicalInput(
  messages: readonly AgentRunContextMessage[],
  sources: readonly AgentRunKnowledgeSource[],
  memories: readonly AgentRunMemoryContext[],
): string {
  return JSON.stringify({
    messages: messages.map(({ senderType, senderId, text }) => ({ senderType, senderId, text })),
    sources: sources.map(
      ({ chunkId, documentVersionId, excerpt, classification, governanceHash, contentHash }) => ({
        chunkId,
        documentVersionId,
        excerpt,
        classification,
        governanceHash,
        contentHash,
      }),
    ),
    memories: memories.map(({ id, version, summary, sensitivity }) => ({
      id,
      version,
      summary,
      sensitivity,
    })),
  });
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
