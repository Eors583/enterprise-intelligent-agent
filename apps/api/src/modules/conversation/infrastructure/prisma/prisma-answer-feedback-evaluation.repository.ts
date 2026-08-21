import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import {
  AnswerFeedbackEvaluationRepository,
  type AnswerFeedbackEvaluationProjection,
  type ProjectNotHelpfulAnswerFeedbackInput,
} from '../../domain/answer-feedback-evaluation.repository.js';

interface ProjectionRow {
  readonly bad_case_id: string;
  readonly created: boolean;
}

interface ContextRow {
  readonly tenant_matches: boolean;
}

@Injectable()
export class PrismaAnswerFeedbackEvaluationRepository extends AnswerFeedbackEvaluationRepository {
  async projectNotHelpful(
    transaction: Prisma.TransactionClient,
    input: ProjectNotHelpfulAnswerFeedbackInput,
  ): Promise<AnswerFeedbackEvaluationProjection> {
    const context = await transaction.$queryRaw<ContextRow[]>(Prisma.sql`
      SELECT
        set_config('app.user_id', ${input.userId}, true),
        NULLIF(current_setting('app.tenant_id', true), '')::uuid
          = ${input.tenantId}::uuid AS "tenant_matches"
    `);
    if (context[0]?.tenant_matches !== true) {
      throw new Error('The answer-feedback evaluation tenant context does not match.');
    }
    const rows = await transaction.$queryRaw<ProjectionRow[]>(Prisma.sql`
      SELECT "bad_case_id", "created"
      FROM public.project_not_helpful_answer_feedback_bad_case(
        ${input.feedbackId}::uuid
      )
    `);
    const projection = rows[0];
    if (projection === undefined) {
      throw new Error('The answer-feedback evaluation projection returned no result.');
    }
    return {
      badCaseId: projection.bad_case_id,
      created: projection.created,
    };
  }
}
