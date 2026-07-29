import { beforeEach, describe, expect, it, vi } from 'vitest';

const { requestMock } = vi.hoisted(() => ({ requestMock: vi.fn() }));
vi.mock('@/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/client')>()),
  request: requestMock,
}));

import { createEvaluationCase, ingestEvaluationBadCase, listEvaluationRuns } from './api';

const SUBJECT_ID = '10000000-0000-4000-8000-000000000001';
const VERSION_ID = '10000000-0000-4000-8000-000000000002';
const EVIDENCE_ID = '10000000-0000-4000-8000-000000000003';
const HASH = 'a'.repeat(64);

beforeEach(() => {
  requestMock.mockReset();
  requestMock.mockResolvedValue({ items: [], nextCursor: null });
});

describe('AI evaluation admin API adapter', () => {
  it('sends exact subject and PASSED filters to the server-side Run list endpoint', async () => {
    await listEvaluationRuns({
      subjectType: 'AGENT_VERSION',
      subjectId: SUBJECT_ID,
      subjectVersion: 7,
      status: 'PASSED',
      limit: 100,
    });

    expect(requestMock.mock.calls[0]?.[0]).toBe(
      `/admin/ai-evaluations/runs?limit=100&subjectType=AGENT_VERSION&subjectId=${SUBJECT_ID}&subjectVersion=7&status=PASSED`,
    );
    expect(
      requestMock.mock.calls[0]?.[1].schema.safeParse({ items: [], nextCursor: null }).success,
    ).toBe(true);
  });

  it('fails locally when a release selector omits part of the subject tuple', async () => {
    expect(() =>
      listEvaluationRuns({
        subjectType: 'KNOWLEDGE_VERSION',
        status: 'PASSED',
        limit: 100,
      }),
    ).toThrow();
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('does not send factual cases without explicit governed evidence', async () => {
    expect(() =>
      createEvaluationCase(VERSION_ID, {
        caseKey: 'FACT-001',
        category: 'FACTUALITY',
        input: '合同交付日是什么？',
        context: {
          roleAssignmentId: null,
          roleVersionId: null,
          objectiveId: null,
          objectiveVersion: null,
          processVersionId: null,
          permissionLabels: [],
          knowledgeVersionIds: [],
          toolVersionIds: [],
          structuredContext: {},
        },
        expectedBehavior: '只根据已签署合同回答。',
        requiredEvidenceIds: [],
        forbiddenBehaviors: [],
        scoring: {
          judgeTypes: ['HUMAN'],
          rubric: '日期必须与合同一致。',
          metricWeights: [{ metric: 'FACTUAL_ACCURACY', weight: 1 }],
        },
        idempotencyKey: 'case-1',
      }),
    ).toThrow();
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('sends only explicitly sanitized manual bad-case content with verified evidence identities', async () => {
    requestMock.mockResolvedValueOnce({ id: VERSION_ID, status: 'RECEIVED', revision: 1 });
    await ingestEvaluationBadCase({
      sourceType: 'AGENT_RUN',
      sourceId: SUBJECT_ID,
      sourceVersion: 1,
      category: 'FACTUALITY',
      sanitizedInput: '已脱敏的错误回答上下文。',
      sourceSnapshotHash: HASH,
      evidenceIds: [EVIDENCE_ID],
      idempotencyKey: 'bad-case-1',
    });
    expect(requestMock).toHaveBeenCalledWith(
      '/admin/ai-evaluations/bad-cases',
      expect.objectContaining({
        method: 'POST',
        body: expect.objectContaining({
          sanitizedInput: '已脱敏的错误回答上下文。',
          evidenceIds: [EVIDENCE_ID],
        }),
      }),
    );
  });
});
