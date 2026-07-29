import { createHash, randomUUID } from 'node:crypto';

import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  CreateRoleAssignmentRequest,
  RevokeRoleAssignmentRequest,
  RoleAssignment,
  RoleAssignmentListResponse,
} from '@enterprise/contracts';
import { roleDefinitionSnapshotSchema } from '@enterprise/contracts';
import { Prisma } from '@prisma/client';

import { AdminPrismaService } from '../../database/admin-prisma.service.js';
import {
  AGENT_RUN_CANCEL_REQUESTED_EVENT_TYPE,
  ROLE_ASSIGNMENT_REVOKED_AGENT_RUN_ERROR_CODE,
} from '../agent-run/domain/agent-run.models.js';
import { AdminAccessService, type AdminPrincipal } from './admin-access.service.js';
import { recordAdminAudit } from './admin-audit.js';

const delegationSourceSelect = {
  id: true,
  userId: true,
  roleTemplateId: true,
  status: true,
  effectiveFrom: true,
  effectiveTo: true,
  organizationScope: true,
  permissionScope: true,
  memoryPolicy: true,
  agentInstanceId: true,
  version: true,
  updatedAt: true,
} satisfies Prisma.RoleAssignmentSelect;

type RoleAssignmentRecord = Prisma.RoleAssignmentGetPayload<{
  include: typeof roleAssignmentInclude;
}>;
type DelegationSource = Prisma.RoleAssignmentGetPayload<{
  select: typeof delegationSourceSelect;
}>;

@Injectable()
export class RoleAssignmentAdminService {
  constructor(
    @Inject(AdminPrismaService) private readonly prisma: AdminPrismaService,
    @Inject(AdminAccessService) private readonly access: AdminAccessService,
  ) {}

  async list(): Promise<RoleAssignmentListResponse> {
    const principal = this.access.requireDirectoryWrite();
    return this.prisma.withTenant(principal.tenantId, async (transaction) => {
      const assignments = await transaction.roleAssignment.findMany({
        where: { tenantId: principal.tenantId },
        include: roleAssignmentInclude,
        orderBy: [{ status: 'asc' }, { effectiveFrom: 'desc' }, { id: 'asc' }],
      });
      return { items: assignments.map(mapRoleAssignment) };
    });
  }

  async create(request: CreateRoleAssignmentRequest): Promise<RoleAssignment> {
    const principal = this.access.requireDirectoryWrite();
    const delegatedRequest = request.source === 'DELEGATION' || request.source === 'HANDOVER';
    if (!delegatedRequest && Object.keys(request.permissionScope).length > 0) {
      throw new ConflictException(
        'Inline permission grants are not supported. Publish permissions with the Role Blueprint.',
      );
    }
    const effectiveFrom = new Date(request.effectiveFrom);
    const effectiveTo =
      request.effectiveTo === undefined || request.effectiveTo === null
        ? null
        : new Date(request.effectiveTo);
    const now = new Date();
    if (effectiveTo !== null && effectiveTo <= now) {
      throw new ConflictException('A new role assignment cannot already be expired.');
    }
    const requestHash = roleAssignmentRequestHash(request);
    const idempotencyKey = request.idempotencyKey ?? `auto:${requestHash}`;

    try {
      return await this.prisma.withTenant(principal.tenantId, async (transaction) => {
        await transaction.$queryRaw`
          SELECT pg_advisory_xact_lock(
            hashtextextended(
              ${`${principal.tenantId}:role-assignment-idempotency:${idempotencyKey}`},
              0
            )
          )::text
        `;
        const existing = await transaction.roleAssignment.findFirst({
          where: { tenantId: principal.tenantId, idempotencyKey },
          include: roleAssignmentInclude,
        });
        if (existing !== null) {
          if (existing.requestHash !== requestHash) {
            throw new ConflictException(
              'The role assignment idempotency key was already used for a different request.',
            );
          }
          return mapRoleAssignment(existing);
        }

        await transaction.$queryRaw`
          SELECT pg_advisory_xact_lock(
            hashtextextended(${`${principal.tenantId}:role-assignment-user:${request.userId}`}, 0)
          )::text
        `;

        const user = await transaction.user.findFirst({
          where: { id: request.userId, tenantId: principal.tenantId, status: 'ACTIVE' },
          select: { id: true, displayName: true, role: true },
        });
        if (user === null) throw new NotFoundException('The active assignment user was not found.');
        if (user.id === principal.userId || user.role === 'OWNER') {
          throw new ForbiddenException(
            'A role administrator cannot self-assign a Role Agent or create an owner assignment.',
          );
        }

        const employment = await transaction.employment.findFirst({
          where: {
            id: request.employmentId,
            tenantId: principal.tenantId,
            userId: request.userId,
            status: 'ACTIVE',
          },
          select: { id: true },
        });
        if (employment === null) {
          throw new ConflictException(
            'The employment must belong to the assignment user and be active.',
          );
        }

        const versionIdentity = await transaction.agentVersion.findFirst({
          where: {
            id: request.agentVersionId,
            tenantId: principal.tenantId,
          },
          select: { templateId: true },
        });
        if (versionIdentity === null) {
          throw new ConflictException(
            'Only an independently approved published structured Role Blueprint version can be assigned.',
          );
        }
        await transaction.$queryRaw`
          SELECT pg_advisory_xact_lock(
            hashtextextended(
              ${`${principal.tenantId}:role-blueprint:${versionIdentity.templateId}`},
              0
            )
          )::text
        `;

        const version = await transaction.agentVersion.findFirst({
          where: {
            id: request.agentVersionId,
            tenantId: principal.tenantId,
            status: 'PUBLISHED',
            reviewStatus: 'APPROVED',
            template: { is: { mission: { not: '' } } },
          },
          include: {
            template: { select: { id: true, key: true, name: true, mission: true } },
          },
        });
        if (version === null || !isGovernedPublishedRoleVersion(version)) {
          throw new ConflictException(
            'Only an independently approved published structured Role Blueprint version can be assigned.',
          );
        }
        const delegationSource = await validateDelegationSource(
          transaction,
          principal.tenantId,
          request,
          version.template.id,
          effectiveFrom,
          effectiveTo,
          now,
        );
        const overlap = await transaction.roleAssignment.findFirst({
          where: {
            tenantId: principal.tenantId,
            userId: user.id,
            roleTemplateId: version.template.id,
            status: { in: ['PENDING', 'ACTIVE', 'SUSPENDED'] },
            ...(effectiveTo === null ? {} : { effectiveFrom: { lt: effectiveTo } }),
            OR: [{ effectiveTo: null }, { effectiveTo: { gt: effectiveFrom } }],
          },
          select: { id: true },
        });
        if (overlap !== null) {
          throw new ConflictException(
            'The member already has an overlapping assignment for this Role Blueprint.',
          );
        }

        const assignmentId = randomUUID();
        const agentInstanceId = randomUUID();
        const assignmentKey =
          request.key ??
          normalizedAssignmentKey(version.template.key, request.userId, assignmentId);
        const activeNow = effectiveFrom <= now && (effectiveTo === null || effectiveTo > now);

        await transaction.agentInstance.create({
          data: {
            id: agentInstanceId,
            tenantId: principal.tenantId,
            key: `role-agent:${assignmentId}`,
            versionId: version.id,
            ownerUserId: user.id,
            createdById: principal.userId,
            name: request.agentName ?? `${user.displayName} · ${version.template.name}`,
            summary: `Role Agent assignment ${assignmentKey}`,
            status: activeNow ? 'ONLINE' : 'OFFLINE',
            settings: {
              visibility: 'owner',
              roleAssignmentId: assignmentId,
              roleTemplateId: version.template.id,
            },
          },
        });

        await transaction.roleAssignment.create({
          data: {
            id: assignmentId,
            tenantId: principal.tenantId,
            key: assignmentKey,
            idempotencyKey,
            requestHash,
            userId: user.id,
            employmentId: request.employmentId,
            roleTemplateId: version.template.id,
            roleVersionId: version.id,
            agentInstanceId,
            status: activeNow ? 'ACTIVE' : 'PENDING',
            source: request.source,
            effectiveFrom,
            effectiveTo,
            organizationScope: toJsonObject(request.organizationScope),
            permissionScope: toJsonObject(request.permissionScope),
            memoryPolicy: toJsonObject(request.memoryPolicy),
            delegatedFromAssignmentId: request.delegatedFromAssignmentId ?? null,
            createdById: principal.userId,
          },
        });

        const handover =
          request.source === 'HANDOVER' && activeNow && delegationSource !== null
            ? await handoverSourceAssignment(
                transaction,
                principal,
                delegationSource,
                assignmentId,
                now,
              )
            : null;

        await recordAdminAudit(
          transaction,
          principal,
          'admin.role_assignment.created',
          'role_assignment',
          assignmentId,
          {
            assignmentKey,
            idempotencyKey,
            userId: user.id,
            employmentId: request.employmentId,
            agentInstanceId,
            agentVersionId: version.id,
            roleTemplateId: version.template.id,
            source: request.source,
            delegatedFromAssignmentId: request.delegatedFromAssignmentId ?? null,
            handedOverAssignmentId: handover?.sourceAssignmentId ?? null,
            cascadedAssignmentIds:
              handover?.cascadedAssignments.map((assignment) => assignment.id) ?? [],
            effectiveFrom: effectiveFrom.toISOString(),
            effectiveTo: effectiveTo?.toISOString() ?? null,
          },
        );

        return mapRoleAssignment(
          await transaction.roleAssignment.findFirstOrThrow({
            where: { id: assignmentId, tenantId: principal.tenantId },
            include: roleAssignmentInclude,
          }),
        );
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        (error.code === 'P2002' || error.code === 'P2004')
      ) {
        throw new ConflictException('A role assignment with this identity already exists.');
      }
      throw error;
    }
  }

  async revoke(id: string, request: RevokeRoleAssignmentRequest): Promise<RoleAssignment> {
    const principal = this.access.requireDirectoryWrite();
    return this.prisma.withTenant(principal.tenantId, async (transaction) => {
      await transaction.$queryRaw`
        SELECT pg_advisory_xact_lock(
          hashtextextended(${`${principal.tenantId}:role-assignment:${id}`}, 0)
        )::text
      `;
      const current = await transaction.roleAssignment.findFirst({
        where: { id, tenantId: principal.tenantId },
        include: roleAssignmentInclude,
      });
      if (current === null) throw new NotFoundException('The role assignment was not found.');
      if (current.status === 'REVOKED') {
        throw new ConflictException('The role assignment has already been revoked.');
      }
      if (
        (request.expectedVersion !== undefined && current.version !== request.expectedVersion) ||
        (request.expectedUpdatedAt !== undefined &&
          current.updatedAt.toISOString() !== request.expectedUpdatedAt)
      ) {
        throw new ConflictException('The role assignment changed. Refresh and try again.');
      }

      const revokedAt = new Date();
      const updated = await transaction.roleAssignment.updateMany({
        where: {
          id,
          tenantId: principal.tenantId,
          version: current.version,
          updatedAt: current.updatedAt,
          status: { not: 'REVOKED' },
        },
        data: {
          status: 'REVOKED',
          revokedAt,
          revokedById: principal.userId,
          revokeReason: request.reason,
          version: { increment: 1 },
          updatedAt: revokedAt,
        },
      });
      if (updated.count !== 1) {
        throw new ConflictException('The role assignment changed. Refresh and try again.');
      }

      const cancelledRuns = await cancelAssignedAgentRuns(
        transaction,
        principal.tenantId,
        current.id,
        current.agentInstanceId,
        current.userId,
        revokedAt,
      );

      await disableAgentInstanceWithoutEffectiveAssignments(
        transaction,
        principal.tenantId,
        current.id,
        current.agentInstanceId,
        revokedAt,
      );
      const cascadedAssignments = await cascadeAssignmentDescendants(
        transaction,
        principal.tenantId,
        current.id,
        'REVOKED',
        revokedAt,
        {
          revokedById: principal.userId,
          reason: `Source assignment ${current.id} was revoked: ${request.reason}`,
          errorCode: ROLE_ASSIGNMENT_REVOKED_AGENT_RUN_ERROR_CODE,
          errorMessage: 'The source role assignment was revoked.',
        },
      );
      for (const cascaded of cascadedAssignments) {
        await recordAdminAudit(
          transaction,
          principal,
          'admin.role_assignment.cascade_revoked',
          'role_assignment',
          cascaded.id,
          {
            sourceAssignmentId: current.id,
            parentAssignmentId: cascaded.parentAssignmentId,
            previousStatus: cascaded.previousStatus,
            cancelledAgentRunIds: cascaded.cancelledRunIds,
          },
        );
      }

      await recordAdminAudit(
        transaction,
        principal,
        'admin.role_assignment.revoked',
        'role_assignment',
        current.id,
        {
          userId: current.userId,
          agentInstanceId: current.agentInstanceId,
          reason: request.reason,
          cancelledAgentRunIds: cancelledRuns.map((run) => run.id),
          externalCancellationRunIds: cancelledRuns
            .filter((run) => run.requiresExternalCancellation)
            .map((run) => run.id),
          cascadedAssignmentIds: cascadedAssignments.map((assignment) => assignment.id),
        },
      );

      return mapRoleAssignment(
        await transaction.roleAssignment.findFirstOrThrow({
          where: { id: current.id, tenantId: principal.tenantId },
          include: roleAssignmentInclude,
        }),
      );
    });
  }
}

async function validateDelegationSource(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  request: CreateRoleAssignmentRequest,
  roleTemplateId: string,
  effectiveFrom: Date,
  effectiveTo: Date | null,
  now: Date,
): Promise<DelegationSource | null> {
  const delegatedSource = request.source === 'DELEGATION' || request.source === 'HANDOVER';
  const delegatedFromAssignmentId = request.delegatedFromAssignmentId ?? null;
  if (delegatedSource !== (delegatedFromAssignmentId !== null)) {
    throw new ConflictException(
      'Delegation and handover assignments must reference exactly one source assignment.',
    );
  }
  if (delegatedFromAssignmentId === null) return null;

  await transaction.$queryRaw`
    SELECT pg_advisory_xact_lock(
      hashtextextended(${`${tenantId}:role-assignment:${delegatedFromAssignmentId}`}, 0)
    )::text
  `;
  const source = await transaction.roleAssignment.findFirst({
    where: { id: delegatedFromAssignmentId, tenantId },
    select: delegationSourceSelect,
  });
  if (source === null) {
    throw new ConflictException('The delegation source assignment was not found.');
  }
  if (!['PENDING', 'ACTIVE'].includes(source.status)) {
    throw new ConflictException('The delegation source assignment is not effective.');
  }
  if (request.source === 'HANDOVER' && effectiveFrom <= now && source.status !== 'ACTIVE') {
    throw new ConflictException('An immediate handover requires an active source assignment.');
  }
  if (source.userId === request.userId) {
    throw new ConflictException('A role assignment cannot be delegated to the same member.');
  }
  if (source.roleTemplateId !== roleTemplateId) {
    throw new ConflictException(
      'A delegation or handover must keep the source Role Blueprint identity.',
    );
  }
  if (
    source.effectiveFrom > effectiveFrom ||
    (source.effectiveTo !== null && source.effectiveTo <= effectiveFrom)
  ) {
    throw new ConflictException(
      'A delegation or handover must start during the source assignment period.',
    );
  }
  if (
    request.source === 'DELEGATION' &&
    source.effectiveTo !== null &&
    (effectiveTo === null || effectiveTo > source.effectiveTo)
  ) {
    throw new ConflictException('A delegation cannot outlive its source assignment.');
  }
  assertDelegatedScopeSubset(
    'organization scope',
    request.organizationScope,
    jsonRecord(source.organizationScope),
  );
  assertDelegatedScopeSubset(
    'permission scope',
    request.permissionScope,
    jsonRecord(source.permissionScope),
  );
  assertDelegatedScopeSubset(
    'memory policy',
    request.memoryPolicy,
    jsonRecord(source.memoryPolicy),
  );
  return source;
}

type CascadedAssignmentTransition = {
  readonly id: string;
  readonly parentAssignmentId: string;
  readonly previousStatus: 'PENDING' | 'ACTIVE' | 'SUSPENDED';
  readonly agentInstanceId: string;
  readonly cancelledRunIds: readonly string[];
};

export function isGovernedPublishedRoleVersion(version: {
  readonly status: string;
  readonly reviewStatus: string;
  readonly createdById: string | null;
  readonly reviewRequestedById: string | null;
  readonly reviewedById: string | null;
  readonly approvedById: string | null;
  readonly blueprintRevision: number;
  readonly roleDefinitionSnapshot: Prisma.JsonValue;
  readonly template: { readonly mission: string };
}): boolean {
  return isGovernedRoleVersion(version, ['PUBLISHED']);
}

export function isGovernedAssignedRoleVersion(version: {
  readonly status: string;
  readonly reviewStatus: string;
  readonly createdById: string | null;
  readonly reviewRequestedById: string | null;
  readonly reviewedById: string | null;
  readonly approvedById: string | null;
  readonly blueprintRevision: number;
  readonly roleDefinitionSnapshot: Prisma.JsonValue;
  readonly template: { readonly mission: string };
}): boolean {
  // Publishing a successor makes an older version unavailable to new
  // assignments, but existing assignments remain pinned to and executable on
  // their immutable snapshot. Explicit retirement is blocked while such
  // assignments exist.
  return isGovernedRoleVersion(version, ['PUBLISHED', 'RETIRED']);
}

function isGovernedRoleVersion(
  version: {
    readonly status: string;
    readonly reviewStatus: string;
    readonly createdById: string | null;
    readonly reviewRequestedById: string | null;
    readonly reviewedById: string | null;
    readonly approvedById: string | null;
    readonly blueprintRevision: number;
    readonly roleDefinitionSnapshot: Prisma.JsonValue;
    readonly template: { readonly mission: string };
  },
  executableStatuses: readonly string[],
): boolean {
  return (
    executableStatuses.includes(version.status) &&
    version.reviewStatus === 'APPROVED' &&
    version.template.mission.trim().length > 0 &&
    version.blueprintRevision > 0 &&
    version.createdById !== null &&
    version.approvedById !== null &&
    version.createdById !== version.approvedById &&
    version.reviewRequestedById !== null &&
    version.reviewedById !== null &&
    version.reviewRequestedById !== version.reviewedById &&
    roleDefinitionSnapshotSchema.safeParse(jsonRecord(version.roleDefinitionSnapshot)).success
  );
}

async function handoverSourceAssignment(
  transaction: Prisma.TransactionClient,
  principal: AdminPrincipal,
  source: DelegationSource,
  successorAssignmentId: string,
  handedOverAt: Date,
): Promise<{
  readonly sourceAssignmentId: string;
  readonly cascadedAssignments: readonly CascadedAssignmentTransition[];
}> {
  const reason = `Handed over to assignment ${successorAssignmentId}.`;
  const transitioned = await transaction.roleAssignment.updateMany({
    where: {
      id: source.id,
      tenantId: principal.tenantId,
      status: 'ACTIVE',
      version: source.version,
      updatedAt: source.updatedAt,
    },
    data: {
      status: 'REVOKED',
      revokedAt: handedOverAt,
      revokedById: principal.userId,
      revokeReason: reason,
      version: { increment: 1 },
      updatedAt: handedOverAt,
    },
  });
  if (transitioned.count !== 1) {
    throw new ConflictException('The handover source assignment changed. Refresh and try again.');
  }

  const cancelled = await cancelAssignedAgentRuns(
    transaction,
    principal.tenantId,
    source.id,
    source.agentInstanceId,
    source.userId,
    handedOverAt,
    {
      errorCode: ROLE_ASSIGNMENT_REVOKED_AGENT_RUN_ERROR_CODE,
      errorMessage: 'The role assignment was handed over to another member.',
    },
  );
  await disableAgentInstanceWithoutEffectiveAssignments(
    transaction,
    principal.tenantId,
    source.id,
    source.agentInstanceId,
    handedOverAt,
  );
  const cascadedAssignments = await cascadeAssignmentDescendants(
    transaction,
    principal.tenantId,
    source.id,
    'REVOKED',
    handedOverAt,
    {
      revokedById: principal.userId,
      reason: `Source assignment ${source.id} was handed over.`,
      errorCode: ROLE_ASSIGNMENT_REVOKED_AGENT_RUN_ERROR_CODE,
      errorMessage: 'The source role assignment was handed over.',
      excludedAssignmentIds: [successorAssignmentId],
    },
  );
  await recordAdminAudit(
    transaction,
    principal,
    'admin.role_assignment.handed_over',
    'role_assignment',
    source.id,
    {
      successorAssignmentId,
      cancelledAgentRunIds: cancelled.map((run) => run.id),
      cascadedAssignmentIds: cascadedAssignments.map((assignment) => assignment.id),
    },
  );
  for (const cascaded of cascadedAssignments) {
    await recordAdminAudit(
      transaction,
      principal,
      'admin.role_assignment.cascade_revoked',
      'role_assignment',
      cascaded.id,
      {
        sourceAssignmentId: source.id,
        parentAssignmentId: cascaded.parentAssignmentId,
        previousStatus: cascaded.previousStatus,
        cancelledAgentRunIds: cascaded.cancelledRunIds,
      },
    );
  }
  return { sourceAssignmentId: source.id, cascadedAssignments };
}

export async function cascadeAssignmentDescendants(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  sourceAssignmentId: string,
  targetStatus: 'REVOKED' | 'EXPIRED',
  transitionedAt: Date,
  options: {
    readonly revokedById?: string;
    readonly reason: string;
    readonly errorCode: string;
    readonly errorMessage: string;
    readonly excludedAssignmentIds?: readonly string[];
  },
): Promise<readonly CascadedAssignmentTransition[]> {
  const revokedById = options.revokedById;
  if (targetStatus === 'REVOKED' && revokedById === undefined) {
    throw new Error('A cascading revocation requires a revoking administrator.');
  }
  const excluded = new Set(options.excludedAssignmentIds ?? []);
  const visited = new Set([sourceAssignmentId]);
  const pendingParents = [sourceAssignmentId];
  const transitions: CascadedAssignmentTransition[] = [];

  while (pendingParents.length > 0) {
    const parentAssignmentId = pendingParents.shift();
    if (parentAssignmentId === undefined) break;
    const children = await transaction.roleAssignment.findMany({
      where: { tenantId, delegatedFromAssignmentId: parentAssignmentId },
      select: {
        id: true,
        userId: true,
        agentInstanceId: true,
        status: true,
        version: true,
      },
      orderBy: { id: 'asc' },
    });
    for (const child of children) {
      if (visited.has(child.id)) continue;
      visited.add(child.id);
      if (excluded.has(child.id)) continue;
      pendingParents.push(child.id);
      if (!isTransitionableAssignmentStatus(child.status)) continue;

      const updated = await transaction.roleAssignment.updateMany({
        where: {
          tenantId,
          id: child.id,
          status: child.status,
          version: child.version,
        },
        data:
          targetStatus === 'REVOKED'
            ? {
                status: 'REVOKED',
                revokedAt: transitionedAt,
                revokedById: revokedById as string,
                revokeReason: options.reason.slice(0, 500),
                version: { increment: 1 },
                updatedAt: transitionedAt,
              }
            : {
                status: 'EXPIRED',
                version: { increment: 1 },
                updatedAt: transitionedAt,
              },
      });
      if (updated.count !== 1) continue;

      const cancelled = await cancelAssignedAgentRuns(
        transaction,
        tenantId,
        child.id,
        child.agentInstanceId,
        child.userId,
        transitionedAt,
        {
          errorCode: options.errorCode,
          errorMessage: options.errorMessage,
        },
      );
      await disableAgentInstanceWithoutEffectiveAssignments(
        transaction,
        tenantId,
        child.id,
        child.agentInstanceId,
        transitionedAt,
      );
      transitions.push({
        id: child.id,
        parentAssignmentId,
        previousStatus: child.status,
        agentInstanceId: child.agentInstanceId,
        cancelledRunIds: cancelled.map((run) => run.id),
      });
    }
  }
  return transitions;
}

export async function disableAgentInstanceWithoutEffectiveAssignments(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  assignmentId: string,
  agentInstanceId: string,
  now: Date,
): Promise<void> {
  const remaining = await transaction.roleAssignment.count({
    where: {
      tenantId,
      agentInstanceId,
      id: { not: assignmentId },
      status: 'ACTIVE',
      effectiveFrom: { lte: now },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
      employment: { is: { status: 'ACTIVE' } },
    },
  });
  if (remaining > 0) return;
  await transaction.agentInstance.updateMany({
    where: { tenantId, id: agentInstanceId },
    data: { status: 'DISABLED' },
  });
}

function assertDelegatedScopeSubset(
  label: string,
  requested: Record<string, unknown>,
  source: Record<string, unknown>,
): void {
  if (!isDelegatedAssignmentScopeSubset(requested, source)) {
    throw new ConflictException(
      `The delegated ${label} must be equal to or narrower than its source assignment.`,
    );
  }
}

export function isDelegatedAssignmentScopeSubset(
  requested: Record<string, unknown>,
  source: Record<string, unknown>,
): boolean {
  return isRestrictionSubset(requested, source, []);
}

function isRestrictionSubset(
  requested: unknown,
  source: unknown,
  path: readonly string[],
): boolean {
  if (Array.isArray(requested)) {
    if (!Array.isArray(source)) return false;
    const sourceValues = new Set(source.map((value) => canonicalJson(value)));
    return requested.every((value) => sourceValues.has(canonicalJson(value)));
  }
  if (isJsonObject(requested)) {
    if (!isJsonObject(source)) return false;
    const requestedKeys = Object.keys(requested).sort();
    const sourceKeys = Object.keys(source).sort();
    if (canonicalJson(requestedKeys) !== canonicalJson(sourceKeys)) return false;
    return requestedKeys.every((key) =>
      isRestrictionSubset(requested[key], source[key], [...path, key]),
    );
  }
  if (typeof requested === 'boolean' && typeof source === 'boolean') {
    const key = path.at(-1);
    if (key === 'includeChildren' || key === 'includeDescendants') {
      return requested === source || (source && !requested);
    }
    if (key === 'roleOnly' || key === 'readOnly' || key === 'isolated') {
      return requested === source || (!source && requested);
    }
    if (key === 'allowWrite' || key === 'allowSharedMemory') {
      return requested === source || (source && !requested);
    }
  }
  if (
    typeof requested === 'number' &&
    typeof source === 'number' &&
    ['retentionDays', 'maxItems', 'maxBytes'].includes(path.at(-1) ?? '')
  ) {
    return requested <= source;
  }
  return canonicalJson(requested) === canonicalJson(source);
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTransitionableAssignmentStatus(
  status: string,
): status is 'PENDING' | 'ACTIVE' | 'SUSPENDED' {
  return status === 'PENDING' || status === 'ACTIVE' || status === 'SUSPENDED';
}

export async function cancelAssignedAgentRuns(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  roleAssignmentId: string,
  agentInstanceId: string,
  assignmentUserId: string,
  cancelledAt: Date,
  reason: {
    readonly errorCode?: string;
    readonly errorMessage?: string;
  } = {},
): Promise<ReadonlyArray<{ readonly id: string; readonly requiresExternalCancellation: boolean }>> {
  const activeStatuses = ['QUEUED', 'DISPATCHING', 'RUNNING', 'UNKNOWN'] as const;
  const candidateRuns = await transaction.agentRun.findMany({
    where: {
      tenantId,
      agentId: agentInstanceId,
      requesterUserId: assignmentUserId,
      status: { in: [...activeStatuses] },
      cancellationRequestedAt: null,
    },
    select: { id: true },
    orderBy: { id: 'asc' },
  });
  if (candidateRuns.length === 0) return [];

  await transaction.$queryRaw`
    SELECT pg_advisory_xact_lock(
      hashtextextended(${`${tenantId}:agent-run-quota`}, 0)
    )::text
  `;
  for (const run of candidateRuns) {
    await transaction.$queryRaw`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${`${tenantId}:agent-run:${run.id}`}, 0)
      )::text
    `;
  }

  const lockedRuns = await transaction.agentRun.findMany({
    where: {
      tenantId,
      id: { in: candidateRuns.map((run) => run.id) },
      agentId: agentInstanceId,
      requesterUserId: assignmentUserId,
      status: { in: [...activeStatuses] },
      cancellationRequestedAt: null,
    },
    select: { id: true, status: true, externalRunId: true },
    orderBy: { id: 'asc' },
  });
  const cancelledRuns: Array<{ id: string; requiresExternalCancellation: boolean }> = [];
  const cancellationEvents: Prisma.OutboxEventCreateManyInput[] = [];

  for (const run of lockedRuns) {
    const cancellationReason = reason.errorCode ?? ROLE_ASSIGNMENT_REVOKED_AGENT_RUN_ERROR_CODE;
    const requiresExternalCancellation = run.status !== 'QUEUED' || run.externalRunId !== null;
    const cancelled = await transaction.agentRun.updateMany({
      where: {
        tenantId,
        id: run.id,
        agentId: agentInstanceId,
        requesterUserId: assignmentUserId,
        status: run.status,
        externalRunId: run.externalRunId,
        cancellationRequestedAt: null,
      },
      data: {
        updatedAt: cancelledAt,
        ...(requiresExternalCancellation
          ? {
              cancellationRequestedAt: cancelledAt,
              cancellationReason,
            }
          : {
              status: 'CANCELLED' as const,
              errorCode: cancellationReason,
              errorMessage: reason.errorMessage ?? 'Role assignment was revoked.',
              finishedAt: cancelledAt,
              reservedTokens: 0,
            }),
        version: { increment: 1 },
      },
    });
    if (cancelled.count !== 1) continue;

    cancelledRuns.push({ id: run.id, requiresExternalCancellation });
    if (requiresExternalCancellation) {
      cancellationEvents.push({
        tenantId,
        aggregateType: 'agent_run',
        aggregateId: run.id,
        eventType: AGENT_RUN_CANCEL_REQUESTED_EVENT_TYPE,
        payload: {
          runId: run.id,
          roleAssignmentId,
          externalRunId: run.externalRunId,
        },
      });
    }
  }

  if (cancellationEvents.length > 0) {
    await transaction.outboxEvent.createMany({ data: cancellationEvents });
  }
  return cancelledRuns;
}

const roleAssignmentInclude = {
  user: { select: { id: true, displayName: true, status: true } },
  employment: {
    select: {
      id: true,
      organizationId: true,
      orgUnitId: true,
      positionId: true,
      status: true,
    },
  },
  agentInstance: {
    include: {
      version: {
        include: { template: { select: { id: true, key: true, name: true } } },
      },
    },
  },
  createdBy: { select: { id: true, displayName: true } },
  revokedBy: { select: { id: true, displayName: true } },
} satisfies Prisma.RoleAssignmentInclude;

function mapRoleAssignment(record: RoleAssignmentRecord): RoleAssignment {
  return {
    id: record.id,
    key: record.key,
    idempotencyKey: record.idempotencyKey,
    version: record.version,
    status: record.status,
    source: record.source,
    effectiveFrom: record.effectiveFrom.toISOString(),
    effectiveTo: record.effectiveTo?.toISOString() ?? null,
    organizationScope: jsonRecord(record.organizationScope),
    permissionScope: jsonRecord(record.permissionScope),
    memoryPolicy: jsonRecord(record.memoryPolicy),
    delegatedFromAssignmentId: record.delegatedFromAssignmentId,
    roleTemplateId: record.roleTemplateId,
    roleVersionId: record.roleVersionId,
    roleDefinitionSnapshot: parseRoleDefinitionSnapshot(
      record.agentInstance.version.roleDefinitionSnapshot,
    ),
    blueprintRevision: record.agentInstance.version.blueprintRevision,
    assignee: record.user,
    employment: record.employment,
    agent: {
      id: record.agentInstance.id,
      name: record.agentInstance.name,
      status: record.agentInstance.status,
      versionId: record.agentInstance.versionId,
      version: record.agentInstance.version.version,
      versionStatus: record.agentInstance.version.status,
      template: record.agentInstance.version.template,
    },
    createdBy: record.createdBy,
    revokedAt: record.revokedAt?.toISOString() ?? null,
    revokedBy: record.revokedBy,
    revokeReason: record.revokeReason,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

function normalizedAssignmentKey(
  templateKey: string,
  userId: string,
  assignmentId: string,
): string {
  const template = templateKey
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70);
  return `asg:${template || 'role'}:${userId.slice(0, 8)}:${assignmentId.slice(0, 8)}`;
}

function roleAssignmentRequestHash(request: CreateRoleAssignmentRequest): string {
  const canonical = canonicalJson({
    key: request.key ?? null,
    userId: request.userId,
    employmentId: request.employmentId,
    agentVersionId: request.agentVersionId,
    agentName: request.agentName ?? null,
    effectiveFrom: new Date(request.effectiveFrom).toISOString(),
    effectiveTo:
      request.effectiveTo === undefined || request.effectiveTo === null
        ? null
        : new Date(request.effectiveTo).toISOString(),
    source: request.source,
    delegatedFromAssignmentId: request.delegatedFromAssignmentId ?? null,
    organizationScope: request.organizationScope,
    permissionScope: request.permissionScope,
    memoryPolicy: request.memoryPolicy,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function toJsonObject(value: Record<string, unknown>): Prisma.InputJsonObject {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonObject;
}

function jsonRecord(value: Prisma.JsonValue): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function parseRoleDefinitionSnapshot(
  value: Prisma.JsonValue,
): RoleAssignment['roleDefinitionSnapshot'] {
  const parsed = roleDefinitionSnapshotSchema.safeParse(jsonRecord(value));
  return parsed.success ? parsed.data : null;
}
