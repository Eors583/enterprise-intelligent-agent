import type { AiEvaluationBadCase, AiEvaluationCategory, Evidence } from '@enterprise/contracts';
import { useEffect, useState, type ChangeEvent, type FormEvent, type ReactNode } from 'react';

import { messageFromError } from '@/api/client';
import { StatusPill } from '@/components/ui';
import { listEvidence } from '@/features/business-semantics/api';

import {
  ingestEvaluationBadCase,
  listEvaluationDatasets,
  listEvaluationDatasetVersions,
  triageEvaluationBadCase,
} from './api';
import {
  parseBadCaseLineagePackage,
  selectedFormValues,
  type BadCaseLineagePackage,
} from './governance-form';
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
  const [lineagePackage, setLineagePackage] = useState<BadCaseLineagePackage | null>(null);
  const [packageError, setPackageError] = useState<string | null>(null);
  const [evidence, setEvidence] = useState<readonly Evidence[]>([]);
  const [draftVersions, setDraftVersions] = useState<ReadonlyArray<{ id: string; label: string }>>(
    [],
  );
  const verifiedEvidence = evidence.filter(
    (item) => item.status === 'ACTIVE' && item.trustLevel === 'VERIFIED',
  );

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      listEvidence(controller.signal),
      listEvaluationDatasets({ limit: 100 }, controller.signal),
    ])
      .then(async ([evidenceItems, datasetResponse]) => {
        const versionResponses = await Promise.all(
          datasetResponse.items.map(async (dataset) => ({
            dataset,
            versions: await listEvaluationDatasetVersions(
              dataset.id,
              { limit: 100 },
              controller.signal,
            ),
          })),
        );
        if (controller.signal.aborted) return;
        setEvidence(evidenceItems);
        setDraftVersions(
          versionResponses.flatMap(({ dataset, versions }) =>
            versions.items
              .filter((version) => version.status === 'DRAFT')
              .map((version) => ({
                id: version.id,
                label: `${dataset.code} · ${dataset.name} · v${version.version}`,
              })),
          ),
        );
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) {
          onError(`坏样本引用目录加载失败：${messageFromError(caught)}`);
        }
      });
    return () => controller.abort();
  }, [onError]);

  const importLineage = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    setPackageError(null);
    setLineagePackage(null);
    if (!file) return;
    try {
      setLineagePackage(parseBadCaseLineagePackage(await file.text()));
    } catch (caught) {
      setPackageError(messageFromError(caught));
    }
  };

  const ingest = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setBusyId('ingest');
    try {
      if (lineagePackage === null) {
        throw new Error('请先导入由 Runner 或来源系统导出的坏样本结果包。');
      }
      await ingestEvaluationBadCase({
        sourceType: lineagePackage.sourceType,
        sourceId: lineagePackage.sourceId,
        sourceVersion: lineagePackage.sourceVersion,
        category: text(data, 'category') as AiEvaluationCategory,
        sanitizedInput: text(data, 'sanitizedInput'),
        sourceSnapshotHash: lineagePackage.sourceSnapshotHash,
        evidenceIds: [
          ...new Set([
            ...selectedFormValues(data, 'evidenceIds'),
            ...parseUuidList(text(data, 'evidenceIdsOverride'), '兼容坏样本证据'),
          ]),
        ],
        idempotencyKey: crypto.randomUUID(),
      });
      form.reset();
      setLineagePackage(null);
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
      const datasetVersionId = text(data, 'datasetVersionId');
      if (action === 'ADD_TO_DATASET' && !datasetVersionId) {
        throw new Error('当前没有可分流的真实草稿版本；请先创建数据集草稿。');
      }
      await triageEvaluationBadCase(
        badCase.id,
        action === 'ADD_TO_DATASET'
          ? {
              action,
              datasetVersionId,
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
        <label>
          坏样本来源结果包
          <input
            type="file"
            accept="application/json,.json"
            aria-label="坏样本来源结果包"
            onChange={(event) => void importLineage(event)}
          />
          <small>
            JSON 结果包由 Runner 或来源系统导出，必须包含 sourceType、sourceId、sourceVersion 和
            sourceSnapshotHash；页面不会生成来源或快照。
          </small>
        </label>
        {packageError ? <p role="alert">{packageError}</p> : null}
        {lineagePackage ? (
          <dl className="evaluation-definition">
            <div>
              <dt>来源</dt>
              <dd>{lineagePackage.sourceType}</dd>
            </div>
            <div>
              <dt>版本</dt>
              <dd>v{lineagePackage.sourceVersion}</dd>
            </div>
            <div>
              <dt>来源 ID</dt>
              <dd>
                <code>{lineagePackage.sourceId}</code>
              </dd>
            </div>
            <div>
              <dt>快照</dt>
              <dd>
                <code>{lineagePackage.sourceSnapshotHash.slice(0, 16)}…</code>
              </dd>
            </div>
          </dl>
        ) : (
          <p>尚未导入可信来源结果包，接收操作将被阻断。</p>
        )}
        <div className="evaluation-three-column">
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
          已验证证据
          <select name="evidenceIds" multiple size={Math.min(6, verifiedEvidence.length + 1)}>
            {verifiedEvidence.map((item) => (
              <option key={item.id} value={item.id}>
                {item.code} · {item.summary}
              </option>
            ))}
          </select>
          {verifiedEvidence.length === 0 ? (
            <small>当前没有 ACTIVE + VERIFIED 证据，接收操作将被 API 阻断。</small>
          ) : null}
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
                  真实草稿数据集版本（忽略时可留空）
                  <select name="datasetVersionId" defaultValue="">
                    <option value="">请选择草稿版本</option>
                    {draftVersions.map((version) => (
                      <option key={version.id} value={version.id}>
                        {version.label}
                      </option>
                    ))}
                  </select>
                  {draftVersions.length === 0 ? (
                    <small>当前没有草稿版本；“加入草稿数据集”会被明确阻断。</small>
                  ) : null}
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
