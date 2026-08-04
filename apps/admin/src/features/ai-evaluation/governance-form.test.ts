import { describe, expect, it } from 'vitest';

import {
  parseBadCaseLineagePackage,
  stableEvaluationCaseKey,
  stableEvaluationDatasetCode,
} from './governance-form';

describe('AI evaluation guided form helpers', () => {
  it('derives stable dataset codes and case keys without client UUID entry', () => {
    expect(stableEvaluationDatasetCode('角色回归')).toMatch(/^DATASET\.[A-F0-9]{16}$/u);
    expect(stableEvaluationDatasetCode('Role Regression')).toBe('DATASET.ROLE.REGRESSION');
    expect(stableEvaluationCaseKey('FACTUALITY', '问题', '应引用制度')).toBe(
      stableEvaluationCaseKey('FACTUALITY', '问题', '应引用制度'),
    );
    expect(stableEvaluationCaseKey('FACTUALITY', '问题', '应引用制度')).toMatch(
      /^CASE\.FACTUALITY\.[A-F0-9]{16}$/u,
    );
  });

  it('accepts only a strict bad-case lineage result package', () => {
    expect(
      parseBadCaseLineagePackage(
        JSON.stringify({
          sourceType: 'AGENT_RUN',
          sourceId: '00000000-0000-7000-8000-000000000001',
          sourceVersion: 3,
          sourceSnapshotHash: 'a'.repeat(64),
        }),
      ),
    ).toEqual({
      sourceType: 'AGENT_RUN',
      sourceId: '00000000-0000-7000-8000-000000000001',
      sourceVersion: 3,
      sourceSnapshotHash: 'a'.repeat(64),
    });
    expect(() => parseBadCaseLineagePackage('{}')).toThrow('缺少可信来源');
    expect(() => parseBadCaseLineagePackage('{')).toThrow('不是有效 JSON');
  });
});
