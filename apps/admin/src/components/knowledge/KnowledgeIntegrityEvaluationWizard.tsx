import type {
  AiEvaluationDataset,
  AiEvaluationDatasetVersion,
  AiEvaluationRun,
  AiEvaluationRunner,
  Evidence,
  KnowledgeDocumentSummary,
  KnowledgeDocumentVersionSummary,
} from '@enterprise/contracts';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';

import { listKnowledgeDocumentChunks } from '@/api/admin-api';
import { messageFromError } from '@/api/client';
import { FieldError, Modal, Notice, Spinner, StatusPill } from '@/components/ui';
import {
  annotateEvaluationCase,
  createEvaluationDataset,
  createEvaluationDatasetVersion,
  createEvaluationCase,
  createEvaluationRun,
  listEvaluationDatasets,
  listEvaluationDatasetVersions,
  listEvaluationRunners,
  listEvaluationRuns,
  loadEvaluationReadiness,
  startEvaluationRun,
  transitionEvaluationDatasetVersion,
} from '@/features/ai-evaluation/api';
import { listEvidence } from '@/features/business-semantics/api';

import {
  buildKnowledgeIntegrityCases,
  buildKnowledgeIntegrityVersionRequest,
  knowledgeIntegrityDatasetCode,
} from './knowledge-integrity-evaluation';

const UNKNOWN_SNAPSHOT_HASH = '0'.repeat(64);

interface WizardState {
  readonly dataset: AiEvaluationDataset | null;
  readonly version: AiEvaluationDatasetVersion | null;
  readonly runners: readonly AiEvaluationRunner[];
  readonly runs: readonly AiEvaluationRun[];
  readonly evidence: readonly Evidence[];
  readonly firstChunk: string | null;
}

const EMPTY_STATE: WizardState = {
  dataset: null,
  version: null,
  runners: [],
  runs: [],
  evidence: [],
  firstChunk: null,
};

export function KnowledgeIntegrityEvaluationWizard({
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
  const [state, setState] = useState<WizardState>(EMPTY_STATE);
  const [selectedEvidenceId, setSelectedEvidenceId] = useState('');
  const [selectedRunnerId, setSelectedRunnerId] = useState('');
  const [attested, setAttested] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const datasetCode = knowledgeIntegrityDatasetCode(version.id);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const [datasetResponse, runnerResponse, evidenceItems, chunks] = await Promise.all([
        listEvaluationDatasets({ limit: 200 }),
        listEvaluationRunners({ limit: 100 }),
        listEvidence(),
        listKnowledgeDocumentChunks(knowledgeBaseId, document.id, version.id, {
          offset: 0,
          limit: 1,
        }),
      ]);
      const dataset = datasetResponse.items.find(({ code }) => code === datasetCode) ?? null;
      const versions =
        dataset === null
          ? []
          : (await listEvaluationDatasetVersions(dataset.id, { limit: 100 })).items;
      const matchingVersion =
        [...versions]
          .filter((candidate) => candidate.targets.knowledgeVersionIds.includes(version.id))
          .sort((left, right) => right.version - left.version)[0] ?? null;
      const runs = (
        await listEvaluationRuns({
          subjectType: 'KNOWLEDGE_VERSION',
          subjectId: version.id,
          subjectVersion: version.versionNumber,
          limit: 100,
        })
      ).items;
      const trustedEvidence = evidenceItems.filter(
        (item) =>
          item.status === 'ACTIVE' &&
          item.trustLevel === 'VERIFIED' &&
          item.verifiedAt !== null &&
          item.sourceType === 'DOCUMENT' &&
          (item.sourceRecordId === version.id || item.sourceRecordId === document.id),
      );
      setState({
        dataset,
        version: matchingVersion,
        runners: runnerResponse.items,
        runs,
        evidence: trustedEvidence,
        firstChunk: chunks.items[0]?.content ?? null,
      });
      setSelectedEvidenceId((current) =>
        trustedEvidence.some(({ id }) => id === current) ? current : (trustedEvidence[0]?.id ?? ''),
      );
      setSelectedRunnerId((current) =>
        runnerResponse.items.some(({ id }) => id === current)
          ? current
          : (runnerResponse.items[0]?.id ?? ''),
      );
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setLoading(false);
    }
  }, [datasetCode, document.id, knowledgeBaseId, version.id, version.versionNumber]);

  useEffect(() => {
    void load();
  }, [load]);

  const matchingRun = useMemo(
    () =>
      [...state.runs].sort((left, right) => {
        const priority = runPriority(right.status) - runPriority(left.status);
        return priority || Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
      })[0] ?? null,
    [state.runs],
  );

  const prepare = async (): Promise<void> => {
    if (state.firstChunk === null) {
      setError('候选版本没有可密封的切片，不能创建系统完整性评测。');
      return;
    }
    if (selectedEvidenceId === '') {
      setError('必须选择一条当前租户内 ACTIVE、VERIFIED 的治理证据。');
      return;
    }
    if (!attested) {
      setError('请先确认已核对候选切片与所选治理证据。');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const dataset =
        state.dataset ??
        (await createEvaluationDataset({
          code: datasetCode,
          name: `${document.title} v${version.versionNumber} 系统完整性评测`,
          description:
            '系统生成的知识候选完整性数据集。它验证密封切片、引用、权限负例、无答案合同和检索链路，不声明真实语义质量。',
          idempotencyKey: `knowledge-integrity:${version.id}:dataset`,
        }));
      const datasetVersion =
        state.version ??
        (await createEvaluationDatasetVersion(
          dataset.id,
          buildKnowledgeIntegrityVersionRequest({
            documentTitle: document.title,
            version,
          }),
        ));
      if (datasetVersion.status !== 'DRAFT') {
        await load();
        return;
      }
      const cases = buildKnowledgeIntegrityCases({
        documentVersionId: version.id,
        excerpt: state.firstChunk,
        evidenceIds: [selectedEvidenceId],
      });
      for (const request of cases) {
        const created = await createEvaluationCase(datasetVersion.id, request);
        await annotateEvaluationCase(created.id, {
          label: 'PASS',
          expectedScore: 1,
          rationale:
            '创建人已核对该系统完整性探针、候选版本切片与所选治理证据的绑定；最终发布仍需另一名管理员审核。',
          evidenceIds: [selectedEvidenceId],
          expectedRevision: 0,
          idempotencyKey: `knowledge-integrity:${version.id}:annotation:${created.id}`,
        });
      }
      const refreshedVersion = (
        await listEvaluationDatasetVersions(dataset.id, { limit: 100 })
      ).items.find(({ id }) => id === datasetVersion.id);
      if (refreshedVersion === undefined) {
        throw new Error('系统完整性评测集创建后未能重新读取，请刷新后重试。');
      }
      if (refreshedVersion.status === 'DRAFT') {
        await transitionEvaluationDatasetVersion(refreshedVersion.id, {
          action: 'SUBMIT',
          expectedRevision: refreshedVersion.revision,
          idempotencyKey: `knowledge-integrity:${version.id}:submit`,
        });
      }
      await load();
      onChanged('系统完整性评测集已创建并提交，必须由另一名管理员审核后才能运行。');
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setBusy(false);
    }
  };

  const publishDataset = async (): Promise<void> => {
    if (state.version?.status !== 'APPROVED') return;
    setBusy(true);
    setError(null);
    try {
      await transitionEvaluationDatasetVersion(state.version.id, {
        action: 'PUBLISH',
        expectedRevision: state.version.revision,
        idempotencyKey: `knowledge-integrity:${version.id}:publish-dataset`,
      });
      await load();
      onChanged('独立审核通过的系统完整性评测集已发布，可以调用可信 Runner。');
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setBusy(false);
    }
  };

  const execute = async (): Promise<void> => {
    if (state.version?.status !== 'PUBLISHED' || selectedRunnerId === '') return;
    const runner = state.runners.find(({ id }) => id === selectedRunnerId);
    if (runner === undefined) return;
    setBusy(true);
    setError(null);
    try {
      const reusableRun = state.runs.find(({ status }) => status === 'CREATED');
      let run = reusableRun;
      if (run === undefined) {
        const readiness = await loadEvaluationReadiness({
          subjectType: 'KNOWLEDGE_VERSION',
          subjectId: version.id,
          subjectVersion: version.versionNumber,
          datasetVersionId: state.version.id,
          currentSnapshotHash: UNKNOWN_SNAPSHOT_HASH,
        });
        run = await createEvaluationRun({
          datasetVersionId: state.version.id,
          subjectType: 'KNOWLEDGE_VERSION',
          subjectId: version.id,
          subjectVersion: version.versionNumber,
          subjectSnapshotHash: readiness.currentSnapshotHash,
          runnerId: runner.id,
          runnerName: runner.name,
          externalRunId: `knowledge-integrity-${version.id}-${crypto.randomUUID()}`,
          idempotencyKey: crypto.randomUUID(),
        });
      }
      const result = await startEvaluationRun(run.id, {
        expectedRevision: run.revision,
        idempotencyKey: `knowledge-integrity:${version.id}:start:${run.id}`,
      });
      await load();
      onChanged(
        result.status === 'SUBMITTED'
          ? '可信 HMAC Runner 已返回完整结果，等待管理员独立复核。'
          : `系统完整性评测 Run 当前状态：${result.status}。`,
      );
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`系统完整性评测 · “${document.title}” v${version.versionNumber}`}
      description="一站式建立候选版本评测集、等待异人审核、调用可信 HMAC Runner，并把通过的 Run 交给发布门禁。"
      onClose={onClose}
      dismissible={!busy}
      size="wide"
    >
      {loading ? (
        <Spinner label="正在读取评测治理状态…" />
      ) : (
        <div className="form-stack knowledge-integrity-wizard">
          <Notice tone="info">
            该向导只证明切片、引用链、权限负例、无答案合同、检索链路和可信 Runner
            证据链完整。没有真实 Embedding、Reranker 和企业问题集时，仍不能标记为企业语义就绪。
          </Notice>

          <WizardStep
            number="1"
            title="创建系统完整性评测集"
            status={state.version?.status ?? '未创建'}
          >
            {state.version === null || state.version.status === 'DRAFT' ? (
              <>
                <label>
                  <span>绑定的 VERIFIED 治理证据</span>
                  <select
                    value={selectedEvidenceId}
                    onChange={(event) => setSelectedEvidenceId(event.target.value)}
                    disabled={busy}
                  >
                    <option value="">请选择与候选版本核对过的证据</option>
                    {state.evidence.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.summary} · {item.sourceSystem}/{item.sourceRecordId}
                      </option>
                    ))}
                  </select>
                </label>
                {state.evidence.length === 0 ? (
                  <p className="field-error">
                    当前没有绑定此文档或候选版本的 ACTIVE、VERIFIED 文档证据。请先在“业务语义 →
                    证据”中完成证据核验。
                  </p>
                ) : null}
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={attested}
                    onChange={(event) => setAttested(event.target.checked)}
                    disabled={busy}
                  />
                  我已核对候选切片与所选证据；系统将创建 9 类用例并提交异人审核。
                </label>
                <button
                  className="button primary"
                  type="button"
                  disabled={
                    busy || state.firstChunk === null || selectedEvidenceId === '' || !attested
                  }
                  onClick={() => void prepare()}
                >
                  {busy ? <Spinner label="正在创建并提交…" /> : '自动创建并提交评测集'}
                </button>
              </>
            ) : (
              <p>评测集已创建，候选版本状态为 {state.version.status}。</p>
            )}
          </WizardStep>

          <WizardStep
            number="2"
            title="另一名管理员审核"
            status={
              state.version?.status === 'APPROVED' ||
              state.version?.status === 'PUBLISHED' ||
              state.version?.status === 'RETIRED'
                ? '已完成'
                : '待异人审核'
            }
          >
            <p>
              创建人与审核人不能相同，服务端状态机会拒绝同一管理员审批。审核证据和批注意见在 AI
              评测页留痕。
            </p>
            <a className="button secondary compact" href="#ai-evaluation">
              前往 AI 评测审核
            </a>
            {state.version?.status === 'APPROVED' ? (
              <button
                className="button primary compact"
                type="button"
                disabled={busy}
                onClick={() => void publishDataset()}
              >
                发布已审核评测集
              </button>
            ) : null}
          </WizardStep>

          <WizardStep
            number="3"
            title="调用可信 HMAC Runner"
            status={matchingRun?.status ?? '未运行'}
          >
            {state.version?.status === 'PUBLISHED' ? (
              <>
                <label>
                  <span>已注册可信 Runner</span>
                  <select
                    value={selectedRunnerId}
                    onChange={(event) => setSelectedRunnerId(event.target.value)}
                    disabled={busy || state.runners.length === 0}
                  >
                    <option value="">请选择 Runner</option>
                    {state.runners.map((runner) => (
                      <option key={runner.id} value={runner.id}>
                        {runner.name} · {runner.id}
                      </option>
                    ))}
                  </select>
                </label>
                {state.runners.length === 0 ? (
                  <p className="field-error">
                    未配置可信 Runner。需同时配置 API 与 AI Runtime 的 HMAC Secret，并注册匹配指纹与
                    HTTPS 证据源；本向导不会伪造成功。
                  </p>
                ) : null}
                {matchingRun?.status === 'SUBMITTED' ? (
                  <p>Runner 已提交签名结果，请前往 AI 评测页由管理员复核证据。</p>
                ) : matchingRun?.status === 'PASSED' ? (
                  <p>Run {matchingRun.id} 已通过，可返回文档版本执行发布。</p>
                ) : (
                  <button
                    className="button primary"
                    type="button"
                    disabled={busy || selectedRunnerId === ''}
                    onClick={() => void execute()}
                  >
                    {busy ? <Spinner label="可信 Runner 执行中…" /> : '运行系统完整性评测'}
                  </button>
                )}
              </>
            ) : (
              <p>评测集必须先完成异人审核并发布，才能创建密封 Run。</p>
            )}
          </WizardStep>

          <FieldError message={error} />
          <div className="modal-actions">
            <button className="button secondary" type="button" onClick={onClose} disabled={busy}>
              关闭
            </button>
            {matchingRun?.status === 'PASSED' ? (
              <button className="button primary" type="button" onClick={onClose}>
                返回版本发布
              </button>
            ) : null}
          </div>
        </div>
      )}
    </Modal>
  );
}

function WizardStep({
  number,
  title,
  status,
  children,
}: {
  number: string;
  title: string;
  status: string;
  children: ReactNode;
}): ReactNode {
  return (
    <section className="knowledge-integrity-step">
      <header>
        <span>{number}</span>
        <strong>{title}</strong>
        <StatusPill value={status} label={status} />
      </header>
      <div>{children}</div>
    </section>
  );
}

function runPriority(status: AiEvaluationRun['status']): number {
  return (
    {
      PASSED: 7,
      SUBMITTED: 6,
      VERIFIED: 5,
      RUNNING: 4,
      CREATED: 3,
      FAILED: 2,
      CANCELLED: 1,
    }[status] ?? 0
  );
}
