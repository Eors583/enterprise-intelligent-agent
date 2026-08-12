import { describe, expect, it, vi } from 'vitest';

import type { KnowledgeRetrievalService } from '../knowledge-retrieval/knowledge-retrieval.service.js';
import type { KnowledgeBoundaryReadService } from './knowledge-boundary-read.service.js';
import { InProcessKnowledgeRetrievalGateway } from './in-process-knowledge-retrieval.gateway.js';

describe('InProcessKnowledgeRetrievalGateway', () => {
  it('delegates stateless retrieval without a request-scoped administration dependency', async () => {
    const retrieval = {
      search: vi.fn().mockResolvedValue({ items: [] }),
      areChunksAccessible: vi.fn().mockResolvedValue(true),
    };
    const gateway = new InProcessKnowledgeRetrievalGateway(
      retrieval as unknown as KnowledgeRetrievalService,
      {} as KnowledgeBoundaryReadService,
    );
    const input = {
      tenantId: '00000000-0000-7000-8000-000000000001',
      userId: '00000000-0000-7000-8000-000000000002',
      knowledgeBaseIds: ['00000000-0000-7000-8000-000000000003'],
      query: '差旅标准',
    };

    await expect(gateway.search(input)).resolves.toEqual({ items: [] });
    expect(retrieval.search).toHaveBeenCalledWith(input);
  });
});
