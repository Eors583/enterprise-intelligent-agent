import { createEvidenceGuidedRequestSchema, type Evidence } from '@enterprise/contracts';
import { useState, type FormEvent, type ReactNode } from 'react';
import { ZodError } from 'zod';

import { messageFromError } from '@/api/client';
import { FieldError, Modal, Notice } from '@/components/ui';

import { createGuidedEvidence, transitionEvidence, updateEvidence } from './api';

type DraftTrustLevel = Exclude<Evidence['trustLevel'], 'VERIFIED'>;

export type EvidenceBusinessDialogState =
  | { readonly kind: 'create' }
  | { readonly kind: 'edit'; readonly evidence: Evidence }
  | {
      readonly kind: 'transition';
      readonly evidence: Evidence;
      readonly action: 'VERIFY' | 'REVOKE';
    };

export function EvidenceBusinessDialog({
  state,
  currentUserId,
  onClose,
  onSaved,
}: {
  state: EvidenceBusinessDialogState;
  currentUserId: string;
  onClose: () => void;
  onSaved: () => void;
}): ReactNode {
  if (state.kind === 'create') {
    return <CreateEvidenceDialog onClose={onClose} onSaved={onSaved} />;
  }
  if (state.kind === 'edit') {
    return <EditEvidenceDialog evidence={state.evidence} onClose={onClose} onSaved={onSaved} />;
  }
  return (
    <TransitionEvidenceDialog
      action={state.action}
      currentUserId={currentUserId}
      evidence={state.evidence}
      onClose={onClose}
      onSaved={onSaved}
    />
  );
}

function CreateEvidenceDialog({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}): ReactNode {
  const [sourceType, setSourceType] = useState<
    'BUSINESS_SYSTEM' | 'DOCUMENT' | 'HUMAN_ATTESTATION' | 'AGENT_RUN' | 'METRIC' | 'PROCESS_EVENT'
  >('DOCUMENT');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const data = new FormData(event.currentTarget as HTMLFormElement);
      const sourceUri = String(data.get('sourceUri') ?? '').trim();
      const retentionDays = String(data.get('retentionDays') ?? 'none');
      const input = createEvidenceGuidedRequestSchema.parse({
        sourceType: String(data.get('sourceType') ?? ''),
        sourceName: String(data.get('sourceName') ?? ''),
        sourceUri: sourceUri || null,
        observedAt: toIsoTimestamp(String(data.get('observedAt') ?? '')),
        summary: String(data.get('summary') ?? ''),
        trustLevel: String(data.get('trustLevel') ?? ''),
        retentionDays: retentionDays === 'none' ? null : Number(retentionDays),
      });
      await createGuidedEvidence(input);
      onSaved();
    } catch (caught) {
      setError(evidenceFormError(caught));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title="登记证据"
      description="填写业务来源和证据结论；技术标识与校验信息由系统生成。"
      onClose={onClose}
      dismissible={!submitting}
      size="wide"
    >
      <form className="form-stack evidence-business-form" onSubmit={(event) => void submit(event)}>
        <Notice tone="info">
          证据编码、来源记录标识、版本、内容校验值、所有者和权限范围都会由服务端生成或继承，无需手工填写。
        </Notice>

        <div className="form-grid two">
          <label>
            <span>来源类别</span>
            <select
              name="sourceType"
              aria-label="来源类别"
              value={sourceType}
              disabled={submitting}
              onChange={(event) => setSourceType(event.target.value as typeof sourceType)}
            >
              {SOURCE_TYPE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>初步可信程度</span>
            <select
              name="trustLevel"
              aria-label="初步可信程度"
              defaultValue="UNVERIFIED"
              disabled={submitting}
            >
              {DRAFT_TRUST_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <small>“已验证”必须通过后续独立验证动作产生，不能在登记时自行选择。</small>
          </label>
        </div>

        <label>
          <span>来源名称</span>
          <input
            name="sourceName"
            aria-label="来源名称"
            maxLength={500}
            required
            autoFocus
            disabled={submitting}
            placeholder={sourceNamePlaceholder(sourceType)}
          />
          <small>填写用户可识别的文档、系统记录、会议或运行结果名称，不需要复制对象 ID。</small>
        </label>

        <label>
          <span>来源链接（可选）</span>
          <input
            name="sourceUri"
            aria-label="来源链接"
            type="url"
            disabled={submitting}
            placeholder="https://…"
          />
        </label>

        <label>
          <span>证据摘要</span>
          <textarea
            name="summary"
            aria-label="证据摘要"
            rows={5}
            maxLength={20_000}
            required
            disabled={submitting}
            placeholder="说明这份证据证明了什么、适用于什么范围，以及需要注意的限制。"
          />
        </label>

        <div className="form-grid two">
          <label>
            <span>证据发生时间</span>
            <input
              name="observedAt"
              aria-label="证据发生时间"
              type="datetime-local"
              defaultValue={toLocalDateTimeInput(new Date())}
              required
              disabled={submitting}
            />
          </label>
          <label>
            <span>有效期限</span>
            <select
              name="retentionDays"
              aria-label="有效期限"
              defaultValue="none"
              disabled={submitting}
            >
              <option value="none">长期有效</option>
              <option value="30">30 天</option>
              <option value="90">90 天</option>
              <option value="365">1 年</option>
              <option value="730">2 年</option>
            </select>
          </label>
        </div>

        <FieldError message={error} />
        <footer className="modal-actions">
          <button
            className="button secondary"
            type="button"
            onClick={onClose}
            disabled={submitting}
          >
            取消
          </button>
          <button className="button primary" type="submit" disabled={submitting}>
            {submitting ? '正在登记…' : '登记证据'}
          </button>
        </footer>
      </form>
    </Modal>
  );
}

function EditEvidenceDialog({
  evidence,
  onClose,
  onSaved,
}: {
  evidence: Evidence;
  onClose: () => void;
  onSaved: () => void;
}): ReactNode {
  const initialTrust = evidence.trustLevel === 'VERIFIED' ? 'HIGH' : evidence.trustLevel;
  const [summary, setSummary] = useState(evidence.summary);
  const [trustLevel, setTrustLevel] = useState<DraftTrustLevel>(initialTrust);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const changed = summary.trim() !== evidence.summary || trustLevel !== evidence.trustLevel;

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await updateEvidence(evidence.id, {
        expectedRevision: evidence.revision,
        ...(summary.trim() === evidence.summary ? {} : { summary }),
        ...(trustLevel === evidence.trustLevel
          ? {}
          : { trustLevel, confidence: confidenceFor(trustLevel) }),
      });
      onSaved();
    } catch (caught) {
      setError(evidenceFormError(caught));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title="编辑证据说明"
      description="来源身份和系统校验信息保持不变，只调整业务说明与初步可信程度。"
      onClose={onClose}
      dismissible={!submitting}
    >
      <form className="form-stack evidence-business-form" onSubmit={(event) => void submit(event)}>
        <label>
          <span>证据摘要</span>
          <textarea
            aria-label="证据摘要"
            value={summary}
            rows={6}
            required
            disabled={submitting}
            onChange={(event) => setSummary(event.target.value)}
          />
        </label>
        <label>
          <span>初步可信程度</span>
          <select
            aria-label="初步可信程度"
            value={trustLevel}
            disabled={submitting}
            onChange={(event) => setTrustLevel(event.target.value as DraftTrustLevel)}
          >
            {DRAFT_TRUST_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <FieldError message={error} />
        <footer className="modal-actions">
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
            disabled={submitting || !changed || !summary.trim()}
          >
            {submitting ? '正在保存…' : '保存修改'}
          </button>
        </footer>
      </form>
    </Modal>
  );
}

function TransitionEvidenceDialog({
  evidence,
  action,
  currentUserId,
  onClose,
  onSaved,
}: {
  evidence: Evidence;
  action: 'VERIFY' | 'REVOKE';
  currentUserId: string;
  onClose: () => void;
  onSaved: () => void;
}): ReactNode {
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const verifying = action === 'VERIFY';

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const effectiveAt = new Date().toISOString();
      let expectedRevision = evidence.revision;
      if (verifying) {
        const prepared = await updateEvidence(evidence.id, {
          expectedRevision,
          trustLevel: 'VERIFIED',
          confidence: 1,
          verifiedBy: { type: 'USER', id: currentUserId },
          verifiedAt: effectiveAt,
        });
        expectedRevision = prepared.revision;
      }
      await transitionEvidence(evidence.id, {
        expectedRevision,
        action,
        reason,
        effectiveAt,
      });
      onSaved();
    } catch (caught) {
      setError(evidenceFormError(caught));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title={verifying ? '验证并生效证据' : '撤销证据'}
      description={
        verifying
          ? '系统将记录当前管理员为验证人，并保留验证时间和原因。'
          : '撤销后证据不再作为当前有效依据，历史记录仍会保留。'
      }
      onClose={onClose}
      dismissible={!submitting}
    >
      <form className="form-stack evidence-business-form" onSubmit={(event) => void submit(event)}>
        <Notice tone="info">
          {verifying
            ? '请确认你已经核对来源内容；系统生成的哈希和审计信息不会由表单修改。'
            : '这是治理状态变更，不会删除证据或审计历史。'}
        </Notice>
        <label>
          <span>{verifying ? '验证说明' : '撤销原因'}</span>
          <textarea
            aria-label={verifying ? '验证说明' : '撤销原因'}
            value={reason}
            rows={4}
            required
            disabled={submitting}
            placeholder={verifying ? '说明核对了哪些来源和关键事实。' : '说明撤销原因。'}
            onChange={(event) => setReason(event.target.value)}
          />
        </label>
        <FieldError message={error} />
        <footer className="modal-actions">
          <button
            className="button secondary"
            type="button"
            onClick={onClose}
            disabled={submitting}
          >
            取消
          </button>
          <button
            className={`button ${verifying ? 'primary' : 'danger'}`}
            type="submit"
            disabled={submitting || !reason.trim()}
          >
            {submitting ? '正在提交…' : verifying ? '确认验证并生效' : '确认撤销'}
          </button>
        </footer>
      </form>
    </Modal>
  );
}

const SOURCE_TYPE_OPTIONS = [
  { value: 'DOCUMENT', label: '文档或网页' },
  { value: 'BUSINESS_SYSTEM', label: '业务系统记录' },
  { value: 'HUMAN_ATTESTATION', label: '人员确认' },
  { value: 'AGENT_RUN', label: '智能体运行结果' },
  { value: 'METRIC', label: '指标数据' },
  { value: 'PROCESS_EVENT', label: '流程事件' },
] as const;

const DRAFT_TRUST_OPTIONS: ReadonlyArray<{
  readonly value: DraftTrustLevel;
  readonly label: string;
}> = [
  { value: 'UNVERIFIED', label: '待核验' },
  { value: 'LOW', label: '较低' },
  { value: 'MEDIUM', label: '一般' },
  { value: 'HIGH', label: '较高' },
];

function sourceNamePlaceholder(sourceType: (typeof SOURCE_TYPE_OPTIONS)[number]['value']): string {
  return {
    DOCUMENT: '例如：2026 年客户服务复盘',
    BUSINESS_SYSTEM: '例如：CRM 续约分析报表',
    HUMAN_ATTESTATION: '例如：客户成功负责人确认',
    AGENT_RUN: '例如：客户流失风险分析任务',
    METRIC: '例如：本月客户响应时长统计',
    PROCESS_EVENT: '例如：重点客户续约审批完成',
  }[sourceType];
}

function confidenceFor(trustLevel: DraftTrustLevel): number {
  return {
    HIGH: 0.85,
    MEDIUM: 0.65,
    LOW: 0.35,
    UNVERIFIED: 0.5,
  }[trustLevel];
}

function toLocalDateTimeInput(value: Date): string {
  const local = new Date(value.getTime() - value.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function toIsoTimestamp(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error('请选择有效的证据发生时间。');
  return new Date(timestamp).toISOString();
}

function evidenceFormError(error: unknown): string {
  if (error instanceof ZodError) {
    const issue = error.issues[0];
    return issue?.message ?? '请检查证据表单内容。';
  }
  return messageFromError(error);
}
