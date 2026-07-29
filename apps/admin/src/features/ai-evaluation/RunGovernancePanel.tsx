import type {
  AiEvaluationCase,
  AiEvaluationJudgeType,
  AiEvaluationMetric,
  AiEvaluationReadiness,
  AiEvaluationRun,
  AiEvaluationRunner,
  AiEvaluationSubjectType,
} from '@enterprise/contracts';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';

import { messageFromError } from '@/api/client';
import { Spinner, StatusPill } from '@/components/ui';

import {
  createEvaluationRunner,
  createEvaluationRun,
  listEvaluationCases,
  loadEvaluationReadiness,
  startEvaluationRun,
  submitEvaluationRun,
  verifyEvaluationRun,
} from './api';
import {
  EVALUATION_METRICS,
  parseTextList,
  parseUuidList,
  runStatusLabel,
  SUBJECT_TYPES,
} from './view';

export function RunGovernancePanel({
  runs,
  runners,
  reload,
  onNotice,
  onError,
}: {
  runs: readonly AiEvaluationRun[];
  runners: readonly AiEvaluationRunner[];
  reload: () => void;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
}): ReactNode {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [resultRunId, setResultRunId] = useState('');
  const [verifyRunId, setVerifyRunId] = useState('');
  const [readiness, setReadiness] = useState<AiEvaluationReadiness | null>(null);

  const createRunner = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setBusyId('runner');
    try {
      const created = await createEvaluationRunner({
        name: text(data, 'name'),
        attestationKeyFingerprint: text(data, 'attestationKeyFingerprint'),
        allowedEvidenceOrigins: parseTextList(text(data, 'allowedEvidenceOrigins')),
        idempotencyKey: crypto.randomUUID(),
      });
      form.reset();
      reload();
      onNotice(`签名 Runner“${created.name}”已注册；凭据和私钥不会进入管理端。`);
    } catch (caught) {
      onError(messageFromError(caught));
    } finally {
      setBusyId(null);
    }
  };

  const createRun = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const runner = runners.find(({ id }) => id === text(data, 'runnerId'));
    if (!runner) {
      onError('请选择已注册且处于 ACTIVE 状态的 Runner。');
      return;
    }
    setBusyId('run');
    try {
      const created = await createEvaluationRun({
        datasetVersionId: text(data, 'datasetVersionId'),
        subjectType: text(data, 'subjectType') as AiEvaluationSubjectType,
        subjectId: text(data, 'subjectId'),
        subjectVersion: Number(text(data, 'subjectVersion')),
        subjectSnapshotHash: text(data, 'subjectSnapshotHash'),
        runnerId: runner.id,
        runnerName: runner.name,
        externalRunId: text(data, 'externalRunId'),
        idempotencyKey: crypto.randomUUID(),
      });
      reload();
      onNotice(`Run ${created.id} 已创建并绑定不可变快照；尚未产生任何评测结果。`);
    } catch (caught) {
      onError(messageFromError(caught));
    } finally {
      setBusyId(null);
    }
  };

  const start = async (run: AiEvaluationRun): Promise<void> => {
    setBusyId(run.id);
    try {
      await startEvaluationRun(run.id, {
        expectedRevision: run.revision,
        idempotencyKey: crypto.randomUUID(),
      });
      reload();
      onNotice(`Run ${run.id} 已进入执行中；结果仍需签名证据包与独立验证。`);
    } catch (caught) {
      onError(messageFromError(caught));
    } finally {
      setBusyId(null);
    }
  };

  const verify = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const run = runs.find(({ id }) => id === verifyRunId);
    if (!run || run.status !== 'SUBMITTED') return;
    const data = new FormData(event.currentTarget);
    setBusyId(run.id);
    try {
      await verifyEvaluationRun(run.id, {
        decision: text(data, 'decision') as 'PASS' | 'FAIL',
        expectedRevision: run.revision,
        evidenceIds: parseUuidList(text(data, 'evidenceIds'), '验证证据'),
        reason: text(data, 'reason'),
        idempotencyKey: crypto.randomUUID(),
      });
      setVerifyRunId('');
      reload();
      onNotice('Run 已完成独立验证；发布门禁仍会复核对象快照、数据集和全部阈值。');
    } catch (caught) {
      onError(messageFromError(caught));
    } finally {
      setBusyId(null);
    }
  };

  const checkReadiness = async (run: AiEvaluationRun): Promise<void> => {
    setBusyId(run.id);
    setReadiness(null);
    try {
      const result = await loadEvaluationReadiness({
        subjectType: run.subjectType,
        subjectId: run.subjectId,
        subjectVersion: run.subjectVersion,
        datasetVersionId: run.datasetVersionId,
        currentSnapshotHash: run.subjectSnapshotHash,
        evaluationRunId: run.id,
      });
      setReadiness(result);
    } catch (caught) {
      onError(messageFromError(caught));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section className="evaluation-grid-section" aria-labelledby="evaluation-run-heading">
      <header>
        <div>
          <span className="eyebrow">TRUSTED RUNS</span>
          <h2 id="evaluation-run-heading">Runner、Run 与发布可信状态</h2>
        </div>
        <span>{runs.length} 个 Run</span>
      </header>

      <div className="evaluation-two-column">
        <details className="card evaluation-disclosure">
          <summary>注册签名 Runner</summary>
          <form className="evaluation-form" onSubmit={(event) => void createRunner(event)}>
            <label>
              Runner 名称
              <input name="name" required />
            </label>
            <label>
              公钥指纹（SHA-256）
              <input name="attestationKeyFingerprint" required minLength={64} maxLength={64} />
            </label>
            <label>
              证据来源 HTTPS Origin
              <textarea
                name="allowedEvidenceOrigins"
                required
                rows={2}
                placeholder="https://evidence.example.com/"
              />
            </label>
            <button className="button primary" type="submit" disabled={busyId !== null}>
              注册 Runner
            </button>
          </form>
        </details>

        <details className="card evaluation-disclosure" open={runs.length === 0}>
          <summary>创建 Run</summary>
          <form className="evaluation-form" onSubmit={(event) => void createRun(event)}>
            <div className="evaluation-two-column">
              <label>
                已发布数据集版本 ID
                <input name="datasetVersionId" required />
              </label>
              <label>
                Runner
                <select name="runnerId" required>
                  <option value="">请选择</option>
                  {runners.map((runner) => (
                    <option key={runner.id} value={runner.id}>
                      {runner.name} · {runner.id}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                发布对象类型
                <select name="subjectType" defaultValue="AGENT_VERSION">
                  {SUBJECT_TYPES.map((subject) => (
                    <option key={subject.value} value={subject.value}>
                      {subject.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                发布对象 ID
                <input name="subjectId" required />
              </label>
              <label>
                对象版本号
                <input name="subjectVersion" type="number" min="1" defaultValue="1" required />
              </label>
              <label>
                外部 Run ID
                <input name="externalRunId" required />
              </label>
            </div>
            <label>
              当前对象快照 SHA-256
              <input name="subjectSnapshotHash" required minLength={64} maxLength={64} />
            </label>
            <p className="evaluation-help">
              服务端会重新计算当前可信快照；输入不一致时创建失败，不会以客户端哈希为准。
            </p>
            <button
              className="button primary"
              type="submit"
              disabled={busyId !== null || runners.length === 0}
            >
              创建 Run
            </button>
          </form>
        </details>
      </div>

      <article className="card evaluation-table-card">
        <header>
          <h3>评测运行</h3>
          <button className="button secondary compact" type="button" onClick={reload}>
            刷新
          </button>
        </header>
        {runs.length === 0 ? (
          <p>暂无 Run。系统不会自动生成“通过”结果。</p>
        ) : (
          <div className="evaluation-table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Run / 对象</th>
                  <th>状态</th>
                  <th>覆盖</th>
                  <th>指标与证据</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.id}>
                    <td>
                      <strong>{run.id}</strong>
                      <small>
                        {run.subjectType} · {run.subjectId} · v{run.subjectVersion}
                      </small>
                    </td>
                    <td>
                      <StatusPill value={run.status} label={runStatusLabel(run.status)} />
                      {run.verifiedByUserId ? <small>验证人：{run.verifiedByUserId}</small> : null}
                    </td>
                    <td>
                      {run.submittedCaseCount}/{run.expectedCaseCount}
                    </td>
                    <td>
                      {run.metrics.length === 0 ? (
                        <span>尚无指标</span>
                      ) : (
                        <ul className="evaluation-metric-list">
                          {run.metrics.map((metric) => (
                            <li key={metric.metric}>
                              {metric.metric}: {metric.value} / {metric.threshold} ·{' '}
                              {metric.passed ? '通过' : '未通过'} · 证据 {metric.evidenceIds.length}
                            </li>
                          ))}
                        </ul>
                      )}
                    </td>
                    <td>
                      <div className="evaluation-actions vertical">
                        {run.status === 'CREATED' ? (
                          <button
                            className="button primary compact"
                            type="button"
                            disabled={busyId !== null}
                            onClick={() => void start(run)}
                          >
                            启动
                          </button>
                        ) : null}
                        {run.status === 'RUNNING' ? (
                          <button
                            className="button secondary compact"
                            type="button"
                            onClick={() => setResultRunId(run.id)}
                          >
                            提交签名结果
                          </button>
                        ) : null}
                        {run.status === 'SUBMITTED' ? (
                          <button
                            className="button secondary compact"
                            type="button"
                            onClick={() => setVerifyRunId(run.id)}
                          >
                            独立验证
                          </button>
                        ) : null}
                        {run.status === 'PASSED' || run.status === 'FAILED' ? (
                          <button
                            className="button secondary compact"
                            type="button"
                            disabled={busyId !== null}
                            onClick={() => void checkReadiness(run)}
                          >
                            检查发布门禁
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </article>

      {resultRunId ? (
        <RunResultSubmission
          run={runs.find(({ id }) => id === resultRunId) ?? null}
          onClose={() => setResultRunId('')}
          onSaved={() => {
            setResultRunId('');
            reload();
            onNotice('签名结果已提交；必须由另一位管理员完成验证。');
          }}
          onError={onError}
        />
      ) : null}

      {verifyRunId ? (
        <form className="card evaluation-form" onSubmit={(event) => void verify(event)}>
          <h3>独立验证 Run</h3>
          <p>
            当前账号若提交过此结果，服务端会拒绝自审。验证证据必须已在企业证据账本中标记为
            VERIFIED。
          </p>
          <label>
            决策
            <select name="decision" defaultValue="PASS">
              <option value="PASS">通过</option>
              <option value="FAIL">失败</option>
            </select>
          </label>
          <label>
            验证理由
            <textarea name="reason" required rows={2} />
          </label>
          <label>
            已验证证据 ID
            <textarea name="evidenceIds" required rows={2} />
          </label>
          <div className="evaluation-actions">
            <button className="button secondary" type="button" onClick={() => setVerifyRunId('')}>
              取消
            </button>
            <button className="button primary" type="submit" disabled={busyId !== null}>
              提交验证
            </button>
          </div>
        </form>
      ) : null}

      {readiness ? (
        <article className={`card evaluation-readiness ${readiness.ready ? 'ready' : 'blocked'}`}>
          <header>
            <h3>{readiness.ready ? '发布门禁已满足' : '发布门禁阻断'}</h3>
            <strong>{readiness.ready ? 'READY' : 'BLOCKED'}</strong>
          </header>
          <p>
            当前快照 <code>{readiness.currentSnapshotHash}</code>
          </p>
          {readiness.blockers.length > 0 ? (
            <ul>
              {readiness.blockers.map((blocker) => (
                <li key={`${blocker.code}-${blocker.metric ?? ''}`}>
                  {blocker.code} · {blocker.detail}
                </li>
              ))}
            </ul>
          ) : null}
        </article>
      ) : null}
    </section>
  );
}

function RunResultSubmission({
  run,
  onClose,
  onSaved,
  onError,
}: {
  run: AiEvaluationRun | null;
  onClose: () => void;
  onSaved: () => void;
  onError: (message: string) => void;
}): ReactNode {
  const [cases, setCases] = useState<readonly AiEvaluationCase[]>([]);
  const [complete, setComplete] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!run) return;
    const controller = new AbortController();
    void listEvaluationCases(run.datasetVersionId, { limit: 200 }, controller.signal)
      .then((response) => {
        setCases(response.items);
        setComplete(
          response.nextCursor === null && response.items.length === run.expectedCaseCount,
        );
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) onError(messageFromError(caught));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [onError, run]);

  if (!run) return null;

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!complete) return;
    const data = new FormData(event.currentTarget);
    try {
      const metric = text(data, 'metric') as AiEvaluationMetric;
      const direction = text(data, 'direction') as 'AT_LEAST' | 'AT_MOST' | 'ZERO';
      const threshold = Number(text(data, 'threshold'));
      const value = Number(text(data, 'value'));
      const sampleCount = Number(text(data, 'sampleCount'));
      const minimumSampleCount = Number(text(data, 'minimumSampleCount'));
      await submitEvaluationRun(run.id, {
        expectedRevision: run.revision,
        caseResults: cases.map((testCase) => ({
          caseId: testCase.id,
          judgeType: text(data, `${testCase.id}:judgeType`) as AiEvaluationJudgeType,
          passed: data.get(`${testCase.id}:passed`) === 'on',
          score: Number(text(data, `${testCase.id}:score`)),
          actualBehaviorHash: text(data, `${testCase.id}:actualBehaviorHash`),
          evidenceIds: parseUuidList(
            text(data, `${testCase.id}:evidenceIds`),
            `${testCase.caseKey} 结果证据`,
          ),
          detail: text(data, `${testCase.id}:detail`),
        })),
        metrics: [
          {
            metric,
            numerator: Number(text(data, 'numerator')),
            denominator: Number(text(data, 'denominator')),
            value,
            threshold,
            direction,
            sampleCount,
            minimumSampleCount,
            passed:
              sampleCount >= minimumSampleCount &&
              (direction === 'AT_LEAST'
                ? value >= threshold
                : direction === 'AT_MOST'
                  ? value <= threshold
                  : value === 0 && threshold === 0),
            evidenceIds: parseUuidList(text(data, 'metricEvidenceIds'), '指标证据'),
          },
        ],
        evidenceBundleUri: text(data, 'evidenceBundleUri'),
        evidenceBundleHash: text(data, 'evidenceBundleHash'),
        runnerAttestation: text(data, 'runnerAttestation'),
        idempotencyKey: crypto.randomUUID(),
      });
      onSaved();
    } catch (caught) {
      onError(messageFromError(caught));
    }
  };

  return (
    <form className="card evaluation-form" onSubmit={(event) => void submit(event)}>
      <h3>提交完整签名结果</h3>
      <p>该入口只提交真实 Runner 产物。系统不会替你生成哈希、证据 ID、分数或签名声明。</p>
      {loading ? <Spinner label="正在读取密封用例…" /> : null}
      {!loading && !complete ? (
        <p className="field-error">
          当前管理端未加载到全部 {run.expectedCaseCount} 个密封用例，已阻断提交。请使用外部 Runner
          API 分页读取并完整提交。
        </p>
      ) : null}
      {cases.map((testCase) => (
        <fieldset key={testCase.id}>
          <legend>
            {testCase.caseKey} · {testCase.category}
          </legend>
          <div className="evaluation-three-column">
            <label>
              判定方式
              <select name={`${testCase.id}:judgeType`} defaultValue="EXTERNAL_RUNNER">
                <option value="EXTERNAL_RUNNER">外部 Runner</option>
                <option value="SIGNED_CODE">签名代码</option>
                <option value="DETERMINISTIC_RULE">确定性规则</option>
                <option value="HUMAN">人工</option>
              </select>
            </label>
            <label>
              分数
              <input
                name={`${testCase.id}:score`}
                type="number"
                min="0"
                max="1"
                step="0.01"
                required
              />
            </label>
            <label className="evaluation-inline-check">
              <input name={`${testCase.id}:passed`} type="checkbox" />
              用例通过
            </label>
          </div>
          <label>
            实际行为 SHA-256
            <input
              name={`${testCase.id}:actualBehaviorHash`}
              minLength={64}
              maxLength={64}
              required
            />
          </label>
          <label>
            用例结果证据 ID
            <textarea name={`${testCase.id}:evidenceIds`} required rows={2} />
          </label>
          <label>
            判定详情
            <textarea name={`${testCase.id}:detail`} required rows={2} />
          </label>
        </fieldset>
      ))}
      <div className="evaluation-three-column">
        <label>
          聚合指标
          <select name="metric" defaultValue="FACTUAL_ACCURACY">
            {EVALUATION_METRICS.map((metric) => (
              <option key={metric.value} value={metric.value}>
                {metric.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          方向
          <select name="direction" defaultValue="AT_LEAST">
            <option value="AT_LEAST">至少</option>
            <option value="AT_MOST">至多</option>
            <option value="ZERO">必须为零</option>
          </select>
        </label>
        <label>
          阈值
          <input name="threshold" type="number" min="0" step="0.01" required />
        </label>
        <label>
          分子
          <input name="numerator" type="number" min="0" step="0.01" required />
        </label>
        <label>
          分母
          <input name="denominator" type="number" min="0" step="0.01" required />
        </label>
        <label>
          指标值
          <input name="value" type="number" min="0" step="0.01" required />
        </label>
        <label>
          样本数
          <input name="sampleCount" type="number" min="0" required />
        </label>
        <label>
          最小样本数
          <input name="minimumSampleCount" type="number" min="1" required />
        </label>
      </div>
      <label>
        指标证据 ID
        <textarea name="metricEvidenceIds" required rows={2} />
      </label>
      <label>
        证据包 HTTPS URI
        <input name="evidenceBundleUri" type="url" required />
      </label>
      <label>
        证据包 SHA-256
        <input name="evidenceBundleHash" minLength={64} maxLength={64} required />
      </label>
      <label>
        Runner 签名声明
        <textarea name="runnerAttestation" required rows={3} />
      </label>
      <div className="evaluation-actions">
        <button className="button secondary" type="button" onClick={onClose}>
          取消
        </button>
        <button className="button primary" type="submit" disabled={!complete}>
          提交真实结果
        </button>
      </div>
    </form>
  );
}

function text(data: FormData, key: string): string {
  return String(data.get(key) ?? '').trim();
}
