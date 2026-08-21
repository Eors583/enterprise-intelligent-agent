import type {
  AgentRunCancellationPreparation,
  AgentRunExternalAttachment,
  AgentRunEvidenceSource,
  AgentRunPreparation,
  AgentRunReconciliationPreparation,
  AgentRunStreamMode,
  AgentRunUsage,
  AgentRunModelAttempt,
} from './agent-run.models.js';

export abstract class AgentRunRepository {
  abstract prepare(tenantId: string, runId: string): Promise<AgentRunPreparation>;

  abstract prepareReconciliation(
    tenantId: string,
    runId: string,
  ): Promise<AgentRunReconciliationPreparation>;

  abstract attachExternalRun(
    tenantId: string,
    runId: string,
    externalRunId: string,
  ): Promise<AgentRunExternalAttachment>;

  abstract prepareCancellation(
    tenantId: string,
    runId: string,
  ): Promise<AgentRunCancellationPreparation>;

  abstract confirmCancellation(
    tenantId: string,
    runId: string,
    externalRunId: string,
    usage?: AgentRunUsage,
  ): Promise<void>;

  abstract completeSucceeded(
    tenantId: string,
    runId: string,
    output: string,
    citations?: readonly AgentRunEvidenceSource[],
    usage?: AgentRunUsage,
    streamMode?: AgentRunStreamMode,
  ): Promise<{ readonly outputMessageId: string | null; readonly externalRunId: string | null }>;

  abstract completeFailed(
    tenantId: string,
    runId: string,
    errorCode: string,
    safeMessage: string,
    usage?: AgentRunUsage,
    streamMode?: AgentRunStreamMode,
  ): Promise<void>;

  abstract completeUnknown(
    tenantId: string,
    runId: string,
    errorCode: string,
    usage?: AgentRunUsage,
    streamMode?: AgentRunStreamMode,
    reconcileAt?: Date,
  ): Promise<void>;

  abstract recordModelExecutionEvidence(
    tenantId: string,
    runId: string,
    attempts: readonly AgentRunModelAttempt[],
    outputSafetyDecision?: import('@enterprise/contracts').AiSafetyDecision,
  ): Promise<void>;
}
