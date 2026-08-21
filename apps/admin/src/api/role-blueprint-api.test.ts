import {
  createRoleBlueprintRequestSchema,
  createRoleVersionDraftRequestSchema,
  reviewRoleVersionRequestSchema,
  publishRoleVersionRequestSchema,
  roleBlueprintListResponseSchema,
  roleBlueprintSchema,
  roleVersionSchema,
  roleVersionTransitionRequestSchema,
  rollbackRoleVersionRequestSchema,
  rollbackRoleVersionResponseSchema,
  updateRoleBlueprintRequestSchema,
  updateRoleVersionDraftRequestSchema,
} from '@enterprise/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { requestMock } = vi.hoisted(() => ({ requestMock: vi.fn() }));

vi.mock('./client', () => ({ request: requestMock }));

import {
  createRoleBlueprint,
  createRoleVersionDraft,
  listRoleBlueprints,
  publishRoleVersion,
  retireRoleVersion,
  reviewRoleVersion,
  rollbackRoleVersion,
  submitRoleVersion,
  updateRoleBlueprint,
  updateRoleVersionDraft,
} from './admin-api';

const BLUEPRINT_ID = '00000000-0000-7000-8000-000000000101';
const VERSION_ID = '00000000-0000-7000-8000-000000000102';

const blueprintInput = {
  key: 'sales.lead',
  name: '销售负责人',
  description: '负责企业销售经营。',
  mission: '建立可预测、可持续的企业销售增长体系。',
  responsibilities: [
    {
      key: 'pipeline',
      name: '销售管道管理',
      description: '维护销售机会质量与阶段推进。',
      outcomes: ['销售预测可解释'],
    },
  ],
  valueDefinition: {
    statement: '以可持续收入增长创造价值。',
    stakeholderOutcomes: ['客户获得匹配需求的方案'],
    measures: ['续约率'],
  },
  capabilities: [],
  processes: [],
  tools: [],
  knowledgeDomains: [],
};

const draftInput = {
  systemPrompt: 'You are the governed sales lead Role Agent for this enterprise.',
  modelPolicy: {},
  toolPolicy: {},
  knowledgeScope: {},
  changeSummary: 'Initial governed version.',
};

describe('role blueprint admin API', () => {
  beforeEach(() => {
    requestMock.mockReset();
    requestMock.mockResolvedValue(undefined);
  });

  it('lists, creates, and revision-updates Role Blueprints through typed routes', async () => {
    const controller = new AbortController();
    await listRoleBlueprints(controller.signal);
    expect(requestMock).toHaveBeenLastCalledWith('/admin/role-blueprints', {
      schema: roleBlueprintListResponseSchema,
      signal: controller.signal,
    });

    await createRoleBlueprint(blueprintInput);
    expect(requestMock).toHaveBeenLastCalledWith('/admin/role-blueprints', {
      method: 'POST',
      body: createRoleBlueprintRequestSchema.parse(blueprintInput),
      schema: roleBlueprintSchema,
    });

    const update = {
      expectedRevision: 3,
      name: '企业销售负责人',
      mission: '以受治理的销售运营创造可持续增长。',
    };
    await updateRoleBlueprint(BLUEPRINT_ID, update);
    expect(requestMock).toHaveBeenLastCalledWith(`/admin/role-blueprints/${BLUEPRINT_ID}`, {
      method: 'PATCH',
      body: updateRoleBlueprintRequestSchema.parse(update),
      schema: roleBlueprintSchema,
    });
  });

  it('creates and updates version drafts with optimistic revisions', async () => {
    await createRoleVersionDraft(BLUEPRINT_ID, draftInput);
    expect(requestMock).toHaveBeenLastCalledWith(
      `/admin/role-blueprints/${BLUEPRINT_ID}/versions`,
      {
        method: 'POST',
        body: createRoleVersionDraftRequestSchema.parse(draftInput),
        schema: roleVersionSchema,
      },
    );

    const update = {
      expectedRevision: 2,
      systemPrompt: 'You are the updated governed sales lead Role Agent.',
      changeSummary: 'Addressed reviewer feedback.',
    };
    await updateRoleVersionDraft(BLUEPRINT_ID, VERSION_ID, update);
    expect(requestMock).toHaveBeenLastCalledWith(
      `/admin/role-blueprints/${BLUEPRINT_ID}/versions/${VERSION_ID}`,
      {
        method: 'PATCH',
        body: updateRoleVersionDraftRequestSchema.parse(update),
        schema: roleVersionSchema,
      },
    );
  });

  it('uses the exact submit, review, publish, retire, and rollback transition routes', async () => {
    const transition = { expectedRevision: 4 };
    await submitRoleVersion(BLUEPRINT_ID, VERSION_ID, transition);
    expect(requestMock).toHaveBeenLastCalledWith(
      `/admin/role-blueprints/${BLUEPRINT_ID}/versions/${VERSION_ID}/submit`,
      {
        method: 'POST',
        body: roleVersionTransitionRequestSchema.parse(transition),
        schema: roleVersionSchema,
      },
    );

    const review = {
      expectedRevision: 5,
      decision: 'APPROVE' as const,
      comment: 'Approved by an independent reviewer.',
    };
    await reviewRoleVersion(BLUEPRINT_ID, VERSION_ID, review);
    expect(requestMock).toHaveBeenLastCalledWith(
      `/admin/role-blueprints/${BLUEPRINT_ID}/versions/${VERSION_ID}/review`,
      {
        method: 'POST',
        body: reviewRoleVersionRequestSchema.parse(review),
        schema: roleVersionSchema,
      },
    );

    const publication = transition;
    await publishRoleVersion(BLUEPRINT_ID, VERSION_ID, publication);
    expect(requestMock).toHaveBeenLastCalledWith(
      `/admin/role-blueprints/${BLUEPRINT_ID}/versions/${VERSION_ID}/publish`,
      {
        method: 'POST',
        body: publishRoleVersionRequestSchema.parse(publication),
        schema: roleVersionSchema,
      },
    );

    await retireRoleVersion(BLUEPRINT_ID, VERSION_ID, transition);
    expect(requestMock.mock.calls.at(-1)?.[0]).toBe(
      `/admin/role-blueprints/${BLUEPRINT_ID}/versions/${VERSION_ID}/retire`,
    );

    const rollback = {
      expectedPublishedVersionId: VERSION_ID,
      changeSummary: 'Emergency rollback to the last stable version.',
    };
    await rollbackRoleVersion(BLUEPRINT_ID, VERSION_ID, rollback);
    expect(requestMock).toHaveBeenLastCalledWith(
      `/admin/role-blueprints/${BLUEPRINT_ID}/versions/${VERSION_ID}/rollback`,
      {
        method: 'POST',
        body: rollbackRoleVersionRequestSchema.parse(rollback),
        schema: rollbackRoleVersionResponseSchema,
      },
    );
  });

  it('rejects invalid structured definitions before issuing a request', async () => {
    expect(() =>
      createRoleBlueprint({
        ...blueprintInput,
        responsibilities: [],
      }),
    ).toThrow();
    expect(requestMock).not.toHaveBeenCalled();
  });
});
