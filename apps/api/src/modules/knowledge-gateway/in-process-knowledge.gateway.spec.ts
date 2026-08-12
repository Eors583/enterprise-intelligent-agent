import { describe, expect, it, vi } from 'vitest';

import type {
  KnowledgeIngestionProcessor,
  KnowledgeIngestionService,
} from '../knowledge-ingestion/application/knowledge-ingestion.service.js';
import type { KnowledgeRetrievalGateway } from './knowledge-gateway.port.js';
import { InProcessKnowledgeGateway } from './in-process-knowledge.gateway.js';

describe('InProcessKnowledgeGateway', () => {
  it('keeps consumers on a stable boundary while delegating to local modules', async () => {
    const ingestion = {
      upload: vi.fn().mockResolvedValue('document-1'),
    };
    const retrieval = {
      search: vi.fn().mockResolvedValue({ items: [] }),
    };
    const gateway = new InProcessKnowledgeGateway(
      ingestion as unknown as KnowledgeIngestionService,
      {} as KnowledgeIngestionProcessor,
      retrieval as unknown as KnowledgeRetrievalGateway,
    );
    const search = {
      tenantId: '00000000-0000-7000-8000-000000000001',
      userId: '00000000-0000-7000-8000-000000000002',
      knowledgeBaseIds: ['00000000-0000-7000-8000-000000000003'],
      query: '差旅标准',
    };

    await expect(gateway.search(search)).resolves.toEqual({ items: [] });
    await expect(
      gateway.upload({
        knowledgeBaseId: search.knowledgeBaseIds[0] as string,
        title: '制度',
        bytes: Buffer.from('content'),
        mimeType: 'text/plain',
        fileName: 'policy.txt',
      }),
    ).resolves.toBe('document-1');

    expect(retrieval.search).toHaveBeenCalledWith(search);
    expect(ingestion.upload).toHaveBeenCalledOnce();
  });
});
