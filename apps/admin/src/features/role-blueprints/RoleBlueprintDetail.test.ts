import type { RoleBlueprint, RoleVersion } from '@enterprise/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { renderInTestDom } from '@/test/dom-test-utils';

import { RoleBlueprintDetail } from './RoleBlueprintsPage';

const CURRENT_USER_ID = '00000000-0000-7000-8000-000000000001';

describe('RoleBlueprintDetail', () => {
  it('renders every structured role domain and clearly blocks author self-review', () => {
    const ownReview = roleVersion({
      status: 'TESTING',
      reviewStatus: 'IN_REVIEW',
      createdById: CURRENT_USER_ID,
    });
    const html = renderDetail(roleBlueprint([ownReview]));

    expect(html).toContain('使命与价值');
    expect(html).toContain('职责');
    expect(html).toContain('能力');
    expect(html).toContain('流程');
    expect(html).toContain('工具');
    expect(html).toContain('知识域');
    expect(html).toContain('双人审批要求版本作者不能审核自己的版本');
    expect(html).toContain('等待另一位管理员审核');
    expect(html).not.toContain('审批 / 退回');
    expect(html).not.toContain('>发布<');
  });

  it('shows publish only for an approved version and rollback only for a historical version', () => {
    const approved = roleVersion({
      id: '00000000-0000-7000-8000-000000000011',
      version: 3,
      status: 'TESTING',
      reviewStatus: 'APPROVED',
      createdById: '00000000-0000-7000-8000-000000000009',
    });
    const published = roleVersion({
      id: '00000000-0000-7000-8000-000000000012',
      version: 2,
      status: 'PUBLISHED',
      reviewStatus: 'APPROVED',
      publishedAt: '2026-07-22T00:00:00.000Z',
    });
    const retired = roleVersion({
      id: '00000000-0000-7000-8000-000000000013',
      version: 1,
      status: 'RETIRED',
      reviewStatus: 'APPROVED',
      publishedAt: '2026-07-20T00:00:00.000Z',
      retiredAt: '2026-07-22T00:00:00.000Z',
    });
    const html = renderDetail(roleBlueprint([approved, published, retired]));

    expect(html).toContain('>发布<');
    expect(html).toContain('>停用<');
    expect(html).toContain('回滚至此版本');
    expect(html).not.toContain('编辑草稿');
  });

  it('renders an adjacent version diff with captured Blueprint revisions', () => {
    const baseline = roleVersion({
      id: '00000000-0000-7000-8000-000000000021',
      version: 1,
      blueprintRevision: 2,
      status: 'RETIRED',
      reviewStatus: 'APPROVED',
      publishedAt: '2026-07-20T00:00:00.000Z',
      retiredAt: '2026-07-22T00:00:00.000Z',
    });
    if (baseline.roleDefinitionSnapshot === null) throw new Error('Expected a structured fixture.');
    const target = roleVersion({
      id: '00000000-0000-7000-8000-000000000022',
      version: 2,
      blueprintRevision: 4,
      status: 'PUBLISHED',
      reviewStatus: 'APPROVED',
      publishedAt: '2026-07-22T00:00:00.000Z',
      roleDefinitionSnapshot: {
        ...baseline.roleDefinitionSnapshot,
        mission: '建立覆盖收入全周期的可预测增长体系。',
      },
    });
    const html = renderDetail(roleBlueprint([target, baseline]));

    expect(html).toContain('查看历史差异');
    expect(html).toContain('蓝图修订 r4');
    expect(html).toContain('v1 → v2');
    expect(html).toContain('蓝图修订 r2 → r4');
    expect(html).toContain('使命');
    expect(html).toContain('变更');
    expect(html).toContain('建立覆盖收入全周期的可预测增长体系');
    expect(html).toContain('选择 v2 的比较基准');
  });

  it('switches the comparison baseline through the labeled DOM control', async () => {
    const v1 = roleVersion({
      id: '00000000-0000-7000-8000-000000000031',
      version: 1,
      blueprintRevision: 1,
    });
    if (v1.roleDefinitionSnapshot === null) throw new Error('Expected a structured fixture.');
    const v2 = roleVersion({
      id: '00000000-0000-7000-8000-000000000032',
      version: 2,
      blueprintRevision: 2,
      roleDefinitionSnapshot: {
        ...v1.roleDefinitionSnapshot,
        mission: '第二版使命：建立稳定的销售体系。',
      },
    });
    if (v2.roleDefinitionSnapshot === null) throw new Error('Expected a structured fixture.');
    const v3 = roleVersion({
      id: '00000000-0000-7000-8000-000000000033',
      version: 3,
      blueprintRevision: 3,
      roleDefinitionSnapshot: {
        ...v2.roleDefinitionSnapshot,
        mission: '第三版使命：建立可持续的收入体系。',
      },
    });
    const dom = await renderInTestDom(
      createElement(RoleBlueprintDetail, {
        blueprint: roleBlueprint([v3, v2, v1]),
        currentUserId: CURRENT_USER_ID,
        onEditBlueprint: vi.fn(),
        onCreateDraft: vi.fn(),
        onEditVersion: vi.fn(),
        onReview: vi.fn(),
        onTransition: vi.fn(),
        onRollback: vi.fn(),
      }),
    );

    try {
      const select = dom.container.querySelector(
        'select[aria-label="选择 v3 的比较基准"]',
      ) as HTMLSelectElement | null;
      expect(select).not.toBeNull();
      if (!select) return;
      const panel = select.closest('details');
      expect(select.closest('label')?.textContent).toContain('比较基准');
      expect(panel?.querySelector('summary')?.tagName).toBe('SUMMARY');
      expect(panel?.textContent).toContain('v2 → v3');
      expect(panel?.textContent).toContain('第二版使命：建立稳定的销售体系。');

      await dom.change(select, v1.id);

      expect(select.value).toBe(v1.id);
      expect(panel?.textContent).toContain('v1 → v3');
      expect(panel?.textContent).toContain('建立可预测、可持续的企业销售增长体系。');
      expect(panel?.textContent).not.toContain('v2 → v3');
    } finally {
      await dom.cleanup();
    }
  });
});

function renderDetail(blueprint: RoleBlueprint): string {
  return renderToStaticMarkup(
    createElement(RoleBlueprintDetail, {
      blueprint,
      currentUserId: CURRENT_USER_ID,
      onEditBlueprint: vi.fn(),
      onCreateDraft: vi.fn(),
      onEditVersion: vi.fn(),
      onReview: vi.fn(),
      onTransition: vi.fn(),
      onRollback: vi.fn(),
    }),
  );
}

function roleBlueprint(versions: RoleVersion[]): RoleBlueprint {
  return {
    id: '00000000-0000-7000-8000-000000000101',
    key: 'sales.lead',
    name: '销售负责人',
    description: '负责企业销售经营。',
    mission: '建立可预测、可持续的企业销售增长体系。',
    responsibilities: [
      {
        key: 'pipeline',
        name: '销售管道管理',
        description: '维护机会质量。',
        outcomes: ['预测可解释'],
      },
    ],
    valueDefinition: {
      statement: '以可持续收入增长创造价值。',
      stakeholderOutcomes: ['客户获得匹配方案'],
      measures: ['续约率'],
    },
    capabilities: [
      {
        key: 'forecast',
        name: '预测能力',
        description: '形成可信预测。',
        level: 'ADVANCED',
      },
    ],
    processes: [
      {
        key: 'deal-review',
        name: '商机评审',
        description: '评审关键商机。',
        responsibility: 'OWNER',
      },
    ],
    tools: [
      {
        key: 'crm',
        name: 'CRM',
        description: '管理销售记录。',
        access: 'EXECUTE',
      },
    ],
    knowledgeDomains: [
      {
        key: 'pricing',
        name: '定价',
        description: '企业定价规则。',
        sensitivity: 'CONFIDENTIAL',
      },
    ],
    revision: 2,
    createdAt: '2026-07-20T00:00:00.000Z',
    updatedAt: '2026-07-22T00:00:00.000Z',
    versions,
  };
}

function roleVersion(overrides: Partial<RoleVersion> = {}): RoleVersion {
  return {
    id: '00000000-0000-7000-8000-000000000102',
    templateId: '00000000-0000-7000-8000-000000000101',
    version: 1,
    status: 'DRAFT',
    reviewStatus: 'NOT_SUBMITTED',
    systemPrompt: 'You are a governed enterprise sales Role Agent.',
    modelPolicy: {},
    toolPolicy: {},
    knowledgeScope: {},
    roleDefinitionSnapshot: {
      mission: '建立可预测、可持续的企业销售增长体系。',
      responsibilities: [
        {
          key: 'pipeline',
          name: '销售管道管理',
          description: '维护机会质量。',
          outcomes: ['预测可解释'],
        },
      ],
      valueDefinition: {
        statement: '以可持续收入增长创造价值。',
        stakeholderOutcomes: ['客户获得匹配方案'],
        measures: ['续约率'],
      },
      capabilities: [],
      processes: [],
      tools: [],
      knowledgeDomains: [],
    },
    blueprintRevision: 2,
    changeSummary: 'Initial role version',
    revision: 1,
    createdById: CURRENT_USER_ID,
    reviewRequestedAt: null,
    reviewRequestedById: null,
    reviewedAt: null,
    reviewedById: null,
    reviewComment: null,
    approvedAt: null,
    approvedById: null,
    publishedAt: null,
    publishedById: null,
    evaluationRunId: null,
    evaluationDatasetVersionId: null,
    evaluationSnapshotHash: null,
    retiredAt: null,
    retiredById: null,
    rollbackOfVersionId: null,
    createdAt: '2026-07-20T00:00:00.000Z',
    ...overrides,
  };
}
