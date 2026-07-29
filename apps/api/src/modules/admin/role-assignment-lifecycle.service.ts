import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { RoleAssignmentReconcileResponse } from '@enterprise/contracts';
import type { Prisma } from '@prisma/client';

import { LifecyclePrismaService } from '../../database/lifecycle-prisma.service.js';
import {
  cancelAssignedAgentRuns,
  cascadeAssignmentDescendants,
  disableAgentInstanceWithoutEffectiveAssignments,
  isDelegatedAssignmentScopeSubset,
  isGovernedAssignedRoleVersion,
} from './role-assignment-admin.service.js';

export const ROLE_ASSIGNMENT_RECONCILE_INTERVAL_MS = 30_000;
const RECONCILE_BATCH_SIZE = 100;
const ROLE_ASSIGNMENT_LIFECYCLE_ACTOR_ID = '00000000-0000-7000-8000-000000000001';

@Injectable()
export class RoleAssignmentLifecycleService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(RoleAssignmentLifecycleService.name);
  private stopped = true;
  private timer: NodeJS.Timeout | undefined;
  private activeTick: Promise<void> | undefined;

  constructor(
    @Inject(LifecyclePrismaService)
    private readonly prisma: LifecyclePrismaService,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.prisma.enabled) return;
    this.stopped = false;
    this.schedule(0);
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    await this.activeTick;
  }

  /** Reconciles all active tenants once; exposed for operations and deterministic tests. */
  async runOnce(now = new Date()): Promise<RoleAssignmentReconcileResponse> {
    if (!this.prisma.enabled) return emptySummary();
    const tenants = await this.prisma.listActiveTenantIds();
    const total = emptySummary();
    for (const tenantId of tenants) {
      const result = await this.reconcileTenant(tenantId, now);
      total.activated += result.activated;
      total.expired += result.expired;
      total.cancelledRuns += result.cancelledRuns;
    }
    return total;
  }

  /**
   * Drains one tenant in bounded transactions. Each successful batch causes
   * another pass, so backlogs larger than RECONCILE_BATCH_SIZE do not wait for
   * a later timer tick.
   */
  async reconcileTenant(
    tenantId: string,
    now = new Date(),
  ): Promise<RoleAssignmentReconcileResponse> {
    const total = emptySummary();
    for (;;) {
      const batch = await this.reconcileTenantBatch(tenantId, now);
      total.activated += batch.activated;
      total.expired += batch.expired;
      total.cancelledRuns += batch.cancelledRuns;
      if (batch.transitioned === 0) return total;
    }
  }

  private reconcileTenantBatch(
    tenantId: string,
    now: Date,
  ): Promise<RoleAssignmentReconcileResponse & { readonly transitioned: number }> {
    return this.prisma.withTenant(
      tenantId,
      async (transaction) => {
        await transaction.$queryRaw`
          SELECT pg_advisory_xact_lock(
            hashtextextended(${`${tenantId}:role-assignment-lifecycle`}, 0)
          )::text
        `;

        const summary = emptySummary();
        const expiring = await transaction.roleAssignment.findMany({
          where: {
            tenantId,
            status: { in: ['PENDING', 'ACTIVE', 'SUSPENDED'] },
            effectiveTo: { lte: now },
          },
          select: lifecycleAssignmentSelect,
          orderBy: [{ effectiveTo: 'asc' }, { id: 'asc' }],
          take: RECONCILE_BATCH_SIZE,
        });
        for (const assignment of expiring) {
          await lockAssignment(transaction, tenantId, assignment.id);
          const transitioned = await transaction.roleAssignment.updateMany({
            where: {
              id: assignment.id,
              tenantId,
              status: assignment.status,
              version: assignment.version,
              effectiveTo: { lte: now },
            },
            data: {
              status: 'EXPIRED',
              version: { increment: 1 },
              updatedAt: now,
            },
          });
          if (transitioned.count !== 1) continue;

          const cancelled = await cancelAssignedAgentRuns(
            transaction,
            tenantId,
            assignment.id,
            assignment.agentInstanceId,
            assignment.userId,
            now,
            {
              errorCode: 'ROLE_ASSIGNMENT_EXPIRED',
              errorMessage: 'Role assignment expired.',
            },
          );
          await disableAgentInstanceWithoutEffectiveAssignments(
            transaction,
            tenantId,
            assignment.id,
            assignment.agentInstanceId,
            now,
          );
          const cascaded = await cascadeAssignmentDescendants(
            transaction,
            tenantId,
            assignment.id,
            'EXPIRED',
            now,
            {
              reason: `Source assignment ${assignment.id} expired.`,
              errorCode: 'ROLE_ASSIGNMENT_SOURCE_EXPIRED',
              errorMessage: 'The source role assignment expired.',
            },
          );
          await recordLifecycleAudit(
            transaction,
            tenantId,
            assignment.id,
            'admin.role_assignment.expired',
            {
              previousStatus: assignment.status,
              agentInstanceId: assignment.agentInstanceId,
              cancelledAgentRunIds: cancelled.map((run) => run.id),
              cascadedAssignmentIds: cascaded.map((item) => item.id),
            },
            now,
          );
          for (const cascadedAssignment of cascaded) {
            await recordLifecycleAudit(
              transaction,
              tenantId,
              cascadedAssignment.id,
              'admin.role_assignment.cascade_expired',
              {
                sourceAssignmentId: assignment.id,
                parentAssignmentId: cascadedAssignment.parentAssignmentId,
                previousStatus: cascadedAssignment.previousStatus,
                cancelledAgentRunIds: [...cascadedAssignment.cancelledRunIds],
              },
              now,
            );
          }
          summary.expired += 1 + cascaded.length;
          summary.cancelledRuns +=
            cancelled.length +
            cascaded.reduce((total, item) => total + item.cancelledRunIds.length, 0);
        }

        const activating = await transaction.roleAssignment.findMany({
          where: {
            tenantId,
            status: 'PENDING',
            effectiveFrom: { lte: now },
            OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
            user: { is: { status: 'ACTIVE' } },
            employment: { is: { status: 'ACTIVE' } },
            roleVersion: {
              is: {
                status: { in: ['PUBLISHED', 'RETIRED'] },
                reviewStatus: 'APPROVED',
                template: { is: { mission: { not: '' } } },
              },
            },
          },
          select: lifecycleAssignmentSelect,
          orderBy: [{ effectiveFrom: 'asc' }, { id: 'asc' }],
          take: RECONCILE_BATCH_SIZE,
        });
        for (const assignment of activating) {
          if (!isGovernedAssignedRoleVersion(assignment.roleVersion)) continue;
          const delegationSource =
            assignment.source === 'DELEGATION' || assignment.source === 'HANDOVER'
              ? await loadEffectiveDelegationSource(transaction, tenantId, assignment, now)
              : null;
          if (
            (assignment.source === 'DELEGATION' || assignment.source === 'HANDOVER') &&
            delegationSource === null
          ) {
            continue;
          }
          await lockAssignment(transaction, tenantId, assignment.id);
          const transitioned = await transaction.roleAssignment.updateMany({
            where: {
              id: assignment.id,
              tenantId,
              status: 'PENDING',
              version: assignment.version,
              effectiveFrom: { lte: now },
              OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
            },
            data: {
              status: 'ACTIVE',
              version: { increment: 1 },
              updatedAt: now,
            },
          });
          if (transitioned.count !== 1) continue;

          if (assignment.source === 'HANDOVER' && delegationSource !== null) {
            summary.cancelledRuns += await transitionLifecycleHandoverSource(
              transaction,
              tenantId,
              assignment,
              delegationSource,
              now,
            );
          }
          await transaction.agentInstance.updateMany({
            where: {
              id: assignment.agentInstanceId,
              tenantId,
              versionId: assignment.roleVersionId,
              status: { in: ['OFFLINE', 'ONLINE'] },
            },
            data: { status: 'ONLINE' },
          });
          await recordLifecycleAudit(
            transaction,
            tenantId,
            assignment.id,
            'admin.role_assignment.activated',
            {
              agentInstanceId: assignment.agentInstanceId,
              effectiveFrom: assignment.effectiveFrom.toISOString(),
            },
            now,
          );
          summary.activated += 1;
        }
        return {
          ...summary,
          transitioned: summary.activated + summary.expired,
        };
      },
      { timeout: 30_000 },
    );
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      const tick = this.tick();
      this.activeTick = tick;
      void tick.finally(() => {
        if (this.activeTick === tick) this.activeTick = undefined;
      });
    }, delayMs);
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    try {
      await this.runOnce();
    } catch (error) {
      this.logger.error(`Role assignment lifecycle reconciliation failed (${errorKind(error)}).`);
    } finally {
      this.schedule(ROLE_ASSIGNMENT_RECONCILE_INTERVAL_MS);
    }
  }
}

const lifecycleAssignmentSelect = {
  id: true,
  userId: true,
  agentInstanceId: true,
  roleVersionId: true,
  source: true,
  delegatedFromAssignmentId: true,
  createdById: true,
  status: true,
  version: true,
  effectiveFrom: true,
  effectiveTo: true,
  organizationScope: true,
  permissionScope: true,
  memoryPolicy: true,
  roleVersion: {
    select: {
      status: true,
      reviewStatus: true,
      createdById: true,
      reviewRequestedById: true,
      reviewedById: true,
      approvedById: true,
      blueprintRevision: true,
      roleDefinitionSnapshot: true,
      template: { select: { mission: true } },
    },
  },
} satisfies Prisma.RoleAssignmentSelect;

type LifecycleAssignment = Prisma.RoleAssignmentGetPayload<{
  select: typeof lifecycleAssignmentSelect;
}>;

const lifecycleSourceSelect = {
  id: true,
  userId: true,
  agentInstanceId: true,
  status: true,
  version: true,
  updatedAt: true,
  effectiveFrom: true,
  effectiveTo: true,
  organizationScope: true,
  permissionScope: true,
  memoryPolicy: true,
} satisfies Prisma.RoleAssignmentSelect;

type LifecycleSource = Prisma.RoleAssignmentGetPayload<{
  select: typeof lifecycleSourceSelect;
}>;

async function lockAssignment(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  assignmentId: string,
): Promise<void> {
  await transaction.$queryRaw`
    SELECT pg_advisory_xact_lock(
      hashtextextended(${`${tenantId}:role-assignment:${assignmentId}`}, 0)
    )::text
  `;
}

async function loadEffectiveDelegationSource(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  assignment: LifecycleAssignment,
  now: Date,
): Promise<LifecycleSource | null> {
  if (assignment.delegatedFromAssignmentId === null) return null;
  await lockAssignment(transaction, tenantId, assignment.delegatedFromAssignmentId);
  const source = await transaction.roleAssignment.findFirst({
    where: {
      tenantId,
      id: assignment.delegatedFromAssignmentId,
      status: 'ACTIVE',
      effectiveFrom: { lte: now },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
    },
    select: lifecycleSourceSelect,
  });
  if (source === null || source.id === assignment.id) return null;
  if (assignment.effectiveFrom < source.effectiveFrom) return null;
  if (
    !isDelegatedAssignmentScopeSubset(
      jsonRecord(assignment.organizationScope),
      jsonRecord(source.organizationScope),
    ) ||
    !isDelegatedAssignmentScopeSubset(
      jsonRecord(assignment.permissionScope),
      jsonRecord(source.permissionScope),
    ) ||
    !isDelegatedAssignmentScopeSubset(
      jsonRecord(assignment.memoryPolicy),
      jsonRecord(source.memoryPolicy),
    )
  ) {
    return null;
  }
  if (
    assignment.source === 'DELEGATION' &&
    source.effectiveTo !== null &&
    (assignment.effectiveTo === null || assignment.effectiveTo > source.effectiveTo)
  ) {
    return null;
  }
  return source;
}

async function transitionLifecycleHandoverSource(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  assignment: LifecycleAssignment,
  source: LifecycleSource,
  now: Date,
): Promise<number> {
  const reason = `Handed over to assignment ${assignment.id}.`;
  const transitioned = await transaction.roleAssignment.updateMany({
    where: {
      tenantId,
      id: source.id,
      status: 'ACTIVE',
      version: source.version,
      updatedAt: source.updatedAt,
    },
    data: {
      status: 'REVOKED',
      revokedAt: now,
      revokedById: assignment.createdById,
      revokeReason: reason,
      version: { increment: 1 },
      updatedAt: now,
    },
  });
  if (transitioned.count !== 1) {
    throw new Error('The handover source changed during lifecycle activation.');
  }
  const cancelled = await cancelAssignedAgentRuns(
    transaction,
    tenantId,
    source.id,
    source.agentInstanceId,
    source.userId,
    now,
    {
      errorCode: 'ROLE_ASSIGNMENT_REVOKED',
      errorMessage: 'The role assignment was handed over to another member.',
    },
  );
  await disableAgentInstanceWithoutEffectiveAssignments(
    transaction,
    tenantId,
    source.id,
    source.agentInstanceId,
    now,
  );
  const cascaded = await cascadeAssignmentDescendants(
    transaction,
    tenantId,
    source.id,
    'REVOKED',
    now,
    {
      revokedById: assignment.createdById,
      reason: `Source assignment ${source.id} was handed over.`,
      errorCode: 'ROLE_ASSIGNMENT_REVOKED',
      errorMessage: 'The source role assignment was handed over.',
      excludedAssignmentIds: [assignment.id],
    },
  );
  await recordLifecycleAudit(
    transaction,
    tenantId,
    source.id,
    'admin.role_assignment.handed_over',
    {
      successorAssignmentId: assignment.id,
      cancelledAgentRunIds: cancelled.map((run) => run.id),
      cascadedAssignmentIds: cascaded.map((item) => item.id),
    },
    now,
  );
  for (const cascadedAssignment of cascaded) {
    await recordLifecycleAudit(
      transaction,
      tenantId,
      cascadedAssignment.id,
      'admin.role_assignment.cascade_revoked',
      {
        sourceAssignmentId: source.id,
        parentAssignmentId: cascadedAssignment.parentAssignmentId,
        previousStatus: cascadedAssignment.previousStatus,
        cancelledAgentRunIds: [...cascadedAssignment.cancelledRunIds],
      },
      now,
    );
  }
  return (
    cancelled.length + cascaded.reduce((total, item) => total + item.cancelledRunIds.length, 0)
  );
}

async function recordLifecycleAudit(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  assignmentId: string,
  action: string,
  metadata: Prisma.InputJsonObject,
  occurredAt: Date,
): Promise<void> {
  await transaction.auditEvent.createMany({
    data: [
      {
        tenantId,
        actorType: 'SERVICE',
        actorId: ROLE_ASSIGNMENT_LIFECYCLE_ACTOR_ID,
        action,
        resourceType: 'role_assignment',
        resourceId: assignmentId,
        metadata,
        occurredAt,
      },
    ],
  });
}

function emptySummary(): {
  activated: number;
  expired: number;
  cancelledRuns: number;
} {
  return { activated: 0, expired: 0, cancelledRuns: 0 };
}

function errorKind(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function jsonRecord(value: Prisma.JsonValue): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}
