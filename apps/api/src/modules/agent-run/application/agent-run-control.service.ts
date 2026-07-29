import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { AgentRunResponse } from '@enterprise/contracts';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { PrismaService } from '../../../database/prisma.service.js';
import { AuthorizationService } from '../../authorization/authorization.service.js';
import { IdentityService } from '../../identity/application/identity.service.js';
import { AgentRuntimeClient, type RuntimeRunResult } from '../domain/agent-runtime.client.js';
import type { AgentRunUsage } from '../domain/agent-run.models.js';
import { buildAgentRunRetryPolicySnapshot } from '../domain/agent-run-policy-snapshot.js';
import {
  decideAgentRunTokenSettlement,
  type AgentRunTokenSettlement,
} from '../domain/agent-run-token-settlement.js';
import { appendTerminalStreamEvent } from '../infrastructure/prisma/prisma-agent-run-stream.repository.js';

@Injectable()
export class AgentRunControlService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(AgentRuntimeClient) private readonly runtime: AgentRuntimeClient,
    @Inject(AuthorizationService) private readonly authorization: AuthorizationService,
  ) {}

  async cancel(conversationId: string, runId: string): Promise<AgentRunResponse> {
    const { user } = await this.identity.getCurrentIdentity();
    this.authorization.requireCurrent({
      action: 'agent.run.cancel',
      resourceTenantId: user.tenantId,
      taskContext: { taskId: runId },
      risk: 'MEDIUM',
    });
    const target = await this.prisma.withTenant(user.tenantId, async (transaction) => {
      await transaction.$queryRaw`
        SELECT pg_advisory_xact_lock(hashtextextended(${`${user.tenantId}:agent-run-quota`}, 0))::text
      `;
      await transaction.$queryRaw`
        SELECT pg_advisory_xact_lock(hashtextextended(${`${user.tenantId}:agent-run:${runId}`}, 0))::text
      `;
      const run = await transaction.agentRun.findFirst({
        where: {
          id: runId,
          tenantId: user.tenantId,
          conversationId,
          conversation: {
            participants: { some: { tenantId: user.tenantId, userId: user.id, leftAt: null } },
          },
        },
      });
      if (run === null) throw new NotFoundException('The Agent Run was not found.');
      if (['SUCCEEDED', 'FAILED', 'UNKNOWN', 'CANCELLED'].includes(run.status)) {
        if (run.status === 'CANCELLED') {
          await appendTerminalStreamEvent(transaction, {
            tenantId: user.tenantId,
            runId,
            status: 'CANCELLED',
            mode: 'terminal_only',
            createdAt: run.finishedAt ?? new Date(),
          });
          return { kind: 'cancelled' } as const;
        }
        throw new ConflictException('A completed Agent Run cannot be cancelled.');
      }
      if (run.status === 'QUEUED') {
        await persistCancellation(transaction, {
          tenantId: user.tenantId,
          userId: user.id,
          conversationId,
          runId: run.id,
        });
        return { kind: 'cancelled' } as const;
      }
      if (run.externalRunId === null) {
        throw new ConflictException(
          'The Agent Run is being dispatched and cannot be safely cancelled yet.',
        );
      }
      return { kind: 'runtime', externalRunId: run.externalRunId } as const;
    });

    if (target.kind === 'cancelled') return { runId, status: 'cancelled' };

    let result: RuntimeRunResult;
    try {
      result = await this.runtime.cancel(
        user.tenantId,
        target.externalRunId,
        AbortSignal.timeout(10_000),
      );
    } catch {
      // Keep RUNNING and its quota reservation until the durable worker can
      // reconcile the known external id. Never free quota on an unconfirmed
      // provider cancellation.
      throw new ServiceUnavailableException(
        'Cancellation could not be confirmed. The run remains active and will be reconciled.',
      );
    }
    if (result.status !== 'cancelled') {
      throw new ConflictException(
        'The Runtime did not confirm cancellation. Refresh to view the reconciled result.',
      );
    }

    await this.prisma.withTenant(user.tenantId, async (transaction) => {
      await transaction.$queryRaw`
        SELECT pg_advisory_xact_lock(hashtextextended(${`${user.tenantId}:agent-run-quota`}, 0))::text
      `;
      await transaction.$queryRaw`
        SELECT pg_advisory_xact_lock(hashtextextended(${`${user.tenantId}:agent-run:${runId}`}, 0))::text
      `;
      const run = await transaction.agentRun.findFirst({
        where: { id: runId, tenantId: user.tenantId, conversationId },
      });
      if (run === null) throw new NotFoundException('The Agent Run was not found.');
      if (run.status === 'CANCELLED') {
        await appendTerminalStreamEvent(transaction, {
          tenantId: user.tenantId,
          runId,
          status: 'CANCELLED',
          mode: 'terminal_only',
          createdAt: run.finishedAt ?? new Date(),
        });
        return;
      }
      if (['SUCCEEDED', 'FAILED', 'UNKNOWN'].includes(run.status)) {
        throw new ConflictException('The Agent Run completed while cancellation was pending.');
      }
      if (run.externalRunId !== target.externalRunId) {
        throw new ConflictException('The Agent Run execution identity changed.');
      }
      const finishedAt = new Date();
      const usage = usageFromRuntime(result);
      await transaction.agentRun.update({
        where: { id: run.id },
        data: {
          status: 'CANCELLED',
          errorCode: 'CANCELLED_BY_USER',
          errorMessage: 'Generation was stopped by the user.',
          finishedAt,
          ...confirmedTerminalUsageUpdate(run.reservedTokens, usage, finishedAt),
          ...(usage?.costReported === true
            ? { costMicros: BigInt(usage.costMicros), costRecordedAt: finishedAt }
            : {}),
          version: { increment: 1 },
        },
      });
      await appendTerminalStreamEvent(transaction, {
        tenantId: user.tenantId,
        runId,
        status: 'CANCELLED',
        mode: 'terminal_only',
        createdAt: finishedAt,
      });
      await transaction.auditEvent.create({
        data: {
          tenantId: user.tenantId,
          actorType: 'USER',
          actorId: user.id,
          action: 'agent.run.cancel',
          resourceType: 'agent_run',
          resourceId: run.id,
          metadata: {
            conversationId,
            runtimeConfirmed: true,
            tokensReported: usage?.tokensReported === true,
            costReported: usage?.costReported === true,
          },
        },
      });
    });
    return { runId, status: 'cancelled' };
  }

  async retry(conversationId: string, runId: string): Promise<AgentRunResponse> {
    const { user } = await this.identity.getCurrentIdentity();
    this.authorization.requireCurrent({
      action: 'agent.run.retry',
      resourceTenantId: user.tenantId,
      taskContext: { taskId: runId },
      risk: 'MEDIUM',
    });
    return this.prisma.withTenant(user.tenantId, async (transaction) => {
      await transaction.$queryRaw`
        SELECT pg_advisory_xact_lock(hashtextextended(${`${user.tenantId}:${conversationId}:agent-run`}, 0))::text
      `;
      const run = await transaction.agentRun.findFirst({
        where: {
          id: runId,
          tenantId: user.tenantId,
          conversationId,
          conversation: {
            participants: { some: { tenantId: user.tenantId, userId: user.id, leftAt: null } },
          },
        },
        include: {
          agent: true,
          agentVersion: { include: { template: true } },
        },
      });
      if (run === null) throw new NotFoundException('The Agent Run was not found.');
      if (!['FAILED', 'CANCELLED'].includes(run.status)) {
        throw new ConflictException(
          run.status === 'UNKNOWN'
            ? 'This Agent Run has an uncertain provider result and must be reconciled before retrying.'
            : 'Only a failed or cancelled Agent Run can be retried.',
        );
      }

      // Retrying has no caller-supplied idempotency key. The conversation lock
      // serializes API nodes, and an already-active direct child is therefore
      // the durable result of the same repeated click. Once that child reaches
      // a terminal state the caller can explicitly try the source again.
      const existingRetry = await transaction.agentRun.findFirst({
        where: {
          tenantId: user.tenantId,
          conversationId,
          retryOfRunId: run.id,
          status: { in: ['QUEUED', 'DISPATCHING', 'RUNNING'] },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { id: true, status: true },
      });
      if (existingRetry !== null) {
        return {
          runId: existingRetry.id,
          status:
            existingRetry.status === 'RUNNING'
              ? 'running'
              : existingRetry.status === 'DISPATCHING'
                ? 'preparing'
                : 'queued',
        };
      }
      const active = await transaction.agentRun.findFirst({
        where: {
          tenantId: user.tenantId,
          conversationId,
          status: { in: ['QUEUED', 'DISPATCHING', 'RUNNING'] },
        },
        select: { id: true },
      });
      if (active !== null)
        throw new ConflictException('This conversation already has an active Agent Run.');
      if (
        run.agent.status !== 'ONLINE' ||
        !['PUBLISHED', 'RETIRED'].includes(run.agentVersion.status)
      ) {
        throw new ConflictException('The Agent is not currently executable.');
      }

      const id = randomUUID();
      const retryPolicySnapshot = buildAgentRunRetryPolicySnapshot({
        sourceSnapshot: run.policySnapshot,
        sourceAgentVersion: run.agentVersion,
        retryOfRunId: run.id,
      });
      if (retryPolicySnapshot === null) {
        throw new ConflictException('The source Agent Run policy snapshot is invalid.');
      }
      await transaction.agentRun.create({
        data: {
          id,
          tenantId: user.tenantId,
          conversationId,
          inputMessageId: run.inputMessageId,
          requesterUserId: user.id,
          agentId: run.agentId,
          agentVersionId: run.agentVersionId,
          taskId: run.taskId,
          retryOfRunId: run.id,
          trigger: run.trigger,
          turnIndex: run.turnIndex,
          turnLimit: run.turnLimit,
          idempotencyKey: `retry:${run.id}:${id}`,
          policySnapshot: retryPolicySnapshot,
        },
      });
      await Promise.all([
        transaction.outboxEvent.create({
          data: {
            tenantId: user.tenantId,
            aggregateType: 'agent_run',
            aggregateId: id,
            eventType: 'agent.run_requested.v1',
            payload: { runId: id },
          },
        }),
        transaction.auditEvent.create({
          data: {
            tenantId: user.tenantId,
            actorType: 'USER',
            actorId: user.id,
            action: 'agent.run.retry',
            resourceType: 'agent_run',
            resourceId: id,
            metadata: {
              conversationId,
              retryOfRunId: run.id,
              agentVersionId: run.agentVersionId,
            },
          },
        }),
      ]);
      return { runId: id, status: 'queued' };
    });
  }

  async reconcileUnknown(
    tenantId: string,
    actorUserId: string,
    runId: string,
  ): Promise<AgentRunResponse> {
    this.authorization.requireCurrent({
      action: 'agent.run.reconcile',
      resourceTenantId: tenantId,
      taskContext: {
        taskId: runId,
        ownerUserId: actorUserId,
        enforceActorMembership: true,
      },
      risk: 'MEDIUM',
    });
    const target = await this.prisma.withTenant(tenantId, async (transaction) => {
      await transaction.$queryRaw`
        SELECT pg_advisory_xact_lock(hashtextextended(${`${tenantId}:agent-run-quota`}, 0))::text
      `;
      await transaction.$queryRaw`
        SELECT pg_advisory_xact_lock(hashtextextended(${`${tenantId}:agent-run:${runId}`}, 0))::text
      `;
      const run = await transaction.agentRun.findFirst({ where: { tenantId, id: runId } });
      if (run === null) throw new NotFoundException('The Agent Run was not found.');
      if (run.status !== 'UNKNOWN') {
        throw new ConflictException('Only an UNKNOWN Agent Run can be reconciled.');
      }
      if (run.externalRunId === null) {
        throw new ConflictException(
          'This Run has no confirmed Runtime id and requires manual provider-side investigation.',
        );
      }
      return { externalRunId: run.externalRunId };
    });

    try {
      await this.runtime.get(tenantId, target.externalRunId, AbortSignal.timeout(10_000));
    } catch {
      throw new ServiceUnavailableException(
        'The Runtime result is still unavailable. The quota hold was not released.',
      );
    }

    return this.prisma.withTenant(tenantId, async (transaction) => {
      await transaction.$queryRaw`
        SELECT pg_advisory_xact_lock(hashtextextended(${`${tenantId}:agent-run-quota`}, 0))::text
      `;
      await transaction.$queryRaw`
        SELECT pg_advisory_xact_lock(hashtextextended(${`${tenantId}:agent-run:${runId}`}, 0))::text
      `;
      const run = await transaction.agentRun.findFirst({ where: { tenantId, id: runId } });
      if (run === null) throw new NotFoundException('The Agent Run was not found.');
      if (run.status !== 'UNKNOWN' || run.externalRunId !== target.externalRunId) {
        throw new ConflictException('The Agent Run changed while reconciliation was in progress.');
      }
      await transaction.agentRun.update({
        where: { id: run.id },
        data: {
          status: 'RUNNING',
          finishedAt: null,
          errorCode: null,
          errorMessage: null,
          version: { increment: 1 },
        },
      });
      await Promise.all([
        transaction.outboxEvent.create({
          data: {
            tenantId,
            aggregateType: 'agent_run',
            aggregateId: run.id,
            eventType: 'agent.run_requested.v1',
            payload: { runId: run.id, reconciliation: true },
          },
        }),
        transaction.auditEvent.create({
          data: {
            tenantId,
            actorType: 'USER',
            actorId: actorUserId,
            action: 'agent.run.reconcile',
            resourceType: 'agent_run',
            resourceId: run.id,
            metadata: { externalRunId: target.externalRunId },
          },
        }),
      ]);
      return { runId: run.id, status: 'running' };
    });
  }
}

async function persistCancellation(
  transaction: Prisma.TransactionClient,
  input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly conversationId: string;
    readonly runId: string;
  },
): Promise<void> {
  const finishedAt = new Date();
  await transaction.agentRun.update({
    where: { id: input.runId },
    data: {
      status: 'CANCELLED',
      errorCode: 'CANCELLED_BY_USER',
      errorMessage: 'Generation was stopped by the user.',
      finishedAt,
      reservedTokens: 0,
      version: { increment: 1 },
    },
  });
  await appendTerminalStreamEvent(transaction, {
    tenantId: input.tenantId,
    runId: input.runId,
    status: 'CANCELLED',
    mode: 'terminal_only',
    createdAt: finishedAt,
  });
  await transaction.auditEvent.create({
    data: {
      tenantId: input.tenantId,
      actorType: 'USER',
      actorId: input.userId,
      action: 'agent.run.cancel',
      resourceType: 'agent_run',
      resourceId: input.runId,
      metadata: { conversationId: input.conversationId, runtimeConfirmed: false },
    },
  });
}

type AgentRunUsageSettlementUpdate = Prisma.AgentRunUncheckedUpdateInput & {
  readonly tokenEvidence?: 'UNREPORTED' | 'PROVIDER_REPORTED' | 'QUOTA_UPPER_BOUND';
  readonly quotaChargedTokens?: number;
  readonly quotaSettledAt?: Date | null;
};

function confirmedTerminalUsageUpdate(
  reservedTokens: number,
  usage: AgentRunUsage | undefined,
  settledAt: Date,
): AgentRunUsageSettlementUpdate {
  const settlement = decideAgentRunTokenSettlement({
    status: 'CANCELLED',
    reservedTokens,
    usage,
    settledAt,
  });
  return {
    ...(usage === undefined
      ? {}
      : {
          runtimeProvider: usage.provider,
          runtimeModel: usage.model,
          toolCalls: usage.toolCalls,
        }),
    ...tokenSettlementUpdate(settlement),
  };
}

function tokenSettlementUpdate(settlement: AgentRunTokenSettlement): AgentRunUsageSettlementUpdate {
  if (settlement.kind === 'UNKNOWN_HOLD' || settlement.kind === 'UNREPORTED') return {};
  const { kind: _kind, ...update } = settlement;
  return update;
}

function usageFromRuntime(result: RuntimeRunResult): AgentRunUsage | undefined {
  if (result.usage === undefined) return undefined;
  return {
    ...result.usage,
    provider: result.output?.provider ?? null,
    model: result.output?.model ?? null,
  };
}
