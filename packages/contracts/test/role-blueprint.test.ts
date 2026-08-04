import { describe, expect, it } from 'vitest';

import {
  createRoleBlueprintRequestSchema,
  createRoleVersionDraftRequestSchema,
  publishRoleVersionRequestSchema,
  reviewRoleVersionRequestSchema,
  rollbackRoleVersionResponseSchema,
  updateRoleBlueprintRequestSchema,
} from '../src/role-blueprint.js';

const structuredBlueprint = {
  key: 'sales.partner',
  name: '伙伴销售',
  mission: '帮助伙伴持续创造可验证的客户价值。',
  responsibilities: [
    {
      key: 'pipeline',
      name: '商机管道',
      description: '建立并维护真实商机管道。',
      outcomes: ['商机具有负责人和下一步动作'],
    },
  ],
  valueDefinition: {
    statement: '通过可靠协作提高伙伴成功率。',
    stakeholderOutcomes: ['伙伴可预测地获得支持'],
    measures: ['伙伴赢单率'],
  },
  capabilities: [],
  processes: [],
  tools: [],
  knowledgeDomains: [],
};

describe('Role Blueprint contracts', () => {
  it('normalizes and validates a complete structured role definition', () => {
    expect(
      createRoleBlueprintRequestSchema.parse({
        ...structuredBlueprint,
        key: ' SALES.PARTNER ',
      }),
    ).toMatchObject({ key: 'sales.partner', mission: structuredBlueprint.mission });
  });

  it('rejects prompt-only blueprints and malformed structured elements', () => {
    expect(() =>
      createRoleBlueprintRequestSchema.parse({
        key: 'sales.partner',
        name: '伙伴销售',
        mission: '销售',
      }),
    ).toThrow();
    expect(() =>
      createRoleBlueprintRequestSchema.parse({
        ...structuredBlueprint,
        responsibilities: [{ name: '缺少稳定编码' }],
      }),
    ).toThrow();
  });

  it('requires optimistic revision and an actual blueprint change', () => {
    expect(() => updateRoleBlueprintRequestSchema.parse({ expectedRevision: 1 })).toThrow();
    expect(
      updateRoleBlueprintRequestSchema.parse({
        expectedRevision: 1,
        mission: '更新后的企业使命。',
      }),
    ).toEqual({ expectedRevision: 1, mission: '更新后的企业使命。' });
  });

  it('requires an explicit review decision and auditable comment', () => {
    expect(
      reviewRoleVersionRequestSchema.parse({
        expectedRevision: 2,
        decision: 'APPROVE',
        comment: '职责与授权边界已核验。',
      }),
    ).toMatchObject({ decision: 'APPROVE' });
    expect(() =>
      reviewRoleVersionRequestSchema.parse({
        expectedRevision: 2,
        decision: 'APPROVE',
        comment: ' ',
      }),
    ).toThrow();
  });

  it('requires the exact Evaluation Run reference for publication', () => {
    expect(
      publishRoleVersionRequestSchema.parse({
        expectedRevision: 3,
        evaluationRunId: '00000000-0000-7000-8000-000000000105',
      }),
    ).toMatchObject({ expectedRevision: 3 });
    expect(publishRoleVersionRequestSchema.safeParse({ expectedRevision: 3 }).success).toBe(false);
  });

  it('accepts only recognizable knowledge-base selections in a role version', () => {
    const request = {
      systemPrompt: 'Use only governed enterprise knowledge and cite every factual claim.',
      modelPolicy: {},
      toolPolicy: {},
      changeSummary: 'Bind the approved policy knowledge base.',
    };
    expect(
      createRoleVersionDraftRequestSchema.parse({
        ...request,
        knowledgeScope: {
          knowledgeBaseIds: ['00000000-0000-7000-8000-000000000109'],
        },
      }).knowledgeScope.knowledgeBaseIds,
    ).toEqual(['00000000-0000-7000-8000-000000000109']);
    expect(
      createRoleVersionDraftRequestSchema.safeParse({
        ...request,
        knowledgeScope: { knowledgeBaseIds: ['copied-name-not-an-id'] },
      }).success,
    ).toBe(false);
  });

  it('models rollback as a lineage draft that still requires independent review', () => {
    const now = '2026-07-28T04:00:00.000Z';
    expect(
      rollbackRoleVersionResponseSchema.parse({
        id: '00000000-0000-7000-8000-000000000101',
        templateId: '00000000-0000-7000-8000-000000000102',
        version: 3,
        status: 'DRAFT',
        reviewStatus: 'NOT_SUBMITTED',
        systemPrompt: 'Execute the governed enterprise role safely.',
        modelPolicy: {},
        toolPolicy: {},
        knowledgeScope: {},
        roleDefinitionSnapshot: {
          mission: structuredBlueprint.mission,
          responsibilities: structuredBlueprint.responsibilities,
          valueDefinition: structuredBlueprint.valueDefinition,
          capabilities: structuredBlueprint.capabilities,
          processes: structuredBlueprint.processes,
          tools: structuredBlueprint.tools,
          knowledgeDomains: structuredBlueprint.knowledgeDomains,
        },
        blueprintRevision: 1,
        changeSummary: 'Restore the last verified configuration.',
        revision: 1,
        createdById: '00000000-0000-7000-8000-000000000103',
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
        rollbackOfVersionId: '00000000-0000-7000-8000-000000000104',
        createdAt: now,
      }),
    ).toMatchObject({
      status: 'DRAFT',
      reviewStatus: 'NOT_SUBMITTED',
      rollbackOfVersionId: '00000000-0000-7000-8000-000000000104',
    });
  });
});
