import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  textMessageContentSchema,
  type KnowledgeCitationDetail,
  type TenantRole,
} from '@enterprise/contracts';

import { PrismaService } from '../../database/prisma.service.js';
import { hasRoleAgentAssignmentMarker } from '../agent-control/domain/role-agent-assignment.policy.js';
import { readPolicySnapshotAssignmentId } from '../agent-run/domain/agent-run-policy-snapshot.js';
import { AuthorizationDecisionService } from '../authorization/authorization-decision.service.js';
import type { AuthorizationAssignment } from '../authorization/authorization.types.js';
import { IdentityService } from '../identity/application/identity.service.js';
import { accessibleKnowledgeBaseIds } from './knowledge-access.policy.js';
import {
  filterKnowledgeBasesByAssignmentOrganization,
  resolveOrganizationAuthorization,
} from './knowledge-retrieval.service.js';
import {
  knowledgeFiltersFromDecision,
  knowledgeVersionResourcePolicyAllowed,
} from './knowledge-resource-authorization.js';

type Transaction = Prisma.TransactionClient;

@Injectable()
export class KnowledgeCitationService {
  constructor(
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuthorizationDecisionService)
    private readonly authorization: AuthorizationDecisionService,
  ) {}

  async getOriginal(
    messageId: string,
    documentVersionId: string,
    chunkId: string,
  ): Promise<KnowledgeCitationDetail> {
    const { user } = await this.identity.getCurrentIdentity();
    const result = await this.prisma.withTenant(user.tenantId, async (transaction) => {
      const [storedUser, employments, orgUnits, message, chunk] = await Promise.all([
        transaction.user.findFirst({
          where: { tenantId: user.tenantId, id: user.id },
          select: { status: true, role: true },
        }),
        transaction.employment.findMany({
          where: { tenantId: user.tenantId, userId: user.id, status: 'ACTIVE' },
          select: { orgUnitId: true },
        }),
        transaction.orgUnit.findMany({
          where: { tenantId: user.tenantId, status: 'ACTIVE' },
          select: { id: true, parentId: true, organizationId: true },
        }),
        transaction.message.findFirst({
          where: { tenantId: user.tenantId, id: messageId },
          select: {
            id: true,
            tenantId: true,
            conversationId: true,
            senderType: true,
            senderAgentId: true,
            content: true,
            outputAgentRuns: {
              where: { status: 'SUCCEEDED' },
              take: 2,
              select: {
                id: true,
                tenantId: true,
                taskId: true,
                conversationId: true,
                outputMessageId: true,
                requesterUserId: true,
                agentId: true,
                policySnapshot: true,
                agent: {
                  select: {
                    tenantId: true,
                    ownerUserId: true,
                    settings: true,
                    _count: { select: { roleAssignments: true } },
                  },
                },
                conversation: {
                  select: {
                    participants: {
                      where: { leftAt: null },
                      select: { type: true, userId: true, agentId: true },
                    },
                  },
                },
              },
            },
          },
        }),
        transaction.knowledgeChunk.findFirst({
          where: {
            tenantId: user.tenantId,
            id: chunkId,
            documentVersionId,
          },
          select: {
            id: true,
            tenantId: true,
            knowledgeBaseId: true,
            documentId: true,
            documentVersionId: true,
            headingPath: true,
            content: true,
            metadata: true,
            knowledgeBase: {
              select: {
                id: true,
                tenantId: true,
                name: true,
                status: true,
                orgUnits: { select: { orgUnitId: true, includeChildren: true } },
              },
            },
            document: {
              select: {
                id: true,
                tenantId: true,
                knowledgeBaseId: true,
                title: true,
                status: true,
              },
            },
            documentVersion: {
              select: {
                id: true,
                tenantId: true,
                knowledgeBaseId: true,
                documentId: true,
                versionNumber: true,
                sourceType: true,
                status: true,
                createdAt: true,
                createdById: true,
                publishedAt: true,
                governanceOwnerUserId: true,
                classification: true,
                scopeMode: true,
                organizationScopeIds: true,
                projectScopeIds: true,
                taskScopeIds: true,
                roleTemplateScopeIds: true,
                dataLabels: true,
                effectiveFrom: true,
                expiresAt: true,
                retentionUntil: true,
                retentionAction: true,
                supersedesVersionId: true,
                governanceReviewStatus: true,
                governanceHash: true,
              },
            },
          },
        }),
      ]);

      const run = message?.outputAgentRuns[0];
      const parsedContent =
        message === null ? null : textMessageContentSchema.safeParse(message.content);
      const citationBound =
        parsedContent?.success === true &&
        parsedContent.data.citations?.some(
          (citation) =>
            citation.verificationStatus === 'LINEAGE_VERIFIED' &&
            citation.documentVersionId === documentVersionId &&
            citation.chunkId === chunkId,
        ) === true;
      const activeParticipants = run?.conversation.participants ?? [];
      const currentUserIsParticipant = activeParticipants.some(
        (participant) => participant.type === 'USER' && participant.userId === user.id,
      );
      const runAgentIsParticipant =
        run !== undefined &&
        activeParticipants.some(
          (participant) => participant.type === 'AGENT' && participant.agentId === run.agentId,
        );

      if (
        storedUser?.status !== 'ACTIVE' ||
        message === null ||
        chunk === null ||
        run === undefined ||
        message.outputAgentRuns.length !== 1 ||
        message.tenantId !== user.tenantId ||
        message.senderType !== 'AGENT' ||
        message.senderAgentId !== run.agentId ||
        message.conversationId !== run.conversationId ||
        run.tenantId !== user.tenantId ||
        run.agent.tenantId !== user.tenantId ||
        run.outputMessageId !== message.id ||
        run.requesterUserId !== user.id ||
        !currentUserIsParticipant ||
        !runAgentIsParticipant ||
        !citationBound
      ) {
        await this.auditDenied(transaction, user.tenantId, user.id, messageId, 'BINDING_INVALID');
        return null;
      }

      const assignmentRequired =
        hasRoleAgentAssignmentMarker(run.agent.settings) || run.agent._count.roleAssignments > 0;
      const assignmentId = readPolicySnapshotAssignmentId(run.policySnapshot);
      if (assignmentRequired !== (assignmentId !== null)) {
        await this.auditDenied(
          transaction,
          user.tenantId,
          user.id,
          messageId,
          'ASSIGNMENT_BINDING_INVALID',
        );
        return null;
      }

      const assignment =
        assignmentId === null
          ? null
          : await this.loadCurrentAssignment(
              transaction,
              user.tenantId,
              user.id,
              run.agentId,
              assignmentId,
            );
      const participantUserIds = activeParticipants
        .filter((participant) => participant.type === 'USER')
        .map((participant) => participant.userId)
        .filter((participantUserId): participantUserId is string => participantUserId !== null);
      const decision = this.authorization.decide({
        tenantId: user.tenantId,
        userId: user.id,
        tenantRole: storedUser.role as TenantRole,
        action: 'knowledge.retrieve',
        resourceTenantId: chunk.tenantId,
        assignment,
        taskContext: {
          ...(run.taskId === null ? {} : { taskId: run.taskId }),
          assignmentRequired,
          resourceAgentId: run.agentId,
          resourceOwnerUserId: run.agent.ownerUserId,
          resourceVisibility: readAgentVisibility(run.agent.settings),
          requesterUserId: run.requesterUserId,
          participantUserIds,
          enforceActorMembership: true,
        },
        risk: 'LOW',
      });
      if (!decision.allowed) {
        await this.auditDenied(
          transaction,
          user.tenantId,
          user.id,
          messageId,
          decision.reasonCode,
          decision.decisionId,
        );
        return null;
      }

      const authorization = resolveOrganizationAuthorization(
        knowledgeFiltersFromDecision(
          decision,
          assignment?.roleTemplateId === undefined ? [] : [assignment.roleTemplateId],
        ),
        employments,
        orgUnits,
      );
      const activeOrgUnitIds = new Set(orgUnits.map((orgUnit) => orgUnit.id));
      const memberOrgUnitIds = new Set(
        employments
          .map((employment) => employment.orgUnitId)
          .filter((orgUnitId) => activeOrgUnitIds.has(orgUnitId)),
      );
      const knowledgeBases = filterKnowledgeBasesByAssignmentOrganization(
        [chunk.knowledgeBase],
        authorization.assignmentOrgUnitIds,
        new Map(orgUnits.map((orgUnit) => [orgUnit.id, orgUnit.parentId])),
      );
      const accessibleIds = accessibleKnowledgeBaseIds({
        userActive: true,
        memberOrgUnitIds,
        parentByOrgUnitId: new Map(orgUnits.map((orgUnit) => [orgUnit.id, orgUnit.parentId])),
        knowledgeBases,
      });

      if (
        memberOrgUnitIds.size === 0 ||
        chunk.tenantId !== user.tenantId ||
        chunk.documentVersionId !== documentVersionId ||
        chunk.id !== chunkId ||
        chunk.knowledgeBase.tenantId !== user.tenantId ||
        chunk.document.tenantId !== user.tenantId ||
        chunk.documentVersion.tenantId !== user.tenantId ||
        chunk.knowledgeBaseId !== chunk.knowledgeBase.id ||
        chunk.documentId !== chunk.document.id ||
        chunk.documentVersionId !== chunk.documentVersion.id ||
        chunk.document.knowledgeBaseId !== chunk.knowledgeBaseId ||
        chunk.documentVersion.knowledgeBaseId !== chunk.knowledgeBaseId ||
        chunk.documentVersion.documentId !== chunk.documentId ||
        chunk.knowledgeBase.status === 'DRAFT' ||
        (chunk.documentVersion.status !== 'READY' && chunk.documentVersion.status !== 'ARCHIVED') ||
        !accessibleIds.includes(chunk.knowledgeBaseId) ||
        !knowledgeVersionResourcePolicyAllowed(
          {
            ownerUserId:
              chunk.documentVersion.governanceOwnerUserId ?? chunk.documentVersion.createdById,
            classification: chunk.documentVersion.classification,
            scopeMode: chunk.documentVersion.scopeMode,
            organizationScopeIds: chunk.documentVersion.organizationScopeIds,
            projectScopeIds: chunk.documentVersion.projectScopeIds,
            taskScopeIds: chunk.documentVersion.taskScopeIds,
            roleTemplateScopeIds: chunk.documentVersion.roleTemplateScopeIds,
            dataLabels: chunk.documentVersion.dataLabels,
            effectiveFrom: chunk.documentVersion.effectiveFrom.toISOString(),
            expiresAt: chunk.documentVersion.expiresAt?.toISOString() ?? null,
            retentionUntil: chunk.documentVersion.retentionUntil?.toISOString() ?? null,
            retentionAction: chunk.documentVersion.retentionAction,
            supersedesVersionId: chunk.documentVersion.supersedesVersionId,
            reviewStatus: chunk.documentVersion.governanceReviewStatus,
            policyHash: chunk.documentVersion.governanceHash.trim(),
          },
          authorization.filters,
        )
      ) {
        await this.auditDenied(
          transaction,
          user.tenantId,
          user.id,
          messageId,
          'RESOURCE_ACCESS_DENIED',
          decision.decisionId,
        );
        return null;
      }

      await transaction.auditEvent.create({
        data: {
          tenantId: user.tenantId,
          actorType: 'USER',
          actorId: user.id,
          action: 'knowledge.citation.read',
          resourceType: 'knowledge_citation',
          resourceId: messageId,
          metadata: {
            messageId,
            agentRunId: run.id,
            documentVersionId,
            chunkId,
            authorizationDecisionId: decision.decisionId,
          },
        },
      });
      return {
        knowledgeBaseId: chunk.knowledgeBaseId,
        knowledgeBaseName: chunk.knowledgeBase.name,
        documentId: chunk.documentId,
        documentTitle: chunk.document.title,
        documentVersionId: chunk.documentVersionId,
        documentVersion: chunk.documentVersion.versionNumber,
        chunkId: chunk.id,
        headingPath: chunk.headingPath,
        sourceType: chunk.documentVersion.sourceType,
        content: chunk.content,
        updatedAt: (
          chunk.documentVersion.publishedAt ?? chunk.documentVersion.createdAt
        ).toISOString(),
      };
    });
    if (result === null) throw this.notFound();
    return result;
  }

  private async loadCurrentAssignment(
    transaction: Transaction,
    tenantId: string,
    userId: string,
    agentId: string,
    assignmentId: string,
  ): Promise<AuthorizationAssignment | null> {
    const stored = await transaction.roleAssignment.findFirst({
      where: {
        tenantId,
        id: assignmentId,
        userId,
        agentInstanceId: agentId,
      },
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
    if (stored === null) return null;
    const organizationScope = readOrganizationScope(stored.organizationScope);
    return {
      id: stored.id,
      tenantId: stored.tenantId,
      userId: stored.userId,
      agentInstanceId: stored.agentInstanceId,
      status: stored.status,
      effectiveFrom: stored.effectiveFrom,
      effectiveTo: stored.effectiveTo,
      roleTemplateId: stored.roleTemplateId,
      employmentActive:
        stored.employment.status === 'ACTIVE' && stored.employment.userId === userId,
      ...(organizationScope === undefined ? {} : { organizationScope }),
      projectIds: readStringArray(stored.permissionScope, 'projectIds'),
      taskIds: readStringArray(stored.permissionScope, 'taskIds'),
      dataLabels: readStringArray(stored.permissionScope, 'dataLabels'),
      permissionActions: readStringArray(stored.permissionScope, 'actions'),
    };
  }

  private async auditDenied(
    transaction: Transaction,
    tenantId: string,
    userId: string,
    messageId: string,
    reasonCode: string,
    authorizationDecisionId?: string,
  ): Promise<void> {
    await transaction.auditEvent.create({
      data: {
        tenantId,
        actorType: 'USER',
        actorId: userId,
        action: 'knowledge.citation.read_denied',
        resourceType: 'knowledge_citation',
        resourceId: messageId,
        metadata: {
          reasonCode,
          ...(authorizationDecisionId === undefined ? {} : { authorizationDecisionId }),
        },
      },
    });
  }

  private notFound(): NotFoundException {
    return new NotFoundException(
      'Knowledge citation source was not found or is no longer accessible.',
    );
  }
}

function readOrganizationScope(
  value: Prisma.JsonValue,
): AuthorizationAssignment['organizationScope'] | undefined {
  if (!isRecord(value)) return undefined;
  const organizationIds = readStringArray(value, 'organizationIds');
  if (organizationIds.length === 0 && value.includeDescendants !== true) return undefined;
  return {
    organizationIds,
    includeDescendants: value.includeDescendants === true,
  };
}

function readStringArray(value: Prisma.JsonValue, key: string): string[] {
  if (!isRecord(value)) return [];
  const candidate = value[key];
  if (!Array.isArray(candidate)) return [];
  return candidate.filter(
    (item): item is string => typeof item === 'string' && item.trim().length > 0,
  );
}

function readAgentVisibility(value: Prisma.JsonValue): 'tenant' | 'owner' {
  return isRecord(value) && value.visibility === 'tenant' ? 'tenant' : 'owner';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
