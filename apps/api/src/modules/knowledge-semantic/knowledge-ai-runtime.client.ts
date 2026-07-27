import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';

import type { EnvironmentVariables } from '../../config/environment.js';

const MAX_EMBEDDING_BATCH = 64;
const MAX_RERANK_DOCUMENTS = 100;

export interface KnowledgeEmbeddingBatch {
  readonly model: string;
  readonly dimensions: 1536;
  readonly vectors: readonly (readonly number[])[];
  readonly inputTokens: number | null;
}

export interface KnowledgeRerankResult {
  readonly id: string;
  readonly relevanceScore: number;
}

export interface KnowledgeRerankBatch {
  readonly model: string;
  readonly results: readonly KnowledgeRerankResult[];
}

export type KnowledgeRuntimeCapabilityStatus = 'disabled' | 'ready' | 'not_ready';

export interface KnowledgeRuntimeCapabilities {
  readonly embeddings: {
    readonly status: KnowledgeRuntimeCapabilityStatus;
    readonly provider: 'disabled' | 'openai_compatible';
    readonly model: string | null;
    readonly dimensions: number;
  };
  readonly rerank: {
    readonly status: KnowledgeRuntimeCapabilityStatus;
    readonly provider: 'disabled' | 'cohere_compatible';
    readonly model: string | null;
  };
}

export class KnowledgeAiRuntimeError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    message = 'Knowledge AI service is unavailable.',
  ) {
    super(message);
    this.name = 'KnowledgeAiRuntimeError';
  }
}

@Injectable()
export class KnowledgeAiRuntimeClient {
  readonly semanticEnabled: boolean;
  readonly rerankEnabled: boolean;
  readonly vectorSearchMode: 'exact' | 'hnsw';
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly dimensions: 1536;

  constructor(@Inject(ConfigService) config: ConfigService<EnvironmentVariables, true>) {
    this.baseUrl = config.get('AI_RUNTIME_URL', { infer: true });
    this.timeoutMs = config.get('KNOWLEDGE_AI_TIMEOUT_MS', { infer: true });
    this.dimensions = config.get('KNOWLEDGE_EMBEDDING_DIMENSIONS', { infer: true });
    this.semanticEnabled = config.get('KNOWLEDGE_SEMANTIC_SEARCH_ENABLED', { infer: true });
    this.rerankEnabled = config.get('KNOWLEDGE_RERANK_ENABLED', { infer: true });
    this.vectorSearchMode = config.get('KNOWLEDGE_VECTOR_SEARCH_MODE', { infer: true });
  }

  get embeddingDimensions(): 1536 {
    return this.dimensions;
  }

  async embed(tenantId: string, inputs: readonly string[]): Promise<KnowledgeEmbeddingBatch> {
    if (!this.semanticEnabled) {
      throw new KnowledgeAiRuntimeError(
        'KNOWLEDGE_SEMANTIC_DISABLED',
        false,
        'Semantic knowledge search is disabled.',
      );
    }
    if (inputs.length < 1 || inputs.length > MAX_EMBEDDING_BATCH) {
      throw new KnowledgeAiRuntimeError('KNOWLEDGE_EMBEDDING_BATCH_INVALID', false);
    }
    const payload = await this.request('/internal/v1/knowledge/embeddings', tenantId, 'POST', {
      tenant_id: tenantId,
      inputs,
    });
    return parseEmbeddingResponse(payload, inputs.length, this.dimensions);
  }

  async embedAll(tenantId: string, inputs: readonly string[]): Promise<KnowledgeEmbeddingBatch> {
    if (inputs.length === 0) {
      return { model: '', dimensions: this.dimensions, vectors: [], inputTokens: 0 };
    }
    const vectors: Array<readonly number[]> = [];
    let model: string | null = null;
    let inputTokens: number | null = 0;
    for (let offset = 0; offset < inputs.length; offset += MAX_EMBEDDING_BATCH) {
      const batch = await this.embed(tenantId, inputs.slice(offset, offset + MAX_EMBEDDING_BATCH));
      if (model !== null && model !== batch.model) {
        throw new KnowledgeAiRuntimeError('KNOWLEDGE_EMBEDDING_MODEL_CHANGED', true);
      }
      model = batch.model;
      vectors.push(...batch.vectors);
      inputTokens =
        inputTokens === null || batch.inputTokens === null ? null : inputTokens + batch.inputTokens;
    }
    return {
      model: model ?? '',
      dimensions: this.dimensions,
      vectors,
      inputTokens,
    };
  }

  async rerank(
    tenantId: string,
    query: string,
    documents: readonly { readonly id: string; readonly text: string }[],
    topN: number,
  ): Promise<KnowledgeRerankBatch> {
    if (!this.rerankEnabled) return { model: '', results: [] };
    if (documents.length < 1 || documents.length > MAX_RERANK_DOCUMENTS) {
      throw new KnowledgeAiRuntimeError('KNOWLEDGE_RERANK_BATCH_INVALID', false);
    }
    const payload = await this.request('/internal/v1/knowledge/rerank', tenantId, 'POST', {
      tenant_id: tenantId,
      query,
      documents,
      top_n: Math.min(documents.length, Math.max(1, topN)),
    });
    return parseRerankResponse(payload, documents, Math.min(documents.length, Math.max(1, topN)));
  }

  async capabilities(tenantId: string): Promise<KnowledgeRuntimeCapabilities> {
    if (!this.semanticEnabled && !this.rerankEnabled) {
      return {
        embeddings: {
          status: 'disabled',
          provider: 'disabled',
          model: null,
          dimensions: this.dimensions,
        },
        rerank: { status: 'disabled', provider: 'disabled', model: null },
      };
    }
    const payload = parseCapabilitiesResponse(
      await this.request('/internal/v1/knowledge/capabilities', tenantId, 'GET'),
    );
    const embeddings = this.semanticEnabled
      ? normalizeEmbeddingCapability(payload.embeddings, this.dimensions)
      : {
          status: 'disabled' as const,
          provider: 'disabled' as const,
          model: null,
          dimensions: this.dimensions,
        };
    const rerank = this.rerankEnabled
      ? normalizeRerankCapability(payload.rerank)
      : { status: 'disabled' as const, provider: 'disabled' as const, model: null };
    return { embeddings, rerank };
  }

  private async request(
    path: string,
    tenantId: string,
    method: 'GET' | 'POST',
    body?: unknown,
  ): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();
    try {
      const response = await fetch(new URL(path, this.baseUrl), {
        method,
        headers: {
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          'X-Tenant-ID': tenantId,
          'X-Request-ID': `knowledge-${randomUUID()}`,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) throw errorFromResponse(response.status, payload);
      return payload;
    } catch (error) {
      if (error instanceof KnowledgeAiRuntimeError) throw error;
      if (controller.signal.aborted) {
        throw new KnowledgeAiRuntimeError('KNOWLEDGE_AI_TIMEOUT', true);
      }
      throw new KnowledgeAiRuntimeError('KNOWLEDGE_AI_UNAVAILABLE', true);
    } finally {
      clearTimeout(timer);
    }
  }
}

function parseCapabilitiesResponse(value: unknown): KnowledgeRuntimeCapabilities {
  if (!isRecord(value)) throw invalidResponse();
  return {
    embeddings: parseEmbeddingCapability(value.embeddings),
    rerank: parseRerankCapability(value.rerank),
  };
}

function normalizeEmbeddingCapability(
  capability: KnowledgeRuntimeCapabilities['embeddings'],
  configuredDimensions: number,
): KnowledgeRuntimeCapabilities['embeddings'] {
  if (
    capability.status === 'ready' &&
    (capability.provider === 'disabled' ||
      capability.model === null ||
      capability.dimensions !== configuredDimensions)
  ) {
    return { ...capability, status: 'not_ready' };
  }
  return capability.status === 'disabled' ? { ...capability, status: 'not_ready' } : capability;
}

function normalizeRerankCapability(
  capability: KnowledgeRuntimeCapabilities['rerank'],
): KnowledgeRuntimeCapabilities['rerank'] {
  if (
    capability.status === 'ready' &&
    (capability.provider === 'disabled' || capability.model === null)
  ) {
    return { ...capability, status: 'not_ready' };
  }
  return capability.status === 'disabled' ? { ...capability, status: 'not_ready' } : capability;
}

function parseEmbeddingCapability(value: unknown): KnowledgeRuntimeCapabilities['embeddings'] {
  if (
    !isRecord(value) ||
    (value.status !== 'disabled' && value.status !== 'ready' && value.status !== 'not_ready') ||
    (value.provider !== 'disabled' && value.provider !== 'openai_compatible') ||
    !Number.isSafeInteger(value.dimensions) ||
    (value.dimensions as number) < 1 ||
    (value.model !== null &&
      (typeof value.model !== 'string' || value.model.length < 1 || value.model.length > 200))
  ) {
    throw invalidResponse();
  }
  return {
    status: value.status,
    provider: value.provider,
    model: value.model,
    dimensions: value.dimensions as number,
  };
}

function parseRerankCapability(value: unknown): KnowledgeRuntimeCapabilities['rerank'] {
  if (
    !isRecord(value) ||
    (value.status !== 'disabled' && value.status !== 'ready' && value.status !== 'not_ready') ||
    (value.provider !== 'disabled' && value.provider !== 'cohere_compatible') ||
    (value.model !== null &&
      (typeof value.model !== 'string' || value.model.length < 1 || value.model.length > 200))
  ) {
    throw invalidResponse();
  }
  return { status: value.status, provider: value.provider, model: value.model };
}

function parseEmbeddingResponse(
  value: unknown,
  expectedCount: number,
  expectedDimensions: 1536,
): KnowledgeEmbeddingBatch {
  if (
    !isRecord(value) ||
    typeof value.model !== 'string' ||
    value.model.length < 1 ||
    value.model.length > 200
  ) {
    throw invalidResponse();
  }
  if (
    value.dimensions !== expectedDimensions ||
    !Array.isArray(value.items) ||
    value.items.length !== expectedCount
  ) {
    throw invalidResponse();
  }
  const ordered = new Array<readonly number[]>(expectedCount);
  for (const item of value.items) {
    if (!isRecord(item) || !Number.isSafeInteger(item.index) || !Array.isArray(item.embedding)) {
      throw invalidResponse();
    }
    const index = item.index as number;
    if (index < 0 || index >= expectedCount || ordered[index] !== undefined) {
      throw invalidResponse();
    }
    if (
      item.embedding.length !== expectedDimensions ||
      !item.embedding.every(
        (component) => typeof component === 'number' && Number.isFinite(component),
      ) ||
      !item.embedding.some((component) => Math.abs(component as number) > 0)
    ) {
      throw invalidResponse();
    }
    ordered[index] = item.embedding as number[];
  }
  if (ordered.includes(undefined as never)) throw invalidResponse();
  const usage = isRecord(value.usage) ? value.usage : null;
  const inputTokens =
    usage !== null &&
    Number.isSafeInteger(usage.input_tokens) &&
    (usage.input_tokens as number) >= 0
      ? (usage.input_tokens as number)
      : null;
  return {
    model: value.model,
    dimensions: expectedDimensions,
    vectors: ordered,
    inputTokens,
  };
}

function parseRerankResponse(
  value: unknown,
  documents: readonly { readonly id: string }[],
  expectedCount: number,
): KnowledgeRerankBatch {
  if (
    !isRecord(value) ||
    typeof value.model !== 'string' ||
    value.model.length < 1 ||
    value.model.length > 200 ||
    !Array.isArray(value.results) ||
    value.results.length !== expectedCount
  ) {
    throw invalidResponse();
  }
  const expectedIds = new Set(documents.map((document) => document.id));
  const seen = new Set<string>();
  const results = value.results.map((item) => {
    if (
      !isRecord(item) ||
      typeof item.id !== 'string' ||
      !expectedIds.has(item.id) ||
      seen.has(item.id) ||
      typeof item.relevance_score !== 'number' ||
      !Number.isFinite(item.relevance_score) ||
      item.relevance_score < 0 ||
      item.relevance_score > 1
    ) {
      throw invalidResponse();
    }
    seen.add(item.id);
    return { id: item.id, relevanceScore: item.relevance_score };
  });
  return { model: value.model, results };
}

function errorFromResponse(status: number, value: unknown): KnowledgeAiRuntimeError {
  const detail = isRecord(value) && isRecord(value.detail) ? value.detail : null;
  const code =
    detail !== null && typeof detail.code === 'string' && /^[A-Z0-9_]{1,120}$/.test(detail.code)
      ? detail.code
      : `KNOWLEDGE_AI_HTTP_${status}`;
  const retryable =
    detail !== null && typeof detail.retryable === 'boolean'
      ? detail.retryable
      : status === 408 || status === 429 || status >= 500;
  return new KnowledgeAiRuntimeError(code, retryable);
}

function invalidResponse(): KnowledgeAiRuntimeError {
  return new KnowledgeAiRuntimeError('KNOWLEDGE_AI_INVALID_RESPONSE', true);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
