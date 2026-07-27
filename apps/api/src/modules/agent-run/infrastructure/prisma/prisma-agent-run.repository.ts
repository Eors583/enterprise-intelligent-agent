import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { PrismaService } from '../../../../database/prisma.service.js';
import { KnowledgeRetrievalService } from '../../../knowledge-retrieval/knowledge-retrieval.service.js';
import type {
  AgentRunContextMessage,
  AgentRunKnowledgeSource,
  AgentRunPreparation,
  AgentRunUsage,
  PreparedAgentRun,
  StoredAgentRunStatus,
} from '../../domain/agent-run.models.js';
import { packConservativeAgentRunInput } from '../../domain/agent-run-input-budget.js';
import {
  AGENT_RUN_CONCURRENCY_HOLD_STATUSES,
  DEFAULT_AGENT_RUN_MAX_INPUT_TOKENS,
  DEFAULT_AGENT_RUN_MAX_OUTPUT_TOKENS,
  DEFAULT_AGENT_RUN_RESERVED_TOKENS,
  decideAgentRunQuota,
  type AgentRunQuotaSnapshot,
} from '../../domain/agent-run-quota.js';
import { AgentRunRepository } from '../../domain/agent-run.repository.js';

export { exceedsConservativeInputBudget } from '../../domain/agent-run-input-budget.js';

const MAX_CONTEXT_MESSAGES = 30;
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
    agent: true;
    agentVersion: true;
    conversation: true;
    inputMessage: true;
  };
}>;

@Injectable()
export class PrismaAgentRunRepository extends AgentRunRepository {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(KnowledgeRetrievalService) private readonly retrieval: KnowledgeRetrievalService,
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

      if (run.status === 'QUEUED') {
        if (run.turnLimit === 1 && (await hasEarlierActiveDirectRun(transaction, run))) {
          return {
            preparation: {
              kind: 'deferred',
              reasonCode: 'EARLIER_AGENT_RUN_ACTIVE',
            } as AgentRunPreparation,
          };
        }
        const validationError = await validateQueuedRun(transaction, run);
        if (validationError !== null) {
          await markRunTerminal(
            transaction,
            run,
            'FAILED',
            validationError,
            'Agent Run policy validation failed.',
          );
          return { preparation: terminalPreparation('FAILED', null, validationError) };
        }
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
      } else if (run.status !== 'DISPATCHING' && run.status !== 'RUNNING') {
        return { preparation: { kind: 'ambiguous_dispatch' } as AgentRunPreparation };
      }

      const messages = await loadRecentContext(
        transaction,
        tenantId,
        run.conversationId,
        run.inputMessage,
      );
      const knowledgeBaseIds = readSelectedKnowledgeBaseIds(run.agentVersion.knowledgeScope);
      return { run, messages, knowledgeBaseIds };
    });
    if ('preparation' in snapshot) return snapshot.preparation;

    // Embedding and Reranker calls happen only after the snapshot transaction and
    // advisory Run lock have been released. Unexpected retrieval failures leave the Run
    // QUEUED; explicitly classified semantic-provider failures degrade to lexical retrieval
    // and are recorded in the retrieval metadata.
    const retrieval = await this.retrieval.search({
      tenantId,
      userId: snapshot.run.requesterUserId,
      knowledgeBaseIds: snapshot.knowledgeBaseIds,
      query: snapshot.messages.at(-1)?.text ?? '',
      limit: 8,
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
      const validationError = await validateQueuedRun(transaction, run);
      if (validationError !== null) {
        await markRunTerminal(
          transaction,
          run,
          'FAILED',
          validationError,
          'Agent Run policy validation failed.',
        );
        return terminalPreparation('FAILED', null, validationError);
      }
      const knowledgeStillAccessible = await this.retrieval.areChunksAccessibleInTransaction(
        transaction,
        {
          tenantId,
          userId: run.requesterUserId,
          knowledgeBaseIds: snapshot.knowledgeBaseIds,
          chunkIds: knowledgeSources.map((source) => source.chunkId),
        },
      );
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
      const preparedRun = mapPreparedRun(
        run,
        snapshot.messages,
        knowledgeSources,
        snapshot.knowledgeBaseIds.length > 0,
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
        },
      });
      if (transitioned.count !== 1) return { kind: 'ambiguous_dispatch' };
      return {
        kind: 'ready',
        run: packing.kind === 'packed' ? packing.run : preparedRun,
      };
    });
  }

  attachExternalRun(tenantId: string, runId: string, externalRunId: string): Promise<void> {
    if (!isUuid(externalRunId)) {
      throw new Error('AI Runtime returned an invalid Run id.');
    }
    return this.prisma.withTenant(tenantId, async (transaction) => {
      await lockRun(transaction, tenantId, runId);
      const run = await transaction.agentRun.findFirst({ where: { tenantId, id: runId } });
      if (run === null) throw new Error('Agent Run does not exist.');
      if (run.externalRunId === externalRunId && run.status === 'RUNNING') return;
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
    });
  }

  completeSucceeded(
    tenantId: string,
    runId: string,
    output: string,
    citations: readonly AgentRunKnowledgeSource[] = [],
    usage?: AgentRunUsage,
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
          ...(usage?.tokensReported === true ? { reservedTokens: 0 } : {}),
          latencyMs,
          ...usageUpdate(usage, finishedAt),
          version: { increment: 1 },
        },
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
              ...usageAuditMetadata(usage, latencyMs),
            },
          },
        }),
      ]);

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
  ): Promise<void> {
    return this.completeTerminal(tenantId, runId, 'FAILED', errorCode, safeMessage, usage);
  }

  completeUnknown(
    tenantId: string,
    runId: string,
    errorCode: string,
    usage?: AgentRunUsage,
  ): Promise<void> {
    return this.completeTerminal(
      tenantId,
      runId,
      'UNKNOWN',
      errorCode,
      'AI Runtime execution outcome is unknown.',
      usage,
    );
  }

  private completeTerminal(
    tenantId: string,
    runId: string,
    status: 'FAILED' | 'UNKNOWN',
    errorCode: string,
    safeMessage: string,
    usage?: AgentRunUsage,
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
      if (run === null || isTerminal(run.status)) return;
      await markRunTerminal(
        transaction,
        run,
        status,
        safeCode(errorCode),
        truncateSafeMessage(safeMessage),
        usage,
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
      COALESCE(SUM("total_tokens") FILTER (
        WHERE "finished_at" >= ${monthStart} AND "usage_recorded_at" IS NOT NULL
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
      agent: true,
      agentVersion: true,
      conversation: true,
      inputMessage: true,
    },
  });
}

async function validateQueuedRun(
  transaction: Transaction,
  run: RunForExecution,
): Promise<string | null> {
  if (run.requester.status !== 'ACTIVE') return 'REQUESTER_INACTIVE';
  const participants = await transaction.conversationParticipant.findMany({
    where: { tenantId: run.tenantId, conversationId: run.conversationId, leftAt: null },
    select: { type: true, userId: true, agentId: true },
  });
  if (
    !participants.some(
      (participant) => participant.type === 'USER' && participant.userId === run.requesterUserId,
    )
  ) {
    return 'REQUESTER_NOT_PARTICIPANT';
  }
  if (
    !participants.some(
      (participant) => participant.type === 'AGENT' && participant.agentId === run.agentId,
    )
  ) {
    return 'AGENT_NOT_PARTICIPANT';
  }
  if (run.agent.status !== 'ONLINE') return 'AGENT_NOT_ONLINE';
  if (!isVisibleToRequester(run.agent.settings, run.agent.ownerUserId, run.requesterUserId)) {
    return 'AGENT_NOT_VISIBLE';
  }
  if (run.agentVersion.status !== 'PUBLISHED') return 'AGENT_VERSION_NOT_PUBLISHED';

  if (run.turnLimit === 1) {
    if (
      run.trigger !== 'USER_MESSAGE' ||
      run.turnIndex !== 1 ||
      run.parentRunId !== null ||
      run.conversation.relayAgentAId !== null ||
      run.conversation.relayAgentBId !== null ||
      run.conversation.relayTurnLimit !== null
    ) {
      return 'AGENT_RUN_CHAIN_INVALID';
    }
    return null;
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
    return 'AGENT_RELAY_CHAIN_INVALID';
  }
  return null;
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
  messages: readonly AgentRunContextMessage[],
  knowledgeSources: readonly AgentRunKnowledgeSource[],
  knowledgeGroundingRequired: boolean,
): PreparedAgentRun {
  return {
    id: run.id,
    tenantId: run.tenantId,
    conversationId: run.conversationId,
    requesterUserId: run.requesterUserId,
    requesterRole: run.requester.role,
    agentId: run.agentId,
    agentName: run.agent.name,
    agentVersionId: run.agentVersionId,
    agentVersion: run.agentVersion.version,
    systemPrompt: run.agentVersion.systemPrompt,
    externalRunId: run.externalRunId,
    turnIndex: run.turnIndex,
    turnLimit: run.turnLimit,
    maxInputTokens: DEFAULT_AGENT_RUN_MAX_INPUT_TOKENS,
    maxOutputTokens: DEFAULT_AGENT_RUN_MAX_OUTPUT_TOKENS,
    messages,
    knowledgeSources,
    knowledgeGroundingRequired,
  };
}

export async function loadKnowledgeSourcesLegacy(
  transaction: Transaction,
  run: RunForExecution,
  query: string,
) {
  const knowledgeBaseIds = readSelectedKnowledgeBaseIds(run.agentVersion.knowledgeScope);
  if (knowledgeBaseIds.length === 0) return [];

  const employments = await transaction.employment.findMany({
    where: { tenantId: run.tenantId, userId: run.requesterUserId, status: 'ACTIVE' },
    select: { orgUnitId: true },
  });
  const orgUnitIds = employments.map((employment) => employment.orgUnitId);
  const documents = await transaction.knowledgeDocument.findMany({
    where: {
      tenantId: run.tenantId,
      knowledgeBaseId: { in: knowledgeBaseIds },
      status: 'READY',
      contentText: { not: null },
      knowledgeBase: {
        status: 'ACTIVE',
        OR: [
          { orgUnits: { none: {} } },
          ...(orgUnitIds.length === 0
            ? []
            : [{ orgUnits: { some: { orgUnitId: { in: orgUnitIds } } } }]),
        ],
      },
    },
    select: { id: true, knowledgeBaseId: true, title: true, contentText: true },
    take: 100,
  });
  const terms = tokenize(query);
  return documents
    .map((document) => ({
      document,
      score: relevanceScore(document.title, document.contentText ?? '', terms),
    }))
    .filter((candidate) => candidate.score > 0 || terms.length === 0)
    .sort(
      (left, right) =>
        right.score - left.score || left.document.title.localeCompare(right.document.title),
    )
    .slice(0, 6)
    .map(({ document }) => ({
      documentId: document.id,
      knowledgeBaseId: document.knowledgeBaseId,
      title: document.title,
      excerpt: createExcerpt(document.contentText ?? '', terms),
    }));
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
  const nextAgent = await transaction.agentInstance.findFirst({
    where: { tenantId: run.tenantId, id: nextAgentId },
    include: { version: true },
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
      parentRunId: run.id,
      trigger: 'RELAY_TURN',
      turnIndex: nextTurn,
      turnLimit: run.turnLimit,
      idempotencyKey: `relay:${run.id}:turn:${nextTurn}:agent:${nextAgent.id}`,
      policySnapshot: {
        agentVersionId: nextAgent.versionId,
        version: nextAgent.version.version,
        modelPolicy: nextAgent.version.modelPolicy,
        toolPolicy: nextAgent.version.toolPolicy,
        knowledgeScope: nextAgent.version.knowledgeScope,
        relay: true,
      },
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
    readonly dispatchStartedAt?: Date | null;
    readonly startedAt?: Date | null;
  },
  status: 'FAILED' | 'UNKNOWN',
  errorCode: string,
  errorMessage: string,
  usage?: AgentRunUsage,
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
      ...(usage?.tokensReported === true ? { reservedTokens: 0 } : {}),
      ...usageUpdate(usage, finishedAt),
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
        ...usageAuditMetadata(usage, latencyMs),
      },
    },
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

function isVisibleToRequester(
  settings: Prisma.JsonValue,
  ownerUserId: string | null,
  requesterUserId: string,
): boolean {
  if (
    typeof settings === 'object' &&
    settings !== null &&
    !Array.isArray(settings) &&
    settings.visibility === 'tenant'
  ) {
    return true;
  }
  return ownerUserId !== null && ownerUserId === requesterUserId;
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
  return /^[A-Z0-9_]{1,120}$/.test(value) ? value : 'AGENT_RUN_FAILED';
}

function truncateSafeMessage(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) return 'Agent Run processing failed.';
  return normalized.slice(0, 500);
}

function usageUpdate(
  usage: AgentRunUsage | undefined,
  recordedAt: Date,
): Prisma.AgentRunUncheckedUpdateInput {
  if (usage === undefined) return {};
  return {
    runtimeProvider: usage.provider,
    runtimeModel: usage.model,
    toolCalls: usage.toolCalls,
    ...(usage.tokensReported
      ? {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          totalTokens: usage.totalTokens,
          usageRecordedAt: recordedAt,
        }
      : {}),
    ...(usage.costReported
      ? { costMicros: BigInt(usage.costMicros), costRecordedAt: recordedAt }
      : {}),
  };
}

function usageAuditMetadata(
  usage: AgentRunUsage | undefined,
  latencyMs: number | null,
): Prisma.InputJsonObject {
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

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
