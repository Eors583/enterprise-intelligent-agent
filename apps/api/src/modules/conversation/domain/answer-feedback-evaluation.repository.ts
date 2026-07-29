import type { Prisma } from '@prisma/client';

export interface ProjectNotHelpfulAnswerFeedbackInput {
  readonly tenantId: string;
  readonly userId: string;
  readonly feedbackId: string;
}

export interface AnswerFeedbackEvaluationProjection {
  readonly badCaseId: string;
  readonly created: boolean;
}

export abstract class AnswerFeedbackEvaluationRepository {
  abstract projectNotHelpful(
    transaction: Prisma.TransactionClient,
    input: ProjectNotHelpfulAnswerFeedbackInput,
  ): Promise<AnswerFeedbackEvaluationProjection>;
}
