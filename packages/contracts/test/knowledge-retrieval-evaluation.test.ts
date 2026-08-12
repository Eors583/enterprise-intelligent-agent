import { describe, expect, it } from 'vitest';

import {
  bulkImportKnowledgeRetrievalEvaluationCasesRequestSchema,
  knowledgeRetrievalGroundTruthSchema,
  runKnowledgeRetrievalBenchmarkRequestSchema,
} from '../src/index.js';

const KNOWLEDGE_BASE_ID = '00000000-0000-7000-8000-000000000001';
const USER_ID = '00000000-0000-7000-8000-000000000002';
const CHUNK_ID = '00000000-0000-7000-8000-000000000003';
const EVIDENCE_ID = '00000000-0000-7000-8000-000000000004';

function groundTruth(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    knowledgeBaseId: KNOWLEDGE_BASE_ID,
    simulatedUserId: USER_ID,
    expectedNoAnswer: false,
    semanticRequired: true,
    relevance: { [CHUNK_ID]: 3 },
    forbiddenChunkIds: [],
    forbiddenDocumentIds: [],
    forbiddenKnowledgeBaseIds: [],
    expectedRoute: 'DOCUMENT',
    limit: 10,
    ...overrides,
  };
}

describe('knowledge retrieval evaluation contracts', () => {
  it('requires source-grounded relevance for answerable questions', () => {
    expect(
      knowledgeRetrievalGroundTruthSchema.safeParse(groundTruth({ relevance: {} })).success,
    ).toBe(false);
  });

  it('prevents no-answer questions from silently carrying a relevant chunk', () => {
    expect(
      knowledgeRetrievalGroundTruthSchema.safeParse(groundTruth({ expectedNoAnswer: true }))
        .success,
    ).toBe(false);
    expect(
      knowledgeRetrievalGroundTruthSchema.safeParse(
        groundTruth({ expectedNoAnswer: true, relevance: {} }),
      ).success,
    ).toBe(true);
  });

  it('rejects duplicate case keys inside a governed bulk import', () => {
    const item = {
      caseKey: 'KRE.DOC.001',
      query: 'What is the response target?',
      expectedAnswer: '15 minutes.',
      groundTruth: groundTruth(),
    };
    const result = bulkImportKnowledgeRetrievalEvaluationCasesRequestSchema.safeParse({
      evidenceId: EVIDENCE_ID,
      annotationRationale: 'A second reviewer checked the source and expected chunk.',
      cases: [item, item],
      idempotencyKey: 'retrieval-import-001',
    });

    expect(result.success).toBe(false);
  });

  it('applies the enterprise retrieval thresholds when a run omits overrides', () => {
    const parsed = runKnowledgeRetrievalBenchmarkRequestSchema.parse({
      idempotencyKey: 'retrieval-run-001',
    });

    expect(parsed.concurrency).toBe(4);
    expect(parsed.thresholds).toMatchObject({
      minRecallAt5: 0.8,
      minMrr: 0.7,
      minNdcgAt10: 0.7,
      minCitationSupportRate: 0.9,
      minNoAnswerAccuracy: 0.9,
      maxP95LatencyMs: 3_000,
      maxAclLeakCount: 0,
      minCaseCount: 200,
      minNoAnswerCount: 25,
      minAclCaseCount: 25,
    });
  });
});
