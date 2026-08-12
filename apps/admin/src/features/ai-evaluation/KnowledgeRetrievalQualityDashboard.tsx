import type { KnowledgeRetrievalBenchmarkRunSummary } from '@enterprise/contracts';
import type { ReactNode } from 'react';

const KNOWLEDGE_METRICS: ReadonlyArray<{
  metric: 'recallAt5' | 'mrr' | 'ndcgAt10' | 'citationSupportRate' | 'p95LatencyMs';
  label: string;
  help: string;
}> = [
  {
    metric: 'recallAt5',
    label: 'Recall@5',
    help: '正确来源进入前 5 条结果的比例',
  },
  {
    metric: 'mrr',
    label: 'MRR',
    help: '首个正确来源越靠前，分数越高',
  },
  {
    metric: 'ndcgAt10',
    label: 'nDCG@10',
    help: '前 10 条来源的整体排序质量',
  },
  {
    metric: 'citationSupportRate',
    label: '引用支持率',
    help: '回答结论能够被引用证据直接支持的比例',
  },
  {
    metric: 'p95LatencyMs',
    label: 'P95 响应时间',
    help: '95% 的问题应在该时间内完成',
  },
];

export function KnowledgeRetrievalQualityDashboard({
  run,
}: {
  run: KnowledgeRetrievalBenchmarkRunSummary | null;
}): ReactNode {
  const metrics = run?.metrics ?? null;

  return (
    <section className="evaluation-grid-section" aria-labelledby="knowledge-quality-heading">
      <header>
        <div>
          <span className="eyebrow">KNOWLEDGE RETRIEVAL QUALITY</span>
          <h2 id="knowledge-quality-heading">知识检索质量看板</h2>
        </div>
        <span>{metrics ? `最近评测 ${metrics.evaluatedCaseCount} 题` : '尚无正式评测结果'}</span>
      </header>
      <p className="evaluation-help">
        指标来自版本化、绑定标准切片的题集和真实检索
        Run。来源生成基线与业务部门真实问题会明确区分；没有执行时保持“待评测”。
      </p>
      <div className="knowledge-quality-grid">
        {KNOWLEDGE_METRICS.map((definition) => {
          const value = metrics?.[definition.metric] ?? null;
          const passed = metricPassed(run, definition.metric, value);
          return (
            <article className="card knowledge-quality-card" key={definition.metric}>
              <span>{definition.label}</span>
              <strong>{value === null ? '待评测' : formatMetric(definition.metric, value)}</strong>
              <small>{definition.help}</small>
              {value !== null ? (
                <small className={passed ? 'metric-pass' : 'metric-fail'}>
                  {passed ? '达到门槛' : '未达到门槛'} · 样本 {metrics?.evaluatedCaseCount ?? 0}
                </small>
              ) : null}
            </article>
          );
        })}
      </div>
    </section>
  );
}

function formatMetric(metric: (typeof KNOWLEDGE_METRICS)[number]['metric'], value: number): string {
  if (metric === 'p95LatencyMs') {
    return value >= 1_000 ? `${(value / 1_000).toFixed(2)} 秒` : `${Math.round(value)} 毫秒`;
  }
  return `${(value * 100).toFixed(1)}%`;
}

function metricPassed(
  run: KnowledgeRetrievalBenchmarkRunSummary | null,
  metric: (typeof KNOWLEDGE_METRICS)[number]['metric'],
  value: number | null,
): boolean {
  if (run === null || value === null) return false;
  const threshold = run.thresholds;
  if (metric === 'recallAt5') return value >= threshold.minRecallAt5;
  if (metric === 'mrr') return value >= threshold.minMrr;
  if (metric === 'ndcgAt10') return value >= threshold.minNdcgAt10;
  if (metric === 'citationSupportRate') return value >= threshold.minCitationSupportRate;
  return value <= threshold.maxP95LatencyMs;
}
