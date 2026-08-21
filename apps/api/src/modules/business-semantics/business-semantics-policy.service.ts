import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { businessPermissionLabelsSchema } from '@enterprise/contracts';
import type { Prisma } from '@prisma/client';

import type { AdminPrincipal } from '../admin/admin-access.service.js';
import type { TenantPrincipal } from '../../common/context/tenant-context.js';
import { loadBusinessSemanticAuthorizationIdentity } from '../authorization/business-semantics-authorization.context.js';
import {
  businessSemanticFiltersFromDecision,
  evaluateBusinessSemanticAuthorization,
  evaluateBusinessSemanticTraceAuthorization,
  type BusinessSemanticMutation,
  type BusinessSemanticEmployeeWriteAction,
  type BusinessSemanticReadAction,
  type BusinessSemanticResource,
  type BusinessSemanticResourceFilter,
  type BusinessSemanticResourceType,
  type BusinessSemanticWriteAction,
} from '../authorization/domain/business-semantics.authorization.js';
import { businessOwnerFromColumns } from './business-semantics.persistence.js';

@Injectable()
export class BusinessSemanticsPolicyService {
  private readonly logger = new Logger(BusinessSemanticsPolicyService.name);

  async requireWrite(
    transaction: Prisma.TransactionClient,
    principal: AdminPrincipal,
    action: BusinessSemanticWriteAction,
    input: {
      readonly resource?: BusinessSemanticResource | null;
      readonly mutation: BusinessSemanticMutation;
    },
  ): Promise<void> {
    const policyPrincipal = {
      tenantId: principal.tenantId,
      userId: principal.userId,
      tenantRole: principal.role,
    };
    const identity = await loadBusinessSemanticAuthorizationIdentity(transaction, policyPrincipal);
    const decision = evaluateBusinessSemanticAuthorization({
      principal: policyPrincipal,
      action,
      resourceTenantId: principal.tenantId,
      resource: input.resource ?? null,
      employments: identity.employments,
      assignments: identity.assignments,
      mutation: input.mutation,
    });
    this.logger.log(
      JSON.stringify({
        event: 'business_semantics.authorization_decision',
        decisionId: decision.decisionId,
        effect: decision.effect,
        reasonCode: decision.reasonCode,
        tenantId: principal.tenantId,
        userId: principal.userId,
        action,
        resourceId: input.resource?.id ?? null,
        obligationTypes: decision.obligations.map((obligation) => obligation.type),
        evaluatedAt: decision.evaluatedAt,
      }),
    );
    if (!decision.allowed) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        message: 'The requested business semantic mutation is not authorized.',
        reasonCode: decision.reasonCode,
        decisionId: decision.decisionId,
      });
    }
  }

  async requireReadFilter(
    transaction: Prisma.TransactionClient,
    principal: TenantPrincipal,
    action: BusinessSemanticReadAction,
  ): Promise<BusinessSemanticResourceFilter> {
    const policyPrincipal = {
      tenantId: principal.tenantId,
      userId: principal.userId,
      tenantRole: principal.role,
    };
    const identity = await loadBusinessSemanticAuthorizationIdentity(transaction, policyPrincipal);
    const decision = evaluateBusinessSemanticAuthorization({
      principal: policyPrincipal,
      action,
      resourceTenantId: principal.tenantId,
      employments: identity.employments,
      assignments: identity.assignments,
    });
    this.logDecision(principal, action, decision, null);
    if (!decision.allowed) this.throwDenied(decision);
    return businessSemanticFiltersFromDecision(decision);
  }

  async requireEmployeeWrite(
    transaction: Prisma.TransactionClient,
    principal: TenantPrincipal,
    action: BusinessSemanticEmployeeWriteAction,
    input: {
      readonly roleAssignmentId: string;
      readonly resource?: BusinessSemanticResource | null;
      readonly mutation: BusinessSemanticMutation;
    },
  ): Promise<{ readonly decisionId: string; readonly roleAssignmentId: string }> {
    const policyPrincipal = {
      tenantId: principal.tenantId,
      userId: principal.userId,
      tenantRole: principal.role,
    };
    const identity = await loadBusinessSemanticAuthorizationIdentity(transaction, policyPrincipal);
    const claimedAssignment = identity.assignments.find(
      (assignment) => assignment.id === input.roleAssignmentId,
    );
    if (claimedAssignment === undefined) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        message: 'The claimed Role Assignment is not active for this principal.',
        reasonCode: 'ASSIGNMENT_NOT_ACTIVE',
      });
    }
    const decision = evaluateBusinessSemanticAuthorization({
      principal: policyPrincipal,
      action,
      resourceTenantId: principal.tenantId,
      resource: input.resource ?? null,
      employments: identity.employments,
      assignments: [claimedAssignment],
      mutation: input.mutation,
    });
    this.logDecision(principal, action, decision, input.resource?.id ?? null);
    if (!decision.allowed) this.throwDenied(decision);
    return {
      decisionId: decision.decisionId,
      roleAssignmentId: input.roleAssignmentId,
    };
  }

  async listEmployeeWriteRoleAssignments(
    transaction: Prisma.TransactionClient,
    principal: TenantPrincipal,
    action: BusinessSemanticEmployeeWriteAction,
    input: {
      readonly resource?: BusinessSemanticResource | null;
      readonly mutation: BusinessSemanticMutation;
    },
  ): Promise<readonly string[]> {
    const policyPrincipal = {
      tenantId: principal.tenantId,
      userId: principal.userId,
      tenantRole: principal.role,
    };
    const identity = await loadBusinessSemanticAuthorizationIdentity(transaction, policyPrincipal);
    const allowed: string[] = [];
    for (const assignment of identity.assignments) {
      const decision = evaluateBusinessSemanticAuthorization({
        principal: policyPrincipal,
        action,
        resourceTenantId: principal.tenantId,
        resource: input.resource ?? null,
        employments: identity.employments,
        assignments: [assignment],
        mutation: input.mutation,
      });
      if (decision.allowed) allowed.push(assignment.id);
    }
    return [...new Set(allowed)].sort();
  }

  async requireCompleteTrace(
    transaction: Prisma.TransactionClient,
    principal: TenantPrincipal,
    nodes: readonly BusinessSemanticResource[],
  ): Promise<void> {
    const policyPrincipal = {
      tenantId: principal.tenantId,
      userId: principal.userId,
      tenantRole: principal.role,
    };
    const identity = await loadBusinessSemanticAuthorizationIdentity(transaction, policyPrincipal);
    const decision = evaluateBusinessSemanticTraceAuthorization({
      principal: policyPrincipal,
      action: 'business.trace.read',
      resourceTenantId: principal.tenantId,
      employments: identity.employments,
      assignments: identity.assignments,
      nodes,
    });
    this.logDecision(principal, 'business.trace.read', decision, null);
    if (!decision.allowed) this.throwDenied(decision);
  }

  private logDecision(
    principal: Pick<TenantPrincipal, 'tenantId' | 'userId'>,
    action: string,
    decision: {
      readonly decisionId: string;
      readonly effect: string;
      readonly reasonCode: string;
      readonly obligations: readonly { readonly type: string }[];
      readonly evaluatedAt: string;
    },
    resourceId: string | null,
  ): void {
    this.logger.log(
      JSON.stringify({
        event: 'business_semantics.authorization_decision',
        decisionId: decision.decisionId,
        effect: decision.effect,
        reasonCode: decision.reasonCode,
        tenantId: principal.tenantId,
        userId: principal.userId,
        action,
        resourceId,
        obligationTypes: decision.obligations.map((obligation) => obligation.type),
        evaluatedAt: decision.evaluatedAt,
      }),
    );
  }

  private throwDenied(decision: {
    readonly reasonCode: string;
    readonly decisionId: string;
  }): never {
    throw new ForbiddenException({
      statusCode: 403,
      error: 'Forbidden',
      message: 'The requested business semantic resource is not authorized.',
      reasonCode: decision.reasonCode,
      decisionId: decision.decisionId,
    });
  }
}

export function semanticResource(
  type: BusinessSemanticResourceType,
  record: {
    readonly id: string;
    readonly tenantId: string;
    readonly ownerUserId: string | null;
    readonly ownerRoleAssignmentId: string | null;
    readonly ownerRoleTemplateId: string | null;
    readonly ownerOrgUnitId: string | null;
    readonly permissionLabels: unknown;
  },
  scope: {
    readonly responsibleRoleAssignmentIds?: readonly string[];
    readonly organizationId?: string | null;
    readonly projectId?: string | null;
    readonly taskId?: string | null;
  } = {},
): BusinessSemanticResource {
  return {
    id: record.id,
    tenantId: record.tenantId,
    type,
    owner: businessOwnerFromColumns(record),
    permissionLabels: businessPermissionLabelsSchema.parse(record.permissionLabels),
    ...(scope.responsibleRoleAssignmentIds === undefined
      ? {}
      : {
          responsibleRoleAssignmentIds: [...scope.responsibleRoleAssignmentIds],
        }),
    ...(scope.organizationId === undefined ? {} : { organizationId: scope.organizationId }),
    ...(scope.projectId === undefined ? {} : { projectId: scope.projectId }),
    ...(scope.taskId === undefined ? {} : { taskId: scope.taskId }),
  };
}
