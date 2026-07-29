import type {
  AiEvaluationCase,
  AiEvaluationCategory,
  AiEvaluationDataset,
  AiEvaluationDatasetVersion,
  AiEvaluationJudgeType,
  AiEvaluationMetric,
} from '@enterprise/contracts';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';

import { messageFromError } from '@/api/client';
import { Spinner, StatusPill } from '@/components/ui';

import {
  annotateEvaluationCase,
  createEvaluationCase,
  createEvaluationDataset,
  createEvaluationDatasetVersion,
  listEvaluationCases,
  listEvaluationDatasetVersions,
  transitionEvaluationDatasetVersion,
} from './api';
import {
  datasetStatusLabel,
  EVALUATION_CATEGORIES,
  EVALUATION_METRICS,
  parseTextList,
  parseUuidList,
} from './view';

export function DatasetGovernancePanel({
  datasets,
  reloadDatasets,
  onNotice,
  onError,
}: {
  datasets: readonly AiEvaluationDataset[];
  reloadDatasets: () => void;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
}): ReactNode {
  const [selectedDatasetId, setSelectedDatasetId] = useState('');
  const [preferredDatasetId, setPreferredDatasetId] = useState('');
  const [selectedVersionId, setSelectedVersionId] = useState('');
  const [versions, setVersions] = useState<readonly AiEvaluationDatasetVersion[]>([]);
  const [cases, setCases] = useState<readonly AiEvaluationCase[]>([]);
  const [reloadKey, setReloadKey] = useState(0);
  const [busy, setBusy] = useState(false);

  const selectedDataset = datasets.find(({ id }) => id === selectedDatasetId) ?? null;
  const selectedVersion = versions.find(({ id }) => id === selectedVersionId) ?? null;
  const reload = (): void => setReloadKey((value) => value + 1);

  useEffect(() => {
    if (preferredDatasetId && datasets.some(({ id }) => id === preferredDatasetId)) {
      setSelectedDatasetId(preferredDatasetId);
      setPreferredDatasetId('');
      return;
    }
    if (selectedDatasetId === '' && datasets[0]) setSelectedDatasetId(datasets[0].id);
    if (
      selectedDatasetId !== '' &&
      selectedDatasetId !== preferredDatasetId &&
      !datasets.some(({ id }) => id === selectedDatasetId)
    ) {
      setSelectedDatasetId(datasets[0]?.id ?? '');
    }
  }, [datasets, preferredDatasetId, selectedDatasetId]);

  useEffect(() => {
    if (selectedDatasetId === '') {
      setVersions([]);
      setSelectedVersionId('');
      return;
    }
    const controller = new AbortController();
    void listEvaluationDatasetVersions(selectedDatasetId, { limit: 100 }, controller.signal)
      .then((response) => {
        setVersions(response.items);
        setSelectedVersionId((current) =>
          response.items.some(({ id }) => id === current) ? current : (response.items[0]?.id ?? ''),
        );
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) onError(messageFromError(caught));
      });
    return () => controller.abort();
  }, [onError, reloadKey, selectedDatasetId]);

  useEffect(() => {
    if (selectedVersionId === '') {
      setCases([]);
      return;
    }
    const controller = new AbortController();
    void listEvaluationCases(selectedVersionId, { limit: 200 }, controller.signal)
      .then((response) => setCases(response.items))
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) onError(messageFromError(caught));
      });
    return () => controller.abort();
  }, [onError, reloadKey, selectedVersionId]);

  const createDataset = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setBusy(true);
    try {
      const created = await createEvaluationDataset({
        code: text(data, 'code').toUpperCase(),
        name: text(data, 'name'),
        description: text(data, 'description'),
        idempotencyKey: crypto.randomUUID(),
      });
      form.reset();
      setPreferredDatasetId(created.id);
      reloadDatasets();
      onNotice(`评测数据集“${created.name}”已创建。`);
    } catch (caught) {
      onError(messageFromError(caught));
    } finally {
      setBusy(false);
    }
  };

  const createVersion = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!selectedDataset) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    setBusy(true);
    try {
      const metric = text(data, 'metric') as AiEvaluationMetric;
      const created = await createEvaluationDatasetVersion(selectedDataset.id, {
        description: text(data, 'description'),
        targets: {
          agentVersionIds: parseUuidList(text(data, 'agentVersionIds'), '智能体版本'),
          knowledgeVersionIds: parseUuidList(text(data, 'knowledgeVersionIds'), '知识版本'),
          toolVersionIds: parseUuidList(text(data, 'toolVersionIds'), '工具版本'),
          modelRoutes: parseTextList(text(data, 'modelRoutes')),
          promptHashes: parseTextList(text(data, 'promptHashes')),
        },
        thresholds: [
          {
            metric,
            direction: text(data, 'direction') as 'AT_LEAST' | 'AT_MOST' | 'ZERO',
            threshold: Number(text(data, 'threshold')),
            minimumSampleCount: Number(text(data, 'minimumSampleCount')),
            required: true,
          },
        ],
        requiredCategories: data.getAll('requiredCategories') as AiEvaluationCategory[],
        idempotencyKey: crypto.randomUUID(),
      });
      setSelectedVersionId(created.id);
      reload();
      reloadDatasets();
      onNotice(`数据集版本 v${created.version} 已创建；请新增并标注用例。`);
    } catch (caught) {
      onError(messageFromError(caught));
    } finally {
      setBusy(false);
    }
  };

  const createCase = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!selectedVersion) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    setBusy(true);
    try {
      const sourceBadCaseId = text(data, 'sourceBadCaseId');
      await createEvaluationCase(selectedVersion.id, {
        caseKey: text(data, 'caseKey').toUpperCase(),
        category: text(data, 'category') as AiEvaluationCategory,
        input: text(data, 'input'),
        context: {
          roleAssignmentId: nullableUuid(data, 'roleAssignmentId'),
          roleVersionId: nullableUuid(data, 'roleVersionId'),
          objectiveId: null,
          objectiveVersion: null,
          processVersionId: nullableUuid(data, 'processVersionId'),
          permissionLabels: parseTextList(text(data, 'permissionLabels')),
          knowledgeVersionIds: parseUuidList(
            text(data, 'contextKnowledgeVersionIds'),
            '上下文知识版本',
          ),
          toolVersionIds: parseUuidList(text(data, 'contextToolVersionIds'), '上下文工具版本'),
          structuredContext: {},
        },
        expectedBehavior: text(data, 'expectedBehavior'),
        requiredEvidenceIds: parseUuidList(text(data, 'requiredEvidenceIds'), '可信证据'),
        forbiddenBehaviors: parseTextList(text(data, 'forbiddenBehaviors')),
        scoring: {
          judgeTypes: [text(data, 'judgeType') as AiEvaluationJudgeType],
          rubric: text(data, 'rubric'),
          metricWeights: [
            {
              metric: text(data, 'metric') as AiEvaluationMetric,
              weight: 1,
            },
          ],
        },
        ...(sourceBadCaseId ? { sourceBadCaseId } : {}),
        idempotencyKey: crypto.randomUUID(),
      });
      form.reset();
      reload();
      onNotice('评测用例已写入草稿版本；事实、引用和目标用例不会接受空证据。');
    } catch (caught) {
      onError(messageFromError(caught));
    } finally {
      setBusy(false);
    }
  };

  const annotate = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setBusy(true);
    try {
      const label = text(data, 'label') as 'PASS' | 'FAIL' | 'ABSTAIN';
      await annotateEvaluationCase(text(data, 'caseId'), {
        label,
        expectedScore: label === 'ABSTAIN' ? null : Number(text(data, 'expectedScore')),
        rationale: text(data, 'rationale'),
        evidenceIds: parseUuidList(text(data, 'evidenceIds'), '标注证据'),
        expectedRevision: 0,
        idempotencyKey: crypto.randomUUID(),
      });
      reload();
      onNotice('标注已保存。提交数据集后标注不可变更。');
    } catch (caught) {
      onError(messageFromError(caught));
    } finally {
      setBusy(false);
    }
  };

  const transition = async (
    action: 'SUBMIT' | 'APPROVE' | 'REJECT' | 'PUBLISH' | 'RETIRE',
    data?: FormData,
  ): Promise<void> => {
    if (!selectedVersion) return;
    setBusy(true);
    try {
      const expectedRevision = selectedVersion.revision;
      const idempotencyKey = crypto.randomUUID();
      if (action === 'APPROVE' || action === 'REJECT') {
        const form = requiredData(data);
        await transitionEvaluationDatasetVersion(selectedVersion.id, {
          action,
          expectedRevision,
          idempotencyKey,
          reason: text(form, 'reason'),
          evidenceIds: parseUuidList(text(form, 'evidenceIds'), '审核证据'),
        });
      } else if (action === 'RETIRE') {
        await transitionEvaluationDatasetVersion(selectedVersion.id, {
          action,
          expectedRevision,
          idempotencyKey,
          reason: text(requiredData(data), 'reason'),
        });
      } else {
        await transitionEvaluationDatasetVersion(selectedVersion.id, {
          action,
          expectedRevision,
          idempotencyKey,
        });
      }
      reload();
      reloadDatasets();
      onNotice(`数据集版本已执行“${action}”，状态由服务端状态机确认。`);
    } catch (caught) {
      onError(messageFromError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="evaluation-grid-section" aria-labelledby="evaluation-dataset-heading">
      <header>
        <div>
          <span className="eyebrow">DATASET GOVERNANCE</span>
          <h2 id="evaluation-dataset-heading">数据集、版本与受控用例</h2>
        </div>
        <span>{datasets.length} 个数据集</span>
      </header>

      <div className="evaluation-two-column">
        <form className="card evaluation-form" onSubmit={(event) => void createDataset(event)}>
          <h3>创建数据集</h3>
          <label>
            数据集代码
            <input name="code" required placeholder="ROLE.REGRESSION" />
          </label>
          <label>
            名称
            <input name="name" required />
          </label>
          <label>
            说明
            <textarea name="description" required rows={3} />
          </label>
          <button className="button primary" type="submit" disabled={busy}>
            创建数据集
          </button>
        </form>

        <article className="card evaluation-form">
          <h3>版本上下文</h3>
          <label>
            数据集
            <select
              value={selectedDatasetId}
              onChange={(event) => setSelectedDatasetId(event.target.value)}
            >
              <option value="">请选择数据集</option>
              {datasets.map((dataset) => (
                <option key={dataset.id} value={dataset.id}>
                  {dataset.code} · {dataset.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            版本
            <select
              value={selectedVersionId}
              onChange={(event) => setSelectedVersionId(event.target.value)}
              disabled={versions.length === 0}
            >
              <option value="">请选择版本</option>
              {versions.map((version) => (
                <option key={version.id} value={version.id}>
                  v{version.version} · {datasetStatusLabel(version.status)} · r{version.revision}
                </option>
              ))}
            </select>
          </label>
          {selectedVersion ? (
            <dl className="evaluation-definition">
              <div>
                <dt>状态</dt>
                <dd>
                  <StatusPill
                    value={selectedVersion.status}
                    label={datasetStatusLabel(selectedVersion.status)}
                  />
                </dd>
              </div>
              <div>
                <dt>用例 / 标注覆盖率</dt>
                <dd>
                  {selectedVersion.caseCount} /{' '}
                  {Math.round(selectedVersion.annotationCoverage * 100)}%
                </dd>
              </div>
              <div>
                <dt>内容哈希</dt>
                <dd>
                  <code>{selectedVersion.contentHash}</code>
                </dd>
              </div>
            </dl>
          ) : (
            <p>先创建数据集版本，再新增受控用例。</p>
          )}
        </article>
      </div>

      {selectedDataset ? (
        <details className="card evaluation-disclosure" open={versions.length === 0}>
          <summary>创建不可变评测版本</summary>
          <form className="evaluation-form" onSubmit={(event) => void createVersion(event)}>
            <label>
              版本说明
              <textarea name="description" required rows={2} />
            </label>
            <div className="evaluation-two-column">
              <label>
                智能体 / 角色版本 ID（逗号或换行）
                <textarea name="agentVersionIds" rows={2} />
              </label>
              <label>
                知识版本 ID（逗号或换行）
                <textarea name="knowledgeVersionIds" rows={2} />
              </label>
              <label>
                工具版本 ID
                <textarea name="toolVersionIds" rows={2} />
              </label>
              <label>
                模型路由
                <textarea name="modelRoutes" rows={2} />
              </label>
            </div>
            <label>
              提示词 SHA-256（可选）
              <textarea name="promptHashes" rows={2} />
            </label>
            <div className="evaluation-three-column">
              <label>
                必需指标
                <select name="metric" defaultValue="FACTUAL_ACCURACY">
                  {EVALUATION_METRICS.map((metric) => (
                    <option key={metric.value} value={metric.value}>
                      {metric.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                阈值方向
                <select name="direction" defaultValue="AT_LEAST">
                  <option value="AT_LEAST">至少</option>
                  <option value="AT_MOST">至多</option>
                  <option value="ZERO">必须为零</option>
                </select>
              </label>
              <label>
                阈值
                <input name="threshold" type="number" step="0.01" min="0" defaultValue="0.8" />
              </label>
              <label>
                最小样本数
                <input name="minimumSampleCount" type="number" min="1" defaultValue="1" />
              </label>
            </div>
            <fieldset>
              <legend>必需类别</legend>
              <div className="evaluation-check-grid">
                {EVALUATION_CATEGORIES.map((category) => (
                  <label key={category.value}>
                    <input
                      type="checkbox"
                      name="requiredCategories"
                      value={category.value}
                      defaultChecked={category.value === 'FACTUALITY'}
                    />
                    {category.label}
                  </label>
                ))}
              </div>
            </fieldset>
            <button className="button primary" type="submit" disabled={busy}>
              创建版本
            </button>
          </form>
        </details>
      ) : null}

      {selectedVersion?.status === 'DRAFT' ? (
        <div className="evaluation-two-column">
          <details className="card evaluation-disclosure" open>
            <summary>新增受控评测用例</summary>
            <form className="evaluation-form" onSubmit={(event) => void createCase(event)}>
              <div className="evaluation-two-column">
                <label>
                  用例 Key
                  <input name="caseKey" required />
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
                输入
                <textarea name="input" required rows={3} />
              </label>
              <label>
                预期行为
                <textarea name="expectedBehavior" required rows={3} />
              </label>
              <label>
                已验证证据 ID
                <textarea
                  name="requiredEvidenceIds"
                  rows={2}
                  placeholder="事实、引用、目标对齐用例必须填写"
                />
              </label>
              <label>
                禁止行为
                <textarea name="forbiddenBehaviors" rows={2} placeholder="安全用例必须填写" />
              </label>
              <div className="evaluation-two-column">
                <label>
                  判定方式
                  <select name="judgeType" defaultValue="HUMAN">
                    <option value="HUMAN">人工</option>
                    <option value="DETERMINISTIC_RULE">确定性规则</option>
                    <option value="SIGNED_CODE">签名代码</option>
                    <option value="EXTERNAL_RUNNER">外部 Runner</option>
                  </select>
                </label>
                <label>
                  评分指标
                  <select name="metric" defaultValue="FACTUAL_ACCURACY">
                    {EVALUATION_METRICS.map((metric) => (
                      <option key={metric.value} value={metric.value}>
                        {metric.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <label>
                评分规则
                <textarea name="rubric" required rows={2} />
              </label>
              <details>
                <summary>受控上下文（可选）</summary>
                <div className="evaluation-form">
                  <label>
                    角色任命 ID
                    <input name="roleAssignmentId" />
                  </label>
                  <label>
                    角色版本 ID
                    <input name="roleVersionId" />
                  </label>
                  <label>
                    流程版本 ID
                    <input name="processVersionId" />
                  </label>
                  <label>
                    权限标签
                    <input name="permissionLabels" />
                  </label>
                  <label>
                    上下文知识版本 ID
                    <textarea name="contextKnowledgeVersionIds" rows={2} />
                  </label>
                  <label>
                    上下文工具版本 ID
                    <textarea name="contextToolVersionIds" rows={2} />
                  </label>
                  <label>
                    已分流坏样本 ID
                    <input name="sourceBadCaseId" />
                  </label>
                </div>
              </details>
              <button className="button primary" type="submit" disabled={busy}>
                新增用例
              </button>
            </form>
          </details>

          <details className="card evaluation-disclosure" open={cases.length > 0}>
            <summary>独立标注</summary>
            <form className="evaluation-form" onSubmit={(event) => void annotate(event)}>
              <label>
                用例
                <select name="caseId" required>
                  {cases.map((testCase) => (
                    <option key={testCase.id} value={testCase.id}>
                      {testCase.caseKey} · {testCase.category}
                    </option>
                  ))}
                </select>
              </label>
              <div className="evaluation-two-column">
                <label>
                  标签
                  <select name="label" defaultValue="PASS">
                    <option value="PASS">通过</option>
                    <option value="FAIL">失败</option>
                    <option value="ABSTAIN">弃权</option>
                  </select>
                </label>
                <label>
                  预期得分（弃权时留空）
                  <input
                    name="expectedScore"
                    type="number"
                    min="0"
                    max="1"
                    step="0.01"
                    defaultValue="1"
                  />
                </label>
              </div>
              <label>
                标注理由
                <textarea name="rationale" required rows={2} />
              </label>
              <label>
                已验证标注证据 ID
                <textarea name="evidenceIds" required rows={2} />
              </label>
              <button
                className="button primary"
                type="submit"
                disabled={busy || cases.length === 0}
              >
                保存标注
              </button>
            </form>
          </details>
        </div>
      ) : null}

      {selectedVersion ? (
        <VersionTransition
          version={selectedVersion}
          busy={busy}
          onTransition={(action, data) => void transition(action, data)}
        />
      ) : null}

      {busy ? <Spinner label="服务端正在验证操作…" /> : null}
    </section>
  );
}

function VersionTransition({
  version,
  busy,
  onTransition,
}: {
  version: AiEvaluationDatasetVersion;
  busy: boolean;
  onTransition: (
    action: 'SUBMIT' | 'APPROVE' | 'REJECT' | 'PUBLISH' | 'RETIRE',
    data?: FormData,
  ) => void;
}): ReactNode {
  if (version.status === 'RETIRED') return null;
  if (version.status === 'IN_REVIEW') {
    return (
      <form
        className="card evaluation-form"
        onSubmit={(event) => {
          event.preventDefault();
          const submitter = (event.nativeEvent as SubmitEvent)
            .submitter as HTMLButtonElement | null;
          const action = submitter?.value === 'REJECT' ? 'REJECT' : 'APPROVE';
          onTransition(action, new FormData(event.currentTarget));
        }}
      >
        <h3>独立审核</h3>
        <p>批准人必须与提交人不同，且审核证据必须是服务端可验证的可信证据。</p>
        <label>
          审核理由
          <textarea name="reason" required rows={2} />
        </label>
        <label>
          已验证审核证据 ID
          <textarea name="evidenceIds" required rows={2} />
        </label>
        <div className="evaluation-actions">
          <button
            className="button danger"
            type="submit"
            name="action"
            value="REJECT"
            disabled={busy}
          >
            退回
          </button>
          <button
            className="button primary"
            type="submit"
            name="action"
            value="APPROVE"
            disabled={busy}
          >
            批准
          </button>
        </div>
      </form>
    );
  }
  if (version.status === 'PUBLISHED') {
    return (
      <form
        className="card evaluation-form"
        onSubmit={(event) => {
          event.preventDefault();
          onTransition('RETIRE', new FormData(event.currentTarget));
        }}
      >
        <h3>退役版本</h3>
        <label>
          退役理由
          <textarea name="reason" required rows={2} />
        </label>
        <button className="button danger" type="submit" disabled={busy}>
          退役
        </button>
      </form>
    );
  }
  const action = version.status === 'DRAFT' ? 'SUBMIT' : 'PUBLISH';
  return (
    <article className="card evaluation-form">
      <h3>{action === 'SUBMIT' ? '提交审核' : '发布数据集版本'}</h3>
      <p>
        {action === 'SUBMIT'
          ? '服务端会阻断空用例、未完整标注、缺失类别或指标的版本。'
          : '仅已批准且具备独立审核证据的版本可发布。'}
      </p>
      <button
        className="button primary"
        type="button"
        disabled={busy}
        onClick={() => onTransition(action)}
      >
        {action === 'SUBMIT' ? '提交审核' : '发布版本'}
      </button>
    </article>
  );
}

function text(data: FormData, key: string): string {
  return String(data.get(key) ?? '').trim();
}

function nullableUuid(data: FormData, key: string): string | null {
  const value = text(data, key);
  if (!value) return null;
  return parseUuidList(value, key)[0] ?? null;
}

function requiredData(data: FormData | undefined): FormData {
  if (!data) throw new Error('缺少受控状态流转表单。');
  return data;
}
