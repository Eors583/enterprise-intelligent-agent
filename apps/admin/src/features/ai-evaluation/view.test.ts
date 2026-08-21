import { describe, expect, it } from 'vitest';

import { answerFeedbackReasonLabel, evaluationCategoryLabel } from './view';

describe('AI evaluation business labels', () => {
  it('presents internal bad-case categories as administrator-facing Chinese labels', () => {
    expect(evaluationCategoryLabel('FACTUALITY')).toBe('事实正确性');
    expect(evaluationCategoryLabel('CITATION')).toBe('引用完整性');
  });

  it('presents employee answer-feedback reasons without exposing internal enum values', () => {
    expect(answerFeedbackReasonLabel('MISSING_KNOWLEDGE')).toBe('缺少关键知识');
    expect(answerFeedbackReasonLabel('IRRELEVANT_CITATION')).toBe('引用与回答无关');
  });
});
