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
const adminApiMocks = vi.hoisted(() => ({
  listAgents: vi.fn(),
  listKnowledgeBases: vi.fn(),
  listRoleAssignments: vi.fn(),
  listToolDefinitions: vi.fn(),
}));
const businessApiMocks = vi.hoisted(() => ({
  listEvidence: vi.fn(),
  listProcessDefinitions: vi.fn(),
}));

vi.mock('./api', () => apiMocks);
vi.mock('@/api/admin-api', () => adminApiMocks);
vi.mock('@/features/business-semantics/api', () => businessApiMocks);

import { AiEvaluationPage } from './AiEvaluationPage';
import { PassingEvaluationRunSelect } from './PassingEvaluationRunSelect';

const SUBJECT_ID = '10000000-0000-4000-8000-000000000001';

beforeEach(() => {
  for (const mock of Object.values(apiMocks)) mock.mockReset();
  for (const mock of Object.values(adminApiMocks)) mock.mockReset();
  for (const mock of Object.values(businessApiMocks)) mock.mockReset();
  apiMocks.listEvaluationDatasets.mockResolvedValue(page([]));
  apiMocks.listEvaluationRuns.mockResolvedValue(page([]));
  apiMocks.listEvaluationRunners.mockResolvedValue(page([]));
  apiMocks.listEvaluationBadCases.mockResolvedValue(page([]));
  apiMocks.listEvaluationDatasetVersions.mockResolvedValue(page([]));
  apiMocks.listEvaluationCases.mockResolvedValue(page([]));
  adminApiMocks.listAgents.mockResolvedValue({ items: [] });
  adminApiMocks.listKnowledgeBases.mockResolvedValue({ items: [] });
  adminApiMocks.listRoleAssignments.mockResolvedValue({ items: [] });
  adminApiMocks.listToolDefinitions.mockResolvedValue({ items: [], nextCursor: null });
  businessApiMocks.listEvidence.mockResolvedValue([]);
  businessApiMocks.listProcessDefinitions.mockResolvedValue([]);
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
      expect(dom.container.querySelector('select[name="evidenceIds"]')).not.toBeNull();
      expect(dom.container.querySelector('[aria-label="坏样本来源结果包"]')).not.toBeNull();
      expect(dom.container.querySelector('input[name="sourceId"]')).toBeNull();
      expect(dom.container.querySelector('input[name="sourceVersion"]')).toBeNull();
      expect(dom.container.querySelector('input[name="sourceSnapshotHash"]')).toBeNull();
      expect(dom.container.querySelector('input[name="code"]')).toBeNull();
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

  it('uses published reference selectors and keeps legacy ids and prompt hashes advanced', async () => {
    apiMocks.listEvaluationDatasets.mockResolvedValue(
      page([
        {
          id: '10000000-0000-4000-8000-000000000101',
          code: 'DATASET.ROLE',
          name: '角色评测',
          latestVersion: 1,
        },
      ]),
    );
    apiMocks.listEvaluationDatasetVersions.mockResolvedValue(
      page([
        {
          id: '10000000-0000-4000-8000-000000000102',
          version: 1,
          revision: 1,
          status: 'DRAFT',
          caseCount: 0,
          annotationCoverage: 0,
          contentHash: 'a'.repeat(64),
        },
      ]),
    );
    adminApiMocks.listAgents.mockResolvedValue({
      items: [
        {
          name: 'HR 助手',
          versionId: '10000000-0000-4000-8000-000000000103',
          version: 2,
          versionStatus: 'PUBLISHED',
        },
      ],
    });
    adminApiMocks.listKnowledgeBases.mockResolvedValue({
      items: [
        {
          name: '员工制度',
          documents: [
            {
              title: '请假制度',
              currentVersionId: '10000000-0000-4000-8000-000000000104',
              versions: [
                {
                  id: '10000000-0000-4000-8000-000000000104',
                  status: 'READY',
                  versionNumber: 3,
                },
              ],
            },
          ],
        },
      ],
    });
    adminApiMocks.listToolDefinitions.mockResolvedValue({
      items: [
        {
          name: '查询假期',
          status: 'PUBLISHED',
          currentVersionId: '10000000-0000-4000-8000-000000000105',
          currentVersion: 4,
        },
      ],
      nextCursor: null,
    });
    adminApiMocks.listRoleAssignments.mockResolvedValue({
      items: [
        {
          id: '10000000-0000-4000-8000-000000000106',
          status: 'ACTIVE',
          roleVersionId: '10000000-0000-4000-8000-000000000107',
          assignee: { displayName: '测试员工' },
          agent: { id: 'agent', name: 'HR 助手', versionId: 'version', version: 2 },
        },
      ],
    });
    businessApiMocks.listProcessDefinitions.mockResolvedValue([
      {
        code: 'LEAVE.REQUEST',
        name: '请假流程',
        status: 'ACTIVE',
        currentVersionId: '10000000-0000-4000-8000-000000000108',
      },
    ]);
    businessApiMocks.listEvidence.mockResolvedValue([
      {
        id: '10000000-0000-4000-8000-000000000109',
        code: 'EVIDENCE.LEAVE',
        summary: '已审核制度',
        status: 'ACTIVE',
        trustLevel: 'VERIFIED',
      },
    ]);

    const dom = await renderInTestDom(createElement(AiEvaluationPage));
    try {
      await dom.flush();
      await dom.flush();
      await dom.flush();

      expect(dom.container.querySelector('select[name="agentVersionIds"]')).not.toBeNull();
      expect(dom.container.querySelector('textarea[name="agentVersionIds"]')).toBeNull();
      expect(dom.container.querySelector('select[name="knowledgeVersionIds"]')).not.toBeNull();
      expect(dom.container.querySelector('select[name="toolVersionIds"]')).not.toBeNull();
      expect(dom.container.querySelector('select[name="roleAssignmentSelection"]')).not.toBeNull();
      expect(dom.container.querySelector('select[name="processVersionSelection"]')).not.toBeNull();
      expect(dom.container.querySelector('input[name="caseKey"]')).toBeNull();
      expect(dom.container.querySelector('input[name="roleAssignmentId"]')).toBeNull();
      expect(dom.container.querySelector('input[name="processVersionId"]')).toBeNull();

      const promptHashes = dom.container.querySelector('textarea[name="promptHashes"]');
      expect(promptHashes).toBeNull();
      expect(dom.container.textContent).not.toContain('Prompt Hash');
      expect(dom.container.textContent).toContain('HR 助手 · v2');
      expect(dom.container.textContent).toContain('员工制度 / 请假制度 · v3');
      expect(dom.container.textContent).toContain('已审核制度');
    } finally {
      await dom.cleanup();
    }
  });
});

function page<T>(items: readonly T[]): { items: readonly T[]; nextCursor: null } {
  return { items, nextCursor: null };
}
