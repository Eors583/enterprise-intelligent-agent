import { describe, expect, it } from 'vitest';

import {
  chunkKnowledgeDocument,
  chunkKnowledgeDocumentWithParents,
  estimateTokenCount,
} from './knowledge-document.chunker.js';

describe('chunkKnowledgeDocument', () => {
  it.each(['TEXT', 'MARKDOWN'] as const)(
    'does not create chunks for empty %s content',
    (sourceType) => {
      expect(chunkKnowledgeDocument({ content: ' \n\t\n ', sourceType })).toEqual([]);
    },
  );

  it('prefers paragraph boundaries for plain text and keeps chunks ordered', () => {
    const first = 'A'.repeat(30);
    const second = 'B'.repeat(30);
    const third = 'C'.repeat(30);
    const chunks = chunkKnowledgeDocument(
      { content: `${first}\n\n${second}\n\n${third}`, sourceType: 'TEXT' },
      { targetTokens: 40, overlapTokens: 5, charactersPerToken: 1 },
    );

    expect(chunks.map((chunk) => chunk.chunkIndex)).toEqual([0, 1, 2]);
    expect(chunks[0]?.content).toBe(first);
    expect(chunks[1]?.content).toBe(second);
    expect(chunks[2]?.content).toBe(third);
    expect(chunks.every((chunk) => chunk.headingPath.length === 0)).toBe(true);
  });

  it('splits an oversized paragraph with a stable overlap', () => {
    const chunks = chunkKnowledgeDocument(
      { content: 'abcdefghijklmnopqrstuvwxyz'.repeat(8), sourceType: 'TEXT' },
      { targetTokens: 40, overlapTokens: 8, charactersPerToken: 1 },
    );

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.tokenCount <= 40)).toBe(true);
    for (let index = 1; index < chunks.length; index += 1) {
      expect(chunks[index - 1]?.content.slice(-8)).toBe(chunks[index]?.content.slice(0, 8));
    }
  });

  it('tracks Markdown heading paths without treating fenced code as headings', () => {
    const content = [
      '# Employee handbook',
      'Introduction.',
      '## Leave',
      'Leave policy.',
      '```markdown',
      '# Example inside a fence',
      '```',
      '### Requests',
      'Submit a request.',
      '# Security',
      'Security policy.',
    ].join('\n');

    const chunks = chunkKnowledgeDocument(
      { content, sourceType: 'MARKDOWN' },
      { targetTokens: 200, overlapTokens: 20, charactersPerToken: 1 },
    );

    expect(chunks.map((chunk) => chunk.headingPath)).toEqual([
      ['Employee handbook'],
      ['Employee handbook', 'Leave'],
      ['Employee handbook', 'Leave', 'Requests'],
      ['Security'],
    ]);
    expect(chunks[1]?.content).toContain('# Example inside a fence');
  });

  it('normalizes line endings and produces deterministic hashes and token counts', () => {
    const options = { targetTokens: 20, overlapTokens: 4, charactersPerToken: 2 };
    const unix = chunkKnowledgeDocument(
      { content: '# Heading\n\nStable content.', sourceType: 'MARKDOWN' },
      options,
    );
    const windows = chunkKnowledgeDocument(
      { content: '# Heading\r\n\r\nStable content.', sourceType: 'MARKDOWN' },
      options,
    );

    expect(windows).toEqual(unix);
    expect(
      chunkKnowledgeDocument(
        { content: '# Heading\n\nStable content.', sourceType: 'MARKDOWN' },
        options,
      ),
    ).toEqual(unix);
    expect(unix[0]?.contentHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(unix[0]?.tokenCount).toBe(estimateTokenCount(unix[0]?.content ?? '', 2));
  });

  it('keeps explicit parent lineage while precise child chunks split and overlap', () => {
    const hierarchy = chunkKnowledgeDocumentWithParents(
      {
        content: `# 制度\n${'年假申请必须提前提交。'.repeat(20)}\n## 审批\n直属负责人审批。`,
        sourceType: 'MARKDOWN',
      },
      { targetTokens: 40, overlapTokens: 8, charactersPerToken: 1 },
    );

    expect(
      hierarchy.parents.map(({ parentIndex, headingPath }) => ({ parentIndex, headingPath })),
    ).toEqual([
      { parentIndex: 0, headingPath: ['制度'] },
      { parentIndex: 1, headingPath: ['制度', '审批'] },
    ]);
    expect(hierarchy.chunks.length).toBeGreaterThan(hierarchy.parents.length);
    expect(hierarchy.chunks.filter(({ parentIndex }) => parentIndex === 0).length).toBeGreaterThan(
      1,
    );
    expect(hierarchy.chunks.at(-1)).toMatchObject({
      parentIndex: 1,
      headingPath: ['制度', '审批'],
    });
  });

  it('rejects invalid sizing options that could make chunking non-progressing', () => {
    expect(() =>
      chunkKnowledgeDocument(
        { content: 'content', sourceType: 'TEXT' },
        { targetTokens: 80, overlapTokens: 80 },
      ),
    ).toThrowError('overlapTokens must be smaller than targetTokens');
    expect(() => estimateTokenCount('content', 0)).toThrowError(
      'charactersPerToken must be a positive safe integer',
    );
  });
});
