import type { EmployeePeopleProfile } from '@enterprise/contracts';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';

import { ApiClientError } from '../../shared/api/client';
import { appealMyAssessment, getMyPeopleProfile } from './api';
import './people-self-service.css';

export function PeopleSelfServiceWorkspace(): React.JSX.Element {
  const [profile, setProfile] = useState<EmployeePeopleProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedAssessmentId, setSelectedAssessmentId] = useState('');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void getMyPeopleProfile(controller.signal)
      .then((value) => {
        setProfile(value);
        setSelectedAssessmentId((current) => current || value.assessments[0]?.id || '');
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) setError(readableError(caught));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [reloadKey]);

  const submitAppeal = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const assessment = profile?.assessments.find((item) => item.id === selectedAssessmentId);
    if (!assessment) return;
    setSubmitting(true);
    setError(null);
    try {
      await appealMyAssessment(assessment.id, {
        expectedAssessmentRevision: assessment.revision,
        reason,
        supplementalEvidenceIds: [],
        idempotencyKey: crypto.randomUUID(),
      });
      setReason('');
      setReloadKey((value) => value + 1);
    } catch (caught) {
      setError(readableError(caught));
    } finally {
      setSubmitting(false);
    }
  };

  if (loading && profile === null) {
    return (
      <SelfServiceState
        title="正在读取成长档案"
        description="正在加载与你本人相关的证据、评价和发展行动。"
      />
    );
  }
  if (error !== null && profile === null) {
    return (
      <SelfServiceState
        title="成长档案加载失败"
        description={error}
        action={<button onClick={() => setReloadKey((value) => value + 1)}>重新加载</button>}
      />
    );
  }

  return (
    <main className="people-self-workspace" aria-labelledby="people-self-title">
      <header className="people-self-hero">
        <div>
          <p className="eyebrow">GROWTH & EVIDENCE</p>
          <h1 id="people-self-title">我的成长档案</h1>
          <p>仅展示与你本人相关、经权限过滤的能力证据、评价逻辑、归因、差距和发展行动。</p>
        </div>
        <button type="button" onClick={() => setReloadKey((value) => value + 1)}>
          刷新
        </button>
      </header>

      {error ? (
        <div className="people-self-error" role="alert">
          {error}
        </div>
      ) : null}

      <section className="people-self-metrics" aria-label="成长档案概览">
        <Metric label="受控证据" value={profile?.evidence.length ?? 0} />
        <Metric label="能力评价" value={profile?.assessments.length ?? 0} />
        <Metric
          label="待改善差距"
          value={profile?.gaps.filter((item) => item.gap > 0).length ?? 0}
        />
        <Metric label="我的异议" value={profile?.appeals.length ?? 0} />
      </section>

      <div className="people-self-grid">
        <section className="people-self-card">
          <header>
            <h2>评价与归因</h2>
            <span>AI 候选不等于有效结论</span>
          </header>
          {profile?.assessments.length ? (
            profile.assessments.map((assessment) => (
              <article key={assessment.id} className="assessment-card">
                <header>
                  <strong>建议等级 {assessment.proposedLevel}</strong>
                  <span className={`assessment-status ${assessment.status.toLowerCase()}`}>
                    {assessmentStatusLabel(assessment.status)}
                  </span>
                </header>
                <p>{assessment.summary}</p>
                <dl>
                  {assessment.attribution.map((item) => (
                    <div key={item.factor}>
                      <dt>{attributionLabel(item.factor)}</dt>
                      <dd>{item.statement}</dd>
                    </div>
                  ))}
                </dl>
                <small>
                  已确认：{assessment.confirmedRoles.join('、') || '暂无'}；要求：
                  {assessment.requiredConfirmationRoles.join('、')}
                </small>
              </article>
            ))
          ) : (
            <p className="people-self-empty">暂无与你相关的能力评价。</p>
          )}
        </section>

        <section className="people-self-card">
          <header>
            <h2>证据与发展行动</h2>
            <span>可追溯、可补证</span>
          </header>
          {profile?.evidence.length ? (
            <ul className="evidence-list">
              {profile.evidence.map((item) => (
                <li key={item.id}>
                  <strong>等级 {item.demonstratedLevel} 证据</strong>
                  <span>
                    Evidence {item.evidenceId.slice(0, 8)} · v{item.evidenceVersion}
                  </span>
                  <small>
                    {new Date(item.validFrom).toLocaleDateString('zh-CN')}
                    {item.validUntil
                      ? ` 至 ${new Date(item.validUntil).toLocaleDateString('zh-CN')}`
                      : ''}
                  </small>
                </li>
              ))}
            </ul>
          ) : (
            <p className="people-self-empty">暂无有效能力证据。</p>
          )}
          {profile?.developmentPlans
            .flatMap((plan) => plan.actions)
            .map((action) => (
              <article className="development-action" key={action.id}>
                <strong>{action.title}</strong>
                <span>{action.description}</span>
                <small>验证方式：{action.verificationMethod}</small>
              </article>
            ))}
        </section>
      </div>

      <form className="people-self-appeal" onSubmit={(event) => void submitAppeal(event)}>
        <div>
          <h2>补充说明或提出异议</h2>
          <p>提交后进入人工复核；AI 候选不会自动触发晋升、调薪或淘汰。</p>
        </div>
        <label>
          <span>评价</span>
          <select
            required
            value={selectedAssessmentId}
            onChange={(event) => setSelectedAssessmentId(event.target.value)}
          >
            <option value="">请选择</option>
            {profile?.assessments.map((assessment) => (
              <option key={assessment.id} value={assessment.id}>
                {assessment.id.slice(0, 8)} · {assessmentStatusLabel(assessment.status)}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>异议或补证说明</span>
          <textarea
            required
            minLength={3}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </label>
        <button
          type="submit"
          disabled={submitting || !selectedAssessmentId || reason.trim().length < 3}
        >
          {submitting ? '正在提交…' : '提交人工复核'}
        </button>
      </form>
    </main>
  );
}

function Metric({ label, value }: { label: string; value: number }): React.JSX.Element {
  return (
    <article>
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

function SelfServiceState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}): React.JSX.Element {
  return (
    <main className="people-self-workspace state">
      <h1>{title}</h1>
      <p>{description}</p>
      {action}
    </main>
  );
}

function readableError(error: unknown): string {
  if (error instanceof ApiClientError) return error.message;
  return error instanceof Error ? error.message : '企业服务暂时不可用，请稍后重试。';
}

function assessmentStatusLabel(status: string): string {
  return (
    {
      CANDIDATE: 'AI 候选',
      UNDER_REVIEW: '人工复核中',
      EFFECTIVE: '已共同确认',
      REJECTED: '已否决',
      DISPUTED: '存在异议',
      SUPERSEDED: '已被重评替代',
    }[status] ?? status
  );
}

function attributionLabel(factor: string): string {
  return (
    {
      GOAL_REASONABLENESS: '目标合理性',
      RESOURCE: '资源',
      PERMISSION: '权限',
      PROCESS: '流程',
      UPSTREAM_DOWNSTREAM: '上下游',
      MARKET_CHANGE: '市场变化',
      CAPABILITY: '能力',
    }[factor] ?? factor
  );
}
