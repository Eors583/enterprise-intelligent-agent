import type {
  RoleBlueprint,
  RoleVersion,
  RollbackRoleVersionResponse,
} from '@enterprise/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import * as adminApi from '@/api/admin-api';
import { renderInTestDom } from '@/test/dom-test-utils';

import { RoleVersionRollbackModal, RoleVersionTransitionModal } from './RoleVersionModals';

const BLUEPRINT_ID = '00000000-0000-7000-8000-000000000101';
const SOURCE_VERSION_ID = '00000000-0000-7000-8000-000000000102';
const PUBLISHED_VERSION_ID = '00000000-0000-7000-8000-000000000103';

describe('RoleVersionTransitionModal', () => {
  it('explains that publishing preserves existing immutable assignments', () => {
    const version = roleVersion({
      status: 'TESTING',
      reviewStatus: 'APPROVED',
    });
    const html = renderToStaticMarkup(
      createElement(RoleVersionTransitionModal, {
        blueprint: roleBlueprint(version),
        version,
        action: 'publish',
        onClose: vi.fn(),
        onSaved: vi.fn(),
      }),
    );

    expect(html).toContain('新任命唯一可选版本');
    expect(html).toContain('现有任命仍按任命快照继续运行');
  });

  it('warns that explicit retirement is blocked until pinned assignments are migrated', () => {
    const version = roleVersion({
      status: 'PUBLISHED',
      reviewStatus: 'APPROVED',
    });
    const html = renderToStaticMarkup(
      createElement(RoleVersionTransitionModal, {
        blueprint: roleBlueprint(version),
        version,
        action: 'retire',
        onClose: vi.fn(),
        onSaved: vi.fn(),
      }),
    );

    expect(html).toContain('服务端会拒绝停用');
    expect(html).toContain('先迁移或撤销这些任命');
  });
});

describe('RoleVersionRollbackModal', () => {
  it('explains that rollback creates a draft and preserves the current published version', () => {
    const sourceVersion = roleVersion({
      id: SOURCE_VERSION_ID,
      status: 'RETIRED',
      reviewStatus: 'APPROVED',
      publishedAt: '2026-07-20T00:00:00.000Z',
      retiredAt: '2026-07-22T00:00:00.000Z',
    });
    const html = renderToStaticMarkup(
      createElement(RoleVersionRollbackModal, {
        blueprint: roleBlueprint(sourceVersion),
        sourceVersion,
        expectedPublishedVersionId: PUBLISHED_VERSION_ID,
        onClose: vi.fn(),
        onSaved: vi.fn(),
      }),
    );

    expect(html).toContain('创建回滚草稿');
    expect(html).toContain('未提交审核的草稿');
    expect(html).toContain('当前已发布版本保持不变');
    expect(html).toContain('提交审核');
    expect(html).toContain('由另一位企业所有者或管理员审批');
    expect(html).toContain('再单独发布');
  });

  it('submits only a rollback draft through an accessible keyboard-dismissible dialog', async () => {
    const sourceVersion = roleVersion({
      id: SOURCE_VERSION_ID,
      status: 'RETIRED',
      reviewStatus: 'APPROVED',
      publishedAt: '2026-07-20T00:00:00.000Z',
      retiredAt: '2026-07-22T00:00:00.000Z',
    });
    const rollbackDraftBase = roleVersion({
      id: '00000000-0000-7000-8000-000000000104',
      version: 4,
      status: 'DRAFT',
      reviewStatus: 'NOT_SUBMITTED',
      rollbackOfVersionId: SOURCE_VERSION_ID,
    });
    if (rollbackDraftBase.roleDefinitionSnapshot === null) {
      throw new Error('Expected a structured rollback fixture.');
    }
    const rollbackDraft = {
      ...rollbackDraftBase,
      status: 'DRAFT' as const,
      reviewStatus: 'NOT_SUBMITTED' as const,
      rollbackOfVersionId: SOURCE_VERSION_ID,
      roleDefinitionSnapshot: rollbackDraftBase.roleDefinitionSnapshot,
    } satisfies RollbackRoleVersionResponse;
    const rollbackSpy = vi.spyOn(adminApi, 'rollbackRoleVersion').mockResolvedValue(rollbackDraft);
    const publishSpy = vi.spyOn(adminApi, 'publishRoleVersion');
    const onSaved = vi.fn();
    const onClose = vi.fn();
    const dom = await renderInTestDom(
      createElement(RoleVersionRollbackModal, {
        blueprint: roleBlueprint(sourceVersion),
        sourceVersion,
        expectedPublishedVersionId: PUBLISHED_VERSION_ID,
        onClose,
        onSaved,
      }),
    );

    try {
      const dialog = dom.container.querySelector('[role="dialog"]') as HTMLElement | null;
      const textarea = dom.container.querySelector('textarea') as HTMLTextAreaElement | null;
      const form = dom.container.querySelector('form') as HTMLFormElement | null;
      const submit = [...dom.container.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('创建回滚草稿'),
      ) as HTMLButtonElement | undefined;
      expect(dialog).not.toBeNull();
      expect(textarea).not.toBeNull();
      expect(form).not.toBeNull();
      expect(submit).toBeDefined();
      if (!dialog || !textarea || !form || !submit) return;

      const titleId = dialog.getAttribute('aria-labelledby');
      const descriptionId = dialog.getAttribute('aria-describedby');
      expect(dialog.getAttribute('aria-modal')).toBe('true');
      expect(titleId ? dom.document.getElementById(titleId)?.textContent : null).toContain(
        '创建回滚草稿',
      );
      expect(
        descriptionId ? dom.document.getElementById(descriptionId)?.textContent : null,
      ).toContain('不会直接发布');
      expect(textarea.closest('label')?.textContent).toContain('回滚说明');
      expect(textarea.hasAttribute('required')).toBe(true);
      expect(submit.hasAttribute('disabled')).toBe(true);
      expect(dialog.getAttribute('tabindex')).toBe('-1');

      await dom.change(textarea, '恢复上一稳定配置，并按正常审核流程发布。');
      expect(submit.hasAttribute('disabled')).toBe(false);
      await dom.submit(form);
      await dom.flush();

      expect(rollbackSpy).toHaveBeenCalledWith(BLUEPRINT_ID, SOURCE_VERSION_ID, {
        expectedPublishedVersionId: PUBLISHED_VERSION_ID,
        changeSummary: '恢复上一稳定配置，并按正常审核流程发布。',
      });
      expect(publishSpy).not.toHaveBeenCalled();
      expect(onSaved).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'DRAFT',
          reviewStatus: 'NOT_SUBMITTED',
          rollbackOfVersionId: SOURCE_VERSION_ID,
        }),
      );

      await dom.keydown(dialog, 'Escape');
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      await dom.cleanup();
    }
  });
});

function roleBlueprint(version: RoleVersion): RoleBlueprint {
  return {
    id: BLUEPRINT_ID,
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
    capabilities: [],
    processes: [],
    tools: [],
    knowledgeDomains: [],
    revision: 2,
    createdAt: '2026-07-20T00:00:00.000Z',
    updatedAt: '2026-07-22T00:00:00.000Z',
    versions: [version],
  };
}

function roleVersion(overrides: Partial<RoleVersion> = {}): RoleVersion {
  return {
    id: SOURCE_VERSION_ID,
    templateId: BLUEPRINT_ID,
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
    createdById: '00000000-0000-7000-8000-000000000001',
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
