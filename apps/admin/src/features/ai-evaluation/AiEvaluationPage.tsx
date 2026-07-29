import type {
  AiEvaluationBadCase,
  AiEvaluationDataset,
  AiEvaluationRun,
  AiEvaluationRunner,
} from '@enterprise/contracts';
import { useEffect, useState, type ReactNode } from 'react';

import { messageFromError } from '@/api/client';
import { Notice, Spinner } from '@/components/ui';

import {
  listEvaluationBadCases,
  listEvaluationDatasets,
  listEvaluationRunners,
  listEvaluationRuns,
} from './api';
import { BadCaseGovernancePanel } from './BadCaseGovernancePanel';
import { DatasetGovernancePanel } from './DatasetGovernancePanel';
import { RunGovernancePanel } from './RunGovernancePanel';
import './ai-evaluation.css';

export function AiEvaluationPage(): ReactNode {
  const [datasets, setDatasets] = useState<readonly AiEvaluationDataset[]>([]);
  const [runs, setRuns] = useState<readonly AiEvaluationRun[]>([]);
  const [runners, setRunners] = useState<readonly AiEvaluationRunner[]>([]);
  const [badCases, setBadCases] = useState<readonly AiEvaluationBadCase[]>([]);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = (): void => setReloadKey((value) => value + 1);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void Promise.all([
      listEvaluationDatasets({ limit: 100 }, controller.signal),
      listEvaluationRuns({ limit: 100 }, controller.signal),
      listEvaluationRunners({ limit: 100 }, controller.signal),
      listEvaluationBadCases({ limit: 100 }, controller.signal),
    ])
      .then(([datasetResponse, runResponse, runnerResponse, badCaseResponse]) => {
        setDatasets(datasetResponse.items);
        setRuns(runResponse.items);
        setRunners(runnerResponse.items);
        setBadCases(badCaseResponse.items);
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) setError(messageFromError(caught));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [reloadKey]);

  return (
    <section className="page-section ai-evaluation-page">
      <header className="page-header">
        <div>
          <span className="eyebrow">AI EVALUATION GOVERNANCE</span>
          <h1>AI 评测与发布门禁</h1>
          <p>
            用版本化数据集、可信证据、签名
            Runner、独立验证和快照一致性管理智能体与知识发布。此页面不生成假分数，也不会把用户反馈直接升级为可信证据。
          </p>
        </div>
        <button className="button secondary" type="button" onClick={reload}>
          刷新评测状态
        </button>
      </header>

      {notice ? (
        <Notice tone="success" onClose={() => setNotice(null)}>
          {notice}
        </Notice>
      ) : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {loading ? <Spinner label="正在加载企业评测治理数据…" /> : null}

      <div className="evaluation-assurance-strip">
        <article>
          <span>数据集</span>
          <strong>{datasets.length}</strong>
        </article>
        <article>
          <span>已通过 Run</span>
          <strong>{runs.filter(({ status }) => status === 'PASSED').length}</strong>
        </article>
        <article>
          <span>待独立验证</span>
          <strong>{runs.filter(({ status }) => status === 'SUBMITTED').length}</strong>
        </article>
        <article>
          <span>待分流坏样本</span>
          <strong>{badCases.filter(({ status }) => status === 'RECEIVED').length}</strong>
        </article>
      </div>

      <DatasetGovernancePanel
        datasets={datasets}
        reloadDatasets={reload}
        onNotice={setNotice}
        onError={setError}
      />
      <RunGovernancePanel
        runs={runs}
        runners={runners}
        reload={reload}
        onNotice={setNotice}
        onError={setError}
      />
      <BadCaseGovernancePanel
        badCases={badCases}
        reload={reload}
        onNotice={setNotice}
        onError={setError}
      />
    </section>
  );
}
