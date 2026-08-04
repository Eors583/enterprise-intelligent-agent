import { randomUUID } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  CreateRoleBlueprintRequest,
  CreateRoleVersionDraftRequest,
  PublishRoleVersionRequest,
  ReviewRoleVersionRequest,
  RoleAssignmentCandidateListResponse,
  RoleBlueprint,
  RoleBlueprintListResponse,
  RoleDefinitionSnapshot,
  RoleVersion,
  RoleVersionTransitionRequest,
  RollbackRoleVersionRequest,
  UpdateRoleBlueprintRequest,
  UpdateRoleVersionDraftRequest,
} from '@enterprise/contracts';
import { roleDefinitionSnapshotSchema, roleKnowledgeScopeSchema } from '@enterprise/contracts';
import { Prisma } from '@prisma/client';

import { AdminPrismaService } from '../../database/admin-prisma.service.js';
import { AiEvaluationService } from '../ai-evaluation/ai-evaluation.service.js';
import { AdminAccessService, type AdminPrincipal } from './admin-access.service.js';
import { recordAdminAudit } from './admin-audit.js';

type BlueprintRecord = Prisma.AgentTemplateGetPayload<{
  include: typeof roleBlueprintInclude;
}>;
type VersionRecord = Prisma.AgentVersionGetPayload<Record<string, never>>;

@Injectable()
export class RoleBlueprintAdminService {
  constructor(
    @Inject(AdminPrismaService) private readonly prisma: AdminPrismaService,
    @Inject(AdminAccessService) private readonly access: AdminAccessService,
    @Inject(AiEvaluationService) private readonly evaluations: AiEvaluationService,
  ) {}

  async list(): Promise<RoleBlueprintListResponse> {
    const principal = this.access.requireDirectoryWrite();
    return this.prisma.withTenant(principal.tenantId, async (transaction) => ({
      items: (
        await transaction.agentTemplate.findMany({
          // Legacy prompt-only templates intentionally remain assignable, but are
          // not exposed as structured Role Blueprints until an administrator
          // upgrades them with the required blueprint fields.
          where: { tenantId: principal.tenantId, mission: { not: '' } },
          include: roleBlueprintInclude,
          orderBy: [{ name: 'asc' }, { id: 'asc' }],
        })
      ).map(mapBlueprint),
    }));
  }

  async listAssignmentCandidates(): Promise<RoleAssignmentCandidateListResponse> {
    const principal = this.access.requireDirectoryWrite();
    return this.prisma.withTenant(principal.tenantId, async (transaction) => {
      const versions = await transaction.agentVersion.findMany({
        where: {
          tenantId: principal.tenantId,
          status: 'PUBLISHED',
          reviewStatus: 'APPROVED',
          template: { is: { mission: { not: '' } } },
        },
        include: {
          template: { select: { id: true, key: true, name: true } },
        },
        orderBy: [{ template: { name: 'asc' } }, { version: 'desc' }, { id: 'asc' }],
      });
      return {
        items: versions.flatMap((version) => {
          const snapshot = roleDefinitionSnapshotSchema.safeParse(
            jsonRecord(version.roleDefinitionSnapshot),
          );
          if (
            !snapshot.success ||
            version.blueprintRevision <= 0 ||
            version.createdById === null ||
            version.approvedById === null ||
            version.createdById === version.approvedById ||
            version.reviewRequestedById === null ||
            version.reviewedById === null ||
            version.reviewRequestedById === version.reviewedById
          ) {
            return [];
          }
          return [
            {
              id: version.id,
              version: version.version,
              blueprintRevision: version.blueprintRevision,
              roleDefinitionSnapshot: snapshot.data,
              blueprint: version.template,
            },
          ];
        }),
      };
    });
  }

  async create(request: CreateRoleBlueprintRequest): Promise<RoleBlueprint> {
    const principal = this.access.requireDirectoryWrite();
    try {
      return await this.prisma.withTenant(principal.tenantId, async (transaction) => {
        const id = randomUUID();
        await transaction.agentTemplate.create({
          data: {
            id,
            tenantId: principal.tenantId,
            key: request.key,
            name: request.name,
            description: request.description ?? null,
            ...structuredRoleData(request),
          },
        });
        await recordAdminAudit(
          transaction,
          principal,
          'admin.role_blueprint.created',
          'role_blueprint',
          id,
          { key: request.key, revision: 1 },
        );
        return mapBlueprint(
          await transaction.agentTemplate.findFirstOrThrow({
            where: { tenantId: principal.tenantId, id },
            include: roleBlueprintInclude,
          }),
        );
      });
    } catch (error) {
      if (isUniqueConflict(error)) {
        throw new ConflictException('A Role Blueprint with this key already exists.');
      }
      throw error;
    }
  }

  async update(id: string, request: UpdateRoleBlueprintRequest): Promise<RoleBlueprint> {
    const principal = this.access.requireDirectoryWrite();
    return this.prisma.withTenant(principal.tenantId, async (transaction) => {
      await lockBlueprint(transaction, principal.tenantId, id);
      const current = await transaction.agentTemplate.findFirst({
        where: { tenantId: principal.tenantId, id },
        select: { id: true, revision: true },
      });
      if (current === null) throw blueprintNotFound();
      if (current.revision !== request.expectedRevision) throw staleBlueprint();

      const updated = await transaction.agentTemplate.updateMany({
        where: { tenantId: principal.tenantId, id, revision: request.expectedRevision },
        data: {
          ...(request.name === undefined ? {} : { name: request.name }),
          ...(request.description === undefined ? {} : { description: request.description }),
          ...(request.mission === undefined ? {} : { mission: request.mission }),
          ...(request.responsibilities === undefined
            ? {}
            : { responsibilities: jsonValue(request.responsibilities) }),
          ...(request.valueDefinition === undefined
            ? {}
            : { valueDefinition: jsonValue(request.valueDefinition) }),
          ...(request.capabilities === undefined
            ? {}
            : { capabilities: jsonValue(request.capabilities) }),
          ...(request.processes === undefined ? {} : { processes: jsonValue(request.processes) }),
          ...(request.tools === undefined ? {} : { tools: jsonValue(request.tools) }),
          ...(request.knowledgeDomains === undefined
            ? {}
            : { knowledgeDomains: jsonValue(request.knowledgeDomains) }),
          revision: { increment: 1 },
        },
      });
      if (updated.count !== 1) throw staleBlueprint();
      await recordAdminAudit(
        transaction,
        principal,
        'admin.role_blueprint.updated',
        'role_blueprint',
        id,
        { previousRevision: request.expectedRevision, revision: request.expectedRevision + 1 },
      );
      return mapBlueprint(
        await transaction.agentTemplate.findFirstOrThrow({
          where: { tenantId: principal.tenantId, id },
          include: roleBlueprintInclude,
        }),
      );
    });
  }

  async createDraft(
    blueprintId: string,
    request: CreateRoleVersionDraftRequest,
  ): Promise<RoleVersion> {
    const principal = this.access.requireDirectoryWrite();
    return this.prisma.withTenant(principal.tenantId, async (transaction) => {
      await lockBlueprint(transaction, principal.tenantId, blueprintId);
      const blueprint = await transaction.agentTemplate.findFirst({
        where: { tenantId: principal.tenantId, id: blueprintId },
        select: roleDefinitionSelect,
      });
      if (blueprint === null) throw blueprintNotFound();
      const roleDefinitionSnapshot = snapshotRoleDefinition(blueprint);
      const knowledgeScope = await validatedKnowledgeScope(
        transaction,
        principal.tenantId,
        request.knowledgeScope,
      );
      const latest = await transaction.agentVersion.findFirst({
        where: { tenantId: principal.tenantId, templateId: blueprintId },
        select: { version: true },
        orderBy: { version: 'desc' },
      });
      const version = await transaction.agentVersion.create({
        data: {
          tenantId: principal.tenantId,
          templateId: blueprintId,
          version: (latest?.version ?? 0) + 1,
          status: 'DRAFT',
          reviewStatus: 'NOT_SUBMITTED',
          systemPrompt: request.systemPrompt,
          modelPolicy: jsonObject(request.modelPolicy),
          toolPolicy: jsonObject(request.toolPolicy),
          knowledgeScope,
          roleDefinitionSnapshot: jsonValue(roleDefinitionSnapshot),
          blueprintRevision: blueprint.revision,
          changeSummary: request.changeSummary,
          createdById: principal.userId,
        },
      });
      await auditVersion(transaction, principal, 'admin.role_version.draft_created', version);
      return mapVersion(version);
    });
  }

  async updateDraft(
    blueprintId: string,
    versionId: string,
    request: UpdateRoleVersionDraftRequest,
  ): Promise<RoleVersion> {
    const principal = this.access.requireDirectoryWrite();
    return this.prisma.withTenant(principal.tenantId, async (transaction) => {
      await lockBlueprint(transaction, principal.tenantId, blueprintId);
      const current = await findVersion(transaction, principal.tenantId, blueprintId, versionId);
      if (current.status !== 'DRAFT') {
        throw new ConflictException('Only a draft Role Version can be edited.');
      }
      assertVersionRevision(current, request.expectedRevision);
      const knowledgeScope =
        request.knowledgeScope === undefined
          ? undefined
          : await validatedKnowledgeScope(transaction, principal.tenantId, request.knowledgeScope);
      const updated = await transaction.agentVersion.updateMany({
        where: {
          tenantId: principal.tenantId,
          templateId: blueprintId,
          id: versionId,
          status: 'DRAFT',
          revision: request.expectedRevision,
        },
        data: {
          ...(request.systemPrompt === undefined ? {} : { systemPrompt: request.systemPrompt }),
          ...(request.modelPolicy === undefined
            ? {}
            : { modelPolicy: jsonObject(request.modelPolicy) }),
          ...(request.toolPolicy === undefined
            ? {}
            : { toolPolicy: jsonObject(request.toolPolicy) }),
          ...(knowledgeScope === undefined ? {} : { knowledgeScope }),
          ...(request.changeSummary === undefined ? {} : { changeSummary: request.changeSummary }),
          reviewStatus: 'NOT_SUBMITTED',
          reviewRequestedAt: null,
          reviewRequestedById: null,
          reviewedAt: null,
          reviewedById: null,
          reviewComment: null,
          approvedAt: null,
          approvedById: null,
          revision: { increment: 1 },
        },
      });
      if (updated.count !== 1) throw staleVersion();
      const version = await findVersion(transaction, principal.tenantId, blueprintId, versionId);
      await auditVersion(transaction, principal, 'admin.role_version.draft_updated', version);
      return mapVersion(version);
    });
  }

  async submit(
    blueprintId: string,
    versionId: string,
    request: RoleVersionTransitionRequest,
  ): Promise<RoleVersion> {
    const principal = this.access.requireDirectoryWrite();
    return this.prisma.withTenant(principal.tenantId, async (transaction) => {
      await lockBlueprint(transaction, principal.tenantId, blueprintId);
      const current = await findVersion(transaction, principal.tenantId, blueprintId, versionId);
      if (current.status !== 'DRAFT') {
        throw new ConflictException('Only a draft Role Version can be submitted for review.');
      }
      assertVersionRevision(current, request.expectedRevision);
      await validatedKnowledgeScope(
        transaction,
        principal.tenantId,
        jsonRecord(current.knowledgeScope),
      );
      const now = new Date();
      const updated = await transaction.agentVersion.updateMany({
        where: versionCas(principal.tenantId, blueprintId, versionId, request.expectedRevision),
        data: {
          status: 'TESTING',
          reviewStatus: 'IN_REVIEW',
          reviewRequestedAt: now,
          reviewRequestedById: principal.userId,
          reviewedAt: null,
          reviewedById: null,
          reviewComment: null,
          approvedAt: null,
          approvedById: null,
          revision: { increment: 1 },
        },
      });
      if (updated.count !== 1) throw staleVersion();
      const version = await findVersion(transaction, principal.tenantId, blueprintId, versionId);
      await auditVersion(transaction, principal, 'admin.role_version.review_requested', version);
      return mapVersion(version);
    });
  }

  async review(
    blueprintId: string,
    versionId: string,
    request: ReviewRoleVersionRequest,
  ): Promise<RoleVersion> {
    const principal = this.access.requireDirectoryWrite();
    return this.prisma.withTenant(principal.tenantId, async (transaction) => {
      await lockBlueprint(transaction, principal.tenantId, blueprintId);
      const current = await findVersion(transaction, principal.tenantId, blueprintId, versionId);
      if (current.status !== 'TESTING' || current.reviewStatus !== 'IN_REVIEW') {
        throw new ConflictException('Only an in-review Role Version can be reviewed.');
      }
      assertVersionRevision(current, request.expectedRevision);
      if (
        current.createdById === principal.userId ||
        current.reviewRequestedById === principal.userId
      ) {
        throw new ForbiddenException(
          'A Role Version author or review requester cannot review their own submission.',
        );
      }
      const now = new Date();
      const approved = request.decision === 'APPROVE';
      const updated = await transaction.agentVersion.updateMany({
        where: versionCas(principal.tenantId, blueprintId, versionId, request.expectedRevision),
        data: {
          status: approved ? 'TESTING' : 'DRAFT',
          reviewStatus: approved ? 'APPROVED' : 'CHANGES_REQUESTED',
          reviewedAt: now,
          reviewedById: principal.userId,
          reviewComment: request.comment,
          approvedAt: approved ? now : null,
          approvedById: approved ? principal.userId : null,
          revision: { increment: 1 },
        },
      });
      if (updated.count !== 1) throw staleVersion();
      const version = await findVersion(transaction, principal.tenantId, blueprintId, versionId);
      await auditVersion(
        transaction,
        principal,
        approved ? 'admin.role_version.approved' : 'admin.role_version.changes_requested',
        version,
      );
      return mapVersion(version);
    });
  }

  async publish(
    blueprintId: string,
    versionId: string,
    request: PublishRoleVersionRequest,
  ): Promise<RoleVersion> {
    const principal = this.access.requireDirectoryWrite();
    const candidate = await this.prisma.withTenant(principal.tenantId, (transaction) =>
      findVersion(transaction, principal.tenantId, blueprintId, versionId),
    );
    if (candidate.status !== 'TESTING' || candidate.reviewStatus !== 'APPROVED') {
      throw new ConflictException('Only an approved Role Version can be published.');
    }
    assertVersionRevision(candidate, request.expectedRevision);
    const readiness = await this.evaluations.requireReferencedRunReady({
      evaluationRunId: request.evaluationRunId,
      subjectType: 'AGENT_VERSION',
      subjectId: versionId,
      subjectVersion: candidate.version,
    });
    return this.prisma.withTenant(principal.tenantId, async (transaction) => {
      await lockBlueprint(transaction, principal.tenantId, blueprintId);
      const current = await findVersion(transaction, principal.tenantId, blueprintId, versionId);
      if (current.status !== 'TESTING' || current.reviewStatus !== 'APPROVED') {
        throw new ConflictException('Only an approved Role Version can be published.');
      }
      assertVersionRevision(current, request.expectedRevision);
      await validatedKnowledgeScope(
        transaction,
        principal.tenantId,
        jsonRecord(current.knowledgeScope),
      );
      const now = new Date();
      await retirePublishedVersions(transaction, principal, blueprintId, now, versionId);
      const updated = await transaction.agentVersion.updateMany({
        where: versionCas(principal.tenantId, blueprintId, versionId, request.expectedRevision),
        data: {
          status: 'PUBLISHED',
          publishedAt: now,
          publishedById: principal.userId,
          evaluationRunId: request.evaluationRunId,
          evaluationDatasetVersionId: readiness.datasetVersionId,
          evaluationSnapshotHash: readiness.currentSnapshotHash,
          retiredAt: null,
          retiredById: null,
          revision: { increment: 1 },
        },
      });
      if (updated.count !== 1) throw staleVersion();
      const version = await findVersion(transaction, principal.tenantId, blueprintId, versionId);
      const rolledOut = await transaction.agentInstance.updateMany({
        where: {
          tenantId: principal.tenantId,
          version: { is: { templateId: blueprintId } },
        },
        data: { versionId },
      });
      await auditVersion(transaction, principal, 'admin.role_version.published', version);
      await recordAdminAudit(
        transaction,
        principal,
        'admin.role_version.rollout_completed',
        'agent_version',
        version.id,
        { agentInstanceCount: rolledOut.count },
      );
      return mapVersion(version);
    });
  }

  async retire(
    blueprintId: string,
    versionId: string,
    request: RoleVersionTransitionRequest,
  ): Promise<RoleVersion> {
    const principal = this.access.requireDirectoryWrite();
    return this.prisma.withTenant(principal.tenantId, async (transaction) => {
      await lockBlueprint(transaction, principal.tenantId, blueprintId);
      const current = await findVersion(transaction, principal.tenantId, blueprintId, versionId);
      if (current.status !== 'PUBLISHED') {
        throw new ConflictException('Only a published Role Version can be retired.');
      }
      assertVersionRevision(current, request.expectedRevision);
      const pinnedAssignments = await transaction.roleAssignment.count({
        where: {
          tenantId: principal.tenantId,
          roleTemplateId: blueprintId,
          roleVersionId: versionId,
          status: { in: ['PENDING', 'ACTIVE', 'SUSPENDED'] },
        },
      });
      if (pinnedAssignments > 0) {
        throw new ConflictException(
          `This Role Version still has ${pinnedAssignments} current or scheduled assignment(s). Revoke or migrate them before retiring it.`,
        );
      }
      const now = new Date();
      const updated = await transaction.agentVersion.updateMany({
        where: versionCas(principal.tenantId, blueprintId, versionId, request.expectedRevision),
        data: {
          status: 'RETIRED',
          retiredAt: now,
          retiredById: principal.userId,
          revision: { increment: 1 },
        },
      });
      if (updated.count !== 1) throw staleVersion();
      const version = await findVersion(transaction, principal.tenantId, blueprintId, versionId);
      await auditVersion(transaction, principal, 'admin.role_version.retired', version);
      return mapVersion(version);
    });
  }

  async rollback(
    blueprintId: string,
    sourceVersionId: string,
    request: RollbackRoleVersionRequest,
  ): Promise<RoleVersion> {
    const principal = this.access.requireDirectoryWrite();
    return this.prisma.withTenant(principal.tenantId, async (transaction) => {
      await lockBlueprint(transaction, principal.tenantId, blueprintId);
      const source = await findVersion(
        transaction,
        principal.tenantId,
        blueprintId,
        sourceVersionId,
      );
      if (source.status === 'DRAFT' || source.status === 'TESTING') {
        throw new ConflictException('A draft or testing Role Version cannot be a rollback source.');
      }
      const currentPublished = await transaction.agentVersion.findFirst({
        where: {
          tenantId: principal.tenantId,
          templateId: blueprintId,
          status: 'PUBLISHED',
        },
        orderBy: [{ publishedAt: 'desc' }, { version: 'desc' }],
      });
      if ((currentPublished?.id ?? null) !== request.expectedPublishedVersionId) {
        throw new ConflictException('The published Role Version changed. Refresh and try again.');
      }
      const latest = await transaction.agentVersion.findFirst({
        where: { tenantId: principal.tenantId, templateId: blueprintId },
        select: { version: true },
        orderBy: { version: 'desc' },
      });
      const rollback = await transaction.agentVersion.create({
        data: {
          tenantId: principal.tenantId,
          templateId: blueprintId,
          version: (latest?.version ?? 0) + 1,
          status: 'DRAFT',
          reviewStatus: 'NOT_SUBMITTED',
          systemPrompt: source.systemPrompt,
          modelPolicy: source.modelPolicy as Prisma.InputJsonObject,
          toolPolicy: source.toolPolicy as Prisma.InputJsonObject,
          knowledgeScope: source.knowledgeScope as Prisma.InputJsonObject,
          roleDefinitionSnapshot: source.roleDefinitionSnapshot as Prisma.InputJsonObject,
          blueprintRevision: source.blueprintRevision,
          changeSummary: request.changeSummary,
          createdById: principal.userId,
          rollbackOfVersionId: source.id,
        },
      });
      await auditVersion(
        transaction,
        principal,
        'admin.role_version.rollback_draft_created',
        rollback,
        {
          sourceVersionId: source.id,
          currentPublishedVersionId: currentPublished?.id ?? null,
        },
      );
      return mapVersion(rollback);
    });
  }
}

const roleBlueprintInclude = {
  versions: { orderBy: { version: 'desc' as const } },
} satisfies Prisma.AgentTemplateInclude;

const roleDefinitionSelect = {
  id: true,
  mission: true,
  responsibilities: true,
  valueDefinition: true,
  capabilities: true,
  processes: true,
  tools: true,
  knowledgeDomains: true,
  revision: true,
} satisfies Prisma.AgentTemplateSelect;

function structuredRoleData(request: CreateRoleBlueprintRequest): {
  mission: string;
  responsibilities: Prisma.InputJsonValue;
  valueDefinition: Prisma.InputJsonValue;
  capabilities: Prisma.InputJsonValue;
  processes: Prisma.InputJsonValue;
  tools: Prisma.InputJsonValue;
  knowledgeDomains: Prisma.InputJsonValue;
} {
  return {
    mission: request.mission,
    responsibilities: jsonValue(request.responsibilities),
    valueDefinition: jsonValue(request.valueDefinition),
    capabilities: jsonValue(request.capabilities),
    processes: jsonValue(request.processes),
    tools: jsonValue(request.tools),
    knowledgeDomains: jsonValue(request.knowledgeDomains),
  };
}

function snapshotRoleDefinition(
  blueprint: Prisma.AgentTemplateGetPayload<{ select: typeof roleDefinitionSelect }>,
): RoleDefinitionSnapshot {
  const parsed = roleDefinitionSnapshotSchema.safeParse({
    mission: blueprint.mission,
    responsibilities: jsonArray(blueprint.responsibilities),
    valueDefinition: jsonRecord(blueprint.valueDefinition),
    capabilities: jsonArray(blueprint.capabilities),
    processes: jsonArray(blueprint.processes),
    tools: jsonArray(blueprint.tools),
    knowledgeDomains: jsonArray(blueprint.knowledgeDomains),
  });
  if (!parsed.success) {
    throw new ConflictException(
      'A Role Version can only be drafted from a complete structured Role Blueprint.',
    );
  }
  return parsed.data;
}

async function lockBlueprint(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  blueprintId: string,
): Promise<void> {
  await transaction.$queryRaw`
    SELECT pg_advisory_xact_lock(
      hashtextextended(${`${tenantId}:role-blueprint:${blueprintId}`}, 0)
    )::text
  `;
}

async function findVersion(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  blueprintId: string,
  versionId: string,
): Promise<VersionRecord> {
  const version = await transaction.agentVersion.findFirst({
    where: { tenantId, templateId: blueprintId, id: versionId },
  });
  if (version === null) throw new NotFoundException('The Role Version was not found.');
  return version;
}

function versionCas(
  tenantId: string,
  templateId: string,
  id: string,
  revision: number,
): Prisma.AgentVersionWhereInput {
  return { tenantId, templateId, id, revision };
}

function assertVersionRevision(version: VersionRecord, expectedRevision: number): void {
  if (version.revision !== expectedRevision) throw staleVersion();
}

async function retirePublishedVersions(
  transaction: Prisma.TransactionClient,
  principal: AdminPrincipal,
  blueprintId: string,
  retiredAt: Date,
  exceptVersionId?: string,
): Promise<void> {
  await transaction.agentVersion.updateMany({
    where: {
      tenantId: principal.tenantId,
      templateId: blueprintId,
      status: 'PUBLISHED',
      ...(exceptVersionId === undefined ? {} : { id: { not: exceptVersionId } }),
    },
    data: {
      status: 'RETIRED',
      retiredAt,
      retiredById: principal.userId,
      revision: { increment: 1 },
    },
  });
}

async function auditVersion(
  transaction: Prisma.TransactionClient,
  principal: AdminPrincipal,
  action: string,
  version: VersionRecord,
  extra: Prisma.InputJsonObject = {},
): Promise<void> {
  await recordAdminAudit(transaction, principal, action, 'role_version', version.id, {
    blueprintId: version.templateId,
    version: version.version,
    revision: version.revision,
    status: version.status,
    reviewStatus: version.reviewStatus,
    ...extra,
  });
}

function mapBlueprint(record: BlueprintRecord): RoleBlueprint {
  return {
    id: record.id,
    key: record.key,
    name: record.name,
    description: record.description,
    mission: record.mission,
    responsibilities: jsonArray(record.responsibilities) as RoleBlueprint['responsibilities'],
    valueDefinition: jsonRecord(record.valueDefinition) as RoleBlueprint['valueDefinition'],
    capabilities: jsonArray(record.capabilities) as RoleBlueprint['capabilities'],
    processes: jsonArray(record.processes) as RoleBlueprint['processes'],
    tools: jsonArray(record.tools) as RoleBlueprint['tools'],
    knowledgeDomains: jsonArray(record.knowledgeDomains) as RoleBlueprint['knowledgeDomains'],
    revision: record.revision,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    versions: record.versions.map(mapVersion),
  };
}

function mapVersion(version: VersionRecord): RoleVersion {
  return {
    id: version.id,
    templateId: version.templateId,
    version: version.version,
    status: version.status,
    reviewStatus: version.reviewStatus,
    systemPrompt: version.systemPrompt,
    modelPolicy: jsonRecord(version.modelPolicy),
    toolPolicy: jsonRecord(version.toolPolicy),
    knowledgeScope: parseKnowledgeScope(version.knowledgeScope),
    roleDefinitionSnapshot: parseRoleDefinitionSnapshot(version.roleDefinitionSnapshot),
    blueprintRevision: version.blueprintRevision,
    changeSummary: version.changeSummary,
    revision: version.revision,
    createdById: version.createdById,
    reviewRequestedAt: iso(version.reviewRequestedAt),
    reviewRequestedById: version.reviewRequestedById,
    reviewedAt: iso(version.reviewedAt),
    reviewedById: version.reviewedById,
    reviewComment: version.reviewComment,
    approvedAt: iso(version.approvedAt),
    approvedById: version.approvedById,
    publishedAt: iso(version.publishedAt),
    publishedById: version.publishedById,
    evaluationRunId: version.evaluationRunId,
    evaluationDatasetVersionId: version.evaluationDatasetVersionId,
    evaluationSnapshotHash: version.evaluationSnapshotHash,
    retiredAt: iso(version.retiredAt),
    retiredById: version.retiredById,
    rollbackOfVersionId: version.rollbackOfVersionId,
    createdAt: version.createdAt.toISOString(),
  };
}

function blueprintNotFound(): NotFoundException {
  return new NotFoundException('The Role Blueprint was not found.');
}

function staleBlueprint(): ConflictException {
  return new ConflictException('The Role Blueprint changed. Refresh and try again.');
}

function staleVersion(): ConflictException {
  return new ConflictException('The Role Version changed. Refresh and try again.');
}

function isUniqueConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function jsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function jsonObject(value: Record<string, unknown>): Prisma.InputJsonObject {
  return jsonValue(value) as Prisma.InputJsonObject;
}

async function validatedKnowledgeScope(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  value: Record<string, unknown>,
): Promise<Prisma.InputJsonObject> {
  const scope = jsonObject(value);
  const rawIds = value.knowledgeBaseIds;
  if (rawIds === undefined) return { ...scope, knowledgeBaseIds: [] };
  if (
    !Array.isArray(rawIds) ||
    rawIds.length > 50 ||
    rawIds.some((id) => typeof id !== 'string' || !UUID_PATTERN.test(id))
  ) {
    throw new BadRequestException('Knowledge scope must contain valid knowledge base selections.');
  }
  const knowledgeBaseIds = [...new Set(rawIds)].sort();
  if (knowledgeBaseIds.length > 0) {
    const active = await transaction.knowledgeBase.findMany({
      where: { tenantId, id: { in: knowledgeBaseIds }, status: 'ACTIVE' },
      select: { id: true },
    });
    if (active.length !== knowledgeBaseIds.length) {
      throw new ConflictException(
        'Knowledge scope contains a missing, inactive, or cross-tenant knowledge base.',
      );
    }
  }
  return { ...scope, knowledgeBaseIds };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function jsonRecord(value: Prisma.JsonValue): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function parseRoleDefinitionSnapshot(
  value: Prisma.JsonValue,
): RoleVersion['roleDefinitionSnapshot'] {
  const parsed = roleDefinitionSnapshotSchema.safeParse(jsonRecord(value));
  return parsed.success ? parsed.data : null;
}

function parseKnowledgeScope(
  value: Prisma.JsonValue,
): Record<string, unknown> & { knowledgeBaseIds: string[] } {
  const parsed = roleKnowledgeScopeSchema.safeParse(jsonRecord(value));
  if (!parsed.success) return { knowledgeBaseIds: [] };
  return {
    ...parsed.data,
    knowledgeBaseIds: parsed.data.knowledgeBaseIds ?? [],
  };
}

function jsonArray(value: Prisma.JsonValue): unknown[] {
  if (!Array.isArray(value)) return [];
  return JSON.parse(JSON.stringify(value)) as unknown[];
}

function iso(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}
