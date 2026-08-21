import type { AiEvaluationRun, AiEvaluationSubjectType } from '@enterprise/contracts';
import { useEffect, useState, type ReactNode } from 'react';

import { messageFromError } from '@/api/client';
import { Spinner } from '@/components/ui';

import { listEvaluationRuns } from './api';
import { runMatchesSubject } from './view';

export function PassingEvaluationRunSelect({
  subjectType,
  subjectId,
  subjectVersion,
  value,
  onChange,
  disabled = false,
}: {
  subjectType: AiEvaluationSubjectType;
  subjectId: string;
  subjectVersion: number;
  value: string;
  onChange: (runId: string) => void;
  disabled?: boolean;
}): ReactNode {
  const [runs, setRuns] = useState<readonly AiEvaluationRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    onChange('');
    setLoading(true);
    setError(null);
    const load = async (): Promise<void> => {
      try {
        const response = await listEvaluationRuns(
          {
            subjectType,
            subjectId,
            subjectVersion,
            status: 'PASSED',
            limit: 100,
          },
          controller.signal,
        );
        if (controller.signal.aborted) return;
        const trustedScope = response.items.filter((run) =>
          runMatchesSubject(run, { subjectType, subjectId, subjectVersion }),
        );
        if (trustedScope.length !== response.items.length) {
          setRuns([]);
          setError('服务端返回了超出发布对象范围的评测运行，已拒绝展示。');
          return;
        }
        setRuns(trustedScope);
      } catch (caught) {
        if (!controller.signal.aborted) setError(messageFromError(caught));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    void load();
    return () => controller.abort();
  }, [onChange, subjectId, subjectType, subjectVersion]);

  if (loading) return <Spinner label="正在加载已通过的评测运行…" />;

  return (
    <div className="evaluation-run-picker">
      <label>
        <span>已通过的评测运行</span>
        <select
          required
          value={value}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled || runs.length === 0}
        >
          <option value="">请选择与当前发布对象完全一致的 Run</option>
          {runs.map((run) => (
            <option key={run.id} value={run.id}>
              {run.id} · 数据集 {run.datasetVersionId} · {run.metrics.length} 项指标
            </option>
          ))}
        </select>
      </label>
      {error ? <p className="field-error">{error}</p> : null}
      {!error && runs.length === 0 ? (
        <div className="evaluation-run-picker-empty">
          <strong>当前版本没有可用于发布的已通过 Run。</strong>
          <span>请先完成评测、独立验证并达到全部阈值；发布接口仍会复核快照和证据。</span>
          <a className="button secondary compact" href="#ai-evaluation">
            前往 AI 评测
          </a>
        </div>
      ) : (
        <small>这里只列出服务端按类型、对象 ID、版本号和 PASSED 状态精确筛选的 Run。</small>
      )}
    </div>
  );
}
