import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';

import { PrismaService } from '../../../../database/prisma.service.js';
import { hasRoleAgentAssignmentMarker } from '../../../agent-control/domain/role-agent-assignment.policy.js';
import { AuthorizationDecisionService } from '../../../authorization/authorization-decision.service.js';
import type {
  AuthorizationAssignment,
  AuthorizationReasonCode,
} from '../../../authorization/authorization.types.js';
import {
  KnowledgeRetrievalGateway,
  type KnowledgeRetrievalAuthorizationContext,
} from '../../../knowledge-gateway/knowledge-gateway.port.js';
import type {
  AgentRunCancellationPreparation,
  AgentRunExternalAttachment,
  AgentRunContextMessage,
  AgentRunKnowledgeSource,
  AgentRunMemoryContext,
  AgentRunMemoryContextSnapshot,
  AgentRunPreparation,
  AgentRunStreamMode,
  AgentRunUsage,
  AgentRunModelAttempt,
  PreparedAgentRun,
  StoredAgentRunStatus,
} from '../../domain/agent-run.models.js';
import { ROLE_ASSIGNMENT_REVOKED_AGENT_RUN_ERROR_CODE } from '../../domain/agent-run.models.js';
import {
  buildAgentRunPolicySnapshot,
  isAgentRunPolicySnapshotV2,
  readControlledModelConnectivityProbeCatalogId,
  readPolicySnapshotAssignmentId,
  resolveAgentRunExecutionSnapshot,
  type AgentRunExecutionSnapshot,
} from '../../domain/agent-run-policy-snapshot.js';
import { packConservativeAgentRunInput } from '../../domain/agent-run-input-budget.js';
import {
  AGENT_RUN_CONCURRENCY_HOLD_STATUSES,
  DEFAULT_AGENT_RUN_MAX_INPUT_TOKENS,
  DEFAULT_AGENT_RUN_MAX_OUTPUT_TOKENS,
  DEFAULT_AGENT_RUN_RESERVED_TOKENS,
  decideAgentRunQuota,
  type AgentRunQuotaSnapshot,
} from '../../domain/agent-run-quota.js';
import {
  decideAgentRunTokenSettlement,
  type AgentRunTokenSettlement,
} from '../../domain/agent-run-token-settlement.js';
import { AgentRunRepository } from '../../domain/agent-run.repository.js';
import { appendTerminalStreamEvent } from './prisma-agent-run-stream.repository.js';
import {
  ModelRouteUnavailableError,
  readModelRouteRequest,
  resolveTrustedModelRouteSnapshot,
} from '../../../ai-safety-model-routing/model-route-execution.js';
import { evaluateAndMinimizeRunInput } from '../../../ai-safety-model-routing/ai-safety-policy.js';
import {
  trustedModelRouteSnapshotSchema,
  type AiSafetyDecision,
  type TrustedModelRouteSnapshot,
} from '@enterprise/contracts';

export { exceedsConservativeInputBudget } from '../../domain/agent-run-input-budget.js';

const MAX_CONTEXT_MESSAGES = 30;
const MAX_MEMORY_CONTEXTS = 12;
const MAX_MEMORY_CANDIDATES = 100;
const AGENT_RUN_MEMORY_PURPOSE = 'AGENT_RUN_CONTEXT' as const;
const MAX_OUTPUT_CHARACTERS = 20_000;
const TERMINAL_STATUSES = new Set<StoredAgentRunStatus>([
  'SUCCEEDED',
  'FAILED',
  'UNKNOWN',
  'CANCELLED',
]);

type Transaction = Prisma.TransactionClient;
type RunForExecution = Prisma.AgentRunGetPayload<{
  include: {
    requester: true;
    agent: { include: { _count: { select: { roleAssignments: true } } } };
    agentVersion: true;
    conversation: true;
    inputMessage: true;
  };
}>;

@Injectable()
export class PrismaAgentRunRepository extends AgentRunRepository {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(KnowledgeRetrievalGateway)
    private readonly retrieval: KnowledgeRetrievalGateway,
    @Inject(AuthorizationDecisionService)
    private readonly authorization: AuthorizationDecisionService,
  ) {
    super();
  }

  async prepare(tenantId: string, runId: string): Promise<AgentRunPreparation> {
    const snapshot = await this.prisma.withTenant(tenantId, async (transaction) => {
      await lockTenantQuota(transaction, tenantId);
      await lockRun(transaction, tenantId, runId);
      const run = await findRunForExecution(transaction, tenantId, runId);
      if (run === null) {
        return { preparation: terminalPreparation('FAILED', null, 'AGENT_RUN_NOT_FOUND') };
      }
      if (isTerminal(run.status)) {
        return { preparation: terminalPreparation(run.status, run.externalRunId, run.errorCode) };
      }

      if (run.status === 'DISPATCHING' && run.externalRunId === null) {
        return { preparation: { kind: 'ambiguous_dispatch' } as AgentRunPreparation };
      }
      if (run.status === 'RUNNING' && run.externalRunId === null) {
        return { preparation: { kind: 'ambiguous_dispatch' } as AgentRunPreparation };
      }

      if (
        run.status === 'QUEUED' &&
        run.turnLimit === 1 &&
        (await hasEarlierActiveDirectRun(transaction, run))
      ) {
        return {
          preparation: {
            kind: 'deferred',
            reasonCode: 'EARLIER_AGENT_RUN_ACTIVE',
          } as AgentRunPreparation,
        };
      }
      if (run.status !== 'QUEUED' && run.status !== 'DISPATCHING' && run.status !== 'RUNNING') {
        return { preparation: { kind: 'ambiguous_dispatch' } as AgentRunPreparation };
      }

      const validation = await validateQueuedRun(transaction, run, this.authorization);
      if (validation.errorCode !== null) {
        await markRunTerminal(
          transaction,
          run,
          'FAILED',
          validation.errorCode,
          'Agent Run policy validation failed.',
        );
        return { preparation: terminalPreparation('FAILED', null, validation.errorCode) };
      }
      const executionSnapshot = resolveAgentRunExecutionSnapshot(
        run.policySnapshot,
        run.agentVersion,
      );
      if (executionSnapshot === null) {
        await markRunTerminal(
          transaction,
          run,
          'FAILED',
          'AGENT_RUN_SNAPSHOT_INVALID',
          'Agent Run policy snapshot validation failed.',
        );
        return {
          preparation: terminalPreparation('FAILED', null, 'AGENT_RUN_SNAPSHOT_INVALID'),
        };
      }

      if (run.status === 'QUEUED') {
        const quotaNow = new Date();
        const quotaDecision = decideAgentRunQuota(
          await loadQuotaSnapshot(transaction, tenantId, quotaNow),
          DEFAULT_AGENT_RUN_RESERVED_TOKENS,
          quotaNow,
        );
        if (quotaDecision.kind === 'deferred') {
          return {
            preparation: {
              kind: 'deferred',
              reasonCode: quotaDecision.reasonCode,
              availableAt: quotaDecision.availableAt,
            } as AgentRunPreparation,
          };
        }
        if (quotaDecision.kind === 'rejected') {
          await markRunTerminal(
            transaction,
            run,
            'FAILED',
            quotaDecision.reasonCode,
            'The tenant monthly Agent token quota has been exhausted.',
          );
          return {
            preparation: terminalPreparation('FAILED', null, quotaDecision.reasonCode),
          };
        }
      }
      const messages = await loadRecentContext(
        transaction,
        tenantId,
        run.conversationId,
        run.inputMessage,
      );
      const knowledgeBaseIds = readSelectedKnowledgeBaseIds(executionSnapshot.knowledgeScope);
      const resolveAuthorizedKnowledgeBases = isOwnerAuthorizedKnowledgeScope(
        executionSnapshot.knowledgeScope,
      );
      const storedMemorySnapshot = parseAgentRunMemoryContextSnapshot(run.memoryContextSnapshot);
      if (run.memoryContextSnapshot != null && storedMemorySnapshot === null) {
        await markRunTerminal(
          transaction,
          run,
          'FAILED',
          'AGENT_RUN_MEMORY_SNAPSHOT_INVALID',
          'Agent Run memory context snapshot validation failed.',
        );
        return {
          preparation: terminalPreparation(
            'FAILED',
            run.externalRunId,
            'AGENT_RUN_MEMORY_SNAPSHOT_INVALID',
          ),
        };
      }
      const memorySnapshot =
        storedMemorySnapshot ??
        (await loadAgentRunMemoryContextSnapshot(transaction, run, messages.at(-1)?.text ?? ''));
      return {
        run,
        messages,
        knowledgeBaseIds,
        resolveAuthorizedKnowledgeBases,
        knowledgeAuthorization: validation.knowledgeAuthorization,
        executionSnapshot,
        memorySnapshot,
      };
    });
    if ('preparation' in snapshot) return snapshot.preparation;

    const modelPolicyClassification = readModelRouteRequest(
      snapshot.executionSnapshot.modelPolicy,
    ).classification;
    const preRetrievalSafety = evaluateAndMinimizeRunInput({
      messages: snapshot.messages,
      knowledgeSources: [],
      memoryContexts: snapshot.memorySnapshot.contexts,
      modelPolicyClassification,
    });
    if (preRetrievalSafety.decision.action === 'BLOCK') {
      return this.prisma.withTenant(tenantId, async (transaction) => {
        await lockRun(transaction, tenantId, runId);
        const run = await findRunForExecution(transaction, tenantId, runId);
        if (run === null) return terminalPreparation('FAILED', null, 'AGENT_RUN_NOT_FOUND');
        if (isTerminal(run.status)) {
          return terminalPreparation(run.status, run.externalRunId, run.errorCode);
        }
        if (run.version !== snapshot.run.version) return { kind: 'ambiguous_dispatch' };
        await persistSafetyDecision(
          transaction,
          tenantId,
          run.id,
          run.requesterUserId,
          preRetrievalSafety.decision,
        );
        await markRunTerminal(
          transaction,
          run,
          'FAILED',
          'AI_SAFETY_INPUT_BLOCKED',
          'The Agent Run input was blocked before external knowledge retrieval.',
        );
        return terminalPreparation('FAILED', null, 'AI_SAFETY_INPUT_BLOCKED');
      });
    }

    const knowledgeBaseIds = snapshot.resolveAuthorizedKnowledgeBases
      ? await this.retrieval.resolveAccessibleKnowledgeBaseIds({
          tenantId,
          userId: snapshot.run.requesterUserId,
          authorization: snapshot.knowledgeAuthorization,
        })
      : snapshot.knowledgeBaseIds;

    // Embedding and Reranker calls happen only after the snapshot transaction and
    // advisory Run lock have been released. Unexpected retrieval failures leave the Run
    // QUEUED; explicitly classified semantic-provider failures degrade to lexical retrieval
    // and are recorded in the retrieval metadata.
    const retrieval = await this.retrieval.search({
      tenantId,
      userId: snapshot.run.requesterUserId,
      knowledgeBaseIds,
      authorization: snapshot.knowledgeAuthorization,
      query: preRetrievalSafety.messages.at(-1)?.text ?? '',
      maximumOutboundClassification: preRetrievalSafety.decision.classification,
    });
    const knowledgeSources: AgentRunKnowledgeSource[] = retrieval.items.map((item) => ({
      documentId: item.documentId,
      documentVersionId: item.documentVersionId,
      chunkId: item.chunkId,
      knowledgeBaseId: item.knowledgeBaseId,
      knowledgeBaseName: item.knowledgeBaseName,
      title: item.title,
      documentVersion: item.documentVersion,
      headingPath: [...item.headingPath],
      sourceType: item.sourceType,
      excerpt: createCitationExcerpt(item.content),
      classification: item.classification,
      governanceHash: item.governanceHash,
      contentHash: item.contentHash,
      updatedAt: item.updatedAt.toISOString(),
    }));

    return this.prisma.withTenant(tenantId, async (transaction) => {
      await lockTenantQuota(transaction, tenantId);
      await lockRun(transaction, tenantId, runId);
      const run = await findRunForExecution(transaction, tenantId, runId);
      if (run === null) return terminalPreparation('FAILED', null, 'AGENT_RUN_NOT_FOUND');
      if (isTerminal(run.status)) {
        return terminalPreparation(run.status, run.externalRunId, run.errorCode);
      }
      const isRunningReconciliation =
        snapshot.run.status === 'RUNNING' &&
        snapshot.run.externalRunId !== null &&
        run.status === 'RUNNING' &&
        run.externalRunId === snapshot.run.externalRunId;
      if (
        !isRunningReconciliation &&
        (run.status !== 'QUEUED' || run.version !== snapshot.run.version)
      ) {
        return { kind: 'ambiguous_dispatch' };
      }
      const memoryStillAccessible = await memoryContextSnapshotStillAccessible(
        transaction,
        run,
        snapshot.memorySnapshot,
      );
      if (!memoryStillAccessible) {
        await markRunTerminal(
          transaction,
          run,
          'FAILED',
          'MEMORY_ACCESS_CHANGED',
          'Purpose-bound memory access changed before runtime dispatch.',
        );
        return terminalPreparation('FAILED', run.externalRunId, 'MEMORY_ACCESS_CHANGED');
      }
      const validation = await validateQueuedRun(transaction, run, this.authorization);
      if (validation.errorCode !== null) {
        await markRunTerminal(
          transaction,
          run,
          'FAILED',
          validation.errorCode,
          'Agent Run policy validation failed.',
        );
        return terminalPreparation('FAILED', null, validation.errorCode);
      }
      const knowledgeStillAccessible = await this.retrieval.areChunksAccessible({
        tenantId,
        userId: run.requesterUserId,
        knowledgeBaseIds,
        chunks: knowledgeSources.map((source) => ({
          chunkId: source.chunkId,
          documentVersionId: source.documentVersionId,
          classification: source.classification,
          governanceHash: source.governanceHash,
          contentHash: source.contentHash,
        })),
        authorization: validation.knowledgeAuthorization,
      });
      if (!knowledgeStillAccessible) {
        await markRunTerminal(
          transaction,
          run,
          'FAILED',
          'KNOWLEDGE_ACCESS_CHANGED',
          'Knowledge access changed before runtime dispatch.',
        );
        return terminalPreparation('FAILED', null, 'KNOWLEDGE_ACCESS_CHANGED');
      }
      const currentMemorySnapshot = parseAgentRunMemoryContextSnapshot(run.memoryContextSnapshot);
      if (
        run.memoryContextSnapshot != null &&
        (currentMemorySnapshot === null ||
          currentMemorySnapshot.snapshotSha256 !== snapshot.memorySnapshot.snapshotSha256)
      ) {
        await markRunTerminal(
          transaction,
          run,
          'FAILED',
          'AGENT_RUN_MEMORY_SNAPSHOT_CHANGED',
          'The immutable Agent Run memory context snapshot changed unexpectedly.',
        );
        return terminalPreparation(
          'FAILED',
          run.externalRunId,
          'AGENT_RUN_MEMORY_SNAPSHOT_CHANGED',
        );
      }
      const safety = evaluateAndMinimizeRunInput({
        messages: snapshot.messages,
        knowledgeSources,
        memoryContexts: snapshot.memorySnapshot.contexts,
        modelPolicyClassification,
      });
      await persistSafetyDecision(
        transaction,
        tenantId,
        run.id,
        run.requesterUserId,
        safety.decision,
      );
      if (safety.decision.action === 'BLOCK') {
        await markRunTerminal(
          transaction,
          run,
          'FAILED',
          'AI_SAFETY_INPUT_BLOCKED',
          'The Agent Run input was blocked by the configured safety policy.',
        );
        return terminalPreparation('FAILED', null, 'AI_SAFETY_INPUT_BLOCKED');
      }
      let modelRoute: TrustedModelRouteSnapshot | null;
      try {
        modelRoute = await resolveTrustedModelRouteSnapshot(transaction, {
          tenantId,
          existingSnapshot: run.modelRouteSnapshot,
          modelPolicy: snapshot.executionSnapshot.modelPolicy,
          effectiveClassification: safety.decision.classification,
        });
      } catch (error) {
        if (!(error instanceof ModelRouteUnavailableError)) throw error;
        await markRunTerminal(
          transaction,
          run,
          'FAILED',
          error.code,
          'No trusted model route is currently available for this Agent Run.',
        );
        return terminalPreparation('FAILED', null, error.code);
      }
      const snapshotProbeCatalogId = readControlledModelConnectivityProbeCatalogId(
        run.policySnapshot,
      );
      const storedConnectivityProbe =
        snapshotProbeCatalogId === null
          ? null
          : await transaction.aiModelConnectivityProbe.findFirst({
              where: { tenantId, runId },
              select: { targetCatalogVersionId: true },
            });
      const storedProbeCatalogId = storedConnectivityProbe?.targetCatalogVersionId ?? null;
      if (
        snapshotProbeCatalogId !== storedProbeCatalogId ||
        (storedProbeCatalogId !== null &&
          (modelRoute === null ||
            !modelRoute.candidates.some(
              ({ catalogVersionId }) => catalogVersionId === storedProbeCatalogId,
            )))
      ) {
        await markRunTerminal(
          transaction,
          run,
          'FAILED',
          'CONNECTIVITY_PROBE_PROVENANCE_MISMATCH',
          'The controlled model connectivity probe provenance is invalid.',
        );
        return terminalPreparation(
          'FAILED',
          run.externalRunId,
          'CONNECTIVITY_PROBE_PROVENANCE_MISMATCH',
        );
      }
      const preparedRun = mapPreparedRun(
        run,
        snapshot.executionSnapshot,
        safety.messages,
        safety.knowledgeSources,
        safety.memoryContexts,
        snapshot.resolveAuthorizedKnowledgeBases || knowledgeBaseIds.length > 0,
        modelRoute,
        safety.decision,
        storedProbeCatalogId,
      );
      const packing = packConservativeAgentRunInput(preparedRun);
      if (!isRunningReconciliation && packing.kind === 'required_input_exceeds_budget') {
        await markRunTerminal(
          transaction,
          run,
          'FAILED',
          'INPUT_TOKEN_BUDGET_PREFLIGHT_EXCEEDED',
          'The Agent input exceeds the conservative preflight token budget.',
        );
        return terminalPreparation('FAILED', null, 'INPUT_TOKEN_BUDGET_PREFLIGHT_EXCEEDED');
      }
      if (isRunningReconciliation) {
        return {
          kind: 'ready',
          run: packing.kind === 'packed' ? packing.run : preparedRun,
        };
      }
      const quotaNow = new Date();
      const quotaDecision = decideAgentRunQuota(
        await loadQuotaSnapshot(transaction, tenantId, quotaNow),
        DEFAULT_AGENT_RUN_RESERVED_TOKENS,
        quotaNow,
      );
      if (quotaDecision.kind === 'deferred') {
        return {
          kind: 'deferred',
          reasonCode: quotaDecision.reasonCode,
          availableAt: quotaDecision.availableAt,
        };
      }
      if (quotaDecision.kind === 'rejected') {
        await markRunTerminal(
          transaction,
          run,
          'FAILED',
          quotaDecision.reasonCode,
          'The tenant monthly Agent token quota has been exhausted.',
        );
        return terminalPreparation('FAILED', null, quotaDecision.reasonCode);
      }
      const transitioned = await transaction.agentRun.updateMany({
        where: { tenantId, id: runId, status: 'QUEUED', version: run.version },
        data: {
          status: 'DISPATCHING',
          attempts: { increment: 1 },
          version: { increment: 1 },
          dispatchStartedAt: new Date(),
          reservedTokens: DEFAULT_AGENT_RUN_RESERVED_TOKENS,
          errorCode: null,
          errorMessage: null,
          ...(modelRoute === null
            ? {}
            : {
                modelRoutePolicyVersionId: modelRoute.policyVersionId,
                modelRouteSnapshot: modelRoute,
              }),
          ...(run.memoryContextSnapshot == null
            ? {
                memoryContextSnapshot: memoryContextSnapshotJson(snapshot.memorySnapshot),
              }
            : {}),
        },
      });
      if (transitioned.count !== 1) return { kind: 'ambiguous_dispatch' };
      return {
        kind: 'ready',
        run: packing.kind === 'packed' ? packing.run : preparedRun,
      };
    });
  }

  async recordModelExecutionEvidence(
    tenantId: string,
    runId: string,
    attempts: readonly AgentRunModelAttempt[],
    outputSafetyDecision?: AiSafetyDecision,
  ): Promise<void> {
    if (attempts.length === 0 && outputSafetyDecision === undefined) return;
    await this.prisma.withTenant(tenantId, async (transaction) => {
      await lockRun(transaction, tenantId, runId);
      const run = await transaction.agentRun.findFirst({
        where: { tenantId, id: runId },
        select: {
          requesterUserId: true,
          modelRouteSnapshot: true,
        },
      });
      if (run === null) throw new Error('Agent Run does not exist.');
      await transaction.$queryRaw`SELECT set_config('app.user_id', ${run.requesterUserId}, true)`;
      const route = trustedModelRouteSnapshotSchema.safeParse(run.modelRouteSnapshot);
      for (const attempt of attempts) {
        if (!route.success) {
          throw new Error('Runtime model attempt has no trusted immutable route snapshot.');
        }
        const candidate = route.data.candidates.find(
          (item) =>
            item.ordinal === attempt.attemptNumber &&
            item.catalogVersionId === attempt.catalogVersionId &&
            item.routeKey === attempt.routeKey &&
            item.provider === attempt.provider &&
            item.model === attempt.model,
        );
        if (candidate === undefined) {
          throw new Error('Runtime model attempt does not match the immutable route snapshot.');
        }
        const common = {
          tenantId,
          runId,
          attemptNumber: attempt.attemptNumber,
          catalogVersionId: attempt.catalogVersionId,
          routeKey: attempt.routeKey,
          provider: attempt.provider,
          modelName: attempt.model,
          startedAt: attempt.startedAt,
        };
        await transaction.aiModelAttemptReceipt.createMany({
          data: [
            {
              ...common,
              phase: 'STARTED',
              outcome: 'STARTED',
              retrySafe: false,
              receiptHash: hashEvidence({ ...common, phase: 'STARTED', outcome: 'STARTED' }),
            },
            {
              ...common,
              phase: 'TERMINAL',
              outcome: attempt.outcome,
              reasonCode: attempt.reasonCode,
              retrySafe: attempt.retrySafe,
              finishedAt: attempt.finishedAt,
              receiptHash: hashEvidence({
                ...common,
                phase: 'TERMINAL',
                outcome: attempt.outcome,
                reasonCode: attempt.reasonCode,
                retrySafe: attempt.retrySafe,
                finishedAt: attempt.finishedAt,
              }),
            },
          ],
          skipDuplicates: true,
        });
        await updateCircuitFromAttempt(transaction, tenantId, attempt, route.data);
      }
      if (outputSafetyDecision !== undefined) {
        await persistSafetyDecision(
          transaction,
          tenantId,
          runId,
          run.requesterUserId,
          outputSafetyDecision,
        );
      }
    });
  }

  attachExternalRun(
    tenantId: string,
    runId: string,
    externalRunId: string,
  ): Promise<AgentRunExternalAttachment> {
    if (!isUuid(externalRunId)) {
      throw new Error('AI Runtime returned an invalid Run id.');
    }
    return this.prisma.withTenant(tenantId, async (transaction) => {
      await lockRun(transaction, tenantId, runId);
      const run = await transaction.agentRun.findFirst({ where: { tenantId, id: runId } });
      if (run === null) throw new Error('Agent Run does not exist.');
      if (run.cancellationRequestedAt !== null && run.cancellationConfirmedAt === null) {
        if (run.externalRunId !== null && run.externalRunId !== externalRunId) {
          throw new Error('Agent Run is already attached to a different external Run.');
        }
        if (run.externalRunId === null) {
          await transaction.agentRun.update({
            where: { id: run.id },
            data: {
              externalRunId,
              version: { increment: 1 },
            },
          });
        }
        return 'cancellation_required';
      }
      if (run.externalRunId === externalRunId && run.status === 'RUNNING') return 'attached';
      if (run.status !== 'DISPATCHING' || run.externalRunId !== null) {
        throw new Error('Agent Run is no longer awaiting an external Run id.');
      }

      await transaction.agentRun.update({
        where: { id: run.id },
        data: {
          externalRunId,
          status: 'RUNNING',
          startedAt: new Date(),
          version: { increment: 1 },
        },
      });
      await transaction.auditEvent.create({
        data: {
          tenantId,
          actorType: 'SERVICE',
          actorId: run.id,
          action: 'agent.run.start',
          resourceType: 'agent_run',
          resourceId: run.id,
          metadata: { conversationId: run.conversationId, agentId: run.agentId },
        },
      });
      return 'attached';
    });
  }

  prepareCancellation(tenantId: string, runId: string): Promise<AgentRunCancellationPreparation> {
    return this.prisma.withTenant(tenantId, async (transaction) => {
      await lockRun(transaction, tenantId, runId);
      const run = await transaction.agentRun.findFirst({
        where: { tenantId, id: runId },
        select: {
          status: true,
          externalRunId: true,
          finishedAt: true,
          cancellationRequestedAt: true,
          cancellationConfirmedAt: true,
        },
      });
      if (run === null || run.cancellationRequestedAt === null) {
        if (run?.status === 'CANCELLED') {
          await appendTerminalStreamEvent(transaction, {
            tenantId,
            runId,
            status: 'CANCELLED',
            mode: 'terminal_only',
            createdAt: run.finishedAt ?? new Date(),
          });
        }
        return { kind: 'complete', externalRunId: run?.externalRunId ?? null };
      }
      if (run.cancellationConfirmedAt !== null) {
        return { kind: 'complete', externalRunId: run.externalRunId };
      }
      if (run.status === 'SUCCEEDED' || run.status === 'FAILED' || run.status === 'CANCELLED') {
        await transaction.agentRun.update({
          where: { id: runId },
          data: {
            // A terminal transition may have raced with the cancellation
            // request. Use the observation time so confirmed_at can never
            // predate requested_at.
            cancellationConfirmedAt: cancellationConfirmationTime(run.cancellationRequestedAt),
            version: { increment: 1 },
          },
        });
        return { kind: 'complete', externalRunId: run.externalRunId };
      }
      if (run.externalRunId === null) {
        return {
          kind: 'deferred',
          reasonCode: 'CANCEL_WAITING_FOR_EXTERNAL_RUN_ID',
        };
      }
      return { kind: 'ready', externalRunId: run.externalRunId };
    });
  }

  confirmCancellation(
    tenantId: string,
    runId: string,
    externalRunId: string,
    usage?: AgentRunUsage,
  ): Promise<void> {
    return this.prisma.withTenant(tenantId, async (transaction) => {
      await lockTenantQuota(transaction, tenantId);
      await lockRun(transaction, tenantId, runId);
      const run = await transaction.agentRun.findFirst({
        where: { tenantId, id: runId },
        select: {
          status: true,
          externalRunId: true,
          conversationId: true,
          reservedTokens: true,
          cancellationRequestedAt: true,
          cancellationReason: true,
          cancellationConfirmedAt: true,
        },
      });
      if (run === null) throw new Error('Agent Run does not exist.');
      if (run.externalRunId !== externalRunId) {
        throw new Error('Agent Run external cancellation target changed.');
      }
      if (run.cancellationRequestedAt === null || run.cancellationConfirmedAt !== null) {
        return;
      }
      const confirmedAt = cancellationConfirmationTime(run.cancellationRequestedAt);
      const cancellationReason = safeCode(
        run.cancellationReason ?? ROLE_ASSIGNMENT_REVOKED_AGENT_RUN_ERROR_CODE,
      );
      if (run.status === 'SUCCEEDED' || run.status === 'FAILED' || run.status === 'CANCELLED') {
        await transaction.agentRun.update({
          where: { id: runId },
          data: {
            cancellationConfirmedAt: confirmedAt,
            version: { increment: 1 },
          },
        });
        return;
      }
      if (run.status === 'UNKNOWN') {
        await transaction.agentRun.update({
          where: { id: runId },
          data: {
            cancellationConfirmedAt: confirmedAt,
            ...runtimeUsageIdentityUpdate(usage),
            version: { increment: 1 },
          },
        });
        await transaction.auditEvent.create({
          data: {
            tenantId,
            actorType: 'SERVICE',
            actorId: runId,
            action: 'agent.run.cancellation_confirmed_after_unknown',
            resourceType: 'agent_run',
            resourceId: runId,
            metadata: {
              conversationId: run.conversationId,
              cancellationReason,
              ...terminalUsageAuditMetadata(run, 'UNKNOWN', usage, confirmedAt, null),
            },
          },
        });
        return;
      }
      if (run.status !== 'QUEUED' && run.status !== 'DISPATCHING' && run.status !== 'RUNNING') {
        return;
      }
      await transaction.agentRun.update({
        where: { id: runId },
        data: {
          status: 'CANCELLED',
          errorCode: cancellationReason,
          errorMessage: 'AI Runtime confirmed that the cancelled Agent Run stopped.',
          finishedAt: confirmedAt,
          cancellationConfirmedAt: confirmedAt,
          ...terminalUsageUpdate(run, 'CANCELLED', usage, confirmedAt),
          version: { increment: 1 },
        },
      });
      await appendTerminalStreamEvent(transaction, {
        tenantId,
        runId,
        status: 'CANCELLED',
        mode: 'terminal_only',
        createdAt: confirmedAt,
      });
      await transaction.auditEvent.create({
        data: {
          tenantId,
          actorType: 'SERVICE',
          actorId: runId,
          action: 'agent.run.cancel_confirmed',
          resourceType: 'agent_run',
          resourceId: runId,
          metadata: {
            conversationId: run.conversationId,
            cancellationReason,
            ...terminalUsageAuditMetadata(run, 'CANCELLED', usage, confirmedAt, null),
          },
        },
      });
    });
  }

  completeSucceeded(
    tenantId: string,
    runId: string,
    output: string,
    citations: readonly AgentRunKnowledgeSource[] = [],
    usage?: AgentRunUsage,
    streamMode: AgentRunStreamMode = 'terminal_only',
  ): Promise<{ readonly outputMessageId: string; readonly externalRunId: string | null }> {
    return this.prisma.withTenant(tenantId, async (transaction) => {
      const initial = await transaction.agentRun.findFirst({
        where: { tenantId, id: runId },
        select: { conversationId: true, turnLimit: true },
      });
      if (initial === null) throw new Error('Agent Run does not exist.');
      await lockTenantQuota(transaction, tenantId);
      await lockAgentConversation(transaction, tenantId, initial.conversationId);
      await lockRun(transaction, tenantId, runId);

      const run = await transaction.agentRun.findFirst({
        where: { tenantId, id: runId },
        include: { conversation: true, agent: true },
      });
      if (run === null) throw new Error('Agent Run does not exist.');
      if (run.status === 'SUCCEEDED') {
        if (run.outputMessageId === null) {
          throw new Error('Succeeded Agent Run has no output message.');
        }
        await appendTerminalStreamEvent(transaction, {
          tenantId,
          runId,
          status: 'SUCCEEDED',
          mode: streamMode,
          createdAt: run.finishedAt ?? new Date(),
        });
        return { outputMessageId: run.outputMessageId, externalRunId: run.externalRunId };
      }
      if (isTerminal(run.status)) {
        throw new Error('A terminal Agent Run cannot be completed again.');
      }
      if (run.status !== 'RUNNING' || run.externalRunId === null) {
        throw new Error('Agent Run has no confirmed external execution.');
      }

      const safeOutput = truncateOutput(output);
      const senderKey = `agent:${run.agentId}`;
      const message = await transaction.message.create({
        data: {
          tenantId,
          conversationId: run.conversationId,
          senderType: 'AGENT',
          senderAgentId: run.agentId,
          senderKey,
          senderName: run.agent.name,
          clientMessageId: `agent-run:${run.id}`,
          contentType: 'TEXT',
          content: {
            type: 'text',
            text: safeOutput,
            ...(citations.length === 0
              ? {}
              : {
                  citations: citations.slice(0, 12).map((citation) => ({
                    documentId: citation.documentId,
                    documentVersionId: citation.documentVersionId,
                    chunkId: citation.chunkId,
                    knowledgeBaseId: citation.knowledgeBaseId,
                    knowledgeBaseName: citation.knowledgeBaseName,
                    title: citation.title,
                    documentVersion: citation.documentVersion,
                    headingPath: [...citation.headingPath],
                    sourceType: citation.sourceType,
                    excerpt: citation.excerpt,
                    updatedAt: citation.updatedAt,
                  })),
                }),
          },
        },
      });
      const recipients = await transaction.conversationParticipant.findMany({
        where: {
          tenantId,
          conversationId: run.conversationId,
          leftAt: null,
          NOT: { participantKey: senderKey },
        },
        select: { type: true, userId: true, agentId: true },
        orderBy: { participantKey: 'asc' },
      });
      if (recipients.length === 0) {
        throw new Error('An Agent message requires at least one active recipient.');
      }

      await transaction.conversation.updateMany({
        where: {
          tenantId,
          id: run.conversationId,
          OR: [{ lastMessageAt: null }, { lastMessageAt: { lt: message.createdAt } }],
        },
        data: { lastMessageAt: message.createdAt },
      });
      const finishedAt = new Date();
      const latencyMs = calculateLatencyMs(run, finishedAt);
      await transaction.agentRun.update({
        where: { id: run.id },
        data: {
          status: 'SUCCEEDED',
          outputMessageId: message.id,
          finishedAt,
          errorCode: null,
          errorMessage: null,
          groundedCitationCount: Math.min(citations.length, 12),
          latencyMs,
          ...terminalUsageUpdate(run, 'SUCCEEDED', usage, finishedAt),
          version: { increment: 1 },
        },
      });
      await appendTerminalStreamEvent(transaction, {
        tenantId,
        runId,
        status: 'SUCCEEDED',
        mode: streamMode,
        createdAt: finishedAt,
      });
      await Promise.all([
        transaction.outboxEvent.create({
          data: {
            tenantId,
            aggregateType: 'message',
            aggregateId: message.id,
            eventType: 'message.created.v1',
            payload: {
              messageId: message.id,
              conversationId: run.conversationId,
              sender: { type: 'agent', id: run.agentId },
              recipients: recipients.map((recipient) => ({
                type: recipient.type === 'USER' ? 'user' : 'agent',
                id: recipient.userId ?? recipient.agentId,
              })),
              content: { type: 'text', text: safeOutput },
            },
          },
        }),
        transaction.auditEvent.create({
          data: {
            tenantId,
            actorType: 'AGENT',
            actorId: run.agentId,
            action: 'message.create',
            resourceType: 'message',
            resourceId: message.id,
            metadata: { conversationId: run.conversationId, agentRunId: run.id },
          },
        }),
        transaction.auditEvent.create({
          data: {
            tenantId,
            actorType: 'SERVICE',
            actorId: run.id,
            action: 'agent.run.succeed',
            resourceType: 'agent_run',
            resourceId: run.id,
            metadata: {
              conversationId: run.conversationId,
              outputMessageId: message.id,
              ...terminalUsageAuditMetadata(run, 'SUCCEEDED', usage, finishedAt, latencyMs),
            },
          },
        }),
      ]);
      await closeControlledConnectivityProbeParticipants(transaction, run, finishedAt);

      if (run.turnIndex < run.turnLimit) {
        await enqueueNextRelayRun(transaction, run, message.id);
      }
      return { outputMessageId: message.id, externalRunId: run.externalRunId };
    });
  }

  completeFailed(
    tenantId: string,
    runId: string,
    errorCode: string,
    safeMessage: string,
    usage?: AgentRunUsage,
    streamMode: AgentRunStreamMode = 'terminal_only',
  ): Promise<void> {
    return this.completeTerminal(
      tenantId,
      runId,
      'FAILED',
      errorCode,
      safeMessage,
      usage,
      streamMode,
    );
  }

  completeUnknown(
    tenantId: string,
    runId: string,
    errorCode: string,
    usage?: AgentRunUsage,
    streamMode: AgentRunStreamMode = 'terminal_only',
  ): Promise<void> {
    return this.completeTerminal(
      tenantId,
      runId,
      'UNKNOWN',
      errorCode,
      'AI Runtime execution outcome is unknown.',
      usage,
      streamMode,
    );
  }

  private completeTerminal(
    tenantId: string,
    runId: string,
    status: 'FAILED' | 'UNKNOWN',
    errorCode: string,
    safeMessage: string,
    usage?: AgentRunUsage,
    streamMode: AgentRunStreamMode = 'terminal_only',
  ): Promise<void> {
    return this.prisma.withTenant(tenantId, async (transaction) => {
      const initial = await transaction.agentRun.findFirst({
        where: { tenantId, id: runId },
        select: { conversationId: true, turnLimit: true },
      });
      if (initial === null) return;
      await lockTenantQuota(transaction, tenantId);
      await lockAgentConversation(transaction, tenantId, initial.conversationId);
      await lockRun(transaction, tenantId, runId);
      const run = await transaction.agentRun.findFirst({ where: { tenantId, id: runId } });
      if (run === null) return;
      if (isTerminal(run.status)) {
        if (run.status === status) {
          await appendTerminalStreamEvent(transaction, {
            tenantId,
            runId,
            status,
            mode: streamMode,
            createdAt: run.finishedAt ?? new Date(),
          });
        }
        return;
      }
      await markRunTerminal(
        transaction,
        run,
        status,
        safeCode(errorCode),
        truncateSafeMessage(safeMessage),
        usage,
        streamMode,
      );
    });
  }
}

async function loadQuotaSnapshot(
  transaction: Transaction,
  tenantId: string,
  now: Date,
): Promise<AgentRunQuotaSnapshot> {
  const tenant = await transaction.tenant.findFirst({
    where: { id: tenantId },
    select: {
      agentRunConcurrencyLimit: true,
      agentRunRateLimitPerMinute: true,
      agentRunMonthlyTokenLimit: true,
    },
  });
  if (tenant === null) throw new Error('Agent Run tenant does not exist.');

  // UNKNOWN means the provider may still be executing. It therefore consumes a
  // tenant concurrency slot until a trusted reconciliation changes its status;
  // elapsed wall-clock time is not evidence that remote work stopped.
  const minuteStart = new Date(now.getTime() - 60_000);
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
  const activeRuns = await transaction.agentRun.count({
    where: {
      tenantId,
      status: { in: [...AGENT_RUN_CONCURRENCY_HOLD_STATUSES] },
      OR: [{ status: { not: 'UNKNOWN' } }, { cancellationConfirmedAt: null }],
    },
  });
  const runsLastMinute = await transaction.agentRun.count({
    where: { tenantId, dispatchStartedAt: { gte: minuteStart } },
  });
  const oldestDispatch = await transaction.agentRun.findFirst({
    where: { tenantId, dispatchStartedAt: { gte: minuteStart } },
    orderBy: [{ dispatchStartedAt: 'asc' }, { id: 'asc' }],
    select: { dispatchStartedAt: true },
  });
  const [tokenLedger] = await transaction.$queryRaw<
    Array<{ monthly_tokens_used: bigint; tokens_reserved: bigint }>
  >(Prisma.sql`
    SELECT
      COALESCE(SUM(
        CASE
          WHEN "finished_at" >= ${monthStart}
            AND "token_evidence" = 'PROVIDER_REPORTED'::public."AgentRunTokenEvidence"
            THEN "total_tokens"
          WHEN "quota_settled_at" >= ${monthStart}
            AND "token_evidence" = 'QUOTA_UPPER_BOUND'::public."AgentRunTokenEvidence"
            THEN "quota_charged_tokens"
          ELSE 0
        END
      ), 0)::bigint AS monthly_tokens_used,
      COALESCE(SUM("reserved_tokens") FILTER (
        WHERE "reserved_tokens" > 0
      ), 0)::bigint AS tokens_reserved
    FROM public."agent_runs"
    WHERE "tenant_id" = ${tenantId}::uuid
  `);

  return {
    concurrencyLimit: tenant.agentRunConcurrencyLimit,
    rateLimitPerMinute: tenant.agentRunRateLimitPerMinute,
    monthlyTokenLimit: tenant.agentRunMonthlyTokenLimit,
    activeRuns,
    runsLastMinute,
    oldestDispatchInWindow: oldestDispatch?.dispatchStartedAt ?? null,
    monthlyTokensUsed: tokenLedger?.monthly_tokens_used ?? 0n,
    tokensReserved: tokenLedger?.tokens_reserved ?? 0n,
  };
}

async function hasEarlierActiveDirectRun(
  transaction: Transaction,
  run: RunForExecution,
): Promise<boolean> {
  const earlier = await transaction.agentRun.findFirst({
    where: {
      tenantId: run.tenantId,
      conversationId: run.conversationId,
      turnLimit: 1,
      status: { in: ['QUEUED', 'DISPATCHING', 'RUNNING'] },
      OR: [{ createdAt: { lt: run.createdAt } }, { createdAt: run.createdAt, id: { lt: run.id } }],
    },
    select: { id: true },
  });
  return earlier !== null;
}

async function findRunForExecution(
  transaction: Transaction,
  tenantId: string,
  runId: string,
): Promise<RunForExecution | null> {
  return transaction.agentRun.findFirst({
    where: { tenantId, id: runId },
    include: {
      requester: true,
      agent: { include: { _count: { select: { roleAssignments: true } } } },
      agentVersion: true,
      conversation: true,
      inputMessage: true,
    },
  });
}

async function validateQueuedRun(
  transaction: Transaction,
  run: RunForExecution,
  authorization: AuthorizationDecisionService,
): Promise<
  | { readonly errorCode: string; readonly knowledgeAuthorization?: never }
  | {
      readonly errorCode: null;
      readonly knowledgeAuthorization: KnowledgeRetrievalAuthorizationContext;
    }
> {
  if (run.requester.status !== 'ACTIVE') return { errorCode: 'REQUESTER_INACTIVE' };
  const participants = await transaction.conversationParticipant.findMany({
    where: { tenantId: run.tenantId, conversationId: run.conversationId, leftAt: null },
    select: { type: true, userId: true, agentId: true },
  });
  if (
    !participants.some(
      (participant) => participant.type === 'USER' && participant.userId === run.requesterUserId,
    )
  ) {
    return { errorCode: 'REQUESTER_NOT_PARTICIPANT' };
  }
  if (
    !participants.some(
      (participant) => participant.type === 'AGENT' && participant.agentId === run.agentId,
    )
  ) {
    return { errorCode: 'AGENT_NOT_PARTICIPANT' };
  }
  if (run.agent.status !== 'ONLINE') return { errorCode: 'AGENT_NOT_ONLINE' };
  if (run.agent.kind === 'DEPARTMENT') {
    if (run.agent.orgUnitId === null) return { errorCode: 'AGENT_DEPARTMENT_INVALID' };
    const activeDepartmentEmployment = await transaction.employment.findFirst({
      where: {
        tenantId: run.tenantId,
        userId: run.requesterUserId,
        orgUnitId: run.agent.orgUnitId,
        status: 'ACTIVE',
      },
      select: { id: true },
    });
    if (activeDepartmentEmployment === null) {
      return { errorCode: 'AGENT_DEPARTMENT_ACCESS_DENIED' };
    }
  }
  const assignmentRequired =
    hasRoleAgentAssignmentMarker(run.agent.settings) || run.agent._count.roleAssignments > 0;
  let assignment: AuthorizationAssignment | null = null;
  if (assignmentRequired) {
    const storedAssignment = await transaction.roleAssignment.findFirst({
      where: {
        tenantId: run.tenantId,
        agentInstanceId: run.agentId,
        userId: run.requesterUserId,
      },
      orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
      select: {
        id: true,
        tenantId: true,
        userId: true,
        agentInstanceId: true,
        status: true,
        effectiveFrom: true,
        effectiveTo: true,
        roleTemplateId: true,
        organizationScope: true,
        permissionScope: true,
        employment: { select: { status: true, userId: true } },
      },
    });
    if (storedAssignment !== null) {
      const organizationScope = readAuthorizationOrganizationScope(
        storedAssignment.organizationScope,
      );
      assignment = {
        id: storedAssignment.id,
        tenantId: storedAssignment.tenantId,
        userId: storedAssignment.userId,
        agentInstanceId: storedAssignment.agentInstanceId,
        status: storedAssignment.status,
        effectiveFrom: storedAssignment.effectiveFrom,
        effectiveTo: storedAssignment.effectiveTo,
        roleTemplateId: storedAssignment.roleTemplateId,
        employmentActive:
          storedAssignment.employment.status === 'ACTIVE' &&
          storedAssignment.employment.userId === run.requesterUserId,
        ...(organizationScope === undefined ? {} : { organizationScope }),
        projectIds: readStringArray(storedAssignment.permissionScope, 'projectIds'),
        taskIds: readStringArray(storedAssignment.permissionScope, 'taskIds'),
        dataLabels: readStringArray(storedAssignment.permissionScope, 'dataLabels'),
        permissionActions: readStringArray(storedAssignment.permissionScope, 'actions'),
      };
    }
  }
  if (
    isAgentRunPolicySnapshotV2(run.policySnapshot) &&
    (assignmentRequired
      ? readPolicySnapshotAssignmentId(run.policySnapshot) !== assignment?.id
      : readPolicySnapshotAssignmentId(run.policySnapshot) !== null)
  ) {
    return { errorCode: 'AGENT_RUN_ASSIGNMENT_SNAPSHOT_MISMATCH' };
  }
  const taskContext = {
    ...(run.taskId === null ? {} : { taskId: run.taskId }),
    assignmentRequired,
    resourceAgentId: run.agentId,
    resourceOwnerUserId: run.agent.ownerUserId,
    resourceVisibility: readAgentVisibility(run.agent.settings),
    requesterUserId: run.requesterUserId,
    participantUserIds: participants
      .filter((participant) => participant.type === 'USER')
      .map((participant) => participant.userId)
      .filter((userId): userId is string => userId !== null),
    enforceActorMembership: true,
  } as const;
  const authorizationDecision = authorization.decide({
    tenantId: run.tenantId,
    userId: run.requesterUserId,
    tenantRole: run.requester.role,
    action: 'agent.run.execute',
    resourceTenantId: run.agent.tenantId,
    assignment,
    taskContext,
    risk: 'MEDIUM',
  });
  if (!authorizationDecision.allowed) {
    return { errorCode: mapRunAuthorizationDenial(authorizationDecision.reasonCode) };
  }
  if (
    !isAgentVersionExecutableForRun({
      status: run.agentVersion.status,
      retryOfRunId: run.retryOfRunId,
      assignmentRequired,
      assignmentId: assignment?.id ?? null,
      policySnapshot: run.policySnapshot,
    })
  ) {
    return { errorCode: 'AGENT_VERSION_NOT_PUBLISHED' };
  }

  if (run.turnLimit === 1) {
    if (
      run.trigger !== 'USER_MESSAGE' ||
      run.turnIndex !== 1 ||
      run.parentRunId !== null ||
      run.conversation.relayAgentAId !== null ||
      run.conversation.relayAgentBId !== null ||
      run.conversation.relayTurnLimit !== null
    ) {
      return { errorCode: 'AGENT_RUN_CHAIN_INVALID' };
    }
    return {
      errorCode: null,
      knowledgeAuthorization: {
        tenantRole: run.requester.role,
        assignment,
        taskContext,
      },
    };
  }

  const expectedAgentId =
    run.turnIndex % 2 === 1 ? run.conversation.relayAgentAId : run.conversation.relayAgentBId;
  if (
    run.conversation.relayAgentAId === null ||
    run.conversation.relayAgentBId === null ||
    run.conversation.relayTurnLimit !== run.turnLimit ||
    expectedAgentId !== run.agentId ||
    (run.turnIndex === 1
      ? run.trigger !== 'USER_MESSAGE' || run.parentRunId !== null
      : run.trigger !== 'RELAY_TURN' || run.parentRunId === null)
  ) {
    return { errorCode: 'AGENT_RELAY_CHAIN_INVALID' };
  }
  return {
    errorCode: null,
    knowledgeAuthorization: {
      tenantRole: run.requester.role,
      assignment,
      taskContext,
    },
  };
}

export function isAgentVersionExecutableForRun(input: {
  readonly status: string;
  readonly retryOfRunId: string | null;
  readonly assignmentRequired: boolean;
  readonly assignmentId: string | null;
  readonly policySnapshot: unknown;
}): boolean {
  if (input.status === 'PUBLISHED') return true;
  if (input.status !== 'RETIRED') return false;
  if (input.retryOfRunId !== null) return isAgentRunPolicySnapshotV2(input.policySnapshot);
  return (
    input.assignmentRequired &&
    input.assignmentId !== null &&
    isAgentRunPolicySnapshotV2(input.policySnapshot) &&
    readPolicySnapshotAssignmentId(input.policySnapshot) === input.assignmentId
  );
}

async function loadAgentRunMemoryContextSnapshot(
  transaction: Transaction,
  run: RunForExecution,
  query: string,
): Promise<AgentRunMemoryContextSnapshot> {
  await setMemoryAccessContext(transaction, run.requesterUserId);
  const assignmentId = readPolicySnapshotAssignmentId(run.policySnapshot);
  const rows = await transaction.$queryRaw<AgentRunMemoryRow[]>(Prisma.sql`
    SELECT
      memory."id",
      memory."version",
      memory."revision",
      memory."scope"::text AS "scope",
      memory."title",
      memory."summary",
      memory."content_hash",
      memory."source_type"::text AS "source_type",
      memory."source_id",
      memory."source_version",
      memory."sensitivity"::text AS "sensitivity",
      memory."effective_from",
      memory."effective_to",
      memory."expires_at",
      memory."updated_at"
    FROM public."memory_records" memory
    WHERE memory."tenant_id" = ${run.tenantId}::uuid
      AND memory."status" IN ('ACTIVE', 'SEALED')
      AND (
        memory."scope" = 'ENTERPRISE'
        OR (
          memory."scope" = 'ROLE'
          AND ${assignmentId}::uuid IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM public."role_assignments" assignment
            WHERE assignment."tenant_id" = memory."tenant_id"
              AND assignment."id" = ${assignmentId}::uuid
              AND assignment."role_template_id" = memory."role_template_id"
              AND assignment."role_version_id" = memory."role_version_id"
          )
        )
        OR (
          memory."scope" = 'EMPLOYEE_PRIVATE'
          AND memory."role_assignment_id" = ${assignmentId}::uuid
        )
        OR (
          memory."scope" = 'TASK'
          AND memory."task_id" = ${run.taskId}::uuid
        )
        OR (
          memory."scope" = 'CONVERSATION'
          AND memory."conversation_id" = ${run.conversationId}::uuid
        )
      )
    ORDER BY memory."updated_at" DESC, memory."id"
    LIMIT ${MAX_MEMORY_CANDIDATES}
  `);
  const terms = tokenize(query);
  const contexts = rows
    .map(mapAgentRunMemoryRow)
    .map((memory) => ({
      memory,
      relevance: relevanceScore(memory.title, memory.summary, terms),
      scopePriority: memoryScopePriority(memory.scope),
    }))
    .filter(
      ({ memory, relevance }) =>
        relevance > 0 ||
        memory.scope === 'EMPLOYEE_PRIVATE' ||
        memory.scope === 'TASK' ||
        memory.scope === 'CONVERSATION',
    )
    .sort(
      (left, right) =>
        right.relevance - left.relevance ||
        right.scopePriority - left.scopePriority ||
        right.memory.updatedAt.localeCompare(left.memory.updatedAt) ||
        left.memory.id.localeCompare(right.memory.id),
    )
    .slice(0, MAX_MEMORY_CONTEXTS)
    .map(({ memory }) => memory);
  return buildMemoryContextSnapshot(contexts, new Date());
}

async function memoryContextSnapshotStillAccessible(
  transaction: Transaction,
  run: RunForExecution,
  snapshot: AgentRunMemoryContextSnapshot,
): Promise<boolean> {
  if (snapshot.contexts.length === 0) return true;
  await setMemoryAccessContext(transaction, run.requesterUserId);
  const ids = Prisma.join(snapshot.contexts.map((memory) => Prisma.sql`${memory.id}::uuid`));
  const rows = await transaction.$queryRaw<AgentRunMemoryRow[]>(Prisma.sql`
    SELECT
      memory."id",
      memory."version",
      memory."revision",
      memory."scope"::text AS "scope",
      memory."title",
      memory."summary",
      memory."content_hash",
      memory."source_type"::text AS "source_type",
      memory."source_id",
      memory."source_version",
      memory."sensitivity"::text AS "sensitivity",
      memory."effective_from",
      memory."effective_to",
      memory."expires_at",
      memory."updated_at"
    FROM public."memory_records" memory
    WHERE memory."tenant_id" = ${run.tenantId}::uuid
      AND memory."id" IN (${ids})
      AND memory."status" IN ('ACTIVE', 'SEALED')
  `);
  if (rows.length !== snapshot.contexts.length) return false;
  const current = new Map(rows.map((row) => [row.id, mapAgentRunMemoryRow(row)]));
  return snapshot.contexts.every((memory) => {
    const found = current.get(memory.id);
    return found !== undefined && hashEvidence(found) === hashEvidence(memory);
  });
}

async function setMemoryAccessContext(
  transaction: Transaction,
  requesterUserId: string,
): Promise<void> {
  await transaction.$queryRaw(Prisma.sql`
    SELECT
      set_config('app.user_id', ${requesterUserId}, true),
      set_config('app.memory_purpose', ${AGENT_RUN_MEMORY_PURPOSE}, true)
  `);
}

export function buildMemoryContextSnapshot(
  contexts: readonly AgentRunMemoryContext[],
  resolvedAt: Date,
): AgentRunMemoryContextSnapshot {
  return {
    schemaVersion: 1,
    purpose: AGENT_RUN_MEMORY_PURPOSE,
    resolvedAt: resolvedAt.toISOString(),
    contexts,
    snapshotSha256: memoryContextSnapshotDigest(contexts),
  };
}

export function parseAgentRunMemoryContextSnapshot(
  value: unknown,
): AgentRunMemoryContextSnapshot | null {
  if (!isJsonRecord(value)) return null;
  if (
    value.schemaVersion !== 1 ||
    value.purpose !== AGENT_RUN_MEMORY_PURPOSE ||
    typeof value.resolvedAt !== 'string' ||
    !validTimestamp(value.resolvedAt) ||
    !Array.isArray(value.contexts) ||
    value.contexts.length > MAX_MEMORY_CONTEXTS ||
    typeof value.snapshotSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(value.snapshotSha256)
  ) {
    return null;
  }
  const contexts: AgentRunMemoryContext[] = [];
  for (const item of value.contexts) {
    const parsed = parseAgentRunMemoryContext(item);
    if (parsed === null) return null;
    contexts.push(parsed);
  }
  if (
    new Set(contexts.map((memory) => memory.id)).size !== contexts.length ||
    memoryContextSnapshotDigest(contexts) !== value.snapshotSha256
  ) {
    return null;
  }
  return {
    schemaVersion: 1,
    purpose: AGENT_RUN_MEMORY_PURPOSE,
    resolvedAt: value.resolvedAt,
    contexts,
    snapshotSha256: value.snapshotSha256,
  };
}

function parseAgentRunMemoryContext(value: unknown): AgentRunMemoryContext | null {
  if (!isJsonRecord(value)) return null;
  const scope = value.scope;
  const sourceType = value.sourceType;
  const sensitivity = value.sensitivity;
  if (
    typeof value.id !== 'string' ||
    !isUuid(value.id) ||
    typeof value.version !== 'number' ||
    !Number.isSafeInteger(value.version) ||
    value.version < 1 ||
    typeof value.revision !== 'number' ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1 ||
    !isMemoryScope(scope) ||
    typeof value.title !== 'string' ||
    typeof value.summary !== 'string' ||
    typeof value.summarySha256 !== 'string' ||
    value.summarySha256 !== hashText(value.summary) ||
    typeof value.contentHash !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(value.contentHash) ||
    !isMemorySourceType(sourceType) ||
    typeof value.sourceId !== 'string' ||
    !isUuid(value.sourceId) ||
    typeof value.sourceVersion !== 'number' ||
    !Number.isSafeInteger(value.sourceVersion) ||
    value.sourceVersion < 1 ||
    !isMemorySensitivity(sensitivity) ||
    typeof value.effectiveFrom !== 'string' ||
    !validTimestamp(value.effectiveFrom) ||
    !(
      value.effectiveTo === null ||
      (typeof value.effectiveTo === 'string' && validTimestamp(value.effectiveTo))
    ) ||
    !(
      value.expiresAt === null ||
      (typeof value.expiresAt === 'string' && validTimestamp(value.expiresAt))
    ) ||
    typeof value.updatedAt !== 'string' ||
    !validTimestamp(value.updatedAt)
  ) {
    return null;
  }
  return {
    id: value.id,
    version: value.version,
    revision: value.revision,
    scope,
    title: value.title,
    summary: value.summary,
    summarySha256: value.summarySha256,
    contentHash: value.contentHash,
    sourceType,
    sourceId: value.sourceId,
    sourceVersion: value.sourceVersion,
    sensitivity,
    effectiveFrom: value.effectiveFrom,
    effectiveTo: value.effectiveTo,
    expiresAt: value.expiresAt,
    updatedAt: value.updatedAt,
  };
}

function memoryContextSnapshotDigest(contexts: readonly AgentRunMemoryContext[]): string {
  return hashEvidence({
    schemaVersion: 1,
    purpose: AGENT_RUN_MEMORY_PURPOSE,
    contexts,
  });
}

function memoryContextSnapshotJson(
  snapshot: AgentRunMemoryContextSnapshot,
): Prisma.InputJsonObject {
  return JSON.parse(JSON.stringify(snapshot)) as Prisma.InputJsonObject;
}

function mapAgentRunMemoryRow(row: AgentRunMemoryRow): AgentRunMemoryContext {
  return {
    id: row.id,
    version: row.version,
    revision: row.revision,
    scope: row.scope,
    title: row.title,
    summary: row.summary,
    summarySha256: hashText(row.summary),
    contentHash: row.content_hash,
    sourceType: row.source_type,
    sourceId: row.source_id,
    sourceVersion: row.source_version,
    sensitivity: row.sensitivity,
    effectiveFrom: row.effective_from.toISOString(),
    effectiveTo: row.effective_to?.toISOString() ?? null,
    expiresAt: row.expires_at?.toISOString() ?? null,
    updatedAt: row.updated_at.toISOString(),
  };
}

function memoryScopePriority(scope: AgentRunMemoryContext['scope']): number {
  return scope === 'EMPLOYEE_PRIVATE'
    ? 5
    : scope === 'TASK'
      ? 4
      : scope === 'CONVERSATION'
        ? 3
        : scope === 'ROLE'
          ? 2
          : 1;
}

function isMemoryScope(value: unknown): value is AgentRunMemoryContext['scope'] {
  return (
    value === 'ENTERPRISE' ||
    value === 'ROLE' ||
    value === 'EMPLOYEE_PRIVATE' ||
    value === 'TASK' ||
    value === 'CONVERSATION'
  );
}

function isMemorySourceType(value: unknown): value is AgentRunMemoryContext['sourceType'] {
  return (
    value === 'KNOWLEDGE' ||
    value === 'ROLE_VERSION' ||
    value === 'TASK' ||
    value === 'CONVERSATION' ||
    value === 'DELIVERABLE' ||
    value === 'EXPERIENCE' ||
    value === 'USER_CONFIRMED'
  );
}

function isMemorySensitivity(value: unknown): value is AgentRunMemoryContext['sensitivity'] {
  return (
    value === 'PUBLIC' || value === 'INTERNAL' || value === 'CONFIDENTIAL' || value === 'RESTRICTED'
  );
}

function validTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hashText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

interface AgentRunMemoryRow {
  readonly id: string;
  readonly version: number;
  readonly revision: number;
  readonly scope: AgentRunMemoryContext['scope'];
  readonly title: string;
  readonly summary: string;
  readonly content_hash: string;
  readonly source_type: AgentRunMemoryContext['sourceType'];
  readonly source_id: string;
  readonly source_version: number;
  readonly sensitivity: AgentRunMemoryContext['sensitivity'];
  readonly effective_from: Date;
  readonly effective_to: Date | null;
  readonly expires_at: Date | null;
  readonly updated_at: Date;
}

async function loadRecentContext(
  transaction: Transaction,
  tenantId: string,
  conversationId: string,
  inputMessage: { readonly id: string; readonly createdAt: Date },
): Promise<readonly AgentRunContextMessage[]> {
  const stored = await transaction.message.findMany({
    where: {
      tenantId,
      conversationId,
      OR: [
        { createdAt: { lt: inputMessage.createdAt } },
        { createdAt: inputMessage.createdAt, id: { lte: inputMessage.id } },
      ],
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: MAX_CONTEXT_MESSAGES,
  });
  const selected: AgentRunContextMessage[] = [];
  for (const message of stored) {
    const text = readText(message.content);
    selected.push({
      senderType: message.senderType,
      senderId: message.senderUserId ?? message.senderAgentId ?? message.id,
      senderName: message.senderName,
      text,
    });
  }
  return selected.reverse();
}

function mapPreparedRun(
  run: RunForExecution,
  executionSnapshot: AgentRunExecutionSnapshot,
  messages: readonly AgentRunContextMessage[],
  knowledgeSources: readonly AgentRunKnowledgeSource[],
  memoryContexts: readonly AgentRunMemoryContext[],
  knowledgeGroundingRequired: boolean,
  modelRoute: TrustedModelRouteSnapshot | null,
  inputSafetyDecision: AiSafetyDecision,
  controlledProbeCatalogId: string | null,
): PreparedAgentRun {
  const controlledCandidate =
    controlledProbeCatalogId === null
      ? undefined
      : modelRoute?.candidates.find(
          ({ catalogVersionId }) => catalogVersionId === controlledProbeCatalogId,
        );
  const controlledModelConnectivityProbe = controlledCandidate !== undefined;
  const effectiveModelRoute =
    controlledCandidate === undefined || modelRoute === null
      ? modelRoute
      : {
          ...modelRoute,
          maximumAttempts: 1,
          candidates: [controlledCandidate],
        };
  return {
    id: run.id,
    tenantId: run.tenantId,
    conversationId: run.conversationId,
    requesterUserId: run.requesterUserId,
    requesterRole: run.requester.role,
    agentId: run.agentId,
    agentName: run.agent.name,
    agentVersionId: executionSnapshot.agentVersionId,
    agentVersion: executionSnapshot.agentVersion,
    systemPrompt: executionSnapshot.systemPrompt,
    externalRunId: run.externalRunId,
    turnIndex: run.turnIndex,
    turnLimit: run.turnLimit,
    maxInputTokens: DEFAULT_AGENT_RUN_MAX_INPUT_TOKENS,
    maxOutputTokens: DEFAULT_AGENT_RUN_MAX_OUTPUT_TOKENS,
    maxSteps: controlledModelConnectivityProbe ? 1 : 3,
    maxToolCalls: 0,
    timeoutMs: 60_000,
    maxCostMicros: 1_000_000,
    messages,
    knowledgeSources,
    memoryContexts,
    knowledgeGroundingRequired,
    knowledgeEvidenceFallbackEnabled: true,
    controlledModelConnectivityProbe,
    ...(effectiveModelRoute === null ? {} : { modelRoute: effectiveModelRoute }),
    inputSafetyDecision,
  };
}

function readSelectedKnowledgeBaseIds(value: Prisma.JsonValue): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [];
  const ids = value.knowledgeBaseIds;
  return Array.isArray(ids)
    ? [...new Set(ids.filter((id): id is string => typeof id === 'string' && isUuid(id)))].slice(
        0,
        50,
      )
    : [];
}

function isOwnerAuthorizedKnowledgeScope(value: Prisma.JsonValue): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    value.mode === 'owner-authorized'
  );
}

function createCitationExcerpt(content: string): string {
  return content.replace(/\s+/g, ' ').trim().slice(0, 500);
}

function tokenize(value: string): string[] {
  return [...new Set(value.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [])].slice(0, 24);
}

function relevanceScore(title: string, content: string, terms: readonly string[]): number {
  const titleText = title.toLowerCase();
  const bodyText = content.toLowerCase();
  return terms.reduce(
    (score, term) => score + (titleText.includes(term) ? 5 : 0) + (bodyText.includes(term) ? 1 : 0),
    0,
  );
}

function createExcerpt(content: string, terms: readonly string[]): string {
  const normalized = content.replace(/\s+/g, ' ').trim();
  const lower = normalized.toLowerCase();
  const firstMatch = terms.map((term) => lower.indexOf(term)).find((index) => index >= 0) ?? 0;
  const start = Math.max(0, firstMatch - 80);
  const excerpt = normalized.slice(start, start + 400).trim();
  return excerpt.length > 0 ? excerpt : '该文档暂无可展示的文本摘要。';
}

async function enqueueNextRelayRun(
  transaction: Transaction,
  run: Prisma.AgentRunGetPayload<{ include: { conversation: true; agent: true } }>,
  inputMessageId: string,
): Promise<void> {
  const nextTurn = run.turnIndex + 1;
  const nextAgentId =
    nextTurn % 2 === 1 ? run.conversation.relayAgentAId : run.conversation.relayAgentBId;
  if (
    nextAgentId === null ||
    run.conversation.relayTurnLimit !== run.turnLimit ||
    run.turnLimit <= 1
  ) {
    throw new Error('Relay configuration changed before the next turn was queued.');
  }
  const now = new Date();
  const nextAgent = await transaction.agentInstance.findFirst({
    where: { tenantId: run.tenantId, id: nextAgentId },
    include: {
      version: { include: { template: true } },
      roleAssignments: {
        where: {
          tenantId: run.tenantId,
          userId: run.requesterUserId,
          status: 'ACTIVE',
          effectiveFrom: { lte: now },
          AND: [
            { OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }] },
            { employment: { is: { userId: run.requesterUserId, status: 'ACTIVE' } } },
          ],
        },
        select: {
          id: true,
          roleTemplateId: true,
          roleVersionId: true,
        },
        take: 1,
      },
    },
  });
  if (nextAgent === null) throw new Error('The next relay Agent does not exist.');

  const childId = randomUUID();
  await transaction.agentRun.create({
    data: {
      id: childId,
      tenantId: run.tenantId,
      conversationId: run.conversationId,
      inputMessageId,
      requesterUserId: run.requesterUserId,
      agentId: nextAgent.id,
      agentVersionId: nextAgent.versionId,
      taskId: run.taskId,
      parentRunId: run.id,
      trigger: 'RELAY_TURN',
      turnIndex: nextTurn,
      turnLimit: run.turnLimit,
      idempotencyKey: `relay:${run.id}:turn:${nextTurn}:agent:${nextAgent.id}`,
      policySnapshot: buildAgentRunPolicySnapshot({
        agentVersion: nextAgent.version,
        roleAssignment: nextAgent.roleAssignments[0] ?? null,
        knowledgeScopeOverride: effectiveAgentKnowledgeScope(
          nextAgent.settings,
          nextAgent.version.knowledgeScope,
        ),
        extra: { relay: true },
      }),
    },
  });
  await Promise.all([
    transaction.outboxEvent.create({
      data: {
        tenantId: run.tenantId,
        aggregateType: 'agent_run',
        aggregateId: childId,
        eventType: 'agent.run_requested.v1',
        payload: { runId: childId },
      },
    }),
    transaction.auditEvent.create({
      data: {
        tenantId: run.tenantId,
        actorType: 'AGENT',
        actorId: run.agentId,
        action: 'agent.run.request',
        resourceType: 'agent_run',
        resourceId: childId,
        metadata: {
          conversationId: run.conversationId,
          inputMessageId,
          parentRunId: run.id,
          agentId: nextAgent.id,
          turnIndex: nextTurn,
          turnLimit: run.turnLimit,
        },
      },
    }),
  ]);
}

async function markRunTerminal(
  transaction: Transaction,
  run: {
    readonly id: string;
    readonly tenantId: string;
    readonly conversationId: string;
    readonly reservedTokens: number;
    readonly dispatchStartedAt?: Date | null;
    readonly startedAt?: Date | null;
  },
  status: 'FAILED' | 'UNKNOWN',
  errorCode: string,
  errorMessage: string,
  usage?: AgentRunUsage,
  streamMode: AgentRunStreamMode = 'terminal_only',
): Promise<void> {
  const finishedAt = new Date();
  const latencyMs = calculateLatencyMs(run, finishedAt);
  await transaction.agentRun.update({
    where: { id: run.id },
    data: {
      status,
      errorCode: safeCode(errorCode),
      errorMessage: truncateSafeMessage(errorMessage),
      finishedAt,
      latencyMs,
      ...terminalUsageUpdate(run, status, usage, finishedAt),
      version: { increment: 1 },
    },
  });
  await transaction.auditEvent.create({
    data: {
      tenantId: run.tenantId,
      actorType: 'SERVICE',
      actorId: run.id,
      action: status === 'UNKNOWN' ? 'agent.run.unknown' : 'agent.run.fail',
      resourceType: 'agent_run',
      resourceId: run.id,
      metadata: {
        conversationId: run.conversationId,
        errorCode: safeCode(errorCode),
        ...terminalUsageAuditMetadata(run, status, usage, finishedAt, latencyMs),
      },
    },
  });
  await appendTerminalStreamEvent(transaction, {
    tenantId: run.tenantId,
    runId: run.id,
    status,
    mode: streamMode,
    createdAt: finishedAt,
  });
  if (status !== 'UNKNOWN') {
    await closeControlledConnectivityProbeParticipants(transaction, run, finishedAt);
  }
}

async function closeControlledConnectivityProbeParticipants(
  transaction: Transaction,
  run: {
    readonly tenantId: string;
    readonly id: string;
    readonly conversationId: string;
    readonly policySnapshot?: Prisma.JsonValue;
  },
  leftAt: Date,
): Promise<void> {
  const markerCatalogId = readControlledModelConnectivityProbeCatalogId(run.policySnapshot);
  if (markerCatalogId === null) return;
  const trustedProbe = await transaction.aiModelConnectivityProbe.findFirst({
    where: { tenantId: run.tenantId, runId: run.id },
    select: { targetCatalogVersionId: true },
  });
  if (trustedProbe?.targetCatalogVersionId !== markerCatalogId) return;
  await transaction.conversationParticipant.updateMany({
    where: {
      tenantId: run.tenantId,
      conversationId: run.conversationId,
      leftAt: null,
    },
    data: { leftAt },
  });
}

function terminalPreparation(
  status: Extract<StoredAgentRunStatus, 'SUCCEEDED' | 'FAILED' | 'UNKNOWN' | 'CANCELLED'>,
  externalRunId: string | null,
  errorCode: string | null,
): AgentRunPreparation {
  return { kind: 'terminal', status, externalRunId, errorCode };
}

function isTerminal(
  status: StoredAgentRunStatus,
): status is Extract<StoredAgentRunStatus, 'SUCCEEDED' | 'FAILED' | 'UNKNOWN' | 'CANCELLED'> {
  return TERMINAL_STATUSES.has(status);
}

async function lockRun(transaction: Transaction, tenantId: string, runId: string): Promise<void> {
  const key = `${tenantId}:agent-run:${runId}`;
  await transaction.$queryRaw`
    SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))::text AS lock_token
  `;
}

async function lockTenantQuota(transaction: Transaction, tenantId: string): Promise<void> {
  const key = `${tenantId}:agent-run-quota`;
  await transaction.$queryRaw`
    SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))::text AS lock_token
  `;
}

async function lockAgentConversation(
  transaction: Transaction,
  tenantId: string,
  conversationId: string,
): Promise<void> {
  const key = `${tenantId}:${conversationId}:agent-run`;
  await transaction.$queryRaw`
    SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))::text AS lock_token
  `;
}

function readAgentVisibility(settings: Prisma.JsonValue): 'tenant' | 'owner' {
  if (
    typeof settings === 'object' &&
    settings !== null &&
    !Array.isArray(settings) &&
    (settings.visibility === 'tenant' || settings.visibility === 'department')
  ) {
    return 'tenant';
  }
  return 'owner';
}

function effectiveAgentKnowledgeScope(
  settings: Prisma.JsonValue,
  versionScope: Prisma.JsonValue,
): Prisma.JsonValue {
  if (
    typeof settings !== 'object' ||
    settings === null ||
    Array.isArray(settings) ||
    !Array.isArray(settings.knowledgeBaseIdsOverride)
  ) {
    return versionScope;
  }
  const knowledgeBaseIds = [
    ...new Set(
      settings.knowledgeBaseIdsOverride.filter((id): id is string => typeof id === 'string'),
    ),
  ]
    .sort()
    .slice(0, 50);
  const base =
    typeof versionScope === 'object' && versionScope !== null && !Array.isArray(versionScope)
      ? (JSON.parse(JSON.stringify(versionScope)) as Prisma.JsonObject)
      : {};
  return { ...base, knowledgeBaseIds };
}

function readAuthorizationOrganizationScope(
  value: Prisma.JsonValue,
): AuthorizationAssignment['organizationScope'] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const organizationIds = readStringArray(value, 'organizationIds');
  const fallbackIds = readStringArray(value, 'orgUnitIds');
  const scopedIds = organizationIds.length > 0 ? organizationIds : fallbackIds;
  const includeDescendants = value.includeDescendants === true || value.includeChildren === true;
  return scopedIds.length > 0 ||
    typeof value.includeDescendants === 'boolean' ||
    typeof value.includeChildren === 'boolean'
    ? {
        organizationIds: scopedIds,
        includeDescendants,
      }
    : undefined;
}

function readStringArray(value: Prisma.JsonValue, key: string): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [];
  const candidate = value[key];
  return Array.isArray(candidate)
    ? [
        ...new Set(
          candidate.filter(
            (item): item is string => typeof item === 'string' && item.trim().length > 0,
          ),
        ),
      ]
    : [];
}

function mapRunAuthorizationDenial(reasonCode: AuthorizationReasonCode): string {
  if (
    reasonCode === 'ASSIGNMENT_REQUIRED' ||
    reasonCode === 'ASSIGNMENT_NOT_ACTIVE' ||
    reasonCode === 'ASSIGNMENT_NOT_EFFECTIVE' ||
    reasonCode === 'ASSIGNMENT_EXPIRED' ||
    reasonCode === 'ASSIGNMENT_EMPLOYMENT_INACTIVE' ||
    reasonCode === 'ASSIGNMENT_TENANT_MISMATCH' ||
    reasonCode === 'ASSIGNMENT_USER_MISMATCH' ||
    reasonCode === 'ASSIGNMENT_RESOURCE_MISMATCH' ||
    reasonCode === 'ASSIGNMENT_TIME_INVALID' ||
    reasonCode === 'ASSIGNMENT_ACTION_DENIED'
  ) {
    return 'AGENT_ASSIGNMENT_INACTIVE';
  }
  if (reasonCode === 'TASK_CONTEXT_DENIED') return 'AGENT_TASK_SCOPE_DENIED';
  if (reasonCode === 'RESOURCE_VISIBILITY_DENIED') return 'AGENT_NOT_VISIBLE';
  if (reasonCode === 'CROSS_TENANT') return 'AUTHORIZATION_CROSS_TENANT';
  return 'AGENT_RUN_AUTHORIZATION_DENIED';
}

function readText(value: Prisma.JsonValue): string {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    value.type !== 'text' ||
    typeof value.text !== 'string'
  ) {
    throw new Error('Agent Run context contains an unsupported message payload.');
  }
  return value.text;
}

function truncateOutput(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error('AI Runtime succeeded without a text output.');
  }
  if (normalized.length <= MAX_OUTPUT_CHARACTERS) return normalized;
  let end = MAX_OUTPUT_CHARACTERS;
  if (isHighSurrogate(normalized.charCodeAt(end - 1))) end -= 1;
  return normalized.slice(0, end);
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff;
}

function safeCode(value: string): string {
  return /^[A-Z0-9][A-Z0-9_]{0,119}$/.test(value) ? value : 'AGENT_RUN_FAILED';
}

function cancellationConfirmationTime(requestedAt: Date): Date {
  return new Date(Math.max(Date.now(), requestedAt.getTime()));
}

function truncateSafeMessage(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) return 'Agent Run processing failed.';
  return normalized.slice(0, 500);
}

type AgentRunUsageSettlementUpdate = Prisma.AgentRunUncheckedUpdateInput;

function runtimeUsageIdentityUpdate(
  usage: AgentRunUsage | undefined,
): Prisma.AgentRunUncheckedUpdateInput {
  if (usage === undefined) return {};
  return {
    runtimeProvider: usage.provider,
    runtimeModel: usage.model,
    toolCalls: usage.toolCalls,
  };
}

function terminalUsageUpdate(
  run: { readonly reservedTokens: number },
  status: 'SUCCEEDED' | 'FAILED' | 'UNKNOWN' | 'CANCELLED',
  usage: AgentRunUsage | undefined,
  recordedAt: Date,
): AgentRunUsageSettlementUpdate {
  const settlement = decideAgentRunTokenSettlement({
    status,
    reservedTokens: run.reservedTokens,
    usage,
    settledAt: recordedAt,
  });
  return {
    ...runtimeUsageIdentityUpdate(usage),
    ...(status !== 'UNKNOWN' && usage?.costReported === true
      ? { costMicros: BigInt(usage.costMicros), costRecordedAt: recordedAt }
      : {}),
    ...tokenSettlementUpdate(settlement),
  };
}

function tokenSettlementUpdate(settlement: AgentRunTokenSettlement): AgentRunUsageSettlementUpdate {
  if (settlement.kind === 'UNKNOWN_HOLD' || settlement.kind === 'UNREPORTED') return {};
  const { kind: _kind, ...update } = settlement;
  return update;
}

function terminalUsageAuditMetadata(
  run: { readonly reservedTokens: number },
  status: 'SUCCEEDED' | 'FAILED' | 'UNKNOWN' | 'CANCELLED',
  usage: AgentRunUsage | undefined,
  recordedAt: Date,
  latencyMs: number | null,
): Prisma.InputJsonObject {
  const settlement = decideAgentRunTokenSettlement({
    status,
    reservedTokens: run.reservedTokens,
    usage,
    settledAt: recordedAt,
  });
  return {
    ...(usage === undefined
      ? {}
      : {
          runtimeProvider: usage.provider,
          runtimeModel: usage.model,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          totalTokens: usage.totalTokens,
          toolCalls: usage.toolCalls,
          costMicros: String(usage.costMicros),
          tokensReported: usage.tokensReported,
          costReported: usage.costReported,
        }),
    tokenEvidence:
      settlement.kind === 'PROVIDER_REPORTED'
        ? 'PROVIDER_REPORTED'
        : settlement.kind === 'QUOTA_UPPER_BOUND'
          ? 'QUOTA_UPPER_BOUND'
          : 'UNREPORTED',
    quotaChargedTokens: settlement.kind === 'QUOTA_UPPER_BOUND' ? settlement.quotaChargedTokens : 0,
    quotaReservationRetained: settlement.kind === 'UNKNOWN_HOLD',
    latencyMs,
  };
}

function calculateLatencyMs(
  run: { readonly dispatchStartedAt?: Date | null; readonly startedAt?: Date | null },
  finishedAt: Date,
): number | null {
  const startedAt = run.startedAt ?? run.dispatchStartedAt;
  if (startedAt === undefined || startedAt === null) return null;
  return Math.min(2_147_483_647, Math.max(0, finishedAt.getTime() - startedAt.getTime()));
}

async function persistSafetyDecision(
  transaction: Transaction,
  tenantId: string,
  runId: string,
  actorUserId: string,
  decision: AiSafetyDecision,
): Promise<void> {
  await transaction.$queryRaw`SELECT set_config('app.user_id', ${actorUserId}, true)`;
  const existing = await transaction.aiSafetyDecisionRecord.findFirst({
    where: {
      tenantId,
      runId,
      direction: decision.direction,
      sequence: 1,
    },
  });
  if (existing !== null) {
    if (existing.decisionHash !== decision.decisionHash) {
      throw new Error('AI safety decision replay does not match the immutable receipt.');
    }
    return;
  }
  await transaction.aiSafetyDecisionRecord.create({
    data: {
      tenantId,
      runId,
      direction: decision.direction,
      sequence: 1,
      classification: decision.classification,
      action: decision.action,
      reasonCodes: decision.reasonCodes,
      contentSha256: decision.contentSha256,
      redactedContentSha256: decision.redactedContentSha256,
      detectorVersion: decision.detectorVersion,
      decisionHash: decision.decisionHash,
    },
  });
}

async function updateCircuitFromAttempt(
  transaction: Transaction,
  tenantId: string,
  attempt: AgentRunModelAttempt,
  route: TrustedModelRouteSnapshot,
): Promise<void> {
  await transaction.$queryRaw`
    SELECT pg_advisory_xact_lock(
      hashtextextended(${`${tenantId}:model-circuit:${attempt.catalogVersionId}`}, 0)
    )::text AS lock_token
  `;
  const current = await transaction.aiModelCircuitStateRecord.findUnique({
    where: {
      tenantId_catalogVersionId: {
        tenantId,
        catalogVersionId: attempt.catalogVersionId,
      },
    },
  });
  const now = new Date();
  if (attempt.outcome === 'SUCCEEDED') {
    await transaction.aiModelCircuitStateRecord.upsert({
      where: {
        tenantId_catalogVersionId: {
          tenantId,
          catalogVersionId: attempt.catalogVersionId,
        },
      },
      create: {
        tenantId,
        catalogVersionId: attempt.catalogVersionId,
        state: 'CLOSED',
        consecutiveFailures: 0,
        lastCheckedAt: now,
      },
      update: {
        state: 'CLOSED',
        consecutiveFailures: 0,
        openedUntil: null,
        lastReasonCode: null,
        lastCheckedAt: now,
        revision: { increment: 1 },
        updatedAt: now,
      },
    });
    return;
  }
  if (attempt.outcome === 'REJECTED' || (attempt.outcome === 'FAILED' && !attempt.retrySafe)) {
    return;
  }
  const failures =
    attempt.outcome === 'UNKNOWN'
      ? route.circuitFailureThreshold
      : (current?.consecutiveFailures ?? 0) + 1;
  const shouldOpen = failures >= route.circuitFailureThreshold;
  await transaction.aiModelCircuitStateRecord.upsert({
    where: {
      tenantId_catalogVersionId: {
        tenantId,
        catalogVersionId: attempt.catalogVersionId,
      },
    },
    create: {
      tenantId,
      catalogVersionId: attempt.catalogVersionId,
      state: shouldOpen ? 'OPEN' : 'CLOSED',
      consecutiveFailures: failures,
      openedUntil: shouldOpen ? new Date(now.getTime() + route.circuitOpenSeconds * 1_000) : null,
      lastReasonCode: attempt.reasonCode,
      lastCheckedAt: now,
    },
    update: {
      state: shouldOpen ? 'OPEN' : 'CLOSED',
      consecutiveFailures: failures,
      openedUntil: shouldOpen ? new Date(now.getTime() + route.circuitOpenSeconds * 1_000) : null,
      lastReasonCode: attempt.reasonCode,
      lastCheckedAt: now,
      revision: { increment: 1 },
      updatedAt: now,
    },
  });
}

function hashEvidence(value: unknown): string {
  return createHash('sha256').update(canonicalEvidence(value), 'utf8').digest('hex');
}

function canonicalEvidence(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalEvidence).join(',')}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalEvidence(item)}`)
    .join(',')}}`;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
