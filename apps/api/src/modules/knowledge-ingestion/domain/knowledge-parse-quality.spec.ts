import { describe, expect, it } from 'vitest';

import {
  assessKnowledgeParseQuality,
  KNOWLEDGE_PARSE_QUALITY_THRESHOLD,
} from './knowledge-parse-quality.js';

describe('knowledge parse quality', () => {
  it('flags short, sparse extraction as low quality without retaining source content', () => {
    const result = assessKnowledgeParseQuality({
      parsed: {
        text: 'tiny',
        metadata: {
          mimeType: 'text/html',
          sourceType: 'TEXT',
          parser: 'linkedom-v0.18',
          byteLength: 1_000,
          characterCount: 4,
        },
      },
      sourceByteLength: 1_000,
      chunkCount: 1,
    });

    expect(result.score).toBeLessThan(KNOWLEDGE_PARSE_QUALITY_THRESHOLD);
    expect(result.diagnostics.lowQualityReasons).toEqual(
      expect.arrayContaining(['CONTENT_TOO_SHORT', 'QUALITY_BELOW_THRESHOLD']),
    );
    expect(JSON.stringify(result.diagnostics)).not.toContain('tiny');
  });

  it('records page coverage and produces a bounded high-quality score', () => {
    const result = assessKnowledgeParseQuality({
      parsed: {
        text: 'A'.repeat(2_000),
        pages: [
          { pageNumber: 1, text: 'A'.repeat(1_000) },
          { pageNumber: 2, text: 'A'.repeat(1_000) },
        ],
        metadata: {
          mimeType: 'application/pdf',
          sourceType: 'TEXT',
          parser: 'pdf-parse-v2',
          byteLength: 2_500,
          characterCount: 2_000,
          pageCount: 2,
        },
      },
      sourceByteLength: 2_500,
      chunkCount: 4,
    });

    expect(result.score).toBe(1);
    expect(result.diagnostics).toMatchObject({
      pageCount: 2,
      nonEmptyPageCount: 2,
      lowQualityReasons: [],
    });
  });
});
