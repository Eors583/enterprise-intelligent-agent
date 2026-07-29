import type { AiEvaluationBadCase, AiEvaluationCategory } from '@enterprise/contracts';
import { useState, type FormEvent, type ReactNode } from 'react';

import { messageFromError } from '@/api/client';
import { StatusPill } from '@/components/ui';

import { ingestEvaluationBadCase, triageEvaluationBadCase } from './api';
import { badCaseStatusLabel, EVALUATION_CATEGORIES, parseUuidList } from './view';

export function BadCaseGovernancePanel({
  badCases,
  reload,
  onNotice,
  onError,
}: {
  badCases: readonly AiEvaluationBadCase[];
  reload: () => void;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
}): ReactNode {
  const [busyId, setBusyId] = useState<string | null>(null);

  const ingest = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setBusyId('ingest');
    try {
      await ingestEvaluationBadCase({
        sourceType: text(data, 'sourceType') as
          'AGENT_RUN' | 'CORRECTION' | 'TOOL_INVOCATION' | 'SECURITY_EVENT',
        sourceId: text(data, 'sourceId'),
        sourceVersion: Number(text(data, 'sourceVersion')),
        category: text(data, 'category') as AiEvaluationCategory,
        sanitizedInput: text(data, 'sanitizedInput'),
        sourceSnapshotHash: text(data, 'sourceSnapshotHash'),
        evidenceIds: parseUuidList(text(data, 'evidenceIds'), '坏样本证据'),
        idempotencyKey: crypto.randomUUID(),
      });
      form.reset();
      reload();
      onNotice('坏样本候选已入队；它仍需独立分流，不能直接污染评测数据集。');
    } catch (caught) {
      onError(messageFromError(caught));
    } finally {
      setBusyId(null);
    }
  };

  const triage = async (
    event: FormEvent<HTMLFormElement>,
    badCase: AiEvaluationBadCase,
  ): Promise<void> => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const action = text(data, 'action') as 'ADD_TO_DATASET' | 'DISMISS';
    setBusyId(badCase.id);
    try {
      await triageEvaluationBadCase(
        badCase.id,
        action === 'ADD_TO_DATASET'
          ? {
              action,
              datasetVersionId: text(data, 'datasetVersionId'),
              expectedRevision: badCase.revision,
              reason: text(data, 'reason'),
              idempotencyKey: crypto.randomUUID(),
            }
          : {
              action,
              expectedRevision: badCase.revision,
              reason: text(data, 'reason'),
              idempotencyKey: crypto.randomUUID(),
            },
      );
      reload();
      onNotice(
        action === 'ADD_TO_DATASET'
          ? '坏样本已分流到指定草稿版本；还需在用例表单中显式引用并定义预期行为。'
          : '坏样本已带理由忽略。',
      );
    } catch (caught) {
      onError(messageFromError(caught));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section className="evaluation-grid-section" aria-labelledby="evaluation-bad-case-heading">
      <header>
        <div>
          <span className="eyebrow">BAD CASE LOOP</span>
          <h2 id="evaluation-bad-case-heading">负反馈与坏样本分流</h2>
        </div>
        <span>{badCases.length} 个候选</span>
      </header>

      <article className="evaluation-feedback-explainer">
        <strong>员工负反馈会自动形成可追溯候选，但不会自动成为可信评测证据。</strong>
        <p>
          NOT_HELPFUL 回答会在原事务中绑定反馈、消息、Agent Run、Agent
          版本和知识引用，输入经过脱敏后进入候选流程。管理员仍需独立分流并选择已验证证据；系统不会把评论、模型输出或普通附件伪装成
          VERIFIED 证据。
        </p>
        <p>
          可信反馈事件：<code>agent.answer-feedback.recorded.v1</code>
          。只有服务端已持久化并完成来源校验的事件才会触发自动候选投影。
        </p>
      </article>

      <form className="card evaluation-form" onSubmit={(event) => void ingest(event)}>
        <h3>手工接收受控坏样本</h3>
        <div className="evaluation-three-column">
          <label>
            来源类型
            <select name="sourceType" defaultValue="AGENT_RUN">
              <option value="AGENT_RUN">Agent Run</option>
              <option value="CORRECTION">纠错</option>
              <option value="TOOL_INVOCATION">工具调用</option>
              <option value="SECURITY_EVENT">安全事件</option>
            </select>
          </label>
          <label>
            来源 ID
            <input name="sourceId" required />
          </label>
          <label>
            来源版本
            <input name="sourceVersion" type="number" min="1" defaultValue="1" required />
          </label>
          <label>
            类别
            <select name="category" defaultValue="FACTUALITY">
              {EVALUATION_CATEGORIES.map((category) => (
                <option key={category.value} value={category.value}>
                  {category.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label>
          已脱敏输入
          <textarea
            name="sanitizedInput"
            required
            rows={4}
            placeholder="仅填写完成 PII、密钥和业务敏感字段脱敏后的问题上下文"
          />
        </label>
        <label>
          来源快照 SHA-256
          <input name="sourceSnapshotHash" required minLength={64} maxLength={64} />
        </label>
        <label>
          已验证证据 ID
          <textarea name="evidenceIds" required rows={2} />
        </label>
        <button className="button primary" type="submit" disabled={busyId !== null}>
          接收候选
        </button>
      </form>

      <div className="evaluation-card-list">
        {badCases.length === 0 ? <p>暂无待处理坏样本。</p> : null}
        {badCases.map((badCase) => (
          <article className="card evaluation-bad-case" key={badCase.id}>
            <header>
              <div>
                <strong>{badCase.category}</strong>
                <small>
                  {badCase.sourceType} · {badCase.sourceId} · v{badCase.sourceVersion}
                </small>
              </div>
              <StatusPill value={badCase.status} label={badCaseStatusLabel(badCase.status)} />
            </header>
            <p>{badCase.sanitizedInput}</p>
            <code>{badCase.sourceSnapshotHash}</code>
            {badCase.answerFeedbackSource ? (
              <dl className="evaluation-bad-case-lineage">
                <div>
                  <dt>Agent Run</dt>
                  <dd>
                    <code>{badCase.answerFeedbackSource.agentRunId}</code>
                  </dd>
                </div>
                <div>
                  <dt>Agent 版本</dt>
                  <dd>
                    <code>{badCase.answerFeedbackSource.agentVersionId}</code>
                  </dd>
                </div>
                <div>
                  <dt>反馈时间</dt>
                  <dd>
                    {new Date(badCase.answerFeedbackSource.feedbackRecordedAt).toLocaleString()}
                  </dd>
                </div>
                <div>
                  <dt>可信引用</dt>
                  <dd>{badCase.answerFeedbackSource.citations.length} 条</dd>
                </div>
              </dl>
            ) : null}
            {badCase.status === 'RECEIVED' ? (
              <form
                className="evaluation-form compact"
                onSubmit={(event) => void triage(event, badCase)}
              >
                <label>
                  分流动作
                  <select name="action" defaultValue="ADD_TO_DATASET">
                    <option value="ADD_TO_DATASET">加入草稿数据集</option>
                    <option value="DISMISS">忽略</option>
                  </select>
                </label>
                <label>
                  草稿数据集版本 ID（忽略时可留空）
                  <input name="datasetVersionId" />
                </label>
                <label>
                  分流理由
                  <textarea name="reason" required rows={2} />
                </label>
                <button className="button secondary" type="submit" disabled={busyId !== null}>
                  提交分流
                </button>
              </form>
            ) : null}
            {badCase.triageReason ? <small>分流说明：{badCase.triageReason}</small> : null}
          </article>
        ))}
      </div>
    </section>
  );
}

function text(data: FormData, key: string): string {
  return String(data.get(key) ?? '').trim();
}
