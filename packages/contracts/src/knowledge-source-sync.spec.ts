import { describe, expect, it } from 'vitest';

import {
  createKnowledgeSourceConnectorRequestSchema,
  knowledgeSourceManifestSchema,
} from './knowledge-source-sync.js';

describe('knowledge source sync contracts', () => {
  it('accepts a paged HTTPS manifest', () => {
    const result = knowledgeSourceManifestSchema.parse({
      schemaVersion: 1,
      nextCursor: 'page-2',
      hasMore: true,
      items: [
        {
          externalId: 'drive/file-1',
          title: '员工手册',
          fileName: 'handbook.md',
          mimeType: 'text/markdown',
          downloadUrl: 'https://drive.example.test/files/1',
          sourceRevision: 'v3',
        },
      ],
    });

    expect(result.items[0]).toMatchObject({ deleted: false, sha256: null });
  });

  it('rejects non-HTTPS connectors and active items without downloads', () => {
    expect(() =>
      createKnowledgeSourceConnectorRequestSchema.parse({
        name: '本地测试',
        manifestUrl: 'http://drive.example.test/manifest',
      }),
    ).toThrow();
    expect(() =>
      knowledgeSourceManifestSchema.parse({
        schemaVersion: 1,
        nextCursor: null,
        hasMore: false,
        items: [
          {
            externalId: 'file-1',
            title: '缺少下载地址',
            fileName: 'missing.txt',
            mimeType: 'text/plain',
            downloadUrl: null,
            sourceRevision: 'v1',
          },
        ],
      }),
    ).toThrow();
  });
});
