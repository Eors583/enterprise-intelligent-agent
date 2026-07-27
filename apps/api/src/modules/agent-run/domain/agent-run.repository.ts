import type {
  AgentRunKnowledgeSource,
  AgentRunPreparation,
  AgentRunUsage,
} from './agent-run.models.js';

export abstract class AgentRunRepository {
  abstract prepare(tenantId: string, runId: string): Promise<AgentRunPreparation>;

  abstract attachExternalRun(tenantId: string, runId: string, externalRunId: string): Promise<void>;

  abstract completeSucceeded(
    tenantId: string,
    runId: string,
    output: string,
    citations?: readonly AgentRunKnowledgeSource[],
    usage?: AgentRunUsage,
  ): Promise<{ readonly outputMessageId: string; readonly externalRunId: string | null }>;

  abstract completeFailed(
    tenantId: string,
    runId: string,
    errorCode: string,
    safeMessage: string,
    usage?: AgentRunUsage,
  ): Promise<void>;

  abstract completeUnknown(
    tenantId: string,
    runId: string,
    errorCode: string,
    usage?: AgentRunUsage,
  ): Promise<void>;
}
