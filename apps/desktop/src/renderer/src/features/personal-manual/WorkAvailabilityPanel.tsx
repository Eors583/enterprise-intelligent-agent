import type {
  CollaborationDisclosureScope,
  MemberSummary,
  WorkAvailability,
  WorkAvailabilityStatus,
} from '@enterprise/contracts';
import { useEffect, useState, type FormEvent } from 'react';

import { getMyWorkAvailability, updateMyWorkAvailability } from './api';

interface AvailabilityDraft {
  status: WorkAvailabilityStatus;
  startsAt: string;
  endsAt: string;
  summary: string;
  expectedResponse: string;
  emergencyContactUserId: string;
  disclosureScope: CollaborationDisclosureScope;
}

export function WorkAvailabilityPanel({
  currentUserId,
  members,
  sharingEnabled,
}: {
  currentUserId: string;
  members: readonly MemberSummary[];
  sharingEnabled: boolean;
}): React.JSX.Element {
  const [availability, setAvailability] = useState<WorkAvailability | null>(null);
  const [draft, setDraft] = useState<AvailabilityDraft>(() => emptyDraft());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void getMyWorkAvailability(controller.signal)
      .then(({ availability: loaded }) => {
        setAvailability(loaded);
        setDraft(loaded === null ? emptyDraft() : availabilityToDraft(loaded));
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) setError(readableError(caught));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, []);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const result = await updateMyWorkAvailability({
        status: draft.status,
        startsAt: localDateTimeToIso(draft.startsAt),
        endsAt: draft.endsAt === '' ? null : localDateTimeToIso(draft.endsAt),
        summary: nullable(draft.summary),
        expectedResponse: nullable(draft.expectedResponse),
        emergencyContactUserId: draft.emergencyContactUserId || null,
        disclosureScope: draft.disclosureScope,
        expectedRevision: availability?.revision ?? null,
      });
      setAvailability(result.availability);
      if (result.availability !== null) setDraft(availabilityToDraft(result.availability));
      setSaved(true);
    } catch (caught) {
      setError(readableError(caught));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="work-availability-panel" aria-labelledby="work-availability-title">
      <header>
        <div>
          <p className="eyebrow">WORK AVAILABILITY</p>
          <h2 id="work-availability-title">我的工作状态</h2>
          <p>只填写同事协作需要的摘要，不要填写航班、酒店、房间或精确位置。</p>
        </div>
        <span className={availability?.expired === true ? 'expired' : 'current'}>
          {availability?.expired === true
            ? '已过期'
            : availability === null
              ? '尚未设置'
              : '当前有效'}
        </span>
      </header>
      {!sharingEnabled ? (
        <div className="work-availability-disabled">
          当前未开启“向同事分享工作状态”，保存后也只供自己查看。
        </div>
      ) : null}
      {error ? (
        <div className="personal-manual-feedback error" role="alert">
          {error}
        </div>
      ) : null}
      {saved ? (
        <div className="personal-manual-feedback success" role="status">
          工作状态已保存。
        </div>
      ) : null}
      {loading ? (
        <p className="work-availability-loading">正在读取工作状态…</p>
      ) : (
        <form onSubmit={(event) => void submit(event)}>
          <label>
            <span>当前状态</span>
            <select
              value={draft.status}
              onChange={(event) => update('status', event.target.value as WorkAvailabilityStatus)}
            >
              <option value="AVAILABLE">可联系</option>
              <option value="FOCUSING">专注工作中</option>
              <option value="IN_MEETING">会议中</option>
              <option value="TRAVELING">出差中</option>
              <option value="ON_LEAVE">休假中</option>
              <option value="UNAVAILABLE">暂时无法联系</option>
            </select>
          </label>
          <label>
            <span>开始时间</span>
            <input
              required
              type="datetime-local"
              value={draft.startsAt}
              onChange={(event) => update('startsAt', event.target.value)}
            />
          </label>
          <label>
            <span>有效至（可选）</span>
            <input
              type="datetime-local"
              value={draft.endsAt}
              onChange={(event) => update('endsAt', event.target.value)}
            />
          </label>
          <label>
            <span>谁可以看到</span>
            <select
              value={draft.disclosureScope}
              onChange={(event) =>
                update('disclosureScope', event.target.value as CollaborationDisclosureScope)
              }
            >
              {scopeOptions()}
            </select>
          </label>
          <label className="wide">
            <span>状态摘要（可选）</span>
            <input
              maxLength={500}
              value={draft.summary}
              placeholder="例如：外出拜访客户，明天下午恢复正常协作。"
              onChange={(event) => update('summary', event.target.value)}
            />
          </label>
          <label>
            <span>预计响应（可选）</span>
            <input
              maxLength={200}
              value={draft.expectedResponse}
              placeholder="例如：明天下午回复"
              onChange={(event) => update('expectedResponse', event.target.value)}
            />
          </label>
          <label>
            <span>紧急联系人（可选）</span>
            <select
              value={draft.emergencyContactUserId}
              onChange={(event) => update('emergencyContactUserId', event.target.value)}
            >
              <option value="">不设置</option>
              {members
                .filter((member) => member.id !== currentUserId && member.status === 'active')
                .map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.name} · {member.title}
                  </option>
                ))}
            </select>
          </label>
          <div className="work-availability-actions">
            <button type="submit" className="primary-button" disabled={saving}>
              {saving ? '正在保存…' : '保存工作状态'}
            </button>
          </div>
        </form>
      )}
    </section>
  );

  function update<K extends keyof AvailabilityDraft>(field: K, value: AvailabilityDraft[K]): void {
    setSaved(false);
    setDraft((current) => ({ ...current, [field]: value }));
  }
}

export function scopeOptions(includeSelf = true): React.JSX.Element[] {
  return [
    ...(includeSelf ? [{ value: 'SELF_ONLY', label: '仅自己' }] : []),
    { value: 'SHARED_WORK', label: '共同工作的人' },
    { value: 'DEPARTMENT', label: '同部门同事' },
    { value: 'TENANT', label: '全公司成员' },
  ].map((option) => (
    <option key={option.value} value={option.value}>
      {option.label}
    </option>
  ));
}

function emptyDraft(): AvailabilityDraft {
  const startsAt = new Date();
  startsAt.setSeconds(0, 0);
  return {
    status: 'AVAILABLE',
    startsAt: isoToLocalDateTime(startsAt.toISOString()),
    endsAt: '',
    summary: '',
    expectedResponse: '',
    emergencyContactUserId: '',
    disclosureScope: 'SHARED_WORK',
  };
}

function availabilityToDraft(value: WorkAvailability): AvailabilityDraft {
  return {
    status: value.status,
    startsAt: isoToLocalDateTime(value.startsAt),
    endsAt: value.endsAt === null ? '' : isoToLocalDateTime(value.endsAt),
    summary: value.summary ?? '',
    expectedResponse: value.expectedResponse ?? '',
    emergencyContactUserId: value.emergencyContact?.id ?? '',
    disclosureScope: value.disclosureScope,
  };
}

function isoToLocalDateTime(value: string): string {
  const date = new Date(value);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function localDateTimeToIso(value: string): string {
  return new Date(value).toISOString();
}

function nullable(value: string): string | null {
  const normalized = value.trim();
  return normalized === '' ? null : normalized;
}

function readableError(error: unknown): string {
  return error instanceof Error ? error.message : '工作状态保存失败，请稍后重试。';
}
