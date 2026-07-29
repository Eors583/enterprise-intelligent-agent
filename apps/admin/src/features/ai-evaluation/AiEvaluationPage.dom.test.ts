import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderInTestDom } from '@/test/dom-test-utils';

const apiMocks = vi.hoisted(() => ({
  listEvaluationDatasets: vi.fn(),
  listEvaluationRuns: vi.fn(),
  listEvaluationRunners: vi.fn(),
  listEvaluationBadCases: vi.fn(),
  listEvaluationDatasetVersions: vi.fn(),
  listEvaluationCases: vi.fn(),
  createEvaluationDataset: vi.fn(),
  createEvaluationDatasetVersion: vi.fn(),
  transitionEvaluationDatasetVersion: vi.fn(),
  createEvaluationCase: vi.fn(),
  annotateEvaluationCase: vi.fn(),
  createEvaluationRunner: vi.fn(),
  createEvaluationRun: vi.fn(),
  startEvaluationRun: vi.fn(),
  submitEvaluationRun: vi.fn(),
  verifyEvaluationRun: vi.fn(),
  loadEvaluationReadiness: vi.fn(),
  ingestEvaluationBadCase: vi.fn(),
  triageEvaluationBadCase: vi.fn(),
}));

vi.mock('./api', () => apiMocks);

import { AiEvaluationPage } from './AiEvaluationPage';
import { PassingEvaluationRunSelect } from './PassingEvaluationRunSelect';

const SUBJECT_ID = '10000000-0000-4000-8000-000000000001';

beforeEach(() => {
  for (const mock of Object.values(apiMocks)) mock.mockReset();
  apiMocks.listEvaluationDatasets.mockResolvedValue(page([]));
  apiMocks.listEvaluationRuns.mockResolvedValue(page([]));
  apiMocks.listEvaluationRunners.mockResolvedValue(page([]));
  apiMocks.listEvaluationBadCases.mockResolvedValue(page([]));
  apiMocks.listEvaluationDatasetVersions.mockResolvedValue(page([]));
  apiMocks.listEvaluationCases.mockResolvedValue(page([]));
});

describe('AI evaluation governance DOM acceptance', () => {
  it('exposes dataset, Run, evidence and bad-case governance without synthetic pass data', async () => {
    const dom = await renderInTestDom(createElement(AiEvaluationPage));
    try {
      await dom.flush();
      expect(dom.container.textContent).toContain('AI 评测与发布门禁');
      expect(dom.container.textContent).toContain('数据集、版本与受控用例');
      expect(dom.container.textContent).toContain('Runner、Run 与发布可信状态');
      expect(dom.container.textContent).toContain('负反馈与坏样本分流');
      expect(dom.container.textContent).toContain('agent.answer-feedback.recorded.v1');
      expect(dom.container.textContent).toContain('不会把评论、模型输出或普通附件伪装成 VERIFIED');
      expect(dom.container.textContent).toContain('系统不会自动生成“通过”结果');
      expect(dom.container.querySelector('textarea[name="sanitizedInput"]')).not.toBeNull();
      expect(dom.container.querySelector('textarea[name="evidenceIds"]')).not.toBeNull();
    } finally {
      await dom.cleanup();
    }
  });

  it('requests exact PASSED subject filters and rejects an out-of-scope server response', async () => {
    apiMocks.listEvaluationRuns.mockResolvedValueOnce(
      page([
        {
          id: '10000000-0000-4000-8000-000000000002',
          status: 'PASSED',
          subjectType: 'AGENT_VERSION',
          subjectId: '10000000-0000-4000-8000-000000000099',
          subjectVersion: 3,
          metrics: [],
        },
      ]),
    );
    const onChange = vi.fn();
    const dom = await renderInTestDom(
      createElement(PassingEvaluationRunSelect, {
        subjectType: 'AGENT_VERSION',
        subjectId: SUBJECT_ID,
        subjectVersion: 3,
        value: '',
        onChange,
      }),
    );
    try {
      await dom.flush();
      expect(apiMocks.listEvaluationRuns).toHaveBeenCalledWith(
        {
          subjectType: 'AGENT_VERSION',
          subjectId: SUBJECT_ID,
          subjectVersion: 3,
          status: 'PASSED',
          limit: 100,
        },
        expect.anything(),
      );
      expect(dom.container.textContent).toContain('服务端返回了超出发布对象范围的评测运行');
      expect(dom.container.querySelectorAll('select option')).toHaveLength(1);
    } finally {
      await dom.cleanup();
    }
  });
});

function page<T>(items: readonly T[]): { items: readonly T[]; nextCursor: null } {
  return { items, nextCursor: null };
}
