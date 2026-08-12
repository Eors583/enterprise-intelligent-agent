import type {
  AdminOrganizationResponse,
  KnowledgeBase,
  KnowledgeDocumentSummary,
  KnowledgeDocumentVersionSummary,
} from '@enterprise/contracts';
import { useState, type FormEvent, type ReactNode } from 'react';

import { updateKnowledgeDocumentAccess } from '@/api/admin-api';
import { messageFromError } from '@/api/client';
import { FieldError, Modal, Notice, Spinner } from '@/components/ui';
import {
  KnowledgeAccessPicker,
  knowledgeAccessError,
  type KnowledgeAccessMode,
} from '@/features/knowledge/KnowledgeAccessPicker';

const MEMBER_LABEL_PREFIX = 'USER:';

export function KnowledgeDocumentAccessModal({
  knowledgeBase,
  document,
  version,
  organization,
  onClose,
  onChanged,
}: {
  knowledgeBase: Pick<KnowledgeBase, 'id' | 'name' | 'orgUnitScopes' | 'memberUserIds'>;
  document: KnowledgeDocumentSummary;
  version: KnowledgeDocumentVersionSummary;
  organization: AdminOrganizationResponse;
  onClose: () => void;
  onChanged: (message: string) => void;
}): ReactNode {
  const initialMemberUserIds = version.governance.dataLabels
    .filter((label) => label.startsWith(MEMBER_LABEL_PREFIX))
    .map((label) => label.slice(MEMBER_LABEL_PREFIX.length));
  const initialOrgUnitIds = version.governance.organizationScopeIds.filter((id) =>
    organization.orgUnits.some((unit) => unit.id === id),
  );
  const [mode, setMode] = useState<KnowledgeAccessMode>(
    initialOrgUnitIds.length > 0 || initialMemberUserIds.length > 0 ? 'RESTRICTED' : 'ENTERPRISE',
  );
  const [orgUnitScopes, setOrgUnitScopes] = useState(
    initialOrgUnitIds.map((orgUnitId) => ({ orgUnitId, includeChildren: true })),
  );
  const [memberUserIds, setMemberUserIds] = useState(initialMemberUserIds);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const accessProblem = knowledgeAccessError(mode, orgUnitScopes, memberUserIds);
    if (accessProblem !== null) {
      setError(accessProblem);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await updateKnowledgeDocumentAccess(knowledgeBase.id, document.id, {
        mode: mode === 'ENTERPRISE' ? 'INHERIT' : 'RESTRICTED',
        orgUnitIds: mode === 'ENTERPRISE' ? [] : orgUnitScopes.map((scope) => scope.orgUnitId),
        memberUserIds: mode === 'ENTERPRISE' ? [] : memberUserIds,
        expectedGovernanceRevision: version.governance.revision,
      });
      onChanged(
        mode === 'ENTERPRISE'
          ? `“${document.title}”已恢复继承知识库访问范围。`
          : `“${document.title}”的访问范围已收紧。`,
      );
      onClose();
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title="权限变更"
      description={`设置“${document.title}”的访问范围。`}
      onClose={onClose}
      size="wide"
      dismissible={!submitting}
    >
      <form className="form-stack" onSubmit={(event) => void submit(event)}>
        <Notice tone="info">
          文档权限只能在“{knowledgeBase.name}”的访问范围内进一步收紧，不能扩大知识库权限。
          最终访问结果始终取知识库权限与文档权限的交集。
        </Notice>
        <KnowledgeAccessPicker
          organization={organization}
          mode={mode}
          orgUnitScopes={orgUnitScopes}
          memberUserIds={memberUserIds}
          disabled={submitting}
          legend="这篇文档允许谁使用"
          description="权限会在关键词、向量、关系检索和引用读取前由服务端统一校验。"
          enterpriseLabel="继承知识库访问范围"
          restrictedLabel="进一步限制到指定部门或成员"
          enterpriseHint={`当前继承“${knowledgeBase.name}”的统一访问范围。`}
          departmentHint="选择部门后自动包含其下级部门"
          includeChildrenEditable={false}
          onModeChange={setMode}
          onOrgUnitScopesChange={setOrgUnitScopes}
          onMemberUserIdsChange={setMemberUserIds}
        />
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
          <button className="button primary" type="submit" disabled={submitting}>
            {submitting ? <Spinner label="正在保存…" /> : '保存权限'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
