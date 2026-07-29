import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type {
  ActivateCompetencyVersionRequest,
  AnalyzeOrganizationChangeRequest,
  ApplyOrganizationChangeRequest,
  ConfirmCompetencyAssessmentRequest,
  CreateCompetencyAppealRequest,
  CreateCompetencyAssessmentRequest,
  CreateCompetencyDefinitionRequest,
  CreateCompetencyEvidenceRequest,
  CreateCompetencyVersionRequest,
  CreateDevelopmentPlanRequest,
  CreateOrganizationChangeRequest,
  CreateTriangleTeamRequest,
  DecideOrganizationChangeRequest,
  PeopleOrganizationOverview,
  TriangleHealthSnapshotRequest,
  TransitionCompetencyAppealRequest,
  TransitionDevelopmentActionRequest,
} from '@enterprise/contracts';
import { Prisma } from '@prisma/client';

import { TenantContext, type TenantPrincipal } from '../../common/context/tenant-context.js';
import { AdminPrismaService } from '../../database/admin-prisma.service.js';
import { PrismaService } from '../../database/prisma.service.js';
import { AdminAccessService } from '../admin/admin-access.service.js';
import {
  PeopleOrganizationPolicyError,
  assertOrganizationChangeCanApply,
  calculateTriangleHealth,
  confirmOrganizationChange,
  decideAssessmentConfirmation,
} from './domain/people-organization.policy.js';
import {
  assertPeopleReplay,
  lockPeopleKey,
  peopleRequestIdentity,
  recordPeopleMutation,
} from './people-organization.persistence.js';

@Injectable()
export class PeopleOrganizationService {
  constructor(
    @Inject(AdminPrismaService) private readonly adminPrisma: AdminPrismaService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AdminAccessService) private readonly access: AdminAccessService,
    @Inject(TenantContext) private readonly context: TenantContext,
  ) {}

  async overview(): Promise<PeopleOrganizationOverview> {
    const principal = this.access.requireDirectoryRead();
    return this.adminPrisma.withTenant(principal.tenantId, async (transaction) => {
      const [
        competencyDefinitions,
        activeCompetencyVersions,
        assessmentsAwaitingConfirmation,
        openAppeals,
        activeTriangleTeams,
        organizationChangesAwaitingConfirmation,
      ] = await Promise.all([
        transaction.competencyDefinition.count({ where: { tenantId: principal.tenantId } }),
        transaction.competencyVersion.count({
          where: { tenantId: principal.tenantId, status: 'ACTIVE' },
        }),
        transaction.competencyAssessment.count({
          where: {
            tenantId: principal.tenantId,
            status: { in: ['CANDIDATE', 'UNDER_REVIEW', 'DISPUTED'] },
          },
        }),
        transaction.competencyAppeal.count({
          where: {
            tenantId: principal.tenantId,
            status: { in: ['OPEN', 'UNDER_REVIEW'] },
          },
        }),
        transaction.triangleTeam.count({
          where: { tenantId: principal.tenantId, status: 'ACTIVE' },
        }),
        transaction.organizationChangeProposal.count({
          where: { tenantId: principal.tenantId, status: { in: ['PROPOSED', 'ANALYZED'] } },
        }),
      ]);
      return {
        competencyDefinitions,
        activeCompetencyVersions,
        assessmentsAwaitingConfirmation,
        openAppeals,
        activeTriangleTeams,
        organizationChangesAwaitingConfirmation,
      };
    });
  }

  async createCompetencyDefinition(request: CreateCompetencyDefinitionRequest) {
    const principal = this.access.requireDirectoryWrite();
    const identity = peopleRequestIdentity(request);
    return this.adminPrisma.withTenant(principal.tenantId, async (transaction) => {
      await lockPeopleKey(transaction, principal.tenantId, 'competency-definition', identity.key);
      const replay = await transaction.competencyDefinition.findFirst({
        where: { tenantId: principal.tenantId, idempotencyKey: identity.key },
      });
      if (replay !== null) {
        assertPeopleReplay(replay, identity.requestHash);
        return mapCompetencyDefinition(replay);
      }
      const created = await transaction.competencyDefinition.create({
        data: {
          tenantId: principal.tenantId,
          code: request.code,
          name: request.name,
          category: request.category,
          description: request.description,
          idempotencyKey: identity.key,
          requestHash: identity.requestHash,
          createdByUserId: principal.userId,
        },
      });
      await recordPeopleMutation(
        transaction,
        principal,
        'people.competency_definition.created',
        'competency_definition',
        created.id,
        { code: created.code, category: created.category },
      );
      return mapCompetencyDefinition(created);
    });
  }

  async createCompetencyVersion(definitionId: string, request: CreateCompetencyVersionRequest) {
    const principal = this.access.requireDirectoryWrite();
    const identity = peopleRequestIdentity(request);
    return this.adminPrisma.withTenant(principal.tenantId, async (transaction) => {
      await lockPeopleKey(transaction, principal.tenantId, 'competency-version', identity.key);
      const replay = await transaction.competencyVersion.findFirst({
        where: { tenantId: principal.tenantId, idempotencyKey: identity.key },
      });
      if (replay !== null) {
        assertPeopleReplay(replay, identity.requestHash);
        return this.mapCompetencyVersion(transaction, replay.id);
      }
      const definition = await transaction.competencyDefinition.findFirst({
        where: { tenantId: principal.tenantId, id: definitionId },
      });
      if (definition === null) throw new NotFoundException('Competency Definition was not found.');
      if (definition.revision !== request.expectedDefinitionRevision) {
        throw new ConflictException(
          'Competency Definition changed. Refresh before adding a version.',
        );
      }
      const roleVersions = await transaction.agentVersion.findMany({
        where: {
          tenantId: principal.tenantId,
          id: { in: request.roleRequirements.map((item) => item.roleVersionId) },
        },
        select: { id: true, templateId: true },
      });
      for (const requirement of request.roleRequirements) {
        if (
          !roleVersions.some(
            (item) =>
              item.id === requirement.roleVersionId &&
              item.templateId === requirement.roleTemplateId,
          )
        ) {
          throw new UnprocessableEntityException(
            'Every competency requirement must reference a tenant-bound Role Blueprint version.',
          );
        }
      }
      const latest = await transaction.competencyVersion.aggregate({
        where: { tenantId: principal.tenantId, competencyDefinitionId: definitionId },
        _max: { version: true },
      });
      const created = await transaction.competencyVersion.create({
        data: {
          tenantId: principal.tenantId,
          competencyDefinitionId: definitionId,
          version: (latest._max.version ?? 0) + 1,
          changeSummary: request.changeSummary,
          createdByUserId: principal.userId,
          idempotencyKey: identity.key,
          requestHash: identity.requestHash,
        },
      });
      for (const level of request.levels) {
        const createdLevel = await transaction.competencyLevel.create({
          data: {
            tenantId: principal.tenantId,
            competencyDefinitionId: definitionId,
            competencyVersionId: created.id,
            competencyVersion: created.version,
            level: level.level,
            name: level.name,
            taskComplexity: level.taskComplexity,
            evidenceRequirements: level.evidenceRequirements,
          },
        });
        await transaction.competencyBehaviorAnchor.createMany({
          data: level.behaviorAnchors.map((statement, ordinal) => ({
            tenantId: principal.tenantId,
            competencyLevelId: createdLevel.id,
            ordinal,
            statement,
          })),
        });
      }
      await transaction.roleCompetencyRequirement.createMany({
        data: request.roleRequirements.map((item) => ({
          tenantId: principal.tenantId,
          competencyDefinitionId: definitionId,
          competencyVersionId: created.id,
          competencyVersion: created.version,
          roleTemplateId: item.roleTemplateId,
          roleVersionId: item.roleVersionId,
          requiredLevel: item.requiredLevel,
          context: item.context,
        })),
      });
      const changed = await transaction.competencyDefinition.updateMany({
        where: {
          tenantId: principal.tenantId,
          id: definitionId,
          revision: request.expectedDefinitionRevision,
        },
        data: { revision: { increment: 1 } },
      });
      if (changed.count !== 1) throw new ConflictException('Competency Definition changed.');
      await recordPeopleMutation(
        transaction,
        principal,
        'people.competency_version.created',
        'competency_version',
        created.id,
        {
          definitionId,
          version: created.version,
          roleRequirementCount: request.roleRequirements.length,
        },
      );
      return this.mapCompetencyVersion(transaction, created.id);
    });
  }

  async activateCompetencyVersion(
    definitionId: string,
    versionId: string,
    request: ActivateCompetencyVersionRequest,
  ) {
    const principal = this.access.requireDirectoryWrite();
    return this.adminPrisma.withTenant(principal.tenantId, async (transaction) => {
      const current = await transaction.competencyVersion.findFirst({
        where: {
          tenantId: principal.tenantId,
          competencyDefinitionId: definitionId,
          id: versionId,
        },
      });
      if (current === null) throw new NotFoundException('Competency Version was not found.');
      if (current.revision !== request.expectedRevision || current.status !== 'DRAFT') {
        throw new ConflictException('Only the current draft Competency Version can be activated.');
      }
      if (current.createdByUserId === principal.userId) {
        throw new ForbiddenException(
          'Maker-checker requires an independent human to activate a Competency Version.',
        );
      }
      await transaction.competencyVersion.updateMany({
        where: {
          tenantId: principal.tenantId,
          competencyDefinitionId: definitionId,
          status: 'ACTIVE',
        },
        data: { status: 'RETIRED', revision: { increment: 1 } },
      });
      const changed = await transaction.competencyVersion.updateMany({
        where: {
          tenantId: principal.tenantId,
          id: versionId,
          revision: request.expectedRevision,
          status: 'DRAFT',
        },
        data: {
          status: 'ACTIVE',
          revision: { increment: 1 },
          activatedAt: new Date(),
          activatedByUserId: principal.userId,
        },
      });
      if (changed.count !== 1) throw new ConflictException('Competency Version changed.');
      await transaction.competencyDefinition.update({
        where: { id: definitionId },
        data: { currentVersionId: versionId, revision: { increment: 1 } },
      });
      await recordPeopleMutation(
        transaction,
        principal,
        'people.competency_version.activated',
        'competency_version',
        versionId,
        { definitionId, comment: request.comment },
      );
      return this.mapCompetencyVersion(transaction, versionId);
    });
  }

  async createCompetencyEvidence(request: CreateCompetencyEvidenceRequest) {
    const principal = this.access.requireDirectoryWrite();
    const identity = peopleRequestIdentity(request);
    return this.adminPrisma.withTenant(principal.tenantId, async (transaction) => {
      await lockPeopleKey(transaction, principal.tenantId, 'competency-evidence', identity.key);
      const replay = await transaction.competencyEvidence.findFirst({
        where: { tenantId: principal.tenantId, idempotencyKey: identity.key },
      });
      if (replay !== null) {
        assertPeopleReplay(replay, identity.requestHash);
        return mapCompetencyEvidence(replay);
      }
      const version = await transaction.competencyVersion.findFirst({
        where: { tenantId: principal.tenantId, id: request.competencyVersionId },
      });
      if (version === null || version.status !== 'ACTIVE') {
        throw new UnprocessableEntityException(
          'Competency Evidence must reference an active Competency Version.',
        );
      }
      const governedEvidence = await transaction.evidence.findFirst({
        where: {
          tenantId: principal.tenantId,
          id: request.evidenceId,
          version: request.evidenceVersion,
          status: 'ACTIVE',
        },
      });
      if (governedEvidence === null) {
        throw new UnprocessableEntityException(
          'Competency Evidence must reference active governed Evidence.',
        );
      }
      const created = await transaction.competencyEvidence.create({
        data: {
          tenantId: principal.tenantId,
          subjectUserId: request.subjectUserId,
          competencyDefinitionId: version.competencyDefinitionId,
          competencyVersionId: version.id,
          competencyVersion: version.version,
          demonstratedLevel: request.demonstratedLevel,
          evidenceId: request.evidenceId,
          evidenceVersion: request.evidenceVersion,
          taskId: request.taskId,
          taskVersion: request.taskVersion,
          deliverableId: request.deliverableId,
          deliverableVersion: request.deliverableVersion,
          metricObservationId: request.metricObservationId,
          metricObservationVersion: request.metricObservationVersion,
          reviewReference: request.reviewReference,
          validFrom: new Date(request.validFrom),
          validUntil: request.validUntil === null ? null : new Date(request.validUntil),
          idempotencyKey: identity.key,
          requestHash: identity.requestHash,
          createdByUserId: principal.userId,
        },
      });
      await recordPeopleMutation(
        transaction,
        principal,
        'people.competency_evidence.created',
        'competency_evidence',
        created.id,
        { subjectUserId: request.subjectUserId, evidenceId: request.evidenceId },
      );
      return mapCompetencyEvidence(created);
    });
  }

  async createAssessment(request: CreateCompetencyAssessmentRequest) {
    const principal = this.access.requireDirectoryWrite();
    const identity = peopleRequestIdentity(request);
    return this.adminPrisma.withTenant(principal.tenantId, async (transaction) => {
      await lockPeopleKey(transaction, principal.tenantId, 'assessment', identity.key);
      const replay = await transaction.competencyAssessment.findFirst({
        where: { tenantId: principal.tenantId, idempotencyKey: identity.key },
      });
      if (replay !== null) {
        assertPeopleReplay(replay, identity.requestHash);
        return this.mapAssessment(transaction, replay.id);
      }
      const [version, run] = await Promise.all([
        transaction.competencyVersion.findFirst({
          where: {
            tenantId: principal.tenantId,
            id: request.competencyVersionId,
            status: 'ACTIVE',
          },
        }),
        transaction.agentRun.findFirst({
          where: { tenantId: principal.tenantId, id: request.agentRunId, status: 'SUCCEEDED' },
        }),
      ]);
      if (version === null || run === null) {
        throw new UnprocessableEntityException(
          'Assessment candidate requires an active Competency Version and succeeded Agent Run.',
        );
      }
      if (request.supersedesAssessmentId !== null) {
        const superseded = await transaction.competencyAssessment.findFirst({
          where: {
            tenantId: principal.tenantId,
            id: request.supersedesAssessmentId,
            subjectUserId: request.subjectUserId,
            competencyVersionId: request.competencyVersionId,
            revision: request.expectedSupersededRevision!,
            status: { in: ['EFFECTIVE', 'REJECTED', 'DISPUTED'] },
          },
        });
        if (superseded === null) {
          throw new ConflictException(
            'Reassessment must supersede the current eligible assessment revision.',
          );
        }
      }
      const created = await transaction.competencyAssessment.create({
        data: {
          tenantId: principal.tenantId,
          subjectUserId: request.subjectUserId,
          competencyDefinitionId: version.competencyDefinitionId,
          competencyVersionId: version.id,
          competencyVersion: version.version,
          proposedLevel: request.proposedLevel,
          confidence: request.confidence,
          agentRunId: request.agentRunId,
          supersedesAssessmentId: request.supersedesAssessmentId,
          supersedesAssessmentRevision: request.expectedSupersededRevision,
          summary: request.summary,
          requiredConfirmationRoles: request.requiredConfirmationRoles,
          createdByUserId: principal.userId,
          idempotencyKey: identity.key,
          requestHash: identity.requestHash,
        },
      });
      await transaction.competencyAssessmentAttribution.createMany({
        data: request.attribution.map((item) => ({
          tenantId: principal.tenantId,
          assessmentId: created.id,
          factor: item.factor,
          contribution: item.contribution,
          statement: item.statement,
          evidenceIds: item.evidenceIds,
        })),
      });
      if (request.supersedesAssessmentId !== null) {
        const superseded = await transaction.competencyAssessment.updateMany({
          where: {
            tenantId: principal.tenantId,
            id: request.supersedesAssessmentId,
            revision: request.expectedSupersededRevision!,
          },
          data: { status: 'SUPERSEDED', revision: { increment: 1 } },
        });
        if (superseded.count !== 1) {
          throw new ConflictException('Assessment selected for reassessment changed.');
        }
      }
      await recordPeopleMutation(
        transaction,
        principal,
        'people.competency_assessment.candidate_created',
        'competency_assessment',
        created.id,
        {
          subjectUserId: request.subjectUserId,
          agentRunId: request.agentRunId,
          candidateOnly: true,
          prohibitedDecisionUses: ['PROMOTION', 'COMPENSATION', 'TERMINATION'],
        },
      );
      return this.mapAssessment(transaction, created.id);
    });
  }

  async confirmAssessment(
    assessmentId: string,
    request: ConfirmCompetencyAssessmentRequest,
    adminRoute: boolean,
  ) {
    const principal = adminRoute ? this.access.requireDirectoryWrite() : this.context.current;
    return this.adminPrisma.withTenant(principal.tenantId, async (transaction) => {
      await lockPeopleKey(
        transaction,
        principal.tenantId,
        'assessment-confirmation',
        request.idempotencyKey,
      );
      const replay = await transaction.competencyAssessmentConfirmation.findFirst({
        where: { tenantId: principal.tenantId, idempotencyKey: request.idempotencyKey },
      });
      const identity = peopleRequestIdentity(request);
      if (replay !== null) {
        assertPeopleReplay(replay, identity.requestHash);
        return this.mapAssessment(transaction, assessmentId);
      }
      const assessment = await transaction.competencyAssessment.findFirst({
        where: { tenantId: principal.tenantId, id: assessmentId },
      });
      if (assessment === null) throw new NotFoundException('Competency Assessment was not found.');
      const confirmations = await transaction.competencyAssessmentConfirmation.findMany({
        where: { tenantId: principal.tenantId, assessmentId },
      });
      const managesSubject = await this.managesSubject(
        transaction,
        principal,
        assessment.subjectUserId,
      );
      try {
        const result = decideAssessmentConfirmation(
          {
            status: assessment.status,
            revision: assessment.revision,
            subjectUserId: assessment.subjectUserId,
            createdByUserId: assessment.createdByUserId,
            requiredConfirmationRoles: jsonStringArray(
              assessment.requiredConfirmationRoles,
            ) as Array<'EMPLOYEE' | 'MANAGER' | 'HR'>,
            confirmations: confirmations.map((item) => ({
              role: item.role,
              decision: item.decision,
              actorUserId: item.actorUserId,
            })),
          },
          request,
          {
            userId: principal.userId,
            isHrAdministrator:
              adminRoute && (principal.role === 'OWNER' || principal.role === 'ADMIN'),
            managesSubject,
          },
        );
        await transaction.competencyAssessmentConfirmation.create({
          data: {
            tenantId: principal.tenantId,
            assessmentId,
            role: request.role,
            decision: request.decision,
            actorUserId: principal.userId,
            assessmentRevision: assessment.revision,
            comment: request.comment,
            idempotencyKey: identity.key,
            requestHash: identity.requestHash,
          },
        });
        const changed = await transaction.competencyAssessment.updateMany({
          where: {
            tenantId: principal.tenantId,
            id: assessmentId,
            revision: request.expectedRevision,
          },
          data: { status: result.nextStatus, revision: { increment: 1 } },
        });
        if (changed.count !== 1) throw new ConflictException('Competency Assessment changed.');
        if (result.effective) await this.createGap(transaction, principal, assessmentId);
        await recordPeopleMutation(
          transaction,
          principal,
          `people.competency_assessment.${request.decision.toLowerCase()}`,
          'competency_assessment',
          assessmentId,
          { role: request.role, effective: result.effective },
        );
      } catch (error) {
        if (error instanceof PeopleOrganizationPolicyError) {
          throw new ForbiddenException(error.message);
        }
        throw error;
      }
      return this.mapAssessment(transaction, assessmentId);
    });
  }

  async createAppeal(assessmentId: string, request: CreateCompetencyAppealRequest) {
    const principal = this.context.current;
    const identity = peopleRequestIdentity(request);
    return this.prisma.withTenant(principal.tenantId, async (transaction) => {
      await lockPeopleKey(transaction, principal.tenantId, 'assessment-appeal', identity.key);
      const replay = await transaction.competencyAppeal.findFirst({
        where: { tenantId: principal.tenantId, idempotencyKey: identity.key },
      });
      if (replay !== null) {
        assertPeopleReplay(replay, identity.requestHash);
        return mapAppeal(replay);
      }
      const assessment = await transaction.competencyAssessment.findFirst({
        where: {
          tenantId: principal.tenantId,
          id: assessmentId,
          subjectUserId: principal.userId,
        },
      });
      if (assessment === null) {
        throw new ForbiddenException('Employees can only appeal their own assessment.');
      }
      if (assessment.revision !== request.expectedAssessmentRevision) {
        throw new ConflictException('Competency Assessment changed.');
      }
      const evidence = await transaction.evidence.findMany({
        where: {
          tenantId: principal.tenantId,
          id: { in: request.supplementalEvidenceIds },
          status: 'ACTIVE',
        },
        orderBy: { version: 'desc' },
      });
      const created = await transaction.competencyAppeal.create({
        data: {
          tenantId: principal.tenantId,
          assessmentId,
          subjectUserId: principal.userId,
          reason: request.reason,
          openedByUserId: principal.userId,
          idempotencyKey: identity.key,
          requestHash: identity.requestHash,
        },
      });
      const latest = new Map<string, number>();
      for (const item of evidence) if (!latest.has(item.id)) latest.set(item.id, item.version);
      if (latest.size > 0) {
        await transaction.competencyAppealEvidence.createMany({
          data: [...latest].map(([evidenceId, evidenceVersion]) => ({
            tenantId: principal.tenantId,
            appealId: created.id,
            evidenceId,
            evidenceVersion,
          })),
        });
      }
      await recordPeopleMutation(
        transaction,
        principal,
        'people.competency_assessment.appealed',
        'competency_appeal',
        created.id,
        { assessmentId, supplementalEvidenceCount: latest.size },
      );
      return mapAppeal(created);
    });
  }

  async transitionAppeal(appealId: string, request: TransitionCompetencyAppealRequest) {
    const principal = this.access.requireDirectoryWrite();
    return this.adminPrisma.withTenant(principal.tenantId, async (transaction) => {
      const appeal = await transaction.competencyAppeal.findFirst({
        where: { tenantId: principal.tenantId, id: appealId },
      });
      if (appeal === null) throw new NotFoundException('Competency Appeal was not found.');
      if (appeal.revision !== request.expectedRevision) {
        throw new ConflictException('Competency Appeal changed.');
      }
      const transitions: Record<TransitionCompetencyAppealRequest['action'], readonly string[]> = {
        START_REVIEW: ['OPEN'],
        UPHOLD: ['UNDER_REVIEW'],
        OVERTURN: ['UNDER_REVIEW'],
        CLOSE: ['UPHELD', 'OVERTURNED'],
      };
      if (!transitions[request.action].includes(appeal.status)) {
        throw new ConflictException(
          `Competency Appeal cannot ${request.action} from ${appeal.status}.`,
        );
      }
      const nextStatus = {
        START_REVIEW: 'UNDER_REVIEW',
        UPHOLD: 'UPHELD',
        OVERTURN: 'OVERTURNED',
        CLOSE: 'CLOSED',
      }[request.action] as 'UNDER_REVIEW' | 'UPHELD' | 'OVERTURNED' | 'CLOSED';
      const changed = await transaction.competencyAppeal.updateMany({
        where: {
          tenantId: principal.tenantId,
          id: appealId,
          revision: request.expectedRevision,
        },
        data: {
          status: nextStatus,
          resolution: request.resolution,
          resolvedByUserId: request.action === 'START_REVIEW' ? null : principal.userId,
          revision: { increment: 1 },
        },
      });
      if (changed.count !== 1) throw new ConflictException('Competency Appeal changed.');
      if (request.action === 'OVERTURN') {
        const assessment = await transaction.competencyAssessment.findFirstOrThrow({
          where: { tenantId: principal.tenantId, id: appeal.assessmentId },
        });
        await transaction.competencyAssessment.updateMany({
          where: {
            tenantId: principal.tenantId,
            id: assessment.id,
            revision: assessment.revision,
          },
          data: { status: 'DISPUTED', revision: { increment: 1 } },
        });
      }
      await recordPeopleMutation(
        transaction,
        principal,
        `people.competency_appeal.${request.action.toLowerCase()}`,
        'competency_appeal',
        appealId,
        { assessmentId: appeal.assessmentId, resolution: request.resolution },
      );
      return mapAppeal(
        await transaction.competencyAppeal.findFirstOrThrow({
          where: { tenantId: principal.tenantId, id: appealId },
        }),
      );
    });
  }

  async createDevelopmentPlan(request: CreateDevelopmentPlanRequest) {
    const principal = this.access.requireDirectoryWrite();
    const identity = peopleRequestIdentity(request);
    return this.adminPrisma.withTenant(principal.tenantId, async (transaction) => {
      await lockPeopleKey(transaction, principal.tenantId, 'development-plan', identity.key);
      const replay = await transaction.developmentPlan.findFirst({
        where: { tenantId: principal.tenantId, idempotencyKey: identity.key },
      });
      if (replay !== null) {
        assertPeopleReplay(replay, identity.requestHash);
        return this.mapDevelopmentPlan(transaction, replay.id);
      }
      const [assessment, gap] = await Promise.all([
        transaction.competencyAssessment.findFirst({
          where: {
            tenantId: principal.tenantId,
            id: request.assessmentId,
            revision: request.expectedAssessmentRevision,
            status: 'EFFECTIVE',
          },
        }),
        transaction.competencyGap.findFirst({
          where: {
            tenantId: principal.tenantId,
            id: request.gapId,
            assessmentId: request.assessmentId,
          },
        }),
      ]);
      if (assessment === null || gap === null) {
        throw new ConflictException(
          'Development Plan requires the current effective Assessment and its traceable Gap.',
        );
      }
      const created = await transaction.developmentPlan.create({
        data: {
          tenantId: principal.tenantId,
          subjectUserId: assessment.subjectUserId,
          assessmentId: assessment.id,
          gapId: gap.id,
          idempotencyKey: identity.key,
          requestHash: identity.requestHash,
          createdByUserId: principal.userId,
        },
      });
      await transaction.developmentAction.createMany({
        data: request.actions.map((action) => ({
          tenantId: principal.tenantId,
          developmentPlanId: created.id,
          type: action.type,
          title: action.title,
          description: action.description,
          linkedTaskId: action.linkedTaskId,
          linkedTaskVersion: action.linkedTaskVersion,
          mentorUserId: action.mentorUserId,
          dueAt: new Date(action.dueAt),
          verificationMethod: action.verificationMethod,
        })),
      });
      await recordPeopleMutation(
        transaction,
        principal,
        'people.development_plan.created',
        'development_plan',
        created.id,
        { assessmentId: assessment.id, gapId: gap.id, actionCount: request.actions.length },
      );
      return this.mapDevelopmentPlan(transaction, created.id);
    });
  }

  async transitionDevelopmentAction(actionId: string, request: TransitionDevelopmentActionRequest) {
    const principal = this.access.requireDirectoryWrite();
    return this.adminPrisma.withTenant(principal.tenantId, async (transaction) => {
      const action = await transaction.developmentAction.findFirst({
        where: { tenantId: principal.tenantId, id: actionId },
      });
      if (action === null) throw new NotFoundException('Development Action was not found.');
      if (action.revision !== request.expectedRevision) {
        throw new ConflictException('Development Action changed.');
      }
      const next =
        request.action === 'START'
          ? 'ACTIVE'
          : request.action === 'COMPLETE'
            ? 'COMPLETED'
            : 'CANCELLED';
      const allowed =
        (request.action === 'START' && action.status === 'PLANNED') ||
        (request.action === 'COMPLETE' && action.status === 'ACTIVE') ||
        (request.action === 'CANCEL' &&
          (action.status === 'PLANNED' || action.status === 'ACTIVE'));
      if (!allowed) {
        throw new ConflictException(
          `Development Action cannot ${request.action} from ${action.status}.`,
        );
      }
      if (request.verificationEvidenceId !== null) {
        const evidence = await transaction.evidence.findFirst({
          where: {
            tenantId: principal.tenantId,
            id: request.verificationEvidenceId,
            version: request.verificationEvidenceVersion!,
            status: 'ACTIVE',
          },
        });
        if (evidence === null) {
          throw new UnprocessableEntityException(
            'Development Action completion requires active governed Evidence.',
          );
        }
      }
      const changed = await transaction.developmentAction.updateMany({
        where: {
          tenantId: principal.tenantId,
          id: actionId,
          revision: request.expectedRevision,
        },
        data: {
          status: next,
          revision: { increment: 1 },
          verificationEvidenceId: request.verificationEvidenceId,
          verificationEvidenceVersion: request.verificationEvidenceVersion,
          completedAt: request.action === 'COMPLETE' ? new Date() : null,
        },
      });
      if (changed.count !== 1) throw new ConflictException('Development Action changed.');
      await recordPeopleMutation(
        transaction,
        principal,
        `people.development_action.${request.action.toLowerCase()}`,
        'development_action',
        actionId,
        { comment: request.comment },
      );
      return mapDevelopmentAction(
        await transaction.developmentAction.findFirstOrThrow({
          where: { tenantId: principal.tenantId, id: actionId },
        }),
      );
    });
  }

  async employeeProfile() {
    const principal = this.context.current;
    return this.prisma.withTenant(principal.tenantId, async (transaction) => {
      const [evidence, assessments, appeals, gaps, plans] = await Promise.all([
        transaction.competencyEvidence.findMany({
          where: { tenantId: principal.tenantId, subjectUserId: principal.userId },
          orderBy: { createdAt: 'desc' },
        }),
        transaction.competencyAssessment.findMany({
          where: { tenantId: principal.tenantId, subjectUserId: principal.userId },
          orderBy: { createdAt: 'desc' },
        }),
        transaction.competencyAppeal.findMany({
          where: { tenantId: principal.tenantId, subjectUserId: principal.userId },
          orderBy: { createdAt: 'desc' },
        }),
        transaction.competencyGap.findMany({
          where: {
            tenantId: principal.tenantId,
            assessmentId: {
              in: await transaction.competencyAssessment
                .findMany({
                  where: { tenantId: principal.tenantId, subjectUserId: principal.userId },
                  select: { id: true },
                })
                .then((items) => items.map((item) => item.id)),
            },
          },
          orderBy: { createdAt: 'desc' },
        }),
        transaction.developmentPlan.findMany({
          where: { tenantId: principal.tenantId, subjectUserId: principal.userId },
          orderBy: { createdAt: 'desc' },
        }),
      ]);
      const mappedAssessments = [];
      for (const assessment of assessments) {
        mappedAssessments.push(await this.mapAssessment(transaction, assessment.id));
      }
      const mappedPlans = [];
      for (const plan of plans) {
        const actions = await transaction.developmentAction.findMany({
          where: { tenantId: principal.tenantId, developmentPlanId: plan.id },
        });
        mappedPlans.push({
          id: plan.id,
          subjectUserId: plan.subjectUserId,
          assessmentId: plan.assessmentId,
          gapId: plan.gapId,
          status: plan.status,
          version: plan.version,
          revision: plan.revision,
          actions: actions.map(mapDevelopmentAction),
          createdAt: plan.createdAt.toISOString(),
          updatedAt: plan.updatedAt.toISOString(),
        });
      }
      return {
        userId: principal.userId,
        evidence: evidence.map(mapCompetencyEvidence),
        assessments: mappedAssessments,
        appeals: appeals.map(mapAppeal),
        gaps: gaps.map(mapGap),
        developmentPlans: mappedPlans,
      };
    });
  }

  async createTriangleTeam(request: CreateTriangleTeamRequest) {
    const principal = this.access.requireDirectoryWrite();
    const identity = peopleRequestIdentity(request);
    return this.adminPrisma.withTenant(principal.tenantId, async (transaction) => {
      await lockPeopleKey(transaction, principal.tenantId, 'triangle-team', identity.key);
      const replay = await transaction.triangleTeam.findFirst({
        where: { tenantId: principal.tenantId, idempotencyKey: identity.key },
      });
      if (replay !== null) {
        assertPeopleReplay(replay, identity.requestHash);
        return this.mapTriangleTeam(transaction, replay.id);
      }
      const roleAssignmentIds = [
        request.customerRoleAssignmentId,
        request.solutionRoleAssignmentId,
        request.deliveryRoleAssignmentId,
        request.arbiterRoleAssignmentId,
      ];
      const now = new Date();
      const [objective, assignments, metrics] = await Promise.all([
        transaction.objective.findFirst({
          where: {
            tenantId: principal.tenantId,
            id: request.objectiveId,
            version: request.objectiveVersion,
            status: 'ACTIVE',
          },
        }),
        transaction.roleAssignment.findMany({
          where: {
            tenantId: principal.tenantId,
            id: { in: roleAssignmentIds },
            status: 'ACTIVE',
            effectiveFrom: { lte: now },
            OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
          },
        }),
        transaction.metricDefinition.findMany({
          where: {
            tenantId: principal.tenantId,
            id: { in: request.metricDefinitionIds },
            status: 'ACTIVE',
          },
          orderBy: { version: 'desc' },
        }),
      ]);
      if (
        objective === null ||
        assignments.length !== new Set(roleAssignmentIds).size ||
        new Set(metrics.map((item) => item.id)).size !== new Set(request.metricDefinitionIds).size
      ) {
        throw new UnprocessableEntityException(
          'Triangle Team requires an active shared objective, effective Role Assignments and active shared metrics.',
        );
      }
      const created = await transaction.triangleTeam.create({
        data: {
          tenantId: principal.tenantId,
          code: request.code,
          name: request.name,
          objectiveId: request.objectiveId,
          objectiveVersion: request.objectiveVersion,
          arbiterRoleAssignmentId: request.arbiterRoleAssignmentId,
          idempotencyKey: identity.key,
          requestHash: identity.requestHash,
          createdByUserId: principal.userId,
        },
      });
      await transaction.triangleTeamMember.createMany({
        data: [
          {
            tenantId: principal.tenantId,
            teamId: created.id,
            responsibility: 'CUSTOMER',
            roleAssignmentId: request.customerRoleAssignmentId,
          },
          {
            tenantId: principal.tenantId,
            teamId: created.id,
            responsibility: 'SOLUTION',
            roleAssignmentId: request.solutionRoleAssignmentId,
          },
          {
            tenantId: principal.tenantId,
            teamId: created.id,
            responsibility: 'DELIVERY',
            roleAssignmentId: request.deliveryRoleAssignmentId,
          },
        ],
      });
      const latestMetrics = new Map<string, number>();
      for (const metric of metrics)
        if (!latestMetrics.has(metric.id)) latestMetrics.set(metric.id, metric.version);
      await transaction.triangleTeamMetric.createMany({
        data: [...latestMetrics].map(([metricDefinitionId, metricDefinitionVersion]) => ({
          tenantId: principal.tenantId,
          teamId: created.id,
          metricDefinitionId,
          metricDefinitionVersion,
        })),
      });
      await transaction.triangleHealthPolicy.create({
        data: {
          tenantId: principal.tenantId,
          teamId: created.id,
          version: 1,
          thresholds: request.healthPolicy.thresholds,
          weights: request.healthPolicy.weights,
          createdByUserId: principal.userId,
        },
      });
      await transaction.triangleTeam.update({
        where: { id: created.id },
        data: { status: 'ACTIVE', revision: { increment: 1 } },
      });
      await recordPeopleMutation(
        transaction,
        principal,
        'organization.triangle_team.activated',
        'triangle_team',
        created.id,
        {
          objectiveId: request.objectiveId,
          responsibilityAssignments: roleAssignmentIds.slice(0, 3),
          arbiterRoleAssignmentId: request.arbiterRoleAssignmentId,
        },
      );
      return this.mapTriangleTeam(transaction, created.id);
    });
  }

  async calculateHealth(teamId: string, request: TriangleHealthSnapshotRequest) {
    const principal = this.access.requireDirectoryWrite();
    const identity = peopleRequestIdentity(request);
    return this.adminPrisma.withTenant(principal.tenantId, async (transaction) => {
      await lockPeopleKey(transaction, principal.tenantId, 'triangle-health', identity.key);
      const replay = await transaction.triangleHealthSnapshot.findFirst({
        where: { tenantId: principal.tenantId, idempotencyKey: identity.key },
      });
      if (replay !== null) {
        assertPeopleReplay(replay, identity.requestHash);
        return this.mapHealthSnapshot(transaction, replay.id);
      }
      const [team, policy] = await Promise.all([
        transaction.triangleTeam.findFirst({
          where: { tenantId: principal.tenantId, id: teamId, status: 'ACTIVE' },
        }),
        transaction.triangleHealthPolicy.findFirst({
          where: { tenantId: principal.tenantId, teamId, version: request.policyVersion },
        }),
      ]);
      if (team === null || policy === null) {
        throw new NotFoundException('Active Triangle Team health policy was not found.');
      }
      const computed = calculateTriangleHealth(
        teamId,
        team.revision,
        request,
        jsonNumberRecord(policy.thresholds),
        jsonNumberRecord(policy.weights),
      );
      const created = await transaction.triangleHealthSnapshot.create({
        data: {
          tenantId: principal.tenantId,
          teamId,
          teamRevision: team.revision,
          policyId: policy.id,
          policyVersion: policy.version,
          score: computed.score,
          rating: computed.rating,
          periodStart: new Date(request.periodStart),
          periodEnd: new Date(request.periodEnd),
          idempotencyKey: identity.key,
          requestHash: identity.requestHash,
          createdByUserId: principal.userId,
        },
      });
      await transaction.triangleHealthComponent.createMany({
        data: computed.components.map((item) => ({
          tenantId: principal.tenantId,
          snapshotId: created.id,
          dimension: item.dimension,
          observedValue: item.observedValue,
          normalizedScore: item.normalizedScore,
          weight: item.weight,
          weightedScore: item.weightedScore,
        })),
      });
      const evidence = await transaction.evidence.findMany({
        where: {
          tenantId: principal.tenantId,
          id: { in: request.sourceEvidenceIds },
          status: 'ACTIVE',
        },
        orderBy: { version: 'desc' },
      });
      const latest = new Map<string, number>();
      for (const item of evidence) if (!latest.has(item.id)) latest.set(item.id, item.version);
      if (latest.size !== new Set(request.sourceEvidenceIds).size) {
        throw new UnprocessableEntityException(
          'Every Triangle health source must reference active governed Evidence.',
        );
      }
      await transaction.triangleHealthSnapshotEvidence.createMany({
        data: [...latest].map(([evidenceId, evidenceVersion]) => ({
          tenantId: principal.tenantId,
          snapshotId: created.id,
          evidenceId,
          evidenceVersion,
        })),
      });
      await recordPeopleMutation(
        transaction,
        principal,
        'organization.triangle_health.snapshotted',
        'triangle_health_snapshot',
        created.id,
        { teamId, score: computed.score, rating: computed.rating },
      );
      return this.mapHealthSnapshot(transaction, created.id);
    });
  }

  async proposeOrganizationChange(request: CreateOrganizationChangeRequest) {
    const principal = this.access.requireDirectoryWrite();
    const identity = peopleRequestIdentity(request);
    return this.adminPrisma.withTenant(principal.tenantId, async (transaction) => {
      await lockPeopleKey(transaction, principal.tenantId, 'organization-change', identity.key);
      const replay = await transaction.organizationChangeProposal.findFirst({
        where: { tenantId: principal.tenantId, idempotencyKey: identity.key },
      });
      if (replay !== null) {
        assertPeopleReplay(replay, identity.requestHash);
        return this.mapOrganizationChange(transaction, replay.id);
      }
      const created = await transaction.organizationChangeProposal.create({
        data: {
          tenantId: principal.tenantId,
          type: request.type,
          subjectId: request.subjectId,
          effectiveAt: new Date(request.effectiveAt),
          reason: request.reason,
          proposedChange: request.proposedChange as Prisma.InputJsonValue,
          proposedByUserId: principal.userId,
          idempotencyKey: identity.key,
          requestHash: identity.requestHash,
        },
      });
      await recordPeopleMutation(
        transaction,
        principal,
        'organization.change.proposed',
        'organization_change',
        created.id,
        { type: request.type, subjectId: request.subjectId },
      );
      return this.mapOrganizationChange(transaction, created.id);
    });
  }

  async analyzeOrganizationChange(proposalId: string, request: AnalyzeOrganizationChangeRequest) {
    const principal = this.access.requireDirectoryWrite();
    return this.adminPrisma.withTenant(principal.tenantId, async (transaction) => {
      const proposal = await transaction.organizationChangeProposal.findFirst({
        where: { tenantId: principal.tenantId, id: proposalId },
      });
      if (
        proposal === null ||
        proposal.status !== 'PROPOSED' ||
        proposal.revision !== request.expectedRevision
      ) {
        throw new ConflictException(
          'Only the current proposed Organization Change can be analyzed.',
        );
      }
      const report = await transaction.organizationImpactReport.create({
        data: {
          tenantId: principal.tenantId,
          proposalId,
          proposalRevision: proposal.revision,
          analyzedByUserId: principal.userId,
        },
      });
      await transaction.organizationImpactItem.createMany({
        data: request.impacts.map((item) => ({
          tenantId: principal.tenantId,
          reportId: report.id,
          area: item.area,
          resourceType: item.resourceType,
          resourceId: item.resourceId,
          risk: item.risk,
          currentState: item.currentState as Prisma.InputJsonValue,
          proposedState: item.proposedState as Prisma.InputJsonValue,
          mitigation: item.mitigation,
        })),
      });
      const changed = await transaction.organizationChangeProposal.updateMany({
        where: {
          tenantId: principal.tenantId,
          id: proposalId,
          revision: request.expectedRevision,
          status: 'PROPOSED',
        },
        data: { status: 'ANALYZED', revision: { increment: 1 } },
      });
      if (changed.count !== 1) throw new ConflictException('Organization Change changed.');
      await recordPeopleMutation(
        transaction,
        principal,
        'organization.change.analyzed',
        'organization_change',
        proposalId,
        {
          reportId: report.id,
          impactCount: request.impacts.length,
          criticalCount: request.impacts.filter((item) => item.risk === 'CRITICAL').length,
        },
      );
      return this.mapOrganizationChange(transaction, proposalId);
    });
  }

  async decideOrganizationChange(proposalId: string, request: DecideOrganizationChangeRequest) {
    const principal = this.access.requireDirectoryWrite();
    return this.adminPrisma.withTenant(principal.tenantId, async (transaction) => {
      const state = await this.organizationChangePolicyState(
        transaction,
        principal.tenantId,
        proposalId,
      );
      try {
        if (request.action === 'CONFIRM') {
          confirmOrganizationChange(state, principal.userId, request.expectedRevision);
        } else if (
          state.revision !== request.expectedRevision ||
          !['PROPOSED', 'ANALYZED'].includes(state.status)
        ) {
          throw new PeopleOrganizationPolicyError(
            'Only a current proposed or analyzed Organization Change can be rejected.',
          );
        }
      } catch (error) {
        if (error instanceof PeopleOrganizationPolicyError) {
          throw new ForbiddenException(error.message);
        }
        throw error;
      }
      await transaction.organizationChangeConfirmation.create({
        data: {
          tenantId: principal.tenantId,
          proposalId,
          decision: request.action,
          actorUserId: principal.userId,
          proposalRevision: request.expectedRevision,
          comment: request.comment,
        },
      });
      const changed = await transaction.organizationChangeProposal.updateMany({
        where: {
          tenantId: principal.tenantId,
          id: proposalId,
          revision: request.expectedRevision,
        },
        data:
          request.action === 'CONFIRM'
            ? {
                status: 'CONFIRMED',
                confirmedByUserId: principal.userId,
                confirmedAt: new Date(),
                decisionComment: request.comment,
                revision: { increment: 1 },
              }
            : {
                status: 'REJECTED',
                decisionComment: request.comment,
                revision: { increment: 1 },
              },
      });
      if (changed.count !== 1) throw new ConflictException('Organization Change changed.');
      await recordPeopleMutation(
        transaction,
        principal,
        `organization.change.${request.action.toLowerCase()}`,
        'organization_change',
        proposalId,
        { comment: request.comment },
      );
      return this.mapOrganizationChange(transaction, proposalId);
    });
  }

  async applyOrganizationChange(proposalId: string, request: ApplyOrganizationChangeRequest) {
    const principal = this.access.requireDirectoryWrite();
    return this.adminPrisma.withTenant(principal.tenantId, async (transaction) => {
      const state = await this.organizationChangePolicyState(
        transaction,
        principal.tenantId,
        proposalId,
      );
      try {
        assertOrganizationChangeCanApply(state, principal.userId, request.expectedRevision);
      } catch (error) {
        if (error instanceof PeopleOrganizationPolicyError) {
          throw new ForbiddenException(error.message);
        }
        throw error;
      }
      if (state.hasCriticalImpact) {
        throw new ForbiddenException(
          'Critical organization changes remain confirmed but require a dedicated approved execution workflow; they are never auto-applied.',
        );
      }
      const changed = await transaction.organizationChangeProposal.updateMany({
        where: {
          tenantId: principal.tenantId,
          id: proposalId,
          revision: request.expectedRevision,
          status: 'CONFIRMED',
        },
        data: {
          status: 'APPLIED',
          appliedByUserId: principal.userId,
          appliedAt: new Date(),
          revision: { increment: 1 },
        },
      });
      if (changed.count !== 1) throw new ConflictException('Organization Change changed.');
      await recordPeopleMutation(
        transaction,
        principal,
        'organization.change.applied',
        'organization_change',
        proposalId,
        { confirmationPhrase: request.confirmationPhrase },
      );
      return this.mapOrganizationChange(transaction, proposalId);
    });
  }

  private async createGap(
    transaction: Prisma.TransactionClient,
    principal: TenantPrincipal,
    assessmentId: string,
  ): Promise<void> {
    const assessment = await transaction.competencyAssessment.findFirstOrThrow({
      where: { tenantId: principal.tenantId, id: assessmentId },
    });
    const assignment = await transaction.roleAssignment.findFirst({
      where: {
        tenantId: principal.tenantId,
        userId: assessment.subjectUserId,
        status: 'ACTIVE',
      },
      orderBy: { effectiveFrom: 'desc' },
    });
    if (assignment === null) return;
    const requirement = await transaction.roleCompetencyRequirement.findFirst({
      where: {
        tenantId: principal.tenantId,
        competencyVersionId: assessment.competencyVersionId,
        roleVersionId: assignment.roleVersionId,
      },
    });
    if (requirement === null || assessment.effectiveLevel === null) return;
    const attribution = await transaction.competencyAssessmentAttribution.findMany({
      where: { tenantId: principal.tenantId, assessmentId },
    });
    await transaction.competencyGap.create({
      data: {
        tenantId: principal.tenantId,
        assessmentId,
        roleRequirementId: requirement.id,
        requiredLevel: requirement.requiredLevel,
        effectiveLevel: assessment.effectiveLevel,
        attributionSummary: attribution
          .map((item) => `${item.factor}: ${item.statement}`)
          .join('\n'),
      },
    });
  }

  private async managesSubject(
    transaction: Prisma.TransactionClient,
    principal: TenantPrincipal,
    subjectUserId: string,
  ): Promise<boolean> {
    const relation = await transaction.managerRelation.findFirst({
      where: {
        tenantId: principal.tenantId,
        employment: { userId: subjectUserId },
        managerEmployment: { userId: principal.userId },
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: new Date() } }],
      },
    });
    return relation !== null;
  }

  private async mapCompetencyVersion(transaction: Prisma.TransactionClient, versionId: string) {
    const version = await transaction.competencyVersion.findFirstOrThrow({
      where: { id: versionId },
    });
    const levels = await transaction.competencyLevel.findMany({
      where: { tenantId: version.tenantId, competencyVersionId: version.id },
      orderBy: { level: 'asc' },
    });
    const anchors = await transaction.competencyBehaviorAnchor.findMany({
      where: {
        tenantId: version.tenantId,
        competencyLevelId: { in: levels.map((item) => item.id) },
      },
      orderBy: { ordinal: 'asc' },
    });
    const requirements = await transaction.roleCompetencyRequirement.findMany({
      where: { tenantId: version.tenantId, competencyVersionId: version.id },
    });
    return {
      id: version.id,
      competencyDefinitionId: version.competencyDefinitionId,
      version: version.version,
      status: version.status,
      changeSummary: version.changeSummary,
      revision: version.revision,
      createdByUserId: version.createdByUserId,
      activatedByUserId: version.activatedByUserId,
      activatedAt: version.activatedAt?.toISOString() ?? null,
      levels: levels.map((level) => ({
        id: level.id,
        level: level.level,
        name: level.name,
        taskComplexity: level.taskComplexity,
        evidenceRequirements: jsonStringArray(level.evidenceRequirements),
        behaviorAnchors: anchors
          .filter((anchor) => anchor.competencyLevelId === level.id)
          .map((anchor) => ({
            id: anchor.id,
            ordinal: anchor.ordinal,
            statement: anchor.statement,
          })),
      })),
      roleRequirements: requirements.map((item) => ({
        id: item.id,
        roleTemplateId: item.roleTemplateId,
        roleVersionId: item.roleVersionId,
        requiredLevel: item.requiredLevel,
        context: item.context,
      })),
      createdAt: version.createdAt.toISOString(),
    };
  }

  private async mapAssessment(transaction: Prisma.TransactionClient, assessmentId: string) {
    const assessment = await transaction.competencyAssessment.findFirstOrThrow({
      where: { id: assessmentId },
    });
    const [attribution, confirmations] = await Promise.all([
      transaction.competencyAssessmentAttribution.findMany({
        where: { tenantId: assessment.tenantId, assessmentId },
      }),
      transaction.competencyAssessmentConfirmation.findMany({
        where: { tenantId: assessment.tenantId, assessmentId, decision: 'CONFIRM' },
      }),
    ]);
    return {
      id: assessment.id,
      subjectUserId: assessment.subjectUserId,
      competencyVersionId: assessment.competencyVersionId,
      proposedLevel: assessment.proposedLevel,
      effectiveLevel: assessment.effectiveLevel,
      confidence: assessment.confidence.toNumber(),
      status: assessment.status,
      agentRunId: assessment.agentRunId,
      supersedesAssessmentId: assessment.supersedesAssessmentId,
      summary: assessment.summary,
      attribution: attribution.map((item) => ({
        factor: item.factor,
        contribution: item.contribution.toNumber(),
        statement: item.statement,
        evidenceIds: jsonStringArray(item.evidenceIds),
      })),
      requiredConfirmationRoles: jsonStringArray(assessment.requiredConfirmationRoles),
      confirmedRoles: confirmations.map((item) => item.role),
      revision: assessment.revision,
      createdAt: assessment.createdAt.toISOString(),
      updatedAt: assessment.updatedAt.toISOString(),
    };
  }

  private async mapTriangleTeam(transaction: Prisma.TransactionClient, teamId: string) {
    const team = await transaction.triangleTeam.findFirstOrThrow({ where: { id: teamId } });
    const [members, metrics] = await Promise.all([
      transaction.triangleTeamMember.findMany({
        where: { tenantId: team.tenantId, teamId },
      }),
      transaction.triangleTeamMetric.findMany({
        where: { tenantId: team.tenantId, teamId },
      }),
    ]);
    const assignment = (responsibility: 'CUSTOMER' | 'SOLUTION' | 'DELIVERY') =>
      members.find((item) => item.responsibility === responsibility)?.roleAssignmentId ?? '';
    return {
      id: team.id,
      code: team.code,
      name: team.name,
      status: team.status,
      objectiveId: team.objectiveId,
      objectiveVersion: team.objectiveVersion,
      customerRoleAssignmentId: assignment('CUSTOMER'),
      solutionRoleAssignmentId: assignment('SOLUTION'),
      deliveryRoleAssignmentId: assignment('DELIVERY'),
      arbiterRoleAssignmentId: team.arbiterRoleAssignmentId,
      metricDefinitionIds: metrics.map((item) => item.metricDefinitionId),
      healthPolicyVersion: team.currentHealthPolicyVersion,
      revision: team.revision,
      createdAt: team.createdAt.toISOString(),
      updatedAt: team.updatedAt.toISOString(),
    };
  }

  private async mapDevelopmentPlan(transaction: Prisma.TransactionClient, planId: string) {
    const plan = await transaction.developmentPlan.findFirstOrThrow({
      where: { id: planId },
    });
    const actions = await transaction.developmentAction.findMany({
      where: { tenantId: plan.tenantId, developmentPlanId: plan.id },
      orderBy: { dueAt: 'asc' },
    });
    return {
      id: plan.id,
      subjectUserId: plan.subjectUserId,
      assessmentId: plan.assessmentId,
      gapId: plan.gapId,
      status: plan.status,
      version: plan.version,
      revision: plan.revision,
      actions: actions.map(mapDevelopmentAction),
      createdAt: plan.createdAt.toISOString(),
      updatedAt: plan.updatedAt.toISOString(),
    };
  }

  private async mapHealthSnapshot(transaction: Prisma.TransactionClient, snapshotId: string) {
    const snapshot = await transaction.triangleHealthSnapshot.findFirstOrThrow({
      where: { id: snapshotId },
    });
    const components = await transaction.triangleHealthComponent.findMany({
      where: { tenantId: snapshot.tenantId, snapshotId },
    });
    return {
      id: snapshot.id,
      teamId: snapshot.teamId,
      teamRevision: snapshot.teamRevision,
      policyVersion: snapshot.policyVersion,
      score: snapshot.score.toNumber(),
      rating: snapshot.rating,
      periodStart: snapshot.periodStart.toISOString(),
      periodEnd: snapshot.periodEnd.toISOString(),
      components: components.map((item) => ({
        dimension: item.dimension,
        observedValue: item.observedValue.toNumber(),
        normalizedScore: item.normalizedScore.toNumber(),
        weight: item.weight.toNumber(),
        weightedScore: item.weightedScore.toNumber(),
      })),
      createdAt: snapshot.createdAt.toISOString(),
    };
  }

  private async organizationChangePolicyState(
    transaction: Prisma.TransactionClient,
    tenantId: string,
    proposalId: string,
  ) {
    const proposal = await transaction.organizationChangeProposal.findFirst({
      where: { tenantId, id: proposalId },
    });
    if (proposal === null) throw new NotFoundException('Organization Change was not found.');
    const report = await transaction.organizationImpactReport.findFirst({
      where: { tenantId, proposalId },
      orderBy: { proposalRevision: 'desc' },
    });
    const impacts =
      report === null
        ? []
        : await transaction.organizationImpactItem.findMany({
            where: { tenantId, reportId: report.id },
          });
    return {
      status: proposal.status,
      revision: proposal.revision,
      proposedByUserId: proposal.proposedByUserId,
      confirmedByUserId: proposal.confirmedByUserId,
      coveredImpactAreas: new Set(impacts.map((item) => item.area)),
      hasCriticalImpact: impacts.some((item) => item.risk === 'CRITICAL'),
    };
  }

  private async mapOrganizationChange(transaction: Prisma.TransactionClient, proposalId: string) {
    const proposal = await transaction.organizationChangeProposal.findFirstOrThrow({
      where: { id: proposalId },
    });
    const report = await transaction.organizationImpactReport.findFirst({
      where: { tenantId: proposal.tenantId, proposalId },
      orderBy: { proposalRevision: 'desc' },
    });
    const impacts =
      report === null
        ? []
        : await transaction.organizationImpactItem.findMany({
            where: { tenantId: proposal.tenantId, reportId: report.id },
          });
    return {
      id: proposal.id,
      type: proposal.type,
      subjectId: proposal.subjectId,
      status: proposal.status,
      effectiveAt: proposal.effectiveAt.toISOString(),
      reason: proposal.reason,
      proposedChange: jsonObject(proposal.proposedChange),
      impacts: impacts.map((item) => ({
        id: item.id,
        area: item.area,
        resourceType: item.resourceType,
        resourceId: item.resourceId,
        risk: item.risk,
        currentState: jsonObject(item.currentState),
        proposedState: jsonObject(item.proposedState),
        mitigation: item.mitigation,
      })),
      proposedByUserId: proposal.proposedByUserId,
      confirmedByUserId: proposal.confirmedByUserId,
      appliedByUserId: proposal.appliedByUserId,
      revision: proposal.revision,
      createdAt: proposal.createdAt.toISOString(),
      updatedAt: proposal.updatedAt.toISOString(),
    };
  }
}

function mapCompetencyDefinition(row: {
  id: string;
  code: string;
  name: string;
  category: 'KNOWLEDGE' | 'SKILL' | 'EXPERIENCE' | 'BEHAVIOR' | 'TOOL';
  description: string;
  status: 'ACTIVE' | 'RETIRED';
  revision: number;
  currentVersionId: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapCompetencyEvidence(row: {
  id: string;
  subjectUserId: string;
  competencyVersionId: string;
  demonstratedLevel: number;
  evidenceId: string;
  evidenceVersion: number;
  taskId: string | null;
  taskVersion: number | null;
  deliverableId: string | null;
  deliverableVersion: number | null;
  metricObservationId: string | null;
  metricObservationVersion: number | null;
  reviewReference: string | null;
  validFrom: Date;
  validUntil: Date | null;
  createdAt: Date;
}) {
  return {
    id: row.id,
    subjectUserId: row.subjectUserId,
    competencyVersionId: row.competencyVersionId,
    demonstratedLevel: row.demonstratedLevel,
    evidenceId: row.evidenceId,
    evidenceVersion: row.evidenceVersion,
    taskId: row.taskId,
    taskVersion: row.taskVersion,
    deliverableId: row.deliverableId,
    deliverableVersion: row.deliverableVersion,
    metricObservationId: row.metricObservationId,
    metricObservationVersion: row.metricObservationVersion,
    reviewReference: row.reviewReference,
    validFrom: row.validFrom.toISOString(),
    validUntil: row.validUntil?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

function mapAppeal(row: {
  id: string;
  assessmentId: string;
  subjectUserId: string;
  status: 'OPEN' | 'UNDER_REVIEW' | 'UPHELD' | 'OVERTURNED' | 'CLOSED';
  reason: string;
  resolution: string | null;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: row.id,
    assessmentId: row.assessmentId,
    subjectUserId: row.subjectUserId,
    status: row.status,
    reason: row.reason,
    resolution: row.resolution,
    revision: row.revision,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapGap(row: {
  id: string;
  assessmentId: string;
  roleRequirementId: string;
  requiredLevel: number;
  effectiveLevel: number;
  gap: number;
  attributionSummary: string;
  version: number;
  createdAt: Date;
}) {
  return { ...row, createdAt: row.createdAt.toISOString() };
}

function mapDevelopmentAction(row: {
  id: string;
  type: 'PRACTICE_TASK' | 'COURSE' | 'MENTORING' | 'SHADOWING' | 'ASSESSMENT';
  title: string;
  description: string;
  linkedTaskId: string | null;
  linkedTaskVersion: number | null;
  mentorUserId: string | null;
  dueAt: Date;
  verificationMethod: string;
  verificationEvidenceId: string | null;
  verificationEvidenceVersion: number | null;
  status: 'PLANNED' | 'ACTIVE' | 'COMPLETED' | 'CANCELLED';
  revision: number;
}) {
  return { ...row, dueAt: row.dueAt.toISOString() };
}

function jsonStringArray(value: Prisma.JsonValue): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : [];
}

function jsonNumberRecord(
  value: Prisma.JsonValue,
): Record<
  | 'TASK_RESPONSE_LATENCY'
  | 'INPUT_OUTPUT_COMPLETENESS'
  | 'PROCESS_RETURN_RATE'
  | 'COMMITMENT_FULFILLMENT'
  | 'CUSTOMER_CLOSURE'
  | 'SHARED_OBJECTIVE_RESULT',
  number
> {
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    throw new UnprocessableEntityException('Triangle health policy is invalid.');
  }
  const result = Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, Number(item)]),
  );
  return result as ReturnType<typeof jsonNumberRecord>;
}

function jsonObject(value: Prisma.JsonValue): Record<string, unknown> {
  return value !== null && !Array.isArray(value) && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}
