import type {
  KnowledgeBaseIndexReadiness,
  KnowledgeDocumentSummary,
  KnowledgeDocumentVersionSummary,
} from '@enterprise/contracts';
import type { ReactNode } from 'react';

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
  const journey = deriveKnowledgePublicationJourney({ document, version, readiness });

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
          <strong>非阻塞提示：</strong>
          {journey.semanticBlocker}
        </p>
      ) : null}
      {journey.nextActionLabel ? (
        <button
          className="button primary compact"
          type="button"
          onClick={() => onAction(journey.nextAction)}
        >
          {journey.nextActionLabel}
        </button>
      ) : (
        <span className="knowledge-publication-complete">
          {journey.semanticReady ? '当前版本已发布并可混合检索' : '等待处理完成'}
        </span>
      )}
    </section>
  );
}
