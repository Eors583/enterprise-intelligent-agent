import type { RoleBlueprint, RoleVersion } from '@enterprise/contracts';
import { describe, expect, it } from 'vitest';

import { ApiError } from '@/api/client';

import {
  currentPublishedVersionId,
  diffRoleVersions,
  parseJsonObject,
  roleBlueprintErrorMessage,
  roleVersionActions,
  roleVersionReviewLabel,
  roleVersionStatusLabel,
} from './role-blueprint-view';

const CURRENT_USER_ID = '00000000-0000-7000-8000-000000000001';
const OTHER_USER_ID = '00000000-0000-7000-8000-000000000002';

describe('role blueprint view model', () => {
  it('exposes only truthful actions for each persisted governance state', () => {
    const draft = roleVersion({ status: 'DRAFT', reviewStatus: 'NOT_SUBMITTED' });
    expect(roleVersionActions(draft, CURRENT_USER_ID, null)).toMatchObject({
      canEdit: true,
      canSubmit: true,
      canReview: false,
      canPublish: false,
      canRetire: false,
      canRollback: false,
    });

    const approved = roleVersion({
      status: 'TESTING',
      reviewStatus: 'APPROVED',
      createdById: OTHER_USER_ID,
    });
    expect(roleVersionActions(approved, CURRENT_USER_ID, null)).toMatchObject({
      canEdit: false,
      canReview: false,
      canPublish: true,
    });

    const published = roleVersion({
      id: '00000000-0000-7000-8000-000000000010',
      status: 'PUBLISHED',
      reviewStatus: 'APPROVED',
      publishedAt: '2026-07-20T00:00:00.000Z',
    });
    expect(roleVersionActions(published, CURRENT_USER_ID, published.id)).toMatchObject({
      canRetire: true,
      canRollback: false,
    });
  });

  it('enforces the two-person review rule before an author can review', () => {
    const ownVersion = roleVersion({
      status: 'TESTING',
      reviewStatus: 'IN_REVIEW',
      createdById: CURRENT_USER_ID,
    });
    expect(roleVersionActions(ownVersion, CURRENT_USER_ID, null)).toMatchObject({
      canReview: false,
      reviewBlockedForAuthor: true,
    });

    expect(
      roleVersionActions({ ...ownVersion, createdById: OTHER_USER_ID }, CURRENT_USER_ID, null),
    ).toMatchObject({ canReview: true, reviewBlockedForAuthor: false });
  });

  it('finds the actual current published version and maps labels', () => {
    const older = roleVersion({
      id: '00000000-0000-7000-8000-000000000011',
      version: 1,
      status: 'PUBLISHED',
      reviewStatus: 'APPROVED',
      publishedAt: '2026-07-20T00:00:00.000Z',
    });
    const newer = roleVersion({
      id: '00000000-0000-7000-8000-000000000012',
      version: 2,
      status: 'PUBLISHED',
      reviewStatus: 'APPROVED',
      publishedAt: '2026-07-21T00:00:00.000Z',
    });
    const blueprint = { versions: [older, newer] } as RoleBlueprint;
    expect(currentPublishedVersionId(blueprint)).toBe(newer.id);
    expect(roleVersionStatusLabel('PUBLISHED')).toBe('已发布');
    expect(roleVersionReviewLabel('CHANGES_REQUESTED')).toBe('已退回');
  });

  it('validates policy JSON objects and clearly translates a self-review failure', () => {
    expect(parseJsonObject('{"model":"governed"}', '模型策略')).toEqual({
      model: 'governed',
    });
    expect(() => parseJsonObject('[]', '模型策略')).toThrow(
      '模型策略必须是 JSON 对象，不能是数组或基础值。',
    );

    const message = roleBlueprintErrorMessage(
      new ApiError('A Role Version author cannot approve their own version.', {
        status: 403,
        requestId: 'req-1',
      }),
    );
    expect(message).toContain('双人审批要求');
    expect(message).toContain('另一位企业所有者或管理员');
    expect(message).toContain('req-1');
  });

  it('reports field-level additions, removals, and changes across versioned definitions', () => {
    const baseline = roleVersion({
      version: 2,
      blueprintRevision: 3,
      systemPrompt: 'You are the governed sales lead for the enterprise.',
      modelPolicy: { route: 'balanced', legacyFallback: true },
      toolPolicy: { crm: { access: 'READ' } },
      knowledgeScope: { domains: ['sales'] },
      roleDefinitionSnapshot: roleDefinitionSnapshot({
        mission: '建立可预测的企业销售体系。',
        tools: [
          {
            key: 'crm',
            name: '客户关系管理系统',
            description: '读取客户与商机记录。',
            access: 'READ',
          },
        ],
      }),
    });
    const target = roleVersion({
      version: 3,
      blueprintRevision: 5,
      systemPrompt: 'You are the governed revenue leader for the enterprise.',
      modelPolicy: { route: 'quality' },
      toolPolicy: { crm: { access: 'EXECUTE' } },
      knowledgeScope: { domains: ['sales', 'pricing'] },
      roleDefinitionSnapshot: roleDefinitionSnapshot({
        mission: '建立可预测、可持续的企业收入体系。',
        capabilities: [
          {
            key: 'forecasting',
            name: '商业预测',
            description: '形成可解释的收入预测。',
            level: 'ADVANCED',
          },
        ],
        tools: [
          {
            key: 'crm',
            name: '客户关系管理系统',
            description: '读取并维护客户与商机记录。',
            access: 'EXECUTE',
          },
        ],
      }),
    });

    const changes = diffRoleVersions(baseline, target);
    expect(changes.find((change) => change.label === '蓝图修订')).toMatchObject({
      kind: 'changed',
      before: 'r3',
      after: 'r5',
    });
    expect(changes.find((change) => change.label === '使命')).toMatchObject({
      kind: 'changed',
      before: '建立可预测的企业销售体系。',
      after: '建立可预测、可持续的企业收入体系。',
    });
    expect(changes.find((change) => change.label === '能力 / forecasting / 名称')).toMatchObject({
      kind: 'added',
      after: '商业预测',
    });
    expect(changes.find((change) => change.label === '模型策略 / legacyFallback')).toMatchObject({
      kind: 'removed',
      before: 'true',
    });
    expect(changes.find((change) => change.label === '工具策略 / crm / access')).toMatchObject({
      kind: 'changed',
      before: 'READ',
      after: 'EXECUTE',
    });
    expect(changes.find((change) => change.label === '知识范围 / domains / 第 2 项')).toMatchObject(
      {
        kind: 'added',
        after: 'pricing',
      },
    );
    expect(changes.find((change) => change.label === '系统提示词')).toMatchObject({
      kind: 'changed',
    });
  });
});

function roleVersion(overrides: Partial<RoleVersion> = {}): RoleVersion {
  return {
    id: '00000000-0000-7000-8000-000000000003',
    templateId: '00000000-0000-7000-8000-000000000004',
    version: 1,
    status: 'DRAFT',
    reviewStatus: 'NOT_SUBMITTED',
    systemPrompt: 'You are a governed enterprise Role Agent.',
    modelPolicy: {},
    toolPolicy: {},
    knowledgeScope: {},
    roleDefinitionSnapshot: roleDefinitionSnapshot(),
    blueprintRevision: 1,
    changeSummary: 'Initial draft',
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

function roleDefinitionSnapshot(
  overrides: Partial<RoleVersion['roleDefinitionSnapshot']> = {},
): RoleVersion['roleDefinitionSnapshot'] {
  return {
    mission: '建立可预测的企业销售体系。',
    responsibilities: [
      {
        key: 'pipeline',
        name: '销售管道管理',
        description: '维护销售机会质量。',
        outcomes: ['预测可解释'],
      },
    ],
    valueDefinition: {
      statement: '以可持续收入增长创造价值。',
      stakeholderOutcomes: ['客户获得匹配方案'],
      measures: ['季度收入达成率'],
    },
    capabilities: [],
    processes: [],
    tools: [],
    knowledgeDomains: [],
    ...overrides,
  };
}
