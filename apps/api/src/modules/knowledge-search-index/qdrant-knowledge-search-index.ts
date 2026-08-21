import { createHash } from 'node:crypto';

import {
  KnowledgeSearchIndex,
  type KnowledgeSearchIndexChunk,
  type KnowledgeSearchIndexHit,
  type KnowledgeSearchIndexQuery,
  type KnowledgeSearchIndexProfile,
  type KnowledgeSearchIndexStatus,
} from './knowledge-search-index.port.js';

const DENSE_VECTOR_NAME = 'dense';
const SPARSE_VECTOR_NAME = 'lexical';
const RRF_K = 60;
const UPSERT_BATCH_SIZE = 128;

export interface QdrantKnowledgeSearchIndexOptions {
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly collection: string;
  readonly dimensions: number;
  readonly timeoutMs: number;
  readonly fetchImplementation?: typeof fetch;
}

export class QdrantKnowledgeSearchIndex extends KnowledgeSearchIndex {
  readonly driver = 'qdrant' as const;
  private readonly baseUrl: URL;
  private readonly apiKey: string | undefined;
  private readonly collection: string;
  private readonly dimensions: number;
  private readonly timeoutMs: number;
  private readonly fetchImplementation: typeof fetch;
  private readonly collectionReadiness = new Map<string, Promise<void>>();

  constructor(options: QdrantKnowledgeSearchIndexOptions) {
    super();
    this.baseUrl = new URL(options.baseUrl);
    this.apiKey = options.apiKey;
    this.collection = options.collection;
    this.dimensions = options.dimensions;
    this.timeoutMs = options.timeoutMs;
    this.fetchImplementation = options.fetchImplementation ?? fetch;
  }

  async replaceDocumentVersion(input: {
    readonly profile: KnowledgeSearchIndexProfile;
    readonly tenantId: string;
    readonly documentVersionId: string;
    readonly active: boolean;
    readonly chunks: readonly KnowledgeSearchIndexChunk[];
  }): Promise<void> {
    const collection = await this.ensureCollection(input.profile);
    for (const chunk of input.chunks) {
      if (chunk.vector !== undefined && chunk.vector.length !== input.profile.dimensions) {
        throw new Error('KNOWLEDGE_QDRANT_DIMENSION_MISMATCH');
      }
    }
    await this.deleteByFilter(collection, [
      keywordCondition('tenant_id', input.tenantId),
      keywordCondition('document_version_id', input.documentVersionId),
    ]);
    for (let offset = 0; offset < input.chunks.length; offset += UPSERT_BATCH_SIZE) {
      const batch = input.chunks.slice(offset, offset + UPSERT_BATCH_SIZE);
      await this.request('PUT', `/collections/${encodeURIComponent(collection)}/points?wait=true`, {
        points: batch.map((chunk) => ({
          id: chunk.chunkId,
          vector: {
            [SPARSE_VECTOR_NAME]: sparseDocumentVector(indexText(chunk)),
            ...(chunk.vector === undefined ? {} : { [DENSE_VECTOR_NAME]: chunk.vector }),
          },
          payload: {
            tenant_id: chunk.tenantId,
            knowledge_base_id: chunk.knowledgeBaseId,
            document_id: chunk.documentId,
            document_version_id: chunk.documentVersionId,
            embedding_index_version_id: input.profile.indexVersionId,
            active: input.active,
            title: chunk.title,
            heading_path: [...chunk.headingPath],
            content: chunk.content,
            content_hash: chunk.contentHash,
            classification: chunk.classification,
            governance_hash: chunk.governanceHash,
            updated_at: chunk.updatedAt,
          },
        })),
      });
    }
  }

  async publishDocumentVersion(input: {
    readonly profile: KnowledgeSearchIndexProfile;
    readonly tenantId: string;
    readonly documentId: string;
    readonly documentVersionId: string;
  }): Promise<void> {
    const collection = await this.ensureCollection(input.profile);
    const scope = [
      keywordCondition('tenant_id', input.tenantId),
      keywordCondition('document_id', input.documentId),
    ];
    await this.setPayload(collection, scope, { active: false });
    await this.setPayload(
      collection,
      [...scope, keywordCondition('document_version_id', input.documentVersionId)],
      { active: true },
    );
  }

  async archiveDocument(input: {
    readonly profile: KnowledgeSearchIndexProfile;
    readonly tenantId: string;
    readonly documentId: string;
  }): Promise<void> {
    const collection = await this.ensureCollection(input.profile);
    await this.setPayload(
      collection,
      [
        keywordCondition('tenant_id', input.tenantId),
        keywordCondition('document_id', input.documentId),
      ],
      { active: false },
    );
  }

  async query(input: KnowledgeSearchIndexQuery): Promise<readonly KnowledgeSearchIndexHit[]> {
    if (input.knowledgeBaseIds.length === 0 || input.limit < 1) return [];
    const sparse = sparseQueryVector(input.query);
    if (sparse.indices.length === 0 && input.vector === undefined) return [];
    if (input.vector !== undefined && input.vector.length !== input.profile.dimensions) {
      throw new Error('KNOWLEDGE_QDRANT_DIMENSION_MISMATCH');
    }
    const collection = await this.ensureCollection(input.profile);
    const filter = {
      must: [
        keywordCondition('tenant_id', input.tenantId),
        anyCondition('knowledge_base_id', input.knowledgeBaseIds),
        ...(input.profile.compatibleIndexVersionIds === undefined
          ? []
          : [anyCondition('embedding_index_version_id', input.profile.compatibleIndexVersionIds)]),
        ...(input.previewDocumentVersionIds === undefined ||
        input.previewDocumentVersionIds.length === 0
          ? [keywordCondition('active', true)]
          : [anyCondition('document_version_id', input.previewDocumentVersionIds)]),
      ],
    };
    const candidateLimit = Math.min(200, Math.max(input.limit, input.limit * 4));
    const body =
      input.vector === undefined || sparse.indices.length === 0
        ? {
            query: input.vector ?? sparse,
            using: input.vector === undefined ? SPARSE_VECTOR_NAME : DENSE_VECTOR_NAME,
            filter,
            limit: input.limit,
            with_payload: false,
            with_vector: false,
          }
        : {
            prefetch: [
              {
                query: sparse,
                using: SPARSE_VECTOR_NAME,
                filter,
                limit: candidateLimit,
              },
              {
                query: input.vector,
                using: DENSE_VECTOR_NAME,
                filter,
                limit: candidateLimit,
              },
            ],
            query: { rrf: { k: RRF_K } },
            filter,
            limit: input.limit,
            with_payload: false,
            with_vector: false,
          };
    const response = await this.request(
      'POST',
      `/collections/${encodeURIComponent(collection)}/points/query`,
      body,
    );
    const points = readQueryPoints(response);
    // Qdrant returns reciprocal-rank-fusion scores when both dense and sparse
    // prefetches are present. Those scores are rank values (roughly 1 / (k+r)),
    // not cosine similarities, so normalize them before applying the retrieval
    // service's common semantic thresholds. With two prefetch branches, agreement
    // at rank one maps to 1 and a rank-one hit from only one branch maps to 0.5;
    // dense-only queries keep their native score.
    const hybrid = input.vector !== undefined && sparse.indices.length > 0;
    return points.map((point) => ({
      chunkId: point.id,
      score: hybrid ? normalizeRrfScore(point.score) : point.score,
    }));
  }

  async status(profile?: KnowledgeSearchIndexProfile): Promise<KnowledgeSearchIndexStatus> {
    const resolvedProfile = profile ?? {
      indexVersionId: 'deployment-default',
      collectionName: null,
      dimensions: this.dimensions,
      distance: 'COSINE' as const,
    };
    try {
      const collection = await this.ensureCollection(resolvedProfile);
      return {
        driver: this.driver,
        ready: true,
        collection,
        dimensions: resolvedProfile.dimensions,
      };
    } catch {
      const collection = this.resolveCollection(resolvedProfile);
      this.collectionReadiness.delete(collection);
      return {
        driver: this.driver,
        ready: false,
        collection,
        dimensions: resolvedProfile.dimensions,
      };
    }
  }

  private async ensureCollection(profile: KnowledgeSearchIndexProfile): Promise<string> {
    const collection = this.resolveCollection(profile);
    let readiness = this.collectionReadiness.get(collection);
    readiness ??= this.initializeCollection(collection, profile.dimensions).catch((error) => {
      this.collectionReadiness.delete(collection);
      throw error;
    });
    this.collectionReadiness.set(collection, readiness);
    await readiness;
    return collection;
  }

  private resolveCollection(profile: KnowledgeSearchIndexProfile): string {
    return profile.collectionName ?? this.collection;
  }

  private async initializeCollection(collection: string, dimensions: number): Promise<void> {
    const path = `/collections/${encodeURIComponent(collection)}`;
    const existing = await this.request('GET', path, undefined, true);
    if (existing === null) {
      await this.request('PUT', path, {
        vectors: {
          [DENSE_VECTOR_NAME]: {
            size: dimensions,
            distance: 'Cosine',
            on_disk: true,
          },
        },
        sparse_vectors: {
          [SPARSE_VECTOR_NAME]: { modifier: 'idf', on_disk: true },
        },
        on_disk_payload: true,
      });
    } else if (readDenseVectorDimensions(existing) !== dimensions) {
      throw new Error('KNOWLEDGE_QDRANT_DIMENSION_MISMATCH');
    }
    for (const fieldName of [
      'tenant_id',
      'knowledge_base_id',
      'document_id',
      'document_version_id',
      'embedding_index_version_id',
      'active',
    ]) {
      await this.request(
        'PUT',
        `/collections/${encodeURIComponent(collection)}/index?wait=true`,
        { field_name: fieldName, field_schema: fieldName === 'active' ? 'bool' : 'keyword' },
        false,
        true,
      );
    }
  }

  private async deleteByFilter(
    collection: string,
    must: readonly Record<string, unknown>[],
  ): Promise<void> {
    await this.request(
      'POST',
      `/collections/${encodeURIComponent(collection)}/points/delete?wait=true`,
      { filter: { must } },
    );
  }

  private async setPayload(
    collection: string,
    must: readonly Record<string, unknown>[],
    payload: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await this.request(
      'POST',
      `/collections/${encodeURIComponent(collection)}/points/payload?wait=true`,
      { payload, filter: { must } },
    );
  }

  private async request(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    body?: unknown,
    allowNotFound = false,
    allowConflict = false,
  ): Promise<unknown | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();
    try {
      const response = await this.fetchImplementation(new URL(path, this.baseUrl), {
        method,
        headers: {
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(this.apiKey === undefined ? {} : { 'api-key': this.apiKey }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'error',
        signal: controller.signal,
      });
      if (allowNotFound && response.status === 404) return null;
      if (allowConflict && response.status === 409) return {};
      if (!response.ok) throw new Error(`KNOWLEDGE_QDRANT_HTTP_${response.status}`);
      const text = await response.text();
      if (text.length === 0) return {};
      const parsed: unknown = JSON.parse(text);
      if (!isRecord(parsed) || parsed.status !== 'ok') {
        throw new Error('KNOWLEDGE_QDRANT_INVALID_RESPONSE');
      }
      return parsed;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('KNOWLEDGE_QDRANT_')) throw error;
      throw new Error('KNOWLEDGE_QDRANT_UNAVAILABLE', { cause: error });
    } finally {
      clearTimeout(timer);
    }
  }
}

function normalizeRrfScore(score: number): number {
  if (!Number.isFinite(score) || score <= 0) return 0;
  return Math.min(1, (score * (RRF_K + 1)) / 2);
}

function readDenseVectorDimensions(response: unknown): number | null {
  if (!isRecord(response)) return null;
  const result = response.result;
  if (!isRecord(result)) return null;
  const config = result.config;
  if (!isRecord(config)) return null;
  const params = config.params;
  if (!isRecord(params)) return null;
  const vectors = params.vectors;
  if (!isRecord(vectors)) return null;
  const dense = vectors[DENSE_VECTOR_NAME];
  if (!isRecord(dense)) return null;
  return Number.isSafeInteger(dense.size) && (dense.size as number) > 0
    ? (dense.size as number)
    : null;
}

function indexText(chunk: KnowledgeSearchIndexChunk): string {
  return [chunk.title, chunk.headingPath.join(' '), chunk.content].filter(Boolean).join('\n');
}

function sparseDocumentVector(text: string): { indices: number[]; values: number[] } {
  const frequencies = tokenFrequencies(text);
  const entries = [...frequencies.entries()]
    .map(([token, frequency]) => [tokenIndex(token), 1 + Math.log(frequency)] as const)
    .sort(([left], [right]) => left - right);
  return combineSparseEntries(entries);
}

function sparseQueryVector(text: string): { indices: number[]; values: number[] } {
  const entries = [...tokenFrequencies(text).keys()]
    .map((token) => [tokenIndex(token), 1] as const)
    .sort(([left], [right]) => left - right);
  return combineSparseEntries(entries);
}

function combineSparseEntries(entries: readonly (readonly [number, number])[]): {
  indices: number[];
  values: number[];
} {
  const combined = new Map<number, number>();
  for (const [index, value] of entries) combined.set(index, (combined.get(index) ?? 0) + value);
  const sorted = [...combined.entries()].sort(([left], [right]) => left - right).slice(0, 4_096);
  return { indices: sorted.map(([index]) => index), values: sorted.map(([, value]) => value) };
}

function tokenFrequencies(text: string): Map<string, number> {
  const normalized = text.normalize('NFKC').toLowerCase();
  const latin = normalized.match(/[a-z0-9][a-z0-9._:/-]{0,63}/gu) ?? [];
  const chineseRuns = normalized.match(/[\p{Script=Han}]+/gu) ?? [];
  const chinese = chineseRuns.flatMap((run) => {
    const characters = [...run];
    return [
      ...(characters.length <= 16 ? [run] : []),
      ...characters.slice(0, -1).map((character, index) => character + characters[index + 1]),
      ...characters
        .slice(0, -2)
        .map((character, index) => character + characters[index + 1] + characters[index + 2]),
    ];
  });
  const frequencies = new Map<string, number>();
  for (const token of [...latin, ...chinese].slice(0, 20_000)) {
    if (token.length === 0) continue;
    frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
  }
  return frequencies;
}

function tokenIndex(token: string): number {
  return createHash('sha256').update(token, 'utf8').digest().readUInt32BE(0);
}

function keywordCondition(key: string, value: string | boolean): Record<string, unknown> {
  return { key, match: { value } };
}

function anyCondition(key: string, values: readonly string[]): Record<string, unknown> {
  return { key, match: { any: [...new Set(values)] } };
}

function readQueryPoints(value: unknown): Array<{ id: string; score: number }> {
  if (!isRecord(value) || !isRecord(value.result) || !Array.isArray(value.result.points)) {
    throw new Error('KNOWLEDGE_QDRANT_INVALID_RESPONSE');
  }
  return value.result.points.map((point) => {
    if (!isRecord(point) || typeof point.id !== 'string' || typeof point.score !== 'number') {
      throw new Error('KNOWLEDGE_QDRANT_INVALID_RESPONSE');
    }
    return { id: point.id, score: point.score };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
