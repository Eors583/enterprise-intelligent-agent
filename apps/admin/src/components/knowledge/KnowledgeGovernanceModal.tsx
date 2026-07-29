import type {
  KnowledgeDocumentSummary,
  KnowledgeDocumentVersionSummary,
  KnowledgeDocumentGovernancePolicy,
} from '@enterprise/contracts';
import { useMemo, useState, type FormEvent, type ReactNode } from 'react';

import {
  reviewKnowledgeDocumentGovernance,
  updateKnowledgeDocumentVersionGovernance,
} from '@/api/admin-api';
import { messageFromError } from '@/api/client';
import { FieldError, Modal, Spinner, StatusPill } from '@/components/ui';

function listText(values: readonly string[]): string {
  return values.join('\n');
}

function parseList(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[\s,，;；]+/u)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ].sort();
}

function localDateTime(value: string | null): string {
  if (value === null) return '';
  const date = new Date(value);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function isoDateTime(value: string): string {
  if (value.trim() === '') return value;
  return new Date(value).toISOString();
}

export function KnowledgeGovernanceModal({
  knowledgeBaseId,
  document,
  version,
  onClose,
  onChanged,
}: {
  knowledgeBaseId: string;
  document: KnowledgeDocumentSummary;
  version: KnowledgeDocumentVersionSummary;
  onClose: () => void;
  onChanged: (message: string) => void;
}): ReactNode {
  const initial = version.governance;
  const [ownerUserId, setOwnerUserId] = useState(initial.ownerUserId);
  const [classification, setClassification] = useState<
    KnowledgeDocumentGovernancePolicy['classification']
  >(initial.classification);
  const [scopeMode, setScopeMode] = useState<KnowledgeDocumentGovernancePolicy['scopeMode']>(
    initial.scopeMode,
  );
  const [organizationScopeIds, setOrganizationScopeIds] = useState(
    listText(initial.organizationScopeIds),
  );
  const [projectScopeIds, setProjectScopeIds] = useState(listText(initial.projectScopeIds));
  const [taskScopeIds, setTaskScopeIds] = useState(listText(initial.taskScopeIds));
  const [roleTemplateScopeIds, setRoleTemplateScopeIds] = useState(
    listText(initial.roleTemplateScopeIds),
  );
  const [dataLabels, setDataLabels] = useState(listText(initial.dataLabels));
  const [effectiveFrom, setEffectiveFrom] = useState(localDateTime(initial.effectiveFrom));
  const [expiresAt, setExpiresAt] = useState(localDateTime(initial.expiresAt));
  const [retentionUntil, setRetentionUntil] = useState(localDateTime(initial.retentionUntil));
  const [retentionAction, setRetentionAction] = useState<
    KnowledgeDocumentGovernancePolicy['retentionAction']
  >(initial.retentionAction);
  const [supersedesVersionId, setSupersedesVersionId] = useState(initial.supersedesVersionId ?? '');
  const [reviewNote, setReviewNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const published = version.publishedAt !== null;
  const restricted = scopeMode === 'RESTRICTED';
  const policy = useMemo<KnowledgeDocumentGovernancePolicy>(
    () => ({
      ownerUserId: ownerUserId.trim(),
      classification,
      scopeMode,
      organizationScopeIds: restricted ? parseList(organizationScopeIds) : [],
      projectScopeIds: restricted ? parseList(projectScopeIds) : [],
      taskScopeIds: restricted ? parseList(taskScopeIds) : [],
      roleTemplateScopeIds: restricted ? parseList(roleTemplateScopeIds) : [],
      dataLabels: restricted ? parseList(dataLabels) : [],
      effectiveFrom: isoDateTime(effectiveFrom),
      expiresAt: expiresAt === '' ? null : isoDateTime(expiresAt),
      retentionUntil: retentionUntil === '' ? null : isoDateTime(retentionUntil),
      retentionAction,
      supersedesVersionId: supersedesVersionId.trim() === '' ? null : supersedesVersionId.trim(),
    }),
    [
      classification,
      dataLabels,
      effectiveFrom,
      expiresAt,
      organizationScopeIds,
      ownerUserId,
      projectScopeIds,
      restricted,
      retentionAction,
      retentionUntil,
      roleTemplateScopeIds,
      scopeMode,
      supersedesVersionId,
      taskScopeIds,
    ],
  );

  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await updateKnowledgeDocumentVersionGovernance(knowledgeBaseId, document.id, version.id, {
        expectedRevision: initial.revision,
        policy,
      });
      onChanged(`“${document.title}”v${version.versionNumber} 的治理策略已更新，需重新独立审核。`);
      onClose();
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setSubmitting(false);
    }
  };

  const review = async (decision: 'APPROVE' | 'REJECT'): Promise<void> => {
    if (decision === 'REJECT' && reviewNote.trim() === '') {
      setError('驳回时必须填写审核意见。');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await reviewKnowledgeDocumentGovernance(knowledgeBaseId, document.id, version.id, {
        decision,
        expectedRevision: initial.revision,
        ...(reviewNote.trim() === '' ? {} : { note: reviewNote.trim() }),
      });
      onChanged(
        `“${document.title}”v${version.versionNumber} 的治理策略已${decision === 'APPROVE' ? '批准' : '驳回'}。`,
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
      title={`知识治理 · “${document.title}” v${version.versionNumber}`}
      description="访问策略固化在文档版本上；缺失、未审核、未生效或已过期的策略不会进入关键词、向量或关系召回。"
      onClose={onClose}
      size="wide"
      dismissible={!submitting}
    >
      <form className="form-stack" onSubmit={(event) => void save(event)}>
        <div className="form-grid three">
          <label>
            <span>数据所有者用户 ID</span>
            <input
              value={ownerUserId}
              onChange={(event) => setOwnerUserId(event.target.value)}
              disabled={published}
              required
            />
          </label>
          <label>
            <span>数据分级</span>
            <select
              value={classification}
              onChange={(event) =>
                setClassification(
                  event.target.value as KnowledgeDocumentGovernancePolicy['classification'],
                )
              }
              disabled={published}
            >
              <option value="PUBLIC">公开</option>
              <option value="INTERNAL">内部</option>
              <option value="SENSITIVE">敏感</option>
              <option value="CONFIDENTIAL">机密</option>
            </select>
          </label>
          <label>
            <span>访问模式</span>
            <select
              value={scopeMode}
              onChange={(event) =>
                setScopeMode(event.target.value as KnowledgeDocumentGovernancePolicy['scopeMode'])
              }
              disabled={published}
            >
              <option value="TENANT">企业全员</option>
              <option value="RESTRICTED">按范围授权</option>
            </select>
          </label>
        </div>
        {restricted ? (
          <div className="form-grid two">
            <label>
              <span>组织 / 部门 ID（每行一个）</span>
              <textarea
                value={organizationScopeIds}
                onChange={(event) => setOrganizationScopeIds(event.target.value)}
                disabled={published}
                rows={4}
              />
            </label>
            <label>
              <span>项目 ID（每行一个）</span>
              <textarea
                value={projectScopeIds}
                onChange={(event) => setProjectScopeIds(event.target.value)}
                disabled={published}
                rows={4}
              />
            </label>
            <label>
              <span>任务 ID（每行一个）</span>
              <textarea
                value={taskScopeIds}
                onChange={(event) => setTaskScopeIds(event.target.value)}
                disabled={published}
                rows={4}
              />
            </label>
            <label>
              <span>角色模板 ID（每行一个）</span>
              <textarea
                value={roleTemplateScopeIds}
                onChange={(event) => setRoleTemplateScopeIds(event.target.value)}
                disabled={published}
                rows={4}
              />
            </label>
            <label>
              <span>数据标签（每行一个）</span>
              <textarea
                value={dataLabels}
                onChange={(event) => setDataLabels(event.target.value)}
                disabled={published}
                rows={4}
                placeholder="例如 CLASSIFICATION:SENSITIVE"
              />
            </label>
          </div>
        ) : null}
        <div className="form-grid three">
          <label>
            <span>生效时间</span>
            <input
              type="datetime-local"
              value={effectiveFrom}
              onChange={(event) => setEffectiveFrom(event.target.value)}
              disabled={published}
              required
            />
          </label>
          <label>
            <span>失效时间（可选）</span>
            <input
              type="datetime-local"
              value={expiresAt}
              onChange={(event) => setExpiresAt(event.target.value)}
              disabled={published}
            />
          </label>
          <label>
            <span>保留期限（可选）</span>
            <input
              type="datetime-local"
              value={retentionUntil}
              onChange={(event) => setRetentionUntil(event.target.value)}
              disabled={published}
            />
          </label>
          <label>
            <span>到期动作</span>
            <select
              value={retentionAction}
              onChange={(event) =>
                setRetentionAction(
                  event.target.value as KnowledgeDocumentGovernancePolicy['retentionAction'],
                )
              }
              disabled={published}
            >
              <option value="ARCHIVE">归档</option>
              <option value="REVIEW_DELETE">人工复核删除</option>
              <option value="LEGAL_HOLD">法务留存</option>
            </select>
          </label>
          <label>
            <span>替代版本 ID（可选）</span>
            <input
              value={supersedesVersionId}
              onChange={(event) => setSupersedesVersionId(event.target.value)}
              disabled={published}
            />
          </label>
        </div>
        <div className="knowledge-governance-review">
          <div>
            <strong>治理审核</strong>
            <StatusPill value={initial.reviewStatus} label={initial.reviewStatus} />
            <small>
              修订 {initial.revision} · 策略哈希 {initial.policyHash.slice(0, 12)}…
            </small>
          </div>
          {!published && initial.reviewStatus === 'PENDING' ? (
            <>
              <label>
                <span>审核意见</span>
                <textarea
                  value={reviewNote}
                  onChange={(event) => setReviewNote(event.target.value)}
                  rows={3}
                  maxLength={2_000}
                  placeholder="批准可选；驳回必填。创建人和数据所有者不能自审。"
                />
              </label>
              <div className="modal-actions">
                <button
                  className="button danger-ghost"
                  type="button"
                  disabled={submitting}
                  onClick={() => void review('REJECT')}
                >
                  驳回策略
                </button>
                <button
                  className="button secondary"
                  type="button"
                  disabled={submitting}
                  onClick={() => void review('APPROVE')}
                >
                  独立批准
                </button>
              </div>
            </>
          ) : null}
        </div>
        <FieldError message={error} />
        <div className="modal-actions">
          <button
            className="button secondary"
            type="button"
            onClick={onClose}
            disabled={submitting}
          >
            关闭
          </button>
          {!published ? (
            <button className="button primary" type="submit" disabled={submitting}>
              {submitting ? <Spinner label="保存中…" /> : '保存策略并重新送审'}
            </button>
          ) : null}
        </div>
      </form>
    </Modal>
  );
}
