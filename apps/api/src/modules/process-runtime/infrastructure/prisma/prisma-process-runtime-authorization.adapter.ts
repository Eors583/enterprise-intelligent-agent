import { randomUUID } from 'node:crypto';

import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../../../database/prisma.service.js';
import {
  ProcessRuntimeAuthorizationPort,
  type TrustedProcessStepActorResolution,
} from '../../process-runtime-authorization.port.js';

const HUMAN_COMMANDS = new Set(['CLAIM', 'COMPLETE', 'REJECT']);

@Injectable()
export class PrismaProcessRuntimeAuthorizationAdapter extends ProcessRuntimeAuthorizationPort {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {
    super();
  }

  async resolveStepActor(
    input: Parameters<ProcessRuntimeAuthorizationPort['resolveStepActor']>[0],
  ): Promise<TrustedProcessStepActorResolution> {
    return this.prisma.withTenant(input.principal.tenantId, async (transaction) => {
      const rows = await transaction.$queryRaw<StepAuthorizationRow[]>(Prisma.sql`
          SELECT
            step."id",
            node."type"::text AS node_type,
            step."resolved_role_assignment_id",
            assignment."user_id" AS assignment_user_id,
            assignment."status"::text AS assignment_status,
            assignment."effective_from",
            assignment."effective_to",
            employment."status"::text AS employment_status,
            unit."status"::text AS org_unit_status,
            version."status"::text AS role_version_status
          FROM public."process_step_instances" step
          JOIN public."process_nodes" node
            ON node."tenant_id" = step."tenant_id"
           AND node."id" = step."process_node_id"
          LEFT JOIN public."role_assignments" assignment
            ON assignment."tenant_id" = step."tenant_id"
           AND assignment."id" = step."resolved_role_assignment_id"
          LEFT JOIN public."employments" employment
            ON employment."tenant_id" = assignment."tenant_id"
           AND employment."id" = assignment."employment_id"
          LEFT JOIN public."organization_units" unit
            ON unit."tenant_id" = employment."tenant_id"
           AND unit."id" = employment."org_unit_id"
          LEFT JOIN public."agent_versions" version
            ON version."tenant_id" = assignment."tenant_id"
           AND version."id" = assignment."role_version_id"
          WHERE step."tenant_id" = ${input.principal.tenantId}::uuid
            AND step."process_instance_id" = ${input.processInstanceId}::uuid
            AND step."id" = ${input.stepInstanceId}::uuid
          LIMIT 1
        `);
      const row = rows[0];
      if (row === undefined) {
        throw new NotFoundException('Process Step was not found.');
      }
      const decisionId = `authz_${randomUUID()}`;
      if (!HUMAN_COMMANDS.has(input.command)) {
        return { actorRoleAssignmentId: null, decisionId };
      }
      const effectiveAt = new Date(input.effectiveAt);
      if (
        row.node_type !== 'HUMAN_APPROVAL' ||
        row.resolved_role_assignment_id === null ||
        row.assignment_user_id !== input.principal.userId ||
        row.assignment_status !== 'ACTIVE' ||
        row.employment_status !== 'ACTIVE' ||
        row.org_unit_status !== 'ACTIVE' ||
        (row.role_version_status !== 'PUBLISHED' && row.role_version_status !== 'RETIRED') ||
        row.effective_from === null ||
        row.effective_from.getTime() > effectiveAt.getTime() ||
        (row.effective_to !== null && row.effective_to.getTime() <= effectiveAt.getTime())
      ) {
        throw new ForbiddenException({
          statusCode: 403,
          error: 'Forbidden',
          message: 'The current user is not the effective human actor for this Process Step.',
          decisionId,
        });
      }
      return {
        actorRoleAssignmentId: row.resolved_role_assignment_id,
        decisionId,
      };
    });
  }
}

interface StepAuthorizationRow {
  readonly id: string;
  readonly node_type: string;
  readonly resolved_role_assignment_id: string | null;
  readonly assignment_user_id: string | null;
  readonly assignment_status: string | null;
  readonly effective_from: Date | null;
  readonly effective_to: Date | null;
  readonly employment_status: string | null;
  readonly org_unit_status: string | null;
  readonly role_version_status: string | null;
}
