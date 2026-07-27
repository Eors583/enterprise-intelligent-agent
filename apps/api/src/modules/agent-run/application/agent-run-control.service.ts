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
import { IdentityService } from '../../identity/application/identity.service.js';
import { AgentRuntimeClient, type RuntimeRunResult } from '../domain/agent-runtime.client.js';

@Injectable()
export class AgentRunControlService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(AgentRuntimeClient) private readonly runtime: AgentRuntimeClient,
  ) {}

  async cancel(conversationId: string, runId: string): Promise<AgentRunResponse> {
    const { user } = await this.identity.getCurrentIdentity();
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
        if (run.status === 'CANCELLED') return { kind: 'cancelled' } as const;
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
      if (run.status === 'CANCELLED') return;
      if (['SUCCEEDED', 'FAILED', 'UNKNOWN'].includes(run.status)) {
        throw new ConflictException('The Agent Run completed while cancellation was pending.');
      }
      if (run.externalRunId !== target.externalRunId) {
        throw new ConflictException('The Agent Run execution identity changed.');
      }
      const finishedAt = new Date();
      const usage = result.usage;
      await transaction.agentRun.update({
        where: { id: run.id },
        data: {
          status: 'CANCELLED',
          errorCode: 'CANCELLED_BY_USER',
          errorMessage: 'Generation was stopped by the user.',
          finishedAt,
          ...(usage?.tokensReported === true
            ? {
                inputTokens: usage.inputTokens,
                outputTokens: usage.outputTokens,
                totalTokens: usage.totalTokens,
                usageRecordedAt: finishedAt,
                reservedTokens: 0,
              }
            : {}),
          ...(usage?.costReported === true
            ? { costMicros: BigInt(usage.costMicros), costRecordedAt: finishedAt }
            : {}),
          ...(usage === undefined ? {} : { toolCalls: usage.toolCalls }),
          version: { increment: 1 },
        },
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
        include: { agent: { include: { version: true } } },
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
      if (run.agent.status !== 'ONLINE' || run.agent.version.status !== 'PUBLISHED') {
        throw new ConflictException('The Agent is not currently executable.');
      }

      const id = randomUUID();
      await transaction.agentRun.create({
        data: {
          id,
          tenantId: user.tenantId,
          conversationId,
          inputMessageId: run.inputMessageId,
          requesterUserId: user.id,
          agentId: run.agentId,
          agentVersionId: run.agent.versionId,
          retryOfRunId: run.id,
          trigger: run.trigger,
          turnIndex: run.turnIndex,
          turnLimit: run.turnLimit,
          idempotencyKey: `retry:${run.id}:${id}`,
          policySnapshot: {
            agentVersionId: run.agent.versionId,
            version: run.agent.version.version,
            modelPolicy: run.agent.version.modelPolicy,
            toolPolicy: run.agent.version.toolPolicy,
            knowledgeScope: run.agent.version.knowledgeScope,
            retryOfRunId: run.id,
          },
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
            metadata: { conversationId, retryOfRunId: run.id },
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
  await transaction.agentRun.update({
    where: { id: input.runId },
    data: {
      status: 'CANCELLED',
      errorCode: 'CANCELLED_BY_USER',
      errorMessage: 'Generation was stopped by the user.',
      finishedAt: new Date(),
      reservedTokens: 0,
      version: { increment: 1 },
    },
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
