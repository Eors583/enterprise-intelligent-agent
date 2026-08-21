import type {
  AdminOrganizationResponse,
  KnowledgeBase,
  KnowledgeSpaceSelection,
  KnowledgeSpaceType,
} from '@enterprise/contracts';
import { useId, type ReactNode } from 'react';

import { orgUnitPath } from '@/components/knowledge/knowledge-view-model';

import { KNOWLEDGE_SPACE_ROOTS } from './knowledge-space-tree';

export interface KnowledgeSpaceDraft {
  readonly type: KnowledgeSpaceType;
  readonly targetId: string;
  readonly targetName: string;
}

export function companyKnowledgeSpaceDraft(
  organization?: AdminOrganizationResponse | null,
): KnowledgeSpaceDraft {
  return {
    type: 'COMPANY',
    targetId: organization?.organization.id ?? '',
    targetName: organization?.organization.name ?? '公司',
  };
}

export function knowledgeSpaceDraftFromBase(item: KnowledgeBase): KnowledgeSpaceDraft {
  return { ...item.space };
}

export function knowledgeSpaceSelectionFromDraft(
  draft: KnowledgeSpaceDraft,
): KnowledgeSpaceSelection {
  if (draft.type === 'COMPANY') return { type: 'COMPANY' };
  if (draft.type === 'DEPARTMENT' || draft.type === 'MEMBER') {
    return { type: draft.type, targetId: draft.targetId };
  }
  return {
    type: 'PROJECT',
    ...(draft.targetId.length === 0 ? {} : { targetId: draft.targetId }),
    targetName: draft.targetName.trim(),
  };
}

export function knowledgeSpaceDraftError(draft: KnowledgeSpaceDraft): string | null {
  if ((draft.type === 'DEPARTMENT' || draft.type === 'MEMBER') && draft.targetId.length === 0) {
    return draft.type === 'DEPARTMENT'
      ? '请选择知识存放部门。'
      : '当前登录账号无法作为成员知识的归属账号，请重新登录后重试。';
  }
  if (draft.type === 'PROJECT' && draft.targetName.trim().length === 0) {
    return '请选择已有项目知识空间，或填写新项目名称。';
  }
  return null;
}

export function KnowledgeSpacePicker({
  currentUserId,
  currentUserName,
  organization,
  knowledgeBases,
  value,
  disabled = false,
  onChange,
}: {
  currentUserId: string;
  currentUserName: string;
  organization: AdminOrganizationResponse | null | undefined;
  knowledgeBases: readonly KnowledgeBase[];
  value: KnowledgeSpaceDraft;
  disabled?: boolean;
  onChange: (value: KnowledgeSpaceDraft) => void;
}): ReactNode {
  const groupName = useId();
  const departments = [...(organization?.orgUnits ?? [])]
    .filter((unit) => unit.status === 'ACTIVE')
    .sort((left, right) =>
      orgUnitPath(organization?.orgUnits ?? [], left.id).localeCompare(
        orgUnitPath(organization?.orgUnits ?? [], right.id),
        'zh-CN',
      ),
    );
  const projects = [
    ...new Map(
      knowledgeBases
        .filter((item) => item.space.type === 'PROJECT')
        .map((item) => [item.space.targetId, item.space] as const),
    ).values(),
  ].sort((left, right) => left.targetName.localeCompare(right.targetName, 'zh-CN'));

  const changeType = (type: KnowledgeSpaceType): void => {
    if (type === 'COMPANY') {
      onChange(companyKnowledgeSpaceDraft(organization));
      return;
    }
    if (type === 'DEPARTMENT') {
      const first = departments[0];
      onChange({
        type,
        targetId: first?.id ?? '',
        targetName: first === undefined ? '' : orgUnitPath(organization?.orgUnits ?? [], first.id),
      });
      return;
    }
    if (type === 'MEMBER') {
      onChange({ type, targetId: currentUserId, targetName: currentUserName });
      return;
    }
    onChange({ type: 'PROJECT', targetId: '', targetName: '' });
  };

  return (
    <fieldset className="knowledge-space-picker" disabled={disabled}>
      <legend>知识存放位置</legend>
      <p>知识归属账号固定为当前登录账号。这里只选择资料存放在公司、部门、项目还是成员知识中。</p>
      <div className="knowledge-space-options">
        {KNOWLEDGE_SPACE_ROOTS.map((root) => (
          <label key={root.type} className={value.type === root.type ? 'selected' : ''}>
            <input
              type="radio"
              name={groupName}
              checked={value.type === root.type}
              onChange={() => changeType(root.type)}
            />
            <span className="knowledge-space-option-glyph" aria-hidden="true">
              {root.glyph}
            </span>
            <span>
              <strong>{root.label}</strong>
              <small>{root.description}</small>
            </span>
          </label>
        ))}
      </div>

      {value.type === 'COMPANY' ? (
        <p className="form-hint">
          将归入“{organization?.organization.name ?? '当前公司'}”，适合战略、经营目标和全员制度。
        </p>
      ) : null}

      {value.type === 'DEPARTMENT' ? (
        <label>
          <span>所属部门</span>
          <select
            value={value.targetId}
            onChange={(event) => {
              const unit = departments.find((candidate) => candidate.id === event.target.value);
              onChange({
                type: 'DEPARTMENT',
                targetId: event.target.value,
                targetName:
                  unit === undefined ? '' : orgUnitPath(organization?.orgUnits ?? [], unit.id),
              });
            }}
          >
            {departments.length === 0 ? <option value="">暂无可选部门</option> : null}
            {departments.map((unit) => (
              <option key={unit.id} value={unit.id}>
                {orgUnitPath(organization?.orgUnits ?? [], unit.id)}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {value.type === 'MEMBER' ? (
        <p className="form-hint">
          成员知识归入当前登录账号：{currentUserName}，不可代其他成员选择。
        </p>
      ) : null}

      {value.type === 'PROJECT' ? (
        <div className="form-grid two">
          <label>
            <span>项目空间</span>
            <select
              value={value.targetId.length === 0 ? '__new__' : value.targetId}
              onChange={(event) => {
                if (event.target.value === '__new__') {
                  onChange({ type: 'PROJECT', targetId: '', targetName: '' });
                  return;
                }
                const project = projects.find(
                  (candidate) => candidate.targetId === event.target.value,
                );
                onChange({
                  type: 'PROJECT',
                  targetId: event.target.value,
                  targetName: project?.targetName ?? '',
                });
              }}
            >
              <option value="__new__">新建项目知识空间</option>
              {projects.map((project) => (
                <option key={project.targetId} value={project.targetId}>
                  {project.targetName}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>项目名称</span>
            <input
              value={value.targetName}
              disabled={value.targetId.length > 0}
              onChange={(event) =>
                onChange({ type: 'PROJECT', targetId: '', targetName: event.target.value })
              }
              placeholder="例如 新一代员工工作台"
            />
          </label>
        </div>
      ) : null}
    </fieldset>
  );
}
