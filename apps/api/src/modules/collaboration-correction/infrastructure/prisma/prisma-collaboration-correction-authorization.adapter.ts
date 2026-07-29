import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { CorrectionCase, CorrectionFeedbackRequest } from '@enterprise/contracts';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../../../database/prisma.service.js';
import { loadBusinessSemanticAuthorizationIdentity } from '../../../authorization/business-semantics-authorization.context.js';
import {
  businessSemanticFiltersFromDecision,
  evaluateBusinessSemanticAuthorization,
  isBusinessSemanticResourceVisible,
} from '../../../authorization/domain/business-semantics.authorization.js';
import { semanticResource } from '../../../business-semantics/business-semantics-policy.service.js';
import type {
  CorrectionFeedbackContext,
  TrustedCorrectionRoleAssignment,
} from '../../../process-orchestration/domain/correction-state-machine.js';
import {
  CollaborationCorrectionAuthorizationPort,
  type AuthorizedRuntimeTaskScope,
} from '../../collaboration-correction-authorization.port.js';

@Injectable()
export class PrismaCollaborationCorrectionAuthorizationAdapter extends CollaborationCorrectionAuthorizationPort {
  private readonly logger = new Logger(PrismaCollaborationCorrectionAuthorizationAdapter.name);

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {
    super();
  }

  async requireTaskAccess(
    input: Parameters<CollaborationCorrectionAuthorizationPort['requireTaskAccess']>[0],
  ): Promise<AuthorizedRuntimeTaskScope> {
    return this.prisma.withTenant(input.principal.tenantId, async (transaction) => {
      const task = await transaction.task.findFirst({
        where: {
          tenantId: input.principal.tenantId,
          id: input.taskId,
        },
      });
      if (task === null) throw new NotFoundException('Task was not found.');
      const policyPrincipal = {
        tenantId: input.principal.tenantId,
        userId: input.principal.userId,
        tenantRole: input.principal.tenantRole,
      };
      const identity = await loadBusinessSemanticAuthorizationIdentity(
        transaction,
        policyPrincipal,
      );
      const resource = semanticResource('TASK', task, { taskId: task.id });
      const policyAction = taskPolicyAction(input.action);
      const decision = evaluateBusinessSemanticAuthorization({
        principal: policyPrincipal,
        action: policyAction,
        resourceTenantId: input.principal.tenantId,
        resource,
        employments: identity.employments,
        assignments: identity.assignments,
        ...(policyAction === 'business.task.execute'
          ? {
              mutation: {
                proposedTenantId: task.tenantId,
                proposedOwner: resource.owner ?? null,
                proposedTaskId: task.id,
                proposedPermissionLabels: resource.permissionLabels ?? [],
              },
            }
          : {}),
      });
      this.logDecision(input, decision);
      if (!decision.allowed) {
        throw new ForbiddenException({
          statusCode: 403,
          error: 'Forbidden',
          message: 'The requested Task runtime data is not authorized.',
          reasonCode: decision.reasonCode,
          decisionId: decision.decisionId,
        });
      }
      const filter = businessSemanticFiltersFromDecision(decision);
      if (!isBusinessSemanticResourceVisible(resource, filter)) {
        throw new ForbiddenException('The requested Task runtime data is not authorized.');
      }
      return {
        tenantId: filter.tenantId,
        userId: filter.userId,
        taskId: input.taskId,
        decisionId: decision.decisionId,
        managementBypass: filter.managementBypass,
        roleAssignmentIds: unique(filter.grants.map((grant) => grant.assignmentId)),
        organizationIds: unique(
          filter.grants.flatMap((grant) => [...grant.organizationIds, ...grant.orgUnitIds]),
        ),
        projectIds: unique(filter.grants.flatMap((grant) => grant.projectIds)),
        permissionLabelScopes: filter.grants.map((grant) => unique(grant.permissionLabels)),
        permissionLabels: unique(filter.grants.flatMap((grant) => grant.permissionLabels)),
      };
    });
  }

  async buildCorrectionFeedbackContext(
    input: Parameters<
      CollaborationCorrectionAuthorizationPort['buildCorrectionFeedbackContext']
    >[0],
  ): Promise<CorrectionFeedbackContext> {
    const effectiveAt = new Date(input.feedback.effectiveAt);
    const now = new Date();
    if (
      !Number.isFinite(effectiveAt.getTime()) ||
      Math.abs(effectiveAt.getTime() - now.getTime()) > 5 * 60 * 1_000
    ) {
      throw new UnprocessableEntityException(
        'Correction feedback effectiveAt must be within five minutes of server time.',
      );
    }
    return this.prisma.withTenant(input.principal.tenantId, async (transaction) => {
      const assignments = await transaction.roleAssignment.findMany({
        where: {
          tenantId: input.principal.tenantId,
          userId: input.principal.userId,
        },
        include: {
          employment: { include: { orgUnit: true } },
          roleVersion: true,
        },
        orderBy: { id: 'asc' },
      });
      const subject = await transaction.roleAssignment.findFirst({
        where: {
          tenantId: input.principal.tenantId,
          id: input.correction.roleAssignmentId,
        },
        select: { id: true, tenantId: true, userId: true },
      });
      if (subject === null) {
        throw new ForbiddenException('The Correction subject Role Assignment is unavailable.');
      }
      const usable = assignments.filter(
        (assignment) =>
          input.scope.managementBypass || input.scope.roleAssignmentIds.includes(assignment.id),
      );
      const actor = chooseCorrectionActor(
        usable.map(mapTrustedCorrectionAssignment),
        input.correction,
        input.feedback,
        input.principal.userId,
      );

      const linkedRows = await transaction.$queryRaw<Array<{ evidence_id: string }>>`
          SELECT "evidence_id"
          FROM public."correction_case_evidence"
          WHERE "tenant_id" = ${input.principal.tenantId}::uuid
            AND "correction_case_id" = ${input.correction.id}::uuid
        `;
      const linkedIds = new Set(linkedRows.map((row) => row.evidence_id));
      const evidence = await transaction.evidence.findMany({
        where: {
          tenantId: input.principal.tenantId,
          id: { in: input.feedback.evidenceIds },
        },
      });
      const policyPrincipal = {
        tenantId: input.principal.tenantId,
        userId: input.principal.userId,
        tenantRole: input.principal.tenantRole,
      };
      const identity = await loadBusinessSemanticAuthorizationIdentity(
        transaction,
        policyPrincipal,
      );
      return {
        actor: {
          type: 'USER',
          tenantId: input.principal.tenantId,
          userId: input.principal.userId,
          roleAssignment: actor,
        },
        subjectRoleAssignment: subject,
        evidence: evidence.map((item) => {
          const resource = semanticResource('EVIDENCE', item);
          const decision = evaluateBusinessSemanticAuthorization({
            principal: policyPrincipal,
            action: 'business.evidence.read',
            resourceTenantId: input.principal.tenantId,
            resource,
            employments: identity.employments,
            assignments: identity.assignments,
          });
          const visible =
            decision.allowed &&
            isBusinessSemanticResourceVisible(
              resource,
              businessSemanticFiltersFromDecision(decision),
            );
          return {
            id: item.id,
            tenantId: item.tenantId,
            active:
              item.status === 'ACTIVE' &&
              item.effectiveFrom.getTime() <= effectiveAt.getTime() &&
              (item.effectiveTo === null || item.effectiveTo.getTime() > effectiveAt.getTime()),
            sealed: /^[0-9a-f]{64}$/.test(item.contentHash),
            visibleToActor: visible,
            linkedToCorrection: linkedIds.has(item.id),
          };
        }),
        now,
      };
    });
  }

  private logDecision(
    input: Parameters<CollaborationCorrectionAuthorizationPort['requireTaskAccess']>[0],
    decision: {
      readonly decisionId: string;
      readonly effect: string;
      readonly reasonCode: string;
      readonly obligations: readonly { readonly type: string }[];
    },
  ): void {
    this.logger.log(
      JSON.stringify({
        event: 'runtime_task.authorization_decision',
        decisionId: decision.decisionId,
        effect: decision.effect,
        reasonCode: decision.reasonCode,
        tenantId: input.principal.tenantId,
        userId: input.principal.userId,
        taskId: input.taskId,
        action: input.action,
        obligationTypes: decision.obligations.map((obligation) => obligation.type),
      }),
    );
  }
}

function taskPolicyAction(
  action: Parameters<CollaborationCorrectionAuthorizationPort['requireTaskAccess']>[0]['action'],
): 'business.task.read' | 'business.task.execute' {
  return ['collaboration.create', 'collaboration.command', 'correction.feedback'].includes(action)
    ? 'business.task.execute'
    : 'business.task.read';
}

function chooseCorrectionActor(
  assignments: readonly TrustedCorrectionRoleAssignment[],
  correction: CorrectionCase,
  feedback: CorrectionFeedbackRequest,
  userId: string,
): TrustedCorrectionRoleAssignment | null {
  const subject = assignments.find(
    (assignment) => assignment.id === correction.roleAssignmentId && assignment.userId === userId,
  );
  const reviewer = assignments.find((assignment) =>
    correction.requiredRoleAssignmentIds.includes(assignment.id),
  );
  const highImpact =
    correction.severity === 'HIGH' ||
    correction.severity === 'CRITICAL' ||
    correction.category === 'CAPABILITY_RISK';
  if (
    feedback.action === 'ACCEPT' ||
    feedback.action === 'RESOLVE' ||
    feedback.action === 'CANCEL' ||
    (feedback.action === 'REJECT' && highImpact)
  ) {
    return reviewer ?? null;
  }
  return subject ?? reviewer ?? null;
}

function mapTrustedCorrectionAssignment(
  assignment: Prisma.RoleAssignmentGetPayload<{
    include: {
      employment: { include: { orgUnit: true } };
      roleVersion: true;
    };
  }>,
): TrustedCorrectionRoleAssignment {
  return {
    id: assignment.id,
    tenantId: assignment.tenantId,
    userId: assignment.userId,
    status: assignment.status,
    employmentStatus: assignment.employment.status,
    orgUnitStatus: assignment.employment.orgUnit.status,
    roleVersionStatus: assignment.roleVersion.status,
    effectiveFrom: assignment.effectiveFrom,
    effectiveTo: assignment.effectiveTo,
  };
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}
