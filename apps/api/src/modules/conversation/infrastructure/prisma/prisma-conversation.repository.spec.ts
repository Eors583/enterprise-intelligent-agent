import { parseStoredTextContent } from './prisma-conversation.repository.js';

describe('parseStoredTextContent', () => {
  it('normalizes a legacy knowledge citation instead of breaking historical message reads', () => {
    const content = parseStoredTextContent({
      type: 'text',
      text: '历史答案 [来源1]',
      citations: [
        {
          documentId: '00000000-0000-7000-8000-000000000501',
          knowledgeBaseId: '00000000-0000-7000-8000-000000000504',
          title: '请假制度',
          excerpt: '年假申请需提前发起。',
        },
      ],
    });

    expect(content.citations?.[0]).toMatchObject({
      verificationStatus: 'LEGACY',
      documentVersionId: null,
      chunkId: null,
      documentVersion: null,
      updatedAt: null,
    });
  });

  it('does not downgrade a partially populated new citation to a legacy citation', () => {
    expect(() =>
      parseStoredTextContent({
        type: 'text',
        text: '损坏的引用',
        citations: [
          {
            documentId: '00000000-0000-7000-8000-000000000501',
            knowledgeBaseId: '00000000-0000-7000-8000-000000000504',
            title: '请假制度',
            excerpt: '年假申请需提前发起。',
            chunkId: '00000000-0000-7000-8000-000000000503',
          },
        ],
      }),
    ).toThrow();
  });
});
