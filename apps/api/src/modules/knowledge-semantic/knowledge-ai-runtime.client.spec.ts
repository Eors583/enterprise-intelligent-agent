import type { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EnvironmentVariables } from '../../config/environment.js';
import {
  KnowledgeAiRuntimeClient,
  KnowledgeAiRuntimeError,
} from './knowledge-ai-runtime.client.js';

const TENANT_ID = '00000000-0000-7000-8000-000000000001';
const DIMENSIONS = 1_536;

describe('KnowledgeAiRuntimeClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('orders embeddings by provider index and sends only tenant-scoped runtime metadata', async () => {
    const first = vector(0.1);
    const second = vector(0.2);
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        model: 'embedding-model-v1',
        dimensions: DIMENSIONS,
        items: [
          { index: 1, embedding: second },
          { index: 0, embedding: first },
        ],
        usage: { input_tokens: 17 },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = createClient({
      serviceToken: 'runtime-service-token-at-least-32-characters',
    });

    await expect(client.embed(TENANT_ID, ['first', 'second'], 'INTERNAL')).resolves.toEqual({
      model: 'embedding-model-v1',
      dimensions: DIMENSIONS,
      vectors: [first, second],
      inputTokens: 17,
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, request] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe('http://127.0.0.1:8100/internal/v1/knowledge/embeddings');
    expect(request.headers).toEqual(
      expect.objectContaining({
        'Content-Type': 'application/json',
        'X-Tenant-ID': TENANT_ID,
        Authorization: 'Bearer runtime-service-token-at-least-32-characters',
      }),
    );
    expect((request.headers as Record<string, string>)['X-Request-ID']).toMatch(/^knowledge-/);
    expect((request.headers as Record<string, string>)['X-Correlation-ID']).toBe(
      (request.headers as Record<string, string>)['X-Request-ID'],
    );
    expect(JSON.parse(String(request.body))).toEqual({
      tenant_id: TENANT_ID,
      inputs: ['first', 'second'],
    });
  });

  it('uses an index-version profile as the model and dimension contract', async () => {
    const dimensions = 768;
    const embedding = Array<number>(dimensions).fill(0.25);
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        model: 'bge-index-v2',
        dimensions,
        items: [{ index: 0, embedding }],
        usage: null,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = createClient({ dimensions });

    await expect(
      client.embed(TENANT_ID, ['input'], 'INTERNAL', undefined, {
        model: 'bge-index-v2',
        dimensions,
      }),
    ).resolves.toMatchObject({ model: 'bge-index-v2', dimensions });

    const [, request] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(JSON.parse(String(request.body))).toEqual({
      tenant_id: TENANT_ID,
      inputs: ['input'],
      expected_model: 'bge-index-v2',
      expected_dimensions: dimensions,
    });
  });

  it.each([
    [
      'an empty model',
      { model: '', dimensions: DIMENSIONS, items: [{ index: 0, embedding: vector(1) }] },
    ],
    [
      'a dimension mismatch',
      { model: 'model', dimensions: 768, items: [{ index: 0, embedding: vector(1) }] },
    ],
    ['a missing item', { model: 'model', dimensions: DIMENSIONS, items: [] }],
    [
      'a duplicate item index',
      {
        model: 'model',
        dimensions: DIMENSIONS,
        items: [
          { index: 0, embedding: vector(1) },
          { index: 0, embedding: vector(2) },
        ],
      },
    ],
    [
      'a non-finite vector component',
      {
        model: 'model',
        dimensions: DIMENSIONS,
        items: [{ index: 0, embedding: [...vector(1).slice(0, -1), Number.NaN] }],
      },
    ],
    [
      'a zero-magnitude vector',
      { model: 'model', dimensions: DIMENSIONS, items: [{ index: 0, embedding: vector(0) }] },
    ],
  ])('rejects %s in a successful embedding response', async (_label, payload) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(payload)));

    await expect(createClient().embed(TENANT_ID, ['input'], 'INTERNAL')).rejects.toMatchObject({
      name: 'KnowledgeAiRuntimeError',
      code: 'KNOWLEDGE_AI_INVALID_RESPONSE',
      retryable: true,
    });
  });

  it('rejects unexpected, duplicate, and out-of-range reranker results', async () => {
    const client = createClient({ rerankEnabled: true });
    const invalidResults = [
      [
        { id: 'foreign', relevance_score: 0.8 },
        { id: 'b', relevance_score: 0.7 },
      ],
      [
        { id: 'a', relevance_score: 0.8 },
        { id: 'a', relevance_score: 0.7 },
      ],
      [
        { id: 'a', relevance_score: 1.1 },
        { id: 'b', relevance_score: 0.7 },
      ],
    ];

    for (const results of invalidResults) {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(jsonResponse({ model: 'reranker-v1', results })),
      );
      await expect(
        client.rerank(
          TENANT_ID,
          'question',
          [
            { id: 'a', text: 'A' },
            { id: 'b', text: 'B' },
          ],
          2,
          'INTERNAL',
        ),
      ).rejects.toMatchObject({ code: 'KNOWLEDGE_AI_INVALID_RESPONSE' });
    }
  });

  it('accepts exactly topN tenant-local reranker results', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        model: 'reranker-v1',
        results: [{ id: 'b', index: 1, relevance_score: 0.91 }],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      createClient({ rerankEnabled: true }).rerank(
        TENANT_ID,
        'question',
        [
          { id: 'a', text: 'A' },
          { id: 'b', text: 'B' },
        ],
        1,
        'INTERNAL',
      ),
    ).resolves.toEqual({
      model: 'reranker-v1',
      results: [{ id: 'b', relevanceScore: 0.91 }],
    });
    const [, request] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(JSON.parse(String(request.body))).toMatchObject({ top_n: 1 });
  });

  it('preserves a safe provider error code and retryability from an HTTP failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse(
            { detail: { code: 'EMBEDDING_PROVIDER_RATE_LIMITED', retryable: true } },
            429,
          ),
        ),
    );

    await expect(createClient().embed(TENANT_ID, ['input'], 'INTERNAL')).rejects.toMatchObject({
      code: 'EMBEDDING_PROVIDER_RATE_LIMITED',
      retryable: true,
    });
  });

  it('maps an aborted provider request to a retryable timeout without leaking the cause', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: URL, request: RequestInit) =>
          new Promise((_resolve, reject) => {
            request.signal?.addEventListener('abort', () => {
              reject(
                new DOMException('provider URL and credentials must not escape', 'AbortError'),
              );
            });
          }),
      ),
    );

    const error = await captureError(
      createClient({ timeoutMs: 5 }).embed(TENANT_ID, ['input'], 'INTERNAL'),
    );
    expect(error).toBeInstanceOf(KnowledgeAiRuntimeError);
    expect(error).toMatchObject({ code: 'KNOWLEDGE_AI_TIMEOUT', retryable: true });
    expect((error as Error).message).toBe('Knowledge AI service is unavailable.');
  });

  it('propagates lease cancellation to an in-flight embedding request', async () => {
    const fetchMock = vi.fn(
      (_url: URL, request: RequestInit) =>
        new Promise((_resolve, reject) => {
          request.signal?.addEventListener('abort', () => {
            reject(new DOMException('lease lost', 'AbortError'));
          });
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();

    const embedding = createClient().embed(TENANT_ID, ['input'], 'INTERNAL', controller.signal);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    controller.abort();

    await expect(embedding).rejects.toMatchObject({
      code: 'KNOWLEDGE_AI_TIMEOUT',
      retryable: true,
    });
    const [, request] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(request.signal?.aborted).toBe(true);
  });

  it('fails closed when semantic search is disabled and avoids a provider request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      createClient({ semanticEnabled: false }).embed(TENANT_ID, ['input'], 'INTERNAL'),
    ).rejects.toMatchObject({
      code: 'KNOWLEDGE_SEMANTIC_DISABLED',
      retryable: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reads only safe knowledge capability status and model metadata', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        embeddings: {
          status: 'ready',
          provider: 'openai_compatible',
          model: 'embedding-v1',
          dimensions: DIMENSIONS,
        },
        rerank: {
          status: 'ready',
          provider: 'cohere_compatible',
          model: 'reranker-v1',
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      createClient({ semanticEnabled: true, rerankEnabled: true }).capabilities(TENANT_ID),
    ).resolves.toEqual({
      embeddings: {
        status: 'ready',
        provider: 'openai_compatible',
        model: 'embedding-v1',
        dimensions: DIMENSIONS,
      },
      rerank: {
        status: 'ready',
        provider: 'cohere_compatible',
        model: 'reranker-v1',
      },
    });
    const [url, request] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe('http://127.0.0.1:8100/internal/v1/knowledge/capabilities');
    expect(request).toMatchObject({ method: 'GET' });
    expect(request).not.toHaveProperty('body');
    const disabledPayload = JSON.stringify(
      await createClient({ semanticEnabled: false }).capabilities(TENANT_ID),
    );
    expect(disabledPayload).not.toContain('api_key');
    expect(disabledPayload).not.toContain('http://');
  });

  it('does not probe the runtime when both knowledge providers are disabled', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      createClient({ semanticEnabled: false, rerankEnabled: false }).capabilities(TENANT_ID),
    ).resolves.toEqual({
      embeddings: {
        status: 'disabled',
        provider: 'disabled',
        model: null,
        dimensions: DIMENSIONS,
      },
      rerank: { status: 'disabled', provider: 'disabled', model: null },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects malformed capability responses without returning upstream fields', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          embeddings: { status: 'ready', model: '' },
          rerank: { status: 'ready', model: 'reranker-v1' },
        }),
      ),
    );

    await expect(
      createClient({ semanticEnabled: true, rerankEnabled: true }).capabilities(TENANT_ID),
    ).rejects.toMatchObject({ code: 'KNOWLEDGE_AI_INVALID_RESPONSE' });
  });

  it('marks a configured provider not ready when Runtime reports a dimension drift', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          embeddings: {
            status: 'ready',
            provider: 'openai_compatible',
            model: 'embedding-v2',
            dimensions: 768,
          },
          rerank: {
            status: 'disabled',
            provider: 'disabled',
            model: null,
          },
        }),
      ),
    );

    await expect(createClient().capabilities(TENANT_ID)).resolves.toMatchObject({
      embeddings: {
        status: 'not_ready',
        provider: 'openai_compatible',
        model: 'embedding-v2',
        dimensions: 768,
      },
      rerank: { status: 'disabled' },
    });
  });

  it('rejects an embedding model change between batches', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(embeddingResponse('model-a', 64))
      .mockResolvedValueOnce(embeddingResponse('model-b', 1));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      createClient().embedAll(TENANT_ID, Array(65).fill('input'), 'INTERNAL'),
    ).rejects.toMatchObject({
      code: 'KNOWLEDGE_EMBEDDING_MODEL_CHANGED',
      retryable: true,
    });
  });

  it('runs at most two embedding batches concurrently and preserves input order', async () => {
    let active = 0;
    let maximumActive = 0;
    const fetchMock = vi.fn(async (_url: URL, request: RequestInit) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      const inputs = (JSON.parse(String(request.body)) as { inputs: string[] }).inputs;
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return jsonResponse({
        model: 'embedding-model-v1',
        dimensions: DIMENSIONS,
        items: inputs.map((input, index) => ({ index, embedding: vector(Number(input)) })),
        usage: { input_tokens: inputs.length },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await createClient().embedAll(
      TENANT_ID,
      Array.from({ length: 129 }, (_, index) => String(index + 1)),
      'INTERNAL',
    );

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(maximumActive).toBe(2);
    expect(result.vectors.map((item) => item[0])).toEqual(
      Array.from({ length: 129 }, (_, index) => index + 1),
    );
  });

  it('blocks confidential embedding and rerank payloads before any provider request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const client = createClient({ rerankEnabled: true });

    await expect(client.embed(TENANT_ID, ['secret'], 'CONFIDENTIAL')).rejects.toMatchObject({
      code: 'KNOWLEDGE_EMBEDDING_CLASSIFICATION_NOT_APPROVED',
      retryable: false,
    });
    await expect(
      client.rerank(
        TENANT_ID,
        'question',
        [{ id: 'a', text: 'secret candidate' }],
        1,
        'RESTRICTED',
      ),
    ).rejects.toMatchObject({
      code: 'KNOWLEDGE_RERANK_CLASSIFICATION_NOT_APPROVED',
      retryable: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function createClient(
  overrides: {
    semanticEnabled?: boolean;
    rerankEnabled?: boolean;
    timeoutMs?: number;
    serviceToken?: string;
    dimensions?: number;
  } = {},
): KnowledgeAiRuntimeClient {
  const values = {
    AI_RUNTIME_URL: 'http://127.0.0.1:8100',
    AI_RUNTIME_SERVICE_TOKEN: overrides.serviceToken,
    KNOWLEDGE_AI_TIMEOUT_MS: overrides.timeoutMs ?? 1_000,
    KNOWLEDGE_EMBEDDING_DIMENSIONS: overrides.dimensions ?? DIMENSIONS,
    KNOWLEDGE_SEMANTIC_SEARCH_ENABLED: overrides.semanticEnabled ?? true,
    KNOWLEDGE_RERANK_ENABLED: overrides.rerankEnabled ?? false,
    KNOWLEDGE_VECTOR_SEARCH_MODE: 'exact',
  } as const;
  const config = {
    get: (key: keyof typeof values) => values[key],
  } as unknown as ConfigService<EnvironmentVariables, true>;
  return new KnowledgeAiRuntimeClient(config);
}

function vector(value: number): number[] {
  return Array<number>(DIMENSIONS).fill(value);
}

function embeddingResponse(model: string, count: number): Response {
  return jsonResponse({
    model,
    dimensions: DIMENSIONS,
    items: Array.from({ length: count }, (_, index) => ({
      index,
      embedding: vector((index + 1) / 100),
    })),
    usage: { input_tokens: count },
  });
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function captureError(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the operation to fail.');
}
