import type { AdminOrganizationResponse, KnowledgeBaseOrgUnitScope } from '@enterprise/contracts';
import { useId, useMemo, useState, type ReactNode } from 'react';

import { orgUnitPath } from '@/components/knowledge/knowledge-view-model';

export type KnowledgeAccessMode = 'ENTERPRISE' | 'RESTRICTED';

export function knowledgeAccessMode(
  orgUnitScopes: readonly KnowledgeBaseOrgUnitScope[],
  memberUserIds: readonly string[],
): KnowledgeAccessMode {
  return orgUnitScopes.length === 0 && memberUserIds.length === 0 ? 'ENTERPRISE' : 'RESTRICTED';
}

export function knowledgeAccessError(
  mode: KnowledgeAccessMode,
  orgUnitScopes: readonly KnowledgeBaseOrgUnitScope[],
  memberUserIds: readonly string[],
): string | null {
  return mode === 'RESTRICTED' && orgUnitScopes.length === 0 && memberUserIds.length === 0
    ? '请选择至少一个可访问部门或成员，或改为全公司成员可访问。'
    : null;
}

export function knowledgeAccessSummary(
  orgUnitScopes: readonly KnowledgeBaseOrgUnitScope[],
  memberUserIds: readonly string[],
): string {
  if (orgUnitScopes.length === 0 && memberUserIds.length === 0) return '全公司成员可访问';
  const parts: string[] = [];
  if (orgUnitScopes.length > 0) parts.push(`${orgUnitScopes.length} 个部门`);
  if (memberUserIds.length > 0) parts.push(`${memberUserIds.length} 名指定成员`);
  return `${parts.join(' + ')}可访问`;
}

export function KnowledgeAccessPicker({
  organization,
  mode,
  orgUnitScopes,
  memberUserIds,
  disabled,
  legend = '谁可以让智能体使用这些知识',
  description = '访问范围会在每次智能体检索前由服务端校验。存放位置决定资料放在哪里，访问范围决定谁能用。',
  enterpriseLabel = '全公司成员可访问',
  restrictedLabel = '仅指定部门或成员可访问',
  enterpriseHint = '知识库启用且文档处理完成后，所有具有有效任职关系的公司成员智能体均可检索。',
  departmentHint = '可选择是否包含下级部门',
  includeChildrenEditable = true,
  onModeChange,
  onOrgUnitScopesChange,
  onMemberUserIdsChange,
}: {
  organization: AdminOrganizationResponse | null;
  mode: KnowledgeAccessMode;
  orgUnitScopes: readonly KnowledgeBaseOrgUnitScope[];
  memberUserIds: readonly string[];
  disabled: boolean;
  legend?: string;
  description?: string;
  enterpriseLabel?: string;
  restrictedLabel?: string;
  enterpriseHint?: string;
  departmentHint?: string;
  includeChildrenEditable?: boolean;
  onModeChange: (mode: KnowledgeAccessMode) => void;
  onOrgUnitScopesChange: (scopes: KnowledgeBaseOrgUnitScope[]) => void;
  onMemberUserIdsChange: (userIds: string[]) => void;
}): ReactNode {
  const groupName = useId();
  const [departmentQuery, setDepartmentQuery] = useState('');
  const [memberQuery, setMemberQuery] = useState('');
  const units = organization?.orgUnits ?? [];

  const activeUnits = useMemo(() => {
    const query = departmentQuery.trim().toLocaleLowerCase('zh-CN');
    return units
      .filter((unit) => unit.status === 'ACTIVE')
      .filter((unit) => orgUnitPath(units, unit.id).toLocaleLowerCase('zh-CN').includes(query))
      .sort((left, right) =>
        orgUnitPath(units, left.id).localeCompare(orgUnitPath(units, right.id), 'zh-CN'),
      );
  }, [departmentQuery, units]);

  const activeMembers = useMemo(() => {
    const query = memberQuery.trim().toLocaleLowerCase('zh-CN');
    return (organization?.members ?? [])
      .filter(
        (member) =>
          member.status === 'ACTIVE' &&
          member.employment?.status === 'ACTIVE' &&
          units.some(
            (unit) => unit.id === member.employment?.orgUnitId && unit.status === 'ACTIVE',
          ),
      )
      .filter((member) => {
        const department =
          member.employment === null ? '' : orgUnitPath(units, member.employment.orgUnitId);
        return `${member.displayName} ${member.email} ${department}`
          .toLocaleLowerCase('zh-CN')
          .includes(query);
      })
      .sort((left, right) => left.displayName.localeCompare(right.displayName, 'zh-CN'));
  }, [memberQuery, organization?.members, units]);

  const toggleOrgUnit = (orgUnitId: string): void => {
    const selected = orgUnitScopes.some((scope) => scope.orgUnitId === orgUnitId);
    onOrgUnitScopesChange(
      selected
        ? orgUnitScopes.filter((scope) => scope.orgUnitId !== orgUnitId)
        : [...orgUnitScopes, { orgUnitId, includeChildren: true }],
    );
  };
  const toggleMember = (userId: string): void => {
    onMemberUserIdsChange(
      memberUserIds.includes(userId)
        ? memberUserIds.filter((candidate) => candidate !== userId)
        : [...memberUserIds, userId],
    );
  };

  return (
    <fieldset className="scope-picker knowledge-access-picker" disabled={disabled}>
      <legend>{legend}</legend>
      <p>{description}</p>
      <div className="scope-mode-options">
        <label>
          <input
            type="radio"
            name={groupName}
            checked={mode === 'ENTERPRISE'}
            onChange={() => {
              onModeChange('ENTERPRISE');
              onOrgUnitScopesChange([]);
              onMemberUserIdsChange([]);
            }}
          />
          <span>{enterpriseLabel}</span>
        </label>
        <label>
          <input
            type="radio"
            name={groupName}
            checked={mode === 'RESTRICTED'}
            onChange={() => onModeChange('RESTRICTED')}
          />
          <span>{restrictedLabel}</span>
        </label>
      </div>

      {disabled ? (
        <span className="inline-empty">组织与成员尚未读取完成，当前访问范围不会被改写。</span>
      ) : mode === 'ENTERPRISE' ? (
        <span className="form-hint">{enterpriseHint}</span>
      ) : (
        <>
          <p className="knowledge-access-selection-summary" aria-live="polite">
            {orgUnitScopes.length === 0 && memberUserIds.length === 0
              ? '尚未选择可访问部门或成员'
              : knowledgeAccessSummary(orgUnitScopes, memberUserIds)}
            ；部门与成员按“满足任一条件”计算。
          </p>
          <div className="knowledge-access-columns">
            <section aria-label="可访问部门">
              <header>
                <strong>可访问部门</strong>
                <small>{departmentHint}</small>
              </header>
              <input
                value={departmentQuery}
                onChange={(event) => setDepartmentQuery(event.target.value)}
                placeholder="搜索部门"
                aria-label="搜索可访问部门"
              />
              <div className="checkbox-grid knowledge-access-options">
                {activeUnits.map((unit) => {
                  const scope = orgUnitScopes.find((candidate) => candidate.orgUnitId === unit.id);
                  return (
                    <div className="scope-picker-row" key={unit.id}>
                      <label>
                        <input
                          type="checkbox"
                          checked={scope !== undefined}
                          onChange={() => toggleOrgUnit(unit.id)}
                        />
                        <span>{orgUnitPath(units, unit.id)}</span>
                      </label>
                      {scope && includeChildrenEditable ? (
                        <label className="scope-picker-children">
                          <input
                            type="checkbox"
                            checked={scope.includeChildren}
                            onChange={(event) =>
                              onOrgUnitScopesChange(
                                orgUnitScopes.map((candidate) =>
                                  candidate.orgUnitId === unit.id
                                    ? { ...candidate, includeChildren: event.target.checked }
                                    : candidate,
                                ),
                              )
                            }
                          />
                          <span>包含下级部门</span>
                        </label>
                      ) : null}
                    </div>
                  );
                })}
                {activeUnits.length === 0 ? (
                  <span className="inline-empty">没有匹配部门</span>
                ) : null}
              </div>
            </section>

            <section aria-label="可访问成员">
              <header>
                <strong>可访问成员</strong>
                <small>适合跨部门协作或单独授权</small>
              </header>
              <input
                value={memberQuery}
                onChange={(event) => setMemberQuery(event.target.value)}
                placeholder="搜索姓名、邮箱或部门"
                aria-label="搜索可访问成员"
              />
              <div className="checkbox-grid knowledge-access-options">
                {activeMembers.map((member) => (
                  <label className="knowledge-access-member" key={member.id}>
                    <input
                      type="checkbox"
                      checked={memberUserIds.includes(member.id)}
                      onChange={() => toggleMember(member.id)}
                    />
                    <span>
                      <strong>{member.displayName}</strong>
                      <small>
                        {member.employment === null
                          ? member.email
                          : `${orgUnitPath(units, member.employment.orgUnitId)}${
                              member.employment.title ? ` · ${member.employment.title}` : ''
                            }`}
                      </small>
                    </span>
                  </label>
                ))}
                {activeMembers.length === 0 ? (
                  <span className="inline-empty">没有匹配成员</span>
                ) : null}
              </div>
            </section>
          </div>
        </>
      )}
    </fieldset>
  );
}
