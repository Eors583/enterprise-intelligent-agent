import type {
  KnowledgeBase,
  ReviewRoleVersionRequest,
  RoleBlueprint,
  RoleVersion,
  RollbackRoleVersionResponse,
} from '@enterprise/contracts';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { ZodError } from 'zod';

import {
  createRoleVersionDraft,
  listKnowledgeBases,
  publishRoleVersion,
  retireRoleVersion,
  reviewRoleVersion,
  rollbackRoleVersion,
  submitRoleVersion,
  updateRoleVersionDraft,
} from '@/api/admin-api';
import { FieldError, Modal, Spinner } from '@/components/ui';

import { roleBlueprintErrorMessage } from './role-blueprint-view';

export function RoleVersionEditor({
  blueprint,
  version,
  sourceVersion,
  onClose,
  onSaved,
}: {
  blueprint: RoleBlueprint;
  version: RoleVersion | null;
  sourceVersion: RoleVersion | null;
  onClose: () => void;
  onSaved: (version: RoleVersion, created: boolean) => void;
}): ReactNode {
  const editing = version !== null;
  const inheritedVersion = version ?? sourceVersion;
  const [systemPrompt, setSystemPrompt] = useState(inheritedVersion?.systemPrompt ?? '');
  const modelPolicy = inheritedVersion?.modelPolicy ?? {};
  const toolPolicy = inheritedVersion?.toolPolicy ?? {};
  const knowledgeScope = inheritedVersion?.knowledgeScope ?? { knowledgeBaseIds: [] };
  const [knowledgeBaseIds, setKnowledgeBaseIds] = useState(() =>
    readKnowledgeBaseIds(knowledgeScope),
  );
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>([]);
  const [knowledgeLoading, setKnowledgeLoading] = useState(true);
  const [knowledgeError, setKnowledgeError] = useState<string | null>(null);
  const [changeSummary, setChangeSummary] = useState(version?.changeSummary ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void listKnowledgeBases(controller.signal)
      .then((response) => {
        setKnowledgeBases(response.items);
        setKnowledgeError(null);
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setKnowledgeError('知识库列表读取失败，请刷新后重试。');
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setKnowledgeLoading(false);
      });
    return () => controller.abort();
  }, []);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const configuration = {
        systemPrompt,
        modelPolicy,
        toolPolicy,
        knowledgeScope: { ...knowledgeScope, knowledgeBaseIds },
        changeSummary,
      };
      const saved =
        version === null
          ? await createRoleVersionDraft(blueprint.id, configuration)
          : await updateRoleVersionDraft(blueprint.id, version.id, {
              expectedRevision: version.revision,
              ...configuration,
            });
      onSaved(saved, version === null);
    } catch (caught) {
      setError(roleVersionFormError(caught));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title={editing ? `编辑 v${version.version} 草稿` : '创建版本草稿'}
      description={`为“${blueprint.name}”配置运行提示词与受治理策略。`}
      onClose={onClose}
      size="wide"
      dismissible={!submitting}
    >
      <form className="form-stack role-version-editor" onSubmit={(event) => void submit(event)}>
        {version?.reviewStatus === 'CHANGES_REQUESTED' ? (
          <div className="role-review-feedback">
            <strong>审核已退回</strong>
            <p>{version.reviewComment ?? '审核人未提供说明。'}</p>
            <span>保存后审核状态会重置为“未提交”，可再次提审。</span>
          </div>
        ) : null}
        <label>
          <span>系统提示词</span>
          <textarea
            autoFocus
            required
            className="role-system-prompt"
            minLength={20}
            maxLength={20_000}
            value={systemPrompt}
            onChange={(event) => setSystemPrompt(event.target.value)}
            placeholder="至少 20 个字符，明确角色目标、边界、升级与安全要求"
          />
        </label>
        <fieldset className="agent-knowledge-options">
          <legend>企业知识库</legend>
          <p className="form-hint">
            选择该角色的智能体回答时可以检索的知识库。员工仍只能看到自身权限范围内的文档。
          </p>
          {knowledgeLoading ? <Spinner label="正在读取知识库…" /> : null}
          {knowledgeBases
            .filter((item) => item.status === 'ACTIVE' || knowledgeBaseIds.includes(item.id))
            .map((item) => (
              <label key={item.id} className="agent-knowledge-option">
                <input
                  type="checkbox"
                  checked={knowledgeBaseIds.includes(item.id)}
                  disabled={item.status !== 'ACTIVE'}
                  onChange={(event) =>
                    setKnowledgeBaseIds((current) =>
                      event.target.checked
                        ? [...new Set([...current, item.id])]
                        : current.filter((id) => id !== item.id),
                    )
                  }
                />
                <span>{item.name}</span>
                <small>
                  {item.documentCount} 篇文档{item.status === 'ACTIVE' ? '' : ' · 已停用'}
                </small>
              </label>
            ))}
          {!knowledgeLoading && knowledgeBases.every((item) => item.status !== 'ACTIVE') ? (
            <p className="form-hint">请先在知识中心启用至少一个已完成语义索引的知识库。</p>
          ) : null}
          <FieldError message={knowledgeError} />
        </fieldset>
        <label>
          <span>变更摘要</span>
          <input
            required
            value={changeSummary}
            maxLength={500}
            onChange={(event) => setChangeSummary(event.target.value)}
            placeholder="说明本版本相较此前版本的变化"
          />
        </label>
        <p className="role-policy-note">
          模型、工具和知识范围请在智能体中心使用选择器绑定；创建新草稿时使用安全默认策略，编辑草稿时保留已绑定策略。
        </p>
        <FieldError message={error} />
        <div className="modal-actions">
          <button
            className="button secondary"
            type="button"
            onClick={onClose}
            disabled={submitting}
          >
            取消
          </button>
          <button
            className="button primary"
            type="submit"
            disabled={submitting || !changeSummary.trim()}
          >
            {submitting ? <Spinner label="正在保存…" /> : editing ? '保存草稿' : '创建草稿'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function readKnowledgeBaseIds(scope: Record<string, unknown>): string[] {
  return Array.isArray(scope.knowledgeBaseIds)
    ? [
        ...new Set(
          scope.knowledgeBaseIds.filter((value): value is string => typeof value === 'string'),
        ),
      ].slice(0, 50)
    : [];
}

export function RoleVersionReviewModal({
  blueprint,
  version,
  onClose,
  onSaved,
}: {
  blueprint: RoleBlueprint;
  version: RoleVersion;
  onClose: () => void;
  onSaved: (version: RoleVersion) => void;
}): ReactNode {
  const [decision, setDecision] = useState<ReviewRoleVersionRequest['decision']>('APPROVE');
  const [comment, setComment] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      onSaved(
        await reviewRoleVersion(blueprint.id, version.id, {
          expectedRevision: version.revision,
          decision,
          comment,
        }),
      );
    } catch (caught) {
      setError(roleBlueprintErrorMessage(caught));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title={`审核 ${blueprint.name} v${version.version}`}
      description="审核决定会记录审核人、时间与意见，并受双人审批约束。"
      onClose={onClose}
      dismissible={!submitting}
    >
      <form className="form-stack" onSubmit={(event) => void submit(event)}>
        <div className="role-two-person-callout">
          <strong>双人审批</strong>
          <p>版本作者不能审核自己的版本；审批人与作者必须是不同账号。</p>
        </div>
        <fieldset className="role-review-decisions">
          <legend>审核决定</legend>
          <label className={decision === 'APPROVE' ? 'selected' : ''}>
            <input
              type="radio"
              name="decision"
              value="APPROVE"
              checked={decision === 'APPROVE'}
              onChange={() => setDecision('APPROVE')}
            />
            <span>
              <strong>批准</strong>
              <small>版本进入可发布状态，但不会自动发布。</small>
            </span>
          </label>
          <label className={decision === 'REQUEST_CHANGES' ? 'selected danger' : ''}>
            <input
              type="radio"
              name="decision"
              value="REQUEST_CHANGES"
              checked={decision === 'REQUEST_CHANGES'}
              onChange={() => setDecision('REQUEST_CHANGES')}
            />
            <span>
              <strong>退回修改</strong>
              <small>版本返回草稿，作者修改后需要重新提交。</small>
            </span>
          </label>
        </fieldset>
        <label>
          <span>审核意见</span>
          <textarea
            autoFocus
            required
            maxLength={1_000}
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            placeholder={
              decision === 'APPROVE' ? '说明核验范围和批准依据' : '明确指出需要修改的内容'
            }
          />
        </label>
        <FieldError message={error} />
        <div className="modal-actions">
          <button
            className="button secondary"
            type="button"
            onClick={onClose}
            disabled={submitting}
          >
            取消
          </button>
          <button
            className={`button ${decision === 'APPROVE' ? 'primary' : 'danger'}`}
            type="submit"
            disabled={submitting}
          >
            {submitting ? (
              <Spinner label="正在提交…" />
            ) : decision === 'APPROVE' ? (
              '确认批准'
            ) : (
              '确认退回'
            )}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export type RoleVersionTransitionAction = 'submit' | 'publish' | 'retire';

export function RoleVersionTransitionModal({
  blueprint,
  version,
  action,
  onClose,
  onSaved,
}: {
  blueprint: RoleBlueprint;
  version: RoleVersion;
  action: RoleVersionTransitionAction;
  onClose: () => void;
  onSaved: (version: RoleVersion) => void;
}): ReactNode {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const copy = transitionCopy(action, blueprint, version);

  const submit = async (): Promise<void> => {
    setSubmitting(true);
    setError(null);
    try {
      const input = { expectedRevision: version.revision };
      const saved =
        action === 'submit'
          ? await submitRoleVersion(blueprint.id, version.id, input)
          : action === 'publish'
            ? await publishRoleVersion(blueprint.id, version.id, input)
            : await retireRoleVersion(blueprint.id, version.id, input);
      onSaved(saved);
    } catch (caught) {
      setError(roleBlueprintErrorMessage(caught));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title={copy.title}
      description={copy.description}
      onClose={onClose}
      dismissible={!submitting}
    >
      <div className={`role-transition-summary ${action}`}>
        <strong>
          {blueprint.name} · v{version.version}
        </strong>
        <p>{copy.impact}</p>
      </div>
      <FieldError message={error} />
      <div className="modal-actions">
        <button className="button secondary" type="button" onClick={onClose} disabled={submitting}>
          取消
        </button>
        <button
          className={`button ${action === 'retire' ? 'danger' : 'primary'}`}
          type="button"
          onClick={() => void submit()}
          disabled={submitting}
        >
          {submitting ? <Spinner label="正在处理…" /> : copy.confirm}
        </button>
      </div>
    </Modal>
  );
}

export function RoleVersionRollbackModal({
  blueprint,
  sourceVersion,
  expectedPublishedVersionId,
  onClose,
  onSaved,
}: {
  blueprint: RoleBlueprint;
  sourceVersion: RoleVersion;
  expectedPublishedVersionId: string | null;
  onClose: () => void;
  onSaved: (version: RollbackRoleVersionResponse) => void;
}): ReactNode {
  const [changeSummary, setChangeSummary] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      onSaved(
        await rollbackRoleVersion(blueprint.id, sourceVersion.id, {
          expectedPublishedVersionId,
          changeSummary,
        }),
      );
    } catch (caught) {
      setError(roleBlueprintErrorMessage(caught));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title={`基于 v${sourceVersion.version} 创建回滚草稿`}
      description="回滚只会复制该历史配置并创建一个未提交审核的草稿，不会改写旧版本，也不会直接发布。"
      onClose={onClose}
      dismissible={!submitting}
    >
      <form className="form-stack" onSubmit={(event) => void submit(event)}>
        <div className="role-transition-summary rollback">
          <strong>{blueprint.name}</strong>
          <p>
            当前已发布版本保持不变。创建后请确认草稿并提交审核，由另一位企业所有者或管理员审批，再单独发布。
          </p>
        </div>
        <label>
          <span>回滚说明</span>
          <textarea
            autoFocus
            required
            maxLength={500}
            value={changeSummary}
            onChange={(event) => setChangeSummary(event.target.value)}
            placeholder="说明回滚原因、风险与后续处理计划"
          />
        </label>
        <FieldError message={error} />
        <div className="modal-actions">
          <button
            className="button secondary"
            type="button"
            onClick={onClose}
            disabled={submitting}
          >
            取消
          </button>
          <button
            className="button primary"
            type="submit"
            disabled={submitting || !changeSummary.trim()}
          >
            {submitting ? <Spinner label="正在创建草稿…" /> : '创建回滚草稿'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function transitionCopy(
  action: RoleVersionTransitionAction,
  blueprint: RoleBlueprint,
  version: RoleVersion,
): { title: string; description: string; impact: string; confirm: string } {
  if (action === 'submit') {
    return {
      title: `提交 v${version.version} 审核`,
      description: `提交“${blueprint.name}”的版本草稿进入独立审核。`,
      impact: '提交后该版本暂不可编辑；审核人必须使用另一个管理员账号。',
      confirm: '确认提交审核',
    };
  }
  if (action === 'publish') {
    return {
      title: `发布 v${version.version}`,
      description: '草稿或测试中的版本可直接发布；审核与评测不再阻塞初版验证。',
      impact:
        '发布会在同一事务中将此前版本标记为已退役，并成为新任命唯一可选版本；已绑定旧版本的现有任命仍按任命快照继续运行。',
      confirm: '确认发布',
    };
  }
  return {
    title: `停用 v${version.version}`,
    description: '停用已发布版本。',
    impact:
      '该版本将不再接受新任命。若仍存在待生效、生效中或已暂停的任命，服务端会拒绝停用；请先迁移或撤销这些任命。',
    confirm: '确认停用',
  };
}

function roleVersionFormError(error: unknown): string {
  if (error instanceof ZodError) {
    const issue = error.issues[0];
    const field = issue?.path.length ? `${issue.path.join('.')}：` : '';
    return `请检查版本配置。${field}${issue?.message ?? '字段不符合契约。'}`;
  }
  return roleBlueprintErrorMessage(error);
}
