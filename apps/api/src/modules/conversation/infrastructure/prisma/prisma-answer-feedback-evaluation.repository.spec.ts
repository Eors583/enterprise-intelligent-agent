import type { Prisma } from '@prisma/client';

import { PrismaAnswerFeedbackEvaluationRepository } from './prisma-answer-feedback-evaluation.repository.js';

const TENANT_ID = '00000000-0000-7000-8000-000000000001';
const USER_ID = '00000000-0000-7000-8000-000000000101';
const FEEDBACK_ID = '00000000-0000-7000-8000-000000000601';
const BAD_CASE_ID = '00000000-0000-7000-8000-000000000701';

describe('PrismaAnswerFeedbackEvaluationRepository', () => {
  it('sets the authenticated actor locally and invokes only the trusted database projection', async () => {
    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce([{ set_config: USER_ID, tenant_matches: true }])
      .mockResolvedValueOnce([{ bad_case_id: BAD_CASE_ID, created: true }]);
    const transaction = { $queryRaw: queryRaw } as unknown as Prisma.TransactionClient;
    const repository = new PrismaAnswerFeedbackEvaluationRepository();

    await expect(
      repository.projectNotHelpful(transaction, {
        tenantId: TENANT_ID,
        userId: USER_ID,
        feedbackId: FEEDBACK_ID,
      }),
    ).resolves.toEqual({ badCaseId: BAD_CASE_ID, created: true });

    const actorStatement = prismaSql(queryRaw.mock.calls[0]?.[0]);
    const projectionStatement = prismaSql(queryRaw.mock.calls[1]?.[0]);
    expect(actorStatement.text).toContain("set_config('app.user_id'");
    expect(actorStatement.values).toContain(USER_ID);
    expect(projectionStatement.text).toContain('project_not_helpful_answer_feedback_bad_case');
    expect(projectionStatement.values).toContain(FEEDBACK_ID);
  });
});

function prismaSql(value: unknown): { text: string; values: readonly unknown[] } {
  if (
    typeof value === 'object' &&
    value !== null &&
    'strings' in value &&
    Array.isArray(value.strings) &&
    'values' in value &&
    Array.isArray(value.values)
  ) {
    return { text: value.strings.join('?'), values: value.values };
  }
  return { text: '', values: [] };
}
