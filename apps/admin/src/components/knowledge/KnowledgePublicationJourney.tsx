import type {
  AiEvaluationRun,
  KnowledgeBaseIndexReadiness,
  KnowledgeDocumentSummary,
  KnowledgeDocumentVersionSummary,
} from '@enterprise/contracts';
import { useEffect, useState, type ReactNode } from 'react';

import { messageFromError } from '@/api/client';
import { listEvaluationRuns } from '@/features/ai-evaluation/api';

import {
  deriveKnowledgePublicationJourney,
  type KnowledgePublicationAction,
} from './knowledge-publication-journey';

export function KnowledgePublicationJourney({
  document,
  version,
  readiness,
  onAction,
}: {
  document: KnowledgeDocumentSummary;
  version: KnowledgeDocumentVersionSummary;
  readiness: KnowledgeBaseIndexReadiness | null;
  onAction: (action: KnowledgePublicationAction) => void;
}): ReactNode {
  const [runs, setRuns] = useState<readonly AiEvaluationRun[]>([]);
  const [runLoadError, setRunLoadError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setRunLoadError(null);
    void listEvaluationRuns(
      {
        subjectType: 'KNOWLEDGE_VERSION',
        subjectId: version.id,
        subjectVersion: version.versionNumber,
        limit: 100,
      },
      controller.signal,
    )
      .then((response) => setRuns(response.items))
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) setRunLoadError(messageFromError(caught));
      });
    return () => controller.abort();
  }, [version.id, version.versionNumber]);

  const journey = deriveKnowledgePublicationJourney({
    document,
    version,
    runs,
    readiness,
  });

  return (
    <section
      className="knowledge-publication-journey"
      aria-label={`v${version.versionNumber} 知识发布流程`}
    >
      <ol>
        {journey.stages.map((stage) => (
          <li className={`is-${stage.state.toLowerCase()}`} key={stage.key}>
            <span className="knowledge-publication-stage-marker" aria-hidden="true">
              {stage.state === 'COMPLETE' ? '✓' : stage.state === 'BLOCKED' ? '!' : '·'}
            </span>
            <span>
              <strong>{stage.label}</strong>
              <small>{stage.detail}</small>
            </span>
          </li>
        ))}
      </ol>
      {!journey.semanticReady ? (
        <p className="knowledge-semantic-not-ready">
          <strong>非企业语义就绪：</strong>
          {journey.semanticBlocker}
        </p>
      ) : null}
      {runLoadError ? <p className="field-error">评测状态读取失败：{runLoadError}</p> : null}
      {journey.nextActionLabel ? (
        <button
          className="button primary compact"
          type="button"
          onClick={() => onAction(journey.nextAction)}
        >
          下一步：{journey.nextActionLabel}
        </button>
      ) : (
        <span className="knowledge-publication-complete">当前版本已完成全部发布门禁</span>
      )}
    </section>
  );
}
