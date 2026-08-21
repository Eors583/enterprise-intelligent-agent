import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  UnprocessableEntityException,
} from '@nestjs/common';
import type {
  AiModelConnectivityProbeResult,
  CreateAiModelConnectivityProbeRequest,
} from '@enterprise/contracts';
import { createHash, randomUUID } from 'node:crypto';

import { PrismaService } from '../../database/prisma.service.js';
import { AdminAccessService, type AdminPrincipal } from '../admin/admin-access.service.js';
import { hasRoleAgentAssignmentMarker } from '../agent-control/domain/role-agent-assignment.policy.js';
import { buildAgentRunPolicySnapshot } from '../agent-run/domain/agent-run-policy-snapshot.js';
import type {
  AgentRunPreparation,
  AgentRunUsage,
  PreparedAgentRun,
} from '../agent-run/domain/agent-run.models.js';
import { AgentRunRepository } from '../agent-run/domain/agent-run.repository.js';
import {
  AgentRuntimeClient,
  AgentRuntimeRequestError,
  type RuntimeRunResult,
} from '../agent-run/domain/agent-runtime.client.js';
import { readModelRouteRequest } from './model-route-execution.js';

const PROBE_IDEMPOTENCY_PREFIX = 'model-connectivity-probe:';
const SUCCESS_EVIDENCE_WINDOW_MS = 86_400_000;

interface ProbeSeed {
  readonly runId: string;
  readonly agentId: string;
  readonly targetCatalogVersionId: string;
  readonly status:
    'QUEUED' | 'DISPATCHING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'UNKNOWN' | 'CANCELLED';
}

@Injectable()
export class AiModelConnectivityProbeService {
  private readonly logger = new Logger(AiModelConnectivityProbeService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AdminAccessService) private readonly access: AdminAccessService,
    @Inject(AgentRunRepository) private readonly runs: AgentRunRepository,
    @Inject(AgentRuntimeClient) private readonly runtime: AgentRuntimeClient,
  ) {}

  async run(
    request: CreateAiModelConnectivityProbeRequest,
  ): Promise<AiModelConnectivityProbeResult> {
    const principal = this.access.requireDirectoryWrite();
    if (!this.prisma.enabled) {
      throw new UnprocessableEntityException(
        'A real model connectivity test requires the Prisma production repository.',
      );
    }
    const seed = await this.createOrLoadProbe(principal, request);
    if (seed.status !== 'QUEUED') {
      return this.readResult(principal, seed);
    }

    let preparation: AgentRunPreparation;
    try {
      preparation = await this.runs.prepare(principal.tenantId, seed.runId);
    } catch (error) {
      this.logger.error(
        `Model connectivity probe preparation failed for run ${seed.runId}: ${safeErrorMessage(error)}`,
      );
      await this.runs.completeFailed(
        principal.tenantId,
        seed.runId,
        'CONNECTIVITY_PROBE_PREPARATION_FAILED',
        'The controlled model connectivity test could not prepare its execution context.',
      );
      return this.finish(principal, seed);
    }
    if (preparation.kind !== 'ready') {
      await this.settleNonReadyPreparation(principal, seed, preparation);
      return this.finish(principal, seed);
    }

    const route = preparation.run.modelRoute;
    const target = route?.candidates.find(
      ({ catalogVersionId }) => catalogVersionId === seed.targetCatalogVersionId,
    );
    if (route === undefined || target === undefined) {
      await this.runs.completeFailed(
        principal.tenantId,
        seed.runId,
        'CONNECTIVITY_PROBE_ROUTE_CHANGED',
        'The published trusted route changed before the connectivity test.',
      );
      return this.finish(principal, seed);
    }
    const controlledRun: PreparedAgentRun = {
      ...preparation.run,
      maxSteps: 1,
      modelRoute: {
        ...route,
        maximumAttempts: 1,
        candidates: [target],
      },
    };
    await this.executeControlledRun(principal, seed, controlledRun);
    return this.finish(principal, seed);
  }

  private async createOrLoadProbe(
    principal: AdminPrincipal,
    request: CreateAiModelConnectivityProbeRequest,
  ): Promise<ProbeSeed> {
    const runIdempotencyKey = probeIdempotencyKey(request.idempotencyKey);
    return this.prisma.withTenant(principal.tenantId, async (transaction) => {
      await transaction.$queryRaw`SELECT set_config('app.user_id', ${principal.userId}, true)`;
      const replay = await transaction.agentRun.findFirst({
        where: { tenantId: principal.tenantId, idempotencyKey: runIdempotencyKey },
        select: {
          id: true,
          agentId: true,
          status: true,
        },
      });
      if (replay !== null) {
        const trustedProbe = await transaction.aiModelConnectivityProbe.findFirst({
          where: { tenantId: principal.tenantId, runId: replay.id },
          select: { targetCatalogVersionId: true },
        });
        if (trustedProbe === null) {
          throw new ConflictException('Connectivity probe idempotency record is invalid.');
        }
        return {
          runId: replay.id,
          agentId: replay.agentId,
          targetCatalogVersionId: trustedProbe.targetCatalogVersionId,
          status: replay.status,
        };
      }

      const activeProbe = await transaction.agentRun.findFirst({
        where: {
          tenantId: principal.tenantId,
          idempotencyKey: { startsWith: PROBE_IDEMPOTENCY_PREFIX },
          status: { in: ['QUEUED', 'DISPATCHING', 'RUNNING', 'UNKNOWN'] },
        },
        select: { id: true },
      });
      if (activeProbe !== null) {
        throw new ConflictException(
          'Another model connectivity test is still active or awaiting reconciliation.',
        );
      }

      const [user, policies, recentSuccessfulReceipts, agents] = await Promise.all([
        transaction.user.findFirst({
          where: { tenantId: principal.tenantId, id: principal.userId, status: 'ACTIVE' },
          select: { id: true, displayName: true },
        }),
        transaction.aiModelRoutePolicyVersion.findMany({
          where: { tenantId: principal.tenantId, status: 'PUBLISHED' },
          orderBy: [{ taskClass: 'asc' }, { version: 'desc' }],
        }),
        transaction.aiModelAttemptReceipt.findMany({
          where: {
            tenantId: principal.tenantId,
            phase: 'TERMINAL',
            outcome: 'SUCCEEDED',
            createdAt: { gte: new Date(Date.now() - SUCCESS_EVIDENCE_WINDOW_MS) },
          },
          select: { catalogVersionId: true },
          distinct: ['catalogVersionId'],
        }),
        transaction.agentInstance.findMany({
          where: {
            tenantId: principal.tenantId,
            status: 'ONLINE',
            version: { status: 'PUBLISHED' },
          },
          include: {
            version: true,
            _count: { select: { roleAssignments: true } },
            roleAssignments: {
              where: {
                userId: principal.userId,
                status: 'ACTIVE',
                effectiveFrom: { lte: new Date() },
                AND: [
                  { OR: [{ effectiveTo: null }, { effectiveTo: { gt: new Date() } }] },
                  { employment: { is: { userId: principal.userId, status: 'ACTIVE' } } },
                ],
              },
              select: { id: true, roleTemplateId: true, roleVersionId: true },
              take: 1,
            },
          },
          orderBy: [{ name: 'asc' }, { id: 'asc' }],
          take: 200,
        }),
      ]);
      if (user === null) {
        throw new UnprocessableEntityException(
          'The administrator account is not active for a real provider test.',
        );
      }

      const policyByTaskClass = new Map<string, (typeof policies)[number]>();
      for (const policy of policies) {
        if (!policyByTaskClass.has(policy.taskClass)) {
          policyByTaskClass.set(policy.taskClass, policy);
        }
      }
      const candidates = await transaction.aiModelRouteCandidate.findMany({
        where: {
          tenantId: principal.tenantId,
          policyVersionId: { in: policies.map(({ id }) => id) },
        },
        orderBy: [{ policyVersionId: 'asc' }, { ordinal: 'asc' }],
      });
      const candidatesByPolicy = groupBy(candidates, ({ policyVersionId }) => policyVersionId);
      const successfulCatalogIds = new Set(
        recentSuccessfulReceipts.map(({ catalogVersionId }) => catalogVersionId),
      );
      const selection = agents.flatMap((agent) => {
        const assignmentRequired =
          hasRoleAgentAssignmentMarker(agent.settings) || agent._count.roleAssignments > 0;
        const assignment = agent.roleAssignments[0] ?? null;
        if (assignmentRequired && assignment === null) return [];
        if (
          !assignmentRequired &&
          agent.ownerUserId !== principal.userId &&
          !isTenantVisible(agent.settings)
        ) {
          return [];
        }
        const request = readModelRouteRequest(agent.version.modelPolicy);
        const policy = policyByTaskClass.get(request.taskClass);
        if (policy === undefined) return [];
        const target = (candidatesByPolicy.get(policy.id) ?? []).find(
          ({ catalogVersionId }) => !successfulCatalogIds.has(catalogVersionId),
        );
        return target === undefined ? [] : [{ agent, assignment, target }];
      })[0];
      if (selection === undefined) {
        await transaction.auditEvent.create({
          data: {
            tenantId: principal.tenantId,
            actorType: 'USER',
            actorId: principal.userId,
            action: 'ai.model.connectivity_probe.rejected',
            resourceType: 'user',
            resourceId: principal.userId,
            metadata: {
              reasonCode: 'NO_ELIGIBLE_PROBE_AGENT_OR_MISSING_EVIDENCE',
              idempotencyKeyHash: runIdempotencyKey.slice(PROBE_IDEMPOTENCY_PREFIX.length),
            },
          },
        });
        throw new UnprocessableEntityException(
          'No tenant-visible published Agent can exercise a route candidate that lacks recent evidence.',
        );
      }

      const conversation = await ensureProbeConversation(transaction, {
        tenantId: principal.tenantId,
        user: { id: user.id, name: user.displayName },
        agent: { id: selection.agent.id, name: selection.agent.name },
      });
      await transaction.$queryRaw`
        SELECT pg_advisory_xact_lock(
          hashtextextended(${`${principal.tenantId}:${conversation.id}:agent-run`}, 0)
        )::text AS lock_token
      `;
      const message = await transaction.message.create({
        data: {
          tenantId: principal.tenantId,
          conversationId: conversation.id,
          senderType: 'USER',
          senderUserId: principal.userId,
          senderKey: `user:${principal.userId}`,
          senderName: user.displayName,
          clientMessageId: runIdempotencyKey,
          contentType: 'TEXT',
          content: {
            type: 'text',
            text: 'Reply with exactly MODEL_CONNECTIVITY_OK. This is a controlled administrator connectivity test. Do not call tools.',
          },
        },
      });
      const runId = randomUUID();
      await transaction.agentRun.create({
        data: {
          id: runId,
          tenantId: principal.tenantId,
          conversationId: conversation.id,
          inputMessageId: message.id,
          requesterUserId: principal.userId,
          agentId: selection.agent.id,
          agentVersionId: selection.agent.versionId,
          trigger: 'USER_MESSAGE',
          turnIndex: 1,
          turnLimit: 1,
          idempotencyKey: runIdempotencyKey,
          policySnapshot: buildAgentRunPolicySnapshot({
            agentVersion: selection.agent.version,
            roleAssignment: selection.assignment,
            knowledgeScopeOverride: { knowledgeBaseIds: [] },
            extra: {
              controlledModelConnectivityProbe: true,
              connectivityProbeCatalogVersionId: selection.target.catalogVersionId,
            },
          }),
        },
      });
      const [registeredProbe] = await transaction.$queryRaw<Array<{ run_id: string }>>`
        SELECT public.register_ai_model_connectivity_probe(
          ${principal.tenantId}::uuid,
          ${runId}::uuid,
          ${selection.target.catalogVersionId}::uuid,
          ${principal.userId}::uuid
        )::text AS run_id
      `;
      if (registeredProbe?.run_id !== runId) {
        throw new Error('Connectivity probe provenance registration failed.');
      }
      await transaction.auditEvent.create({
        data: {
          tenantId: principal.tenantId,
          actorType: 'USER',
          actorId: principal.userId,
          action: 'ai.model.connectivity_probe.requested',
          resourceType: 'agent_run',
          resourceId: runId,
          metadata: {
            agentId: selection.agent.id,
            catalogVersionId: selection.target.catalogVersionId,
            routePolicyVersionId: selection.target.policyVersionId,
            controlled: true,
          },
        },
      });
      return {
        runId,
        agentId: selection.agent.id,
        targetCatalogVersionId: selection.target.catalogVersionId,
        status: 'QUEUED',
      };
    });
  }

  private async executeControlledRun(
    principal: AdminPrincipal,
    seed: ProbeSeed,
    run: PreparedAgentRun,
  ): Promise<void> {
    const controller = new AbortController();
    let externalRunId: string | null = null;
    try {
      let result = await this.runtime.create(run, controller.signal);
      externalRunId = result.runId;
      const attachment = await this.runs.attachExternalRun(
        principal.tenantId,
        seed.runId,
        externalRunId,
      );
      if (attachment === 'cancellation_required') {
        await this.runs.completeFailed(
          principal.tenantId,
          seed.runId,
          'CONNECTIVITY_PROBE_CANCELLED_BY_POLICY',
          'The Agent assignment changed before the connectivity test.',
        );
        return;
      }
      if (result.status === 'queued' || result.status === 'running') {
        result = await this.runtime.execute(run, externalRunId, controller.signal);
      }
      if (result.runId !== externalRunId) {
        throw new AgentRuntimeRequestError(
          'AI_RUNTIME_RUN_MISMATCH',
          'AI Runtime returned a mismatched connectivity test Run.',
          'failed',
        );
      }
      await this.runs.recordModelExecutionEvidence(
        principal.tenantId,
        seed.runId,
        result.modelAttempts ?? [],
        result.outputSafetyDecision,
      );
      const hasTargetSuccess = (result.modelAttempts ?? []).some(
        (attempt) =>
          attempt.catalogVersionId === seed.targetCatalogVersionId &&
          attempt.outcome === 'SUCCEEDED',
      );
      if (result.status === 'succeeded' && result.output?.content.trim() && hasTargetSuccess) {
        await this.runs.completeSucceeded(
          principal.tenantId,
          seed.runId,
          result.output.content,
          [],
          usageFromRuntime(result),
        );
        return;
      }
      if (result.status === 'failed' || result.status === 'cancelled') {
        await this.runs.completeFailed(
          principal.tenantId,
          seed.runId,
          safeCode(result.error?.code ?? 'CONNECTIVITY_PROBE_PROVIDER_FAILED'),
          'The controlled model connectivity test did not succeed.',
          usageFromRuntime(result),
        );
        return;
      }
      if (result.status === 'succeeded' && !hasTargetSuccess) {
        await this.runs.completeFailed(
          principal.tenantId,
          seed.runId,
          'CONNECTIVITY_PROBE_RECEIPT_MISSING',
          'The provider response did not include a verifiable successful attempt receipt.',
          usageFromRuntime(result),
        );
        return;
      }
      await this.runs.completeUnknown(
        principal.tenantId,
        seed.runId,
        'CONNECTIVITY_PROBE_NONTERMINAL',
        usageFromRuntime(result),
      );
    } catch (error) {
      if (error instanceof AgentRuntimeRequestError && error.outcome === 'failed') {
        await this.runs.completeFailed(
          principal.tenantId,
          seed.runId,
          safeCode(error.code),
          'AI Runtime rejected the controlled model connectivity test.',
        );
        return;
      }
      await this.runs.completeUnknown(
        principal.tenantId,
        seed.runId,
        error instanceof AgentRuntimeRequestError
          ? safeCode(error.code)
          : 'CONNECTIVITY_PROBE_UNEXPECTED_FAILURE',
      );
    }
  }

  private async settleNonReadyPreparation(
    principal: AdminPrincipal,
    seed: ProbeSeed,
    preparation: Exclude<AgentRunPreparation, { readonly kind: 'ready' }>,
  ): Promise<void> {
    if (preparation.kind === 'terminal') return;
    if (preparation.kind === 'deferred') {
      await this.runs.completeFailed(
        principal.tenantId,
        seed.runId,
        safeCode(preparation.reasonCode),
        'The controlled model connectivity test was blocked by quota or concurrency policy.',
      );
      return;
    }
    await this.runs.completeUnknown(
      principal.tenantId,
      seed.runId,
      'CONNECTIVITY_PROBE_AMBIGUOUS_DISPATCH',
    );
  }

  private async finish(
    principal: AdminPrincipal,
    seed: ProbeSeed,
  ): Promise<AiModelConnectivityProbeResult> {
    const result = await this.readResult(principal, seed);
    await this.prisma.withTenant(principal.tenantId, async (transaction) => {
      await transaction.$queryRaw`SELECT set_config('app.user_id', ${principal.userId}, true)`;
      await transaction.auditEvent.create({
        data: {
          tenantId: principal.tenantId,
          actorType: 'USER',
          actorId: principal.userId,
          action: 'ai.model.connectivity_probe.completed',
          resourceType: 'agent_run',
          resourceId: seed.runId,
          metadata: {
            agentId: seed.agentId,
            catalogVersionId: seed.targetCatalogVersionId,
            status: result.status,
            evidenceStatus: result.evidenceStatus,
            reasonCode: result.reasonCode,
            successfulReceiptCatalogVersionIds: result.successfulReceiptCatalogVersionIds,
          },
        },
      });
      // UNKNOWN is not a final provider outcome: an administrator can put the
      // same immutable Run back into reconciliation. Keep the system probe
      // identities active until a trusted final outcome exists, otherwise the
      // normal Agent Run authorization boundary will correctly reject the
      // reconciliation as REQUESTER_NOT_PARTICIPANT.
      if (result.status !== 'UNKNOWN') {
        await transaction.conversationParticipant.updateMany({
          where: {
            tenantId: principal.tenantId,
            conversation: {
              agentRuns: { some: { tenantId: principal.tenantId, id: seed.runId } },
            },
            leftAt: null,
          },
          data: { leftAt: new Date() },
        });
      }
    });
    return result;
  }

  private async readResult(
    principal: AdminPrincipal,
    seed: ProbeSeed,
  ): Promise<AiModelConnectivityProbeResult> {
    return this.prisma.withTenant(principal.tenantId, async (transaction) => {
      const [run, successfulReceipts] = await Promise.all([
        transaction.agentRun.findFirst({
          where: { tenantId: principal.tenantId, id: seed.runId },
          select: { status: true, errorCode: true },
        }),
        transaction.aiModelAttemptReceipt.findMany({
          where: {
            tenantId: principal.tenantId,
            runId: seed.runId,
            phase: 'TERMINAL',
            outcome: 'SUCCEEDED',
          },
          select: { catalogVersionId: true },
          distinct: ['catalogVersionId'],
        }),
      ]);
      if (run === null) throw new Error('Connectivity probe Run disappeared.');
      const successfulReceiptCatalogVersionIds = successfulReceipts.map(
        ({ catalogVersionId }) => catalogVersionId,
      );
      const verified =
        run.status === 'SUCCEEDED' &&
        successfulReceiptCatalogVersionIds.includes(seed.targetCatalogVersionId);
      return {
        runId: seed.runId,
        agentId: seed.agentId,
        targetCatalogVersionId: seed.targetCatalogVersionId,
        status:
          run.status === 'SUCCEEDED'
            ? 'SUCCEEDED'
            : run.status === 'FAILED' || run.status === 'CANCELLED'
              ? 'FAILED'
              : 'UNKNOWN',
        evidenceStatus: verified ? 'VERIFIED' : 'INSUFFICIENT_EVIDENCE',
        reasonCode: verified ? null : (run.errorCode ?? 'CONNECTIVITY_PROBE_NOT_VERIFIED'),
        successfulReceiptCatalogVersionIds,
        checkedAt: new Date().toISOString(),
      };
    });
  }
}

async function ensureProbeConversation(
  transaction: Parameters<Parameters<PrismaService['withTenant']>[1]>[0],
  input: {
    readonly tenantId: string;
    readonly user: { readonly id: string; readonly name: string };
    readonly agent: { readonly id: string; readonly name: string };
  },
) {
  const directKey = `model-connectivity-probe:${input.user.id}:${input.agent.id}`;
  let conversation = await transaction.conversation.findFirst({
    where: { tenantId: input.tenantId, directKey },
    select: { id: true },
  });
  if (conversation === null) {
    conversation = await transaction.conversation.create({
      data: {
        tenantId: input.tenantId,
        type: 'DIRECT',
        directKey,
        title: '[SYSTEM] Model connectivity probe',
        createdById: input.user.id,
      },
      select: { id: true },
    });
  }
  for (const participant of [
    { type: 'USER' as const, id: input.user.id, name: input.user.name },
    { type: 'AGENT' as const, id: input.agent.id, name: input.agent.name },
  ]) {
    const participantKey = `${participant.type.toLowerCase()}:${participant.id}`;
    const stored = await transaction.conversationParticipant.findFirst({
      where: { tenantId: input.tenantId, conversationId: conversation.id, participantKey },
      select: { id: true },
    });
    const identity =
      participant.type === 'USER'
        ? { userId: participant.id, agentId: null }
        : { userId: null, agentId: participant.id };
    if (stored === null) {
      await transaction.conversationParticipant.create({
        data: {
          tenantId: input.tenantId,
          conversationId: conversation.id,
          type: participant.type,
          participantKey,
          displayName: participant.name,
          ...identity,
        },
      });
    } else {
      await transaction.conversationParticipant.update({
        where: { id: stored.id },
        data: { leftAt: null, displayName: participant.name, ...identity },
      });
    }
  }
  return conversation;
}

function isTenantVisible(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).visibility === 'tenant'
  );
}

function probeIdempotencyKey(value: string): string {
  return `${PROBE_IDEMPOTENCY_PREFIX}${createHash('sha256').update(value).digest('hex')}`;
}

function groupBy<T>(
  items: readonly T[],
  key: (item: T) => string,
): ReadonlyMap<string, readonly T[]> {
  const result = new Map<string, T[]>();
  for (const item of items) {
    const value = key(item);
    const group = result.get(value) ?? [];
    group.push(item);
    result.set(value, group);
  }
  return result;
}

function usageFromRuntime(result: RuntimeRunResult): AgentRunUsage | undefined {
  if (result.usage === undefined) return undefined;
  return {
    ...result.usage,
    provider: result.output?.provider ?? null,
    model: result.output?.model ?? null,
  };
}

function safeCode(value: string): string {
  return /^[A-Z0-9_]{1,120}$/u.test(value) ? value : 'CONNECTIVITY_PROBE_FAILED';
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return 'Unknown preparation error';
}
