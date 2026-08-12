import {
  type AiEvaluationDatasetVersion,
  type BulkKnowledgeRetrievalEvaluationCase,
  type Evidence,
  type KnowledgeRetrievalBenchmarkRunSummary,
} from '@enterprise/contracts';
import { useEffect, useMemo, useState, type ChangeEvent, type ReactNode } from 'react';

import { messageFromError } from '@/api/client';
import { Spinner, StatusPill } from '@/components/ui';

import {
  bulkImportKnowledgeRetrievalEvaluationCases,
  listKnowledgeRetrievalBenchmarks,
  runKnowledgeRetrievalBenchmark,
} from './api';
import {
  parseQuestionFile,
  questionCoverage,
  type ParsedQuestionFile,
} from './knowledge-retrieval-question-file';

interface BenchmarkProgress {
  readonly processed: number;
  readonly total: number;
}

export function KnowledgeRetrievalEvaluationPanel({
  version,
  evidence,
  refreshToken,
  onChanged,
  onLatestRunChange,
  onNotice,
  onError,
}: {
  version: AiEvaluationDatasetVersion;
  evidence: readonly Evidence[];
  refreshToken: number;
  onChanged: () => void;
  onLatestRunChange: (run: KnowledgeRetrievalBenchmarkRunSummary | null) => void;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
}): ReactNode {
  const [parsed, setParsed] = useState<ParsedQuestionFile | null>(null);
  const [selectedEvidenceId, setSelectedEvidenceId] = useState('');
  const [annotationRationale, setAnnotationRationale] = useState(
    '资料负责人依据当前已发布原文核对问题、答案和标准切片。',
  );
  const [runs, setRuns] = useState<readonly KnowledgeRetrievalBenchmarkRunSummary[]>([]);
  const [progress, setProgress] = useState<BenchmarkProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadingRuns, setLoadingRuns] = useState(true);

  const selectedEvidence = evidence.find(({ id }) => id === selectedEvidenceId) ?? null;
  const coverage = useMemo(() => questionCoverage(parsed?.cases ?? []), [parsed]);
  const latest = runs[0] ?? null;

  useEffect(() => {
    if (selectedEvidenceId === '' && evidence[0] !== undefined) {
      setSelectedEvidenceId(evidence[0].id);
    }
  }, [evidence, selectedEvidenceId]);

  useEffect(() => {
    const controller = new AbortController();
    setLoadingRuns(true);
    void listKnowledgeRetrievalBenchmarks(version.id, { limit: 20 }, controller.signal)
      .then(({ items }) => {
        setRuns(items);
        onLatestRunChange(items[0] ?? null);
        const running = items.find(({ status }) => status === 'RUNNING');
        setProgress(
          running === undefined
            ? null
            : { processed: running.processedCaseCount, total: running.totalCaseCount },
        );
      })
      .catch((caught) => {
        if (!controller.signal.aborted) onError(messageFromError(caught));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingRuns(false);
      });
    return () => controller.abort();
  }, [onError, onLatestRunChange, refreshToken, version.id]);

  useEffect(() => {
    if (!busy && progress === null) return;
    let cancelled = false;
    const poll = async (): Promise<void> => {
      try {
        const { items } = await listKnowledgeRetrievalBenchmarks(version.id, { limit: 20 });
        if (cancelled) return;
        setRuns(items);
        onLatestRunChange(items[0] ?? null);
        const running = items.find(({ status }) => status === 'RUNNING');
        if (running !== undefined) {
          setProgress({
            processed: running.processedCaseCount,
            total: running.totalCaseCount,
          });
        } else if (!busy) {
          setProgress(null);
        }
      } catch {
        // The blocking benchmark request remains the source of truth. A
        // transient progress poll failure must not cancel or duplicate it.
      }
    };
    const timer = window.setInterval(() => void poll(), 2_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [busy, onLatestRunChange, progress, version.id]);

  const chooseFile = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file === undefined) return;
    setBusy(true);
    try {
      setParsed(parseQuestionFile(file.name, await file.text()));
    } catch (caught) {
      onError(messageFromError(caught));
    } finally {
      setBusy(false);
    }
  };

  const importCases = async (): Promise<void> => {
    if (parsed === null || parsed.cases.length === 0) {
      onError('请先选择并校验 CSV、JSON 或 JSONL 题集。');
      return;
    }
    if (parsed.errors.length > 0) {
      onError('题集仍有格式错误，请修正后重新选择文件。');
      return;
    }
    if (selectedEvidence === null) {
      onError('请选择一条 ACTIVE + VERIFIED 的资料核对证据。');
      return;
    }
    setBusy(true);
    try {
      const result = await bulkImportKnowledgeRetrievalEvaluationCases(version.id, {
        evidenceId: selectedEvidence.id,
        annotationRationale,
        cases: [...parsed.cases],
        idempotencyKey: crypto.randomUUID(),
      });
      if (result.failedCount > 0) {
        setParsed({
          ...parsed,
          errors: result.failures.map(
            (failure) =>
              `第 ${failure.rowNumber} 行 ${failure.caseKey}：${failure.message}（${failure.code}）`,
          ),
        });
        onError(
          `已导入 ${result.importedCount} 条，另有 ${result.failedCount} 条失败；失败行已显示。`,
        );
      } else {
        setParsed(null);
        onNotice(
          `已导入并标注 ${result.annotatedCount} 道题；当前版本共 ${result.datasetCaseCount} 道。`,
        );
      }
      onChanged();
    } catch (caught) {
      onError(messageFromError(caught));
    } finally {
      setBusy(false);
    }
  };

  const runBenchmark = async (): Promise<void> => {
    setBusy(true);
    setProgress({ processed: 0, total: version.caseCount });
    try {
      const run = await runKnowledgeRetrievalBenchmark(version.id, {
        thresholds: {
          minRecallAt5: 0.8,
          minMrr: 0.7,
          minNdcgAt10: 0.7,
          minCitationSupportRate: 0.9,
          minNoAnswerAccuracy: 0.9,
          maxP95LatencyMs: 3_000,
          maxAclLeakCount: 0,
          minCaseCount: 200,
          minAnswerableCount: 150,
          minNoAnswerCount: 25,
          minAclCaseCount: 25,
        },
        concurrency: 1,
        idempotencyKey: crypto.randomUUID(),
      });
      const { items } = await listKnowledgeRetrievalBenchmarks(version.id, { limit: 20 });
      setRuns(items);
      onLatestRunChange(items[0] ?? null);
      setProgress(null);
      onNotice(
        run.status === 'PASSED'
          ? '真实检索基准已通过企业阈值。'
          : `真实检索基准已完成，有 ${run.failures.length} 项未达到阈值。`,
      );
    } catch (caught) {
      onError(messageFromError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      className="card retrieval-evaluation-panel"
      aria-labelledby="retrieval-evaluation-heading"
    >
      <header>
        <div>
          <span className="eyebrow">SOURCE-GROUNDED RETRIEVAL EVALUATION</span>
          <h3 id="retrieval-evaluation-heading">来源绑定题集与检索效果</h3>
          <p>
            每道题绑定正确切片，系统会实际走关键词、向量、重排、关系和 SQL
            路由，再计算排名指标；不会用答案文本相似度冒充 Recall。
          </p>
          <p>
            题集可以是业务部门提供的真实问题，也可以是从已发布原文生成的技术验收基线；系统会保留来源说明，不把后者冒充员工真实提问。
          </p>
        </div>
        <StatusPill
          value={version.caseCount >= 200 ? 'READY' : 'INCOMPLETE'}
          label={version.caseCount >= 200 ? '题量达标' : `${version.caseCount}/200 道`}
        />
      </header>

      <ol className="retrieval-evaluation-steps" aria-label="检索评测流程">
        <li className={version.status === 'DRAFT' ? 'is-current' : 'is-complete'}>
          <strong>1. 导入并核对</strong>
          <span>建议 200–500 道，其中至少 25 道无答案、25 道权限反例。</span>
        </li>
        <li className={version.status === 'IN_REVIEW' ? 'is-current' : ''}>
          <strong>2. 异人审核发布</strong>
          <span>提交人不能批准自己的题集，发布后内容不可改。</span>
        </li>
        <li className={version.status === 'PUBLISHED' ? 'is-current' : ''}>
          <strong>3. 运行真实检索</strong>
          <span>展示 Recall@5、MRR、nDCG@10、来源支撑率和 P95。</span>
        </li>
      </ol>

      {version.status === 'DRAFT' ? (
        <div className="retrieval-evaluation-import">
          <div className="evaluation-actions">
            <button className="button secondary" type="button" onClick={downloadCsvTemplate}>
              下载 CSV 模板
            </button>
            <label className="button secondary file-button">
              选择题集文件
              <input
                type="file"
                accept=".csv,.json,.jsonl,application/json,text/csv"
                onChange={(event) => void chooseFile(event)}
              />
            </label>
          </div>
          <small>
            relevance 填“切片 UUID → 相关等级
            1–3”；无答案题填空对象。标准切片可先在知识库“检索测试”中查看并复制。
          </small>

          {parsed ? (
            <div className="retrieval-evaluation-preview" aria-live="polite">
              <h4>
                {parsed.fileName} · {parsed.cases.length} 道有效题
              </h4>
              <dl className="evaluation-definition">
                <div>
                  <dt>可回答</dt>
                  <dd>{coverage.answerable}</dd>
                </div>
                <div>
                  <dt>无答案</dt>
                  <dd>{coverage.noAnswer}</dd>
                </div>
                <div>
                  <dt>权限反例</dt>
                  <dd>{coverage.acl}</dd>
                </div>
                <div>
                  <dt>问题路由标注</dt>
                  <dd>{coverage.routed}</dd>
                </div>
              </dl>
              {parsed.errors.length > 0 ? (
                <div className="inline-error" role="alert">
                  <strong>有 {parsed.errors.length} 个问题，尚不能导入：</strong>
                  <ul>
                    {parsed.errors.slice(0, 20).map((error) => (
                      <li key={error}>{error}</li>
                    ))}
                  </ul>
                </div>
              ) : (
                <div className="retrieval-evaluation-table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>题号</th>
                        <th>问题</th>
                        <th>标准切片</th>
                        <th>类型</th>
                      </tr>
                    </thead>
                    <tbody>
                      {parsed.cases.slice(0, 8).map((item) => (
                        <tr key={item.caseKey}>
                          <td>
                            <code>{item.caseKey}</code>
                          </td>
                          <td>{item.query}</td>
                          <td>{Object.keys(item.groundTruth.relevance).length}</td>
                          <td>
                            {item.groundTruth.expectedNoAnswer
                              ? '无答案'
                              : (item.groundTruth.expectedRoute ?? '文档')}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <label>
                资料核对证据
                <select
                  value={selectedEvidenceId}
                  onChange={(event) => setSelectedEvidenceId(event.target.value)}
                >
                  <option value="">请选择 ACTIVE + VERIFIED 证据</option>
                  {evidence.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.code} · {item.summary}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                本批核对说明
                <textarea
                  rows={2}
                  value={annotationRationale}
                  onChange={(event) => setAnnotationRationale(event.target.value)}
                />
              </label>
              <button
                className="button primary"
                type="button"
                disabled={busy || parsed.errors.length > 0 || selectedEvidence === null}
                onClick={() => void importCases()}
              >
                导入并形成已标注题集
              </button>
            </div>
          ) : null}
        </div>
      ) : (
        <p className="inline-notice">
          当前版本为“{version.status}”。只有草稿可导入；只有完成独立审核并发布的版本可运行正式基准。
        </p>
      )}

      {version.status === 'PUBLISHED' ? (
        <div className="evaluation-actions">
          <button
            className="button primary"
            type="button"
            disabled={busy}
            onClick={() => void runBenchmark()}
          >
            运行 200–500 道来源绑定检索
          </button>
          <small>
            精确基准按单请求串行测量，避免本地 CPU
            模型互相争抢；并发容量由单独的负载验收执行。每题均使用题集中指定的模拟用户执行权限过滤。
          </small>
        </div>
      ) : null}

      {loadingRuns ? <Spinner label="正在读取历史检索基准…" /> : null}
      {latest?.metrics ? (
        <BenchmarkSummary run={latest} />
      ) : !loadingRuns ? (
        <p>尚无真实检索基准。</p>
      ) : null}
      {progress ? (
        <div className="retrieval-benchmark-progress" role="status" aria-live="polite">
          <strong>
            正在逐题检索：{progress.processed}/{progress.total}
          </strong>
          <progress max={Math.max(1, progress.total)} value={progress.processed} />
          <small>页面每 2 秒读取一次服务端真实进度；历史失败 Run 会保留，不会被本次覆盖。</small>
        </div>
      ) : null}
      {busy ? <Spinner label="正在处理来源绑定检索评测…" /> : null}
    </section>
  );
}

function BenchmarkSummary({ run }: { run: KnowledgeRetrievalBenchmarkRunSummary }): ReactNode {
  const metrics = run.metrics;
  if (metrics === null) return null;
  return (
    <div className="retrieval-benchmark-summary">
      <header>
        <h4>最近一次真实基准</h4>
        <StatusPill value={run.status} label={run.status === 'PASSED' ? '通过' : '未通过'} />
      </header>
      <div className="retrieval-benchmark-metrics">
        <Metric label="Recall@5" value={percentage(metrics.recallAt5)} />
        <Metric label="MRR" value={percentage(metrics.mrr)} />
        <Metric label="nDCG@10" value={percentage(metrics.ndcgAt10)} />
        <Metric label="来源支撑率" value={percentage(metrics.citationSupportRate)} />
        <Metric label="无答案准确率" value={percentage(metrics.noAnswerAccuracy)} />
        <Metric
          label="P95"
          value={
            metrics.p95LatencyMs === null ? '不可用' : `${Math.round(metrics.p95LatencyMs)} ms`
          }
        />
      </div>
      <p>
        完成 {metrics.evaluatedCaseCount} 道 · 可回答 {metrics.answerableCaseCount} · 无答案{' '}
        {metrics.noAnswerCaseCount} · 权限反例 {metrics.aclCaseCount} · ACL 泄漏{' '}
        {metrics.aclLeakCount}
      </p>
      {run.failures.length > 0 ? (
        <details className="inline-error" open>
          <summary>{run.failures.length} 项未达标</summary>
          <ul>
            {run.failures.map((failure) => (
              <li key={failure}>{failure}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }): ReactNode {
  return (
    <article>
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

function percentage(value: number | null): string {
  return value === null ? '不可用' : `${(value * 100).toFixed(1)}%`;
}

function downloadCsvTemplate(): void {
  const headers = [
    'caseKey',
    'query',
    'expectedAnswer',
    'knowledgeBaseId',
    'simulatedUserId',
    'expectedNoAnswer',
    'semanticRequired',
    'relevance',
    'forbiddenChunkIds',
    'forbiddenDocumentIds',
    'forbiddenKnowledgeBaseIds',
    'expectedRoute',
    'limit',
  ];
  const sample = [
    'KB-TRAVEL-001',
    '出差结束后需要提交哪些报销材料？',
    '提交审批单、行程凭证和合规发票。',
    '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000002',
    'false',
    'true',
    '{"00000000-0000-4000-8000-000000000003":3}',
    '[]',
    '[]',
    '[]',
    'DOCUMENT',
    '10',
  ];
  const csv = `\uFEFF${headers.map(csvCell).join(',')}\r\n${sample.map(csvCell).join(',')}\r\n`;
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = '企业知识库真实问题集模板.csv';
  anchor.click();
  URL.revokeObjectURL(url);
}

function csvCell(value: string): string {
  return `"${value.replace(/"/gu, '""')}"`;
}
