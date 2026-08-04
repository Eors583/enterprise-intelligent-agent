import type {
  AiEvaluationCase,
  AiEvaluationReadiness,
  AiEvaluationRun,
  AiEvaluationRunner,
  Evidence,
} from '@enterprise/contracts';
import { useEffect, useState, type ChangeEvent, type FormEvent, type ReactNode } from 'react';

import { messageFromError } from '@/api/client';
import { Notice, Spinner, StatusPill } from '@/components/ui';
import { listEvidence } from '@/features/business-semantics/api';

import {
  createEvaluationRun,
  listEvaluationCases,
  loadEvaluationReadiness,
  startEvaluationRun,
  submitEvaluationRun,
  verifyEvaluationRun,
} from './api';
import {
  createRunRequestFromSelection,
  deriveEvaluationRunChoices,
  parseRunnerResultPackage,
  type ParsedRunnerResultPackage,
} from './run-governance';
import { runStatusLabel } from './view';

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
  const [evidence, setEvidence] = useState<readonly Evidence[]>([]);
  const choices = deriveEvaluationRunChoices(runs);
  const [datasetVersionId, setDatasetVersionId] = useState(choices.datasetVersionIds[0] ?? '');
  const [subjectChoiceKey, setSubjectChoiceKey] = useState('');
  const [runnerId, setRunnerId] = useState(runners[0]?.id ?? '');
  const availableSubjects = choices.subjects.filter(
    (subject) => subject.datasetVersionId === datasetVersionId,
  );
  const selectedSubject =
    availableSubjects.find((subject) => subject.key === subjectChoiceKey) ?? null;
  const selectedRunner = runners.find((runner) => runner.id === runnerId) ?? null;
  const verifiedEvidence = evidence.filter(
    (item) => item.status === 'ACTIVE' && item.trustLevel === 'VERIFIED',
  );

  useEffect(() => {
    const controller = new AbortController();
    void listEvidence(controller.signal)
      .then(setEvidence)
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) {
          onError(`验证证据目录加载失败：${messageFromError(caught)}`);
        }
      });
    return () => controller.abort();
  }, [onError]);

  useEffect(() => {
    setDatasetVersionId((current) =>
      choices.datasetVersionIds.includes(current) ? current : (choices.datasetVersionIds[0] ?? ''),
    );
  }, [choices.datasetVersionIds]);

  useEffect(() => {
    setSubjectChoiceKey((current) =>
      availableSubjects.some((subject) => subject.key === current)
        ? current
        : (availableSubjects[0]?.key ?? ''),
    );
  }, [availableSubjects]);

  useEffect(() => {
    setRunnerId((current) =>
      runners.some((runner) => runner.id === current) ? current : (runners[0]?.id ?? ''),
    );
  }, [runners]);

  const createRunFromSelection = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!selectedRunner || !selectedSubject) {
      onError('缺少真实数据集、发布对象或 ACTIVE Runner，无法创建可信 Run。');
      return;
    }
    const idempotencyKey = crypto.randomUUID();
    setBusyId('run');
    try {
      const created = await createEvaluationRun(
        createRunRequestFromSelection({
          subject: selectedSubject,
          runner: selectedRunner,
          idempotencyKey,
        }),
      );
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
        evidenceIds: data.getAll('evidenceIds').map(String),
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
        <article className="card evaluation-form">
          <h3>评测执行服务</h3>
          <Notice tone={runners.length > 0 ? 'success' : 'info'}>
            {runners.length > 0
              ? `已接入 ${runners.length} 个可用执行服务。签名、密钥和证据来源由连接器自动维护。`
              : '尚未接入评测执行服务。当前版本不提供连接器管理页面，请由部署管理员在服务端完成配置。'}
          </Notice>
        </article>

        <article className="card evaluation-form">
          <h3>创建可信 Run</h3>
          <p className="evaluation-help">
            普通路径只复用当前页面真实 Run 中已经绑定的数据集与发布对象快照；Runner
            名称自动取自已注册记录，外部关联号由本次请求生成。
          </p>
          {choices.datasetVersionIds.length === 0 ? (
            <p className="field-error">
              当前页面没有可复用的数据集或发布对象，已阻断创建。请先完成数据集发布和对象测试，
              系统会自动绑定其版本与快照。
            </p>
          ) : null}
          {runners.length === 0 ? (
            <p className="field-error">
              当前没有可用评测执行服务，请由部署管理员在服务端完成配置。
            </p>
          ) : null}
          <form
            className="evaluation-form"
            onSubmit={(event) => void createRunFromSelection(event)}
          >
            <label>
              已发布数据集
              <select
                name="datasetChoice"
                required
                value={datasetVersionId}
                onChange={(event) => setDatasetVersionId(event.target.value)}
              >
                <option value="">请选择</option>
                {choices.datasetVersionIds.map((id) => (
                  <option key={id} value={id}>
                    {id} · 来自现有 Run
                  </option>
                ))}
              </select>
            </label>
            <label>
              Runner
              <select
                name="runnerChoice"
                required
                value={runnerId}
                onChange={(event) => setRunnerId(event.target.value)}
              >
                <option value="">请选择</option>
                {runners.map((runner) => (
                  <option key={runner.id} value={runner.id}>
                    {runner.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              发布对象
              <select
                name="subjectChoice"
                required
                value={subjectChoiceKey}
                onChange={(event) => setSubjectChoiceKey(event.target.value)}
              >
                <option value="">请选择</option>
                {availableSubjects.map((subject) => (
                  <option key={subject.key} value={subject.key}>
                    {subject.subjectType} · {subject.subjectId} · v{subject.subjectVersion}
                  </option>
                ))}
              </select>
            </label>
            {selectedSubject ? (
              <p className="evaluation-help">
                已从真实记录绑定对象版本 v{selectedSubject.subjectVersion} 与快照{' '}
                <code>{selectedSubject.subjectSnapshotHash.slice(0, 12)}…</code>
              </p>
            ) : null}
            <button
              className="button primary"
              type="submit"
              disabled={busyId !== null || selectedRunner === null || selectedSubject === null}
            >
              选择完成并创建 Run
            </button>
          </form>
        </article>
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
            已验证证据
            <select
              name="evidenceIds"
              required
              multiple
              size={Math.min(6, Math.max(3, verifiedEvidence.length))}
            >
              {verifiedEvidence.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.summary || item.code} · {item.sourceSystem}
                </option>
              ))}
            </select>
          </label>
          {verifiedEvidence.length === 0 ? (
            <p className="field-error">
              当前没有可选择的已验证证据，请先在经营主链登记并验证证据。
            </p>
          ) : null}
          <div className="evaluation-actions">
            <button className="button secondary" type="button" onClick={() => setVerifyRunId('')}>
              取消
            </button>
            <button
              className="button primary"
              type="submit"
              disabled={busyId !== null || verifiedEvidence.length === 0}
            >
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
  const [resultPackage, setResultPackage] = useState<ParsedRunnerResultPackage | null>(null);
  const [packageError, setPackageError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

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

  const uploadResultPackage = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    setResultPackage(null);
    setPackageError(null);
    if (!file) return;
    try {
      const parsed = parseRunnerResultPackage(await file.text(), run, cases);
      setResultPackage(parsed);
    } catch (caught) {
      setPackageError(messageFromError(caught));
    }
  };

  const submitResultPackage = async (): Promise<void> => {
    if (!complete || !resultPackage) return;
    setSubmitting(true);
    try {
      await submitEvaluationRun(run.id, {
        expectedRevision: run.revision,
        ...resultPackage.payload,
        idempotencyKey: crypto.randomUUID(),
      });
      onSaved();
    } catch (caught) {
      onError(messageFromError(caught));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="card evaluation-form">
      <h3>提交完整签名结果</h3>
      <p>
        上传真实 Runner 导出的 JSON 结果包，管理端只解析、校验当前
        Run/Runner/对象快照绑定并预览，不生成哈希、证据、指标或签名。
      </p>
      {loading ? <Spinner label="正在读取密封用例…" /> : null}
      {!loading && !complete ? (
        <p className="field-error">
          当前管理端未加载到全部 {run.expectedCaseCount} 个密封用例，已阻断提交。请使用外部 Runner
          API 分页读取并完整提交。
        </p>
      ) : null}
      <label>
        Runner JSON 结果包
        <input
          name="runnerResultPackage"
          type="file"
          accept="application/json,.json"
          disabled={!complete || submitting}
          onChange={(event) => void uploadResultPackage(event)}
        />
      </label>
      <p className="evaluation-help">
        支持 Runtime 原生 snake_case 签名信封或管理端 camelCase
        结果包。预览只验证结构与当前记录绑定；签名真实性仍由可信 Runtime/服务端验证。
      </p>
      {packageError ? <p className="field-error">{packageError}</p> : null}
      {resultPackage ? (
        <article className="evaluation-readiness ready" aria-label="Runner 结果包预览">
          <header>
            <h4>结果包待确认</h4>
            <strong>{resultPackage.preview.algorithm}</strong>
          </header>
          <dl>
            <div>
              <dt>用例 / 行为哈希</dt>
              <dd>
                {resultPackage.preview.caseCount} / {resultPackage.preview.caseHashCount}
              </dd>
            </div>
            <div>
              <dt>指标</dt>
              <dd>
                {resultPackage.preview.metricCount} · {resultPackage.preview.metricNames.join('、')}
              </dd>
            </div>
            <div>
              <dt>唯一证据</dt>
              <dd>{resultPackage.preview.evidenceIdCount}</dd>
            </div>
            <div>
              <dt>签名指纹</dt>
              <dd>{resultPackage.preview.keyFingerprint}</dd>
            </div>
            <div>
              <dt>证据包</dt>
              <dd>{resultPackage.preview.evidenceBundleUri}</dd>
            </div>
            <div>
              <dt>证据包哈希</dt>
              <dd>{resultPackage.preview.evidenceBundleHash}</dd>
            </div>
          </dl>
        </article>
      ) : null}
      <div className="evaluation-actions">
        <button className="button secondary" type="button" onClick={onClose}>
          取消
        </button>
        <button
          className="button primary"
          type="button"
          disabled={!complete || resultPackage === null || submitting}
          onClick={() => void submitResultPackage()}
        >
          {submitting ? '提交中…' : '确认并提交 Runner 结果包'}
        </button>
      </div>
    </section>
  );
}

function text(data: FormData, key: string): string {
  return String(data.get(key) ?? '').trim();
}
