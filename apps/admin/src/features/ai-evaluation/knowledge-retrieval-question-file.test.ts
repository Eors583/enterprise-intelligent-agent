import { describe, expect, it } from 'vitest';
import type { BulkKnowledgeRetrievalEvaluationCase } from '@enterprise/contracts';

import { parseQuestionFile, questionCoverage } from './knowledge-retrieval-question-file';

const KNOWLEDGE_BASE_ID = '00000000-0000-7000-8000-000000000001';
const USER_ID = '00000000-0000-7000-8000-000000000101';
const CHUNK_ID = '00000000-0000-7000-8000-000000000201';
const FORBIDDEN_CHUNK_ID = '00000000-0000-7000-8000-000000000202';

function answerable(caseKey: string): BulkKnowledgeRetrievalEvaluationCase {
  return {
    caseKey,
    query: '季度服务指标的原文怎样表述？',
    expectedAnswer: 'Payment API 的 Q2 uptime 为 0.998。',
    groundTruth: {
      schemaVersion: 1,
      knowledgeBaseId: KNOWLEDGE_BASE_ID,
      simulatedUserId: USER_ID,
      expectedNoAnswer: false,
      semanticRequired: true,
      relevance: { [CHUNK_ID]: 3 },
      forbiddenChunkIds: [FORBIDDEN_CHUNK_ID],
      forbiddenDocumentIds: [],
      forbiddenKnowledgeBaseIds: [],
      expectedRoute: 'DOCUMENT',
      limit: 10,
    },
  };
}

describe('source-grounded retrieval question files', () => {
  it('parses JSON arrays and reports coverage before import', () => {
    const parsed = parseQuestionFile(
      'questions.json',
      JSON.stringify([
        answerable('KRE.DOC.001'),
        {
          ...answerable('KRE.NOANSWER.001'),
          groundTruth: {
            ...answerable('KRE.NOANSWER.001').groundTruth,
            expectedNoAnswer: true,
            relevance: {},
            forbiddenChunkIds: [],
          },
        },
      ]),
    );

    expect(parsed.errors).toEqual([]);
    expect(questionCoverage(parsed.cases)).toEqual({
      answerable: 1,
      noAnswer: 1,
      acl: 1,
      routed: 2,
    });
  });

  it('rejects duplicate case keys before any request is sent', () => {
    const parsed = parseQuestionFile(
      'duplicates.jsonl',
      `${JSON.stringify(answerable('KRE.DOC.001'))}\n${JSON.stringify(answerable('KRE.DOC.001'))}`,
    );

    expect(parsed.cases).toHaveLength(2);
    expect(parsed.errors).toContain('题号重复：KRE.DOC.001');
  });

  it('parses the downloadable CSV shape including JSON evidence fields', () => {
    const parsed = parseQuestionFile(
      'questions.csv',
      [
        'caseKey,query,expectedAnswer,knowledgeBaseId,simulatedUserId,expectedNoAnswer,semanticRequired,relevance,forbiddenChunkIds,forbiddenDocumentIds,forbiddenKnowledgeBaseIds,expectedRoute,limit',
        `KRE.DOC.002,服务指标原文是什么,Payment API Q2 为 0.998,${KNOWLEDGE_BASE_ID},${USER_ID},false,true,"{""${CHUNK_ID}"":3}","[""${FORBIDDEN_CHUNK_ID}""]",[],[],DOCUMENT,10`,
      ].join('\n'),
    );

    expect(parsed.errors).toEqual([]);
    expect(parsed.cases[0]?.groundTruth.relevance).toEqual({ [CHUNK_ID]: 3 });
    expect(parsed.cases[0]?.groundTruth.forbiddenChunkIds).toEqual([FORBIDDEN_CHUNK_ID]);
  });
});
