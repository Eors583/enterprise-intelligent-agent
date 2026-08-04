import type { AiEvaluationCase, AiEvaluationRun, AiEvaluationRunner } from '@enterprise/contracts';
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderInTestDom } from '@/test/dom-test-utils';

const apiMocks = vi.hoisted(() => ({
  createEvaluationRunner: vi.fn(),
  createEvaluationRun: vi.fn(),
  listEvaluationCases: vi.fn(),
  loadEvaluationReadiness: vi.fn(),
  startEvaluationRun: vi.fn(),
  submitEvaluationRun: vi.fn(),
  verifyEvaluationRun: vi.fn(),
}));

vi.mock('./api', () => apiMocks);

import { RunGovernancePanel } from './RunGovernancePanel';

const TENANT_ID = '20000000-0000-4000-8000-000000000001';
const RUN_ID = '20000000-0000-4000-8000-000000000002';
const RUNNER_ID = '20000000-0000-4000-8000-000000000003';
const DATASET_VERSION_ID = '20000000-0000-4000-8000-000000000004';
const SUBJECT_ID = '20000000-0000-4000-8000-000000000005';
const CASE_ID = '20000000-0000-4000-8000-000000000006';
const EVIDENCE_ID = '20000000-0000-4000-8000-000000000007';
const HASH = 'c'.repeat(64);

const RUNNER: AiEvaluationRunner = {
  id: RUNNER_ID,
  name: 'Production Runner',
  status: 'ACTIVE',
  attestationKeyFingerprint: HASH,
  allowedEvidenceOrigins: ['https://evidence.example.com/'],
};

const RUN: AiEvaluationRun = {
  id: RUN_ID,
  tenantId: TENANT_ID,
  datasetVersionId: DATASET_VERSION_ID,
  subjectType: 'AGENT_VERSION',
  subjectId: SUBJECT_ID,
  subjectVersion: 4,
  subjectSnapshotHash: HASH,
  status: 'RUNNING',
  runnerId: RUNNER_ID,
  runnerName: RUNNER.name,
  runnerAttestationKeyFingerprint: HASH,
  externalRunId: 'runtime-4',
  expectedCaseCount: 1,
  submittedCaseCount: 0,
  evidenceBundleUri: null,
  evidenceBundleHash: null,
  runnerAttestation: null,
  metrics: [],
  revision: 2,
  startedAt: '2026-07-29T02:00:00.000Z',
  submittedAt: null,
  verifiedByUserId: null,
  verifiedAt: null,
  finishedAt: null,
  createdAt: '2026-07-29T01:00:00.000Z',
  updatedAt: '2026-07-29T02:00:00.000Z',
};

const TEST_CASE: AiEvaluationCase = {
  id: CASE_ID,
  tenantId: TENANT_ID,
  datasetVersionId: DATASET_VERSION_ID,
  caseKey: 'FACTUALITY.001',
  category: 'FACTUALITY',
  input: 'Question',
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
  expectedBehavior: 'Answer with evidence.',
  requiredEvidenceIds: [EVIDENCE_ID],
  forbiddenBehaviors: [],
  scoring: {
    judgeTypes: ['SIGNED_CODE'],
    rubric: 'Signed factuality check.',
    metricWeights: [{ metric: 'FACTUAL_ACCURACY', weight: 1 }],
  },
  sourceBadCaseId: null,
  contentHash: HASH,
  revision: 1,
  createdAt: '2026-07-29T01:00:00.000Z',
};

beforeEach(() => {
  for (const mock of Object.values(apiMocks)) mock.mockReset();
  apiMocks.listEvaluationCases.mockResolvedValue({ items: [TEST_CASE], nextCursor: null });
});

describe('Run governance streamlined DOM', () => {
  it('blocks the ordinary path without real catalogs and routes Runner setup to connectors', async () => {
    const dom = await renderInTestDom(
      createElement(RunGovernancePanel, {
        runs: [],
        runners: [],
        reload: vi.fn(),
        onNotice: vi.fn(),
        onError: vi.fn(),
      }),
    );
    try {
      await dom.flush();
      expect(dom.container.textContent).toContain('系统会自动绑定其版本与快照');
      expect(dom.container.textContent).toContain('当前没有可用评测执行服务');
      const runnerName = dom.container.querySelector('input[name="name"]');
      expect(runnerName).toBeNull();
      expect(dom.container.textContent).toContain('当前版本不提供连接器管理页面');
      expect(dom.container.textContent).not.toContain('公钥指纹');
    } finally {
      await dom.cleanup();
    }
  });

  it('offers three ordinary selections and accepts only a Runner result file', async () => {
    const dom = await renderInTestDom(
      createElement(RunGovernancePanel, {
        runs: [RUN],
        runners: [RUNNER],
        reload: vi.fn(),
        onNotice: vi.fn(),
        onError: vi.fn(),
      }),
    );
    try {
      await dom.flush();
      expect(dom.container.querySelector('select[name="datasetChoice"]')).not.toBeNull();
      expect(dom.container.querySelector('select[name="runnerChoice"]')).not.toBeNull();
      expect(dom.container.querySelector('select[name="subjectChoice"]')).not.toBeNull();
      for (const name of [
        'datasetVersionId',
        'subjectType',
        'subjectId',
        'subjectVersion',
        'subjectSnapshotHash',
        'externalRunId',
      ]) {
        expect(dom.container.querySelector(`[name="${name}"]`)).toBeNull();
      }

      const resultButton = [...dom.container.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('提交签名结果'),
      );
      expect(resultButton).not.toBeUndefined();
      if (resultButton) await dom.click(resultButton);
      await dom.flush();

      expect(dom.container.querySelector('input[name="runnerResultPackage"]')).not.toBeNull();
      expect(dom.container.textContent).toContain('管理端只解析');
      const rawHash = dom.container.querySelector(`input[name="${CASE_ID}:actualBehaviorHash"]`);
      expect(rawHash).toBeNull();
      expect(dom.container.textContent).not.toContain('逐字段兼容表单');
      expect(
        [...dom.container.querySelectorAll('button')]
          .find((button) => button.textContent?.includes('确认并提交 Runner 结果包'))
          ?.hasAttribute('disabled'),
      ).toBe(true);
    } finally {
      await dom.cleanup();
    }
  });
});
