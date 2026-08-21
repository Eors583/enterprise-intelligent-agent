import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import type { TrustedExperienceActor } from '../../domain/experience-state-machine.js';
import type {
  TrustedMemoryAssignment,
  TrustedMemoryGrant,
} from '../../domain/memory-access.policy.js';
import {
  MemoryExperienceAuthorizationPort,
  type ResolveExperienceActorInput,
  type ResolveMemoryAccessInput,
} from '../../memory-experience-authorization.port.js';
import { PrismaService } from '../../../../database/prisma.service.js';
import { stringArray } from '../../../process-orchestration/infrastructure/prisma/runtime-prisma.support.js';

const ALL_EXPERIENCE_PERMISSIONS: TrustedExperienceActor['permissions'] = [
  'EXPERIENCE_SANITIZE',
  'EXPERIENCE_STRUCTURE',
  'EXPERIENCE_REVIEW',
  'EXPERIENCE_VALIDATE',
  'EXPERIENCE_PUBLISH',
  'EXPERIENCE_MONITOR',
  'EXPERIENCE_RETIRE',
];

@Injectable()
export class PrismaMemoryExperienceAuthorizationAdapter extends MemoryExperienceAuthorizationPort {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {
    super();
  }

  async resolveMemoryAccess(input: ResolveMemoryAccessInput) {
    return this.prisma.withTenant(input.principal.tenantId, async (transaction) => {
      const assignments = await transaction.$queryRaw<AssignmentRow[]>(Prisma.sql`
        SELECT
          assignment."id",
          assignment."tenant_id",
          assignment."user_id",
          assignment."role_template_id",
          assignment."role_version_id",
          assignment."status"::text AS assignment_status,
          assignment."permission_scope",
          assignment."memory_policy",
          assignment."effective_from",
          assignment."effective_to",
          employment."status"::text AS employment_status,
          unit."status"::text AS org_unit_status,
          version."status"::text AS role_version_status
        FROM public."role_assignments" assignment
        JOIN public."employments" employment
          ON employment."tenant_id" = assignment."tenant_id"
         AND employment."id" = assignment."employment_id"
         AND employment."user_id" = assignment."user_id"
        JOIN public."org_units" unit
          ON unit."tenant_id" = employment."tenant_id"
         AND unit."id" = employment."org_unit_id"
        JOIN public."agent_versions" version
          ON version."tenant_id" = assignment."tenant_id"
         AND version."template_id" = assignment."role_template_id"
         AND version."id" = assignment."role_version_id"
        WHERE assignment."tenant_id" = ${input.principal.tenantId}::uuid
          AND assignment."user_id" = ${input.principal.userId}::uuid
          AND assignment."status" = 'ACTIVE'
          AND employment."status" = 'ACTIVE'
          AND unit."status" = 'ACTIVE'
          AND version."status" IN ('PUBLISHED', 'RETIRED')
          AND assignment."effective_from" <= ${input.now}
          AND (
            assignment."effective_to" IS NULL
            OR assignment."effective_to" > ${input.now}
          )
        ORDER BY assignment."effective_from" DESC, assignment."id"
        LIMIT 500
      `);
      const activeEmployeeRows = await transaction.$queryRaw<Array<{ active: boolean }>>(
        Prisma.sql`
          SELECT EXISTS (
            SELECT 1
            FROM public."users" account
            JOIN public."employments" employment
              ON employment."tenant_id" = account."tenant_id"
             AND employment."user_id" = account."id"
            JOIN public."org_units" unit
              ON unit."tenant_id" = employment."tenant_id"
             AND unit."id" = employment."org_unit_id"
            WHERE account."tenant_id" = ${input.principal.tenantId}::uuid
              AND account."id" = ${input.principal.userId}::uuid
              AND account."status" = 'ACTIVE'
              AND employment."status" = 'ACTIVE'
              AND unit."status" = 'ACTIVE'
          ) AS active
        `,
      );
      const activeEmployee = activeEmployeeRows[0]?.active === true;
      const grants: TrustedMemoryGrant[] = [];

      if (activeEmployee && input.operation === 'READ') {
        grants.push(baseGrant(input, 'enterprise', 'ENTERPRISE', []));
      }
      if (
        input.principal.tenantRole === 'OWNER' ||
        input.principal.tenantRole === 'ADMIN' ||
        input.principal.tenantRole === 'KNOWLEDGE_ADMIN'
      ) {
        grants.push(baseGrant(input, 'enterprise-admin', 'ENTERPRISE', ['*']));
        grants.push(baseGrant(input, 'governance', 'GOVERNANCE', ['*']));
      }

      const trustedAssignments = assignments.map(mapAssignment);
      for (const [index, assignment] of trustedAssignments.entries()) {
        const labels = memoryLabels(assignments[index]!);
        grants.push({
          ...baseGrant(input, `role:${assignment.id}`, 'ROLE', labels),
          roleAssignmentId: assignment.id,
          roleTemplateId: assignment.roleTemplateId,
          roleVersionId: assignment.roleVersionId,
          assignment,
        });
        grants.push({
          ...baseGrant(input, `private:${assignment.id}`, 'EMPLOYEE_PRIVATE', labels),
          roleAssignmentId: assignment.id,
          roleTemplateId: assignment.roleTemplateId,
          roleVersionId: assignment.roleVersionId,
          assignment,
        });
      }

      const tasks = await transaction.$queryRaw<TaskGrantRow[]>(Prisma.sql`
        SELECT DISTINCT task."id", task."permission_labels"
        FROM public."tasks" task
        WHERE task."tenant_id" = ${input.principal.tenantId}::uuid
          AND task."effective_from" <= ${input.now}
          AND (task."effective_to" IS NULL OR task."effective_to" > ${input.now})
          AND task."status" <> 'CANCELLED'
          AND (
            task."owner_user_id" = ${input.principal.userId}::uuid
            OR EXISTS (
              SELECT 1
              FROM public."role_assignments" task_assignment
              WHERE task_assignment."tenant_id" = task."tenant_id"
                AND task_assignment."id" = task."owner_role_assignment_id"
                AND task_assignment."user_id" = ${input.principal.userId}::uuid
                AND task_assignment."status" = 'ACTIVE'
                AND task_assignment."effective_from" <= ${input.now}
                AND (
                  task_assignment."effective_to" IS NULL
                  OR task_assignment."effective_to" > ${input.now}
                )
            )
            OR EXISTS (
              SELECT 1
              FROM public."objective_role_assignments" objective_assignment
              JOIN public."role_assignments" objective_actor
                ON objective_actor."tenant_id" = objective_assignment."tenant_id"
               AND objective_actor."id" = objective_assignment."role_assignment_id"
              WHERE objective_assignment."tenant_id" = task."tenant_id"
                AND objective_assignment."objective_id" = task."objective_id"
                AND objective_assignment."objective_version" = task."objective_version"
                AND objective_actor."user_id" = ${input.principal.userId}::uuid
                AND objective_actor."status" = 'ACTIVE'
                AND objective_actor."effective_from" <= ${input.now}
                AND (
                  objective_actor."effective_to" IS NULL
                  OR objective_actor."effective_to" > ${input.now}
                )
            )
          )
        ORDER BY task."id"
        LIMIT 500
      `);
      for (const task of tasks) {
        grants.push({
          ...baseGrant(input, `task:${task.id}`, 'TASK', stringArray(task.permission_labels)),
          taskId: task.id,
        });
      }

      const conversations = await transaction.$queryRaw<ConversationGrantRow[]>(Prisma.sql`
        SELECT participant."conversation_id"
        FROM public."conversation_participants" participant
        WHERE participant."tenant_id" = ${input.principal.tenantId}::uuid
          AND participant."user_id" = ${input.principal.userId}::uuid
          AND participant."left_at" IS NULL
        ORDER BY participant."conversation_id"
        LIMIT 500
      `);
      for (const conversation of conversations) {
        grants.push({
          ...baseGrant(input, `conversation:${conversation.conversation_id}`, 'CONVERSATION', []),
          conversationId: conversation.conversation_id,
        });
      }

      return {
        tenantId: input.principal.tenantId,
        userId: input.principal.userId,
        operation: input.operation,
        purpose: input.purpose,
        grants,
        now: input.now,
      };
    });
  }

  async resolveExperienceActor(
    input: ResolveExperienceActorInput,
  ): Promise<TrustedExperienceActor> {
    return this.prisma.withTenant(input.principal.tenantId, async (transaction) => {
      const tasks = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT task."id"
        FROM public."tasks" task
        WHERE task."tenant_id" = ${input.principal.tenantId}::uuid
          AND task."id" = ${input.taskId}::uuid
        LIMIT 1
      `);
      if (tasks[0] === undefined) throw new NotFoundException('Source Task was not found.');
      const rows = await transaction.$queryRaw<AssignmentRow[]>(Prisma.sql`
        SELECT
          assignment."id",
          assignment."tenant_id",
          assignment."user_id",
          assignment."role_template_id",
          assignment."role_version_id",
          assignment."status"::text AS assignment_status,
          assignment."permission_scope",
          assignment."memory_policy",
          assignment."effective_from",
          assignment."effective_to",
          employment."status"::text AS employment_status,
          unit."status"::text AS org_unit_status,
          version."status"::text AS role_version_status
        FROM public."role_assignments" assignment
        JOIN public."employments" employment
          ON employment."tenant_id" = assignment."tenant_id"
         AND employment."id" = assignment."employment_id"
         AND employment."user_id" = assignment."user_id"
        JOIN public."org_units" unit
          ON unit."tenant_id" = employment."tenant_id"
         AND unit."id" = employment."org_unit_id"
        JOIN public."agent_versions" version
          ON version."tenant_id" = assignment."tenant_id"
         AND version."template_id" = assignment."role_template_id"
         AND version."id" = assignment."role_version_id"
        LEFT JOIN public."tasks" task
          ON task."tenant_id" = assignment."tenant_id"
         AND task."id" = ${input.taskId}::uuid
        WHERE assignment."tenant_id" = ${input.principal.tenantId}::uuid
          AND assignment."user_id" = ${input.principal.userId}::uuid
          AND assignment."status" = 'ACTIVE'
          AND employment."status" = 'ACTIVE'
          AND unit."status" = 'ACTIVE'
          AND version."status" IN ('PUBLISHED', 'RETIRED')
          AND assignment."effective_from" <= ${input.now}
          AND (
            assignment."effective_to" IS NULL
            OR assignment."effective_to" > ${input.now}
          )
        ORDER BY
          (task."owner_role_assignment_id" = assignment."id") DESC,
          assignment."effective_from" DESC,
          assignment."id"
        LIMIT 1
      `);
      const row = rows[0];
      if (row === undefined) {
        throw new ForbiddenException(
          'Experience governance requires an active trusted Role Assignment.',
        );
      }
      const configured = configuredExperiencePermissions(row);
      const privileged =
        input.principal.tenantRole === 'OWNER' ||
        input.principal.tenantRole === 'ADMIN' ||
        input.principal.tenantRole === 'KNOWLEDGE_ADMIN';
      const permissions = privileged ? ALL_EXPERIENCE_PERMISSIONS : configured;
      if (
        input.action !== 'CONTRIBUTE' &&
        !permissions.includes(requiredPermission(input.action))
      ) {
        throw new ForbiddenException(
          'The trusted Role Assignment lacks the required experience permission.',
        );
      }
      return {
        tenantId: row.tenant_id,
        userId: row.user_id,
        roleAssignmentId: row.id,
        assignmentStatus: row.assignment_status,
        employmentStatus: row.employment_status,
        permissions,
        effectiveFrom: row.effective_from,
        effectiveTo: row.effective_to,
      };
    });
  }
}

function baseGrant(
  input: ResolveMemoryAccessInput,
  id: string,
  scope: TrustedMemoryGrant['scope'],
  permissionLabels: readonly string[],
): TrustedMemoryGrant {
  return {
    id,
    tenantId: input.principal.tenantId,
    userId: input.principal.userId,
    scope,
    roleAssignmentId: null,
    roleTemplateId: null,
    roleVersionId: null,
    taskId: null,
    conversationId: null,
    permissionLabels,
    assignment: null,
    effectiveFrom: input.now,
    effectiveTo: null,
  };
}

function mapAssignment(row: AssignmentRow): TrustedMemoryAssignment {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    roleTemplateId: row.role_template_id,
    roleVersionId: row.role_version_id,
    status: row.assignment_status,
    employmentStatus: row.employment_status,
    orgUnitStatus: row.org_unit_status,
    roleVersionStatus: row.role_version_status,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
  };
}

function memoryLabels(row: AssignmentRow): readonly string[] {
  return unique([
    ...jsonStringArray(row.memory_policy, 'permissionLabels'),
    ...jsonStringArray(row.memory_policy, 'labels'),
    ...jsonStringArray(row.permission_scope, 'memoryLabels'),
  ]);
}

function configuredExperiencePermissions(
  row: AssignmentRow,
): TrustedExperienceActor['permissions'] {
  const values = unique([
    ...jsonStringArray(row.permission_scope, 'permissions'),
    ...jsonStringArray(row.permission_scope, 'bundles'),
  ]);
  return values.filter(isExperiencePermission);
}

function jsonStringArray(value: unknown, key: string): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || !(key in value)) {
    return [];
  }
  const candidate = (value as Record<string, unknown>)[key];
  return Array.isArray(candidate)
    ? candidate.filter((item): item is string => typeof item === 'string')
    : [];
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function isExperiencePermission(
  value: string,
): value is TrustedExperienceActor['permissions'][number] {
  return (ALL_EXPERIENCE_PERMISSIONS as readonly string[]).includes(value);
}

function requiredPermission(
  action: Exclude<ResolveExperienceActorInput['action'], 'CONTRIBUTE'>,
): TrustedExperienceActor['permissions'][number] {
  return action === 'SANITIZE'
    ? 'EXPERIENCE_SANITIZE'
    : action === 'STRUCTURE'
      ? 'EXPERIENCE_STRUCTURE'
      : action === 'APPROVE' || action === 'REJECT'
        ? 'EXPERIENCE_REVIEW'
        : action === 'VALIDATE'
          ? 'EXPERIENCE_VALIDATE'
          : action === 'PUBLISH'
            ? 'EXPERIENCE_PUBLISH'
            : action === 'MONITOR'
              ? 'EXPERIENCE_MONITOR'
              : 'EXPERIENCE_RETIRE';
}

interface AssignmentRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly user_id: string;
  readonly role_template_id: string;
  readonly role_version_id: string;
  readonly assignment_status: TrustedMemoryAssignment['status'];
  readonly permission_scope: unknown;
  readonly memory_policy: unknown;
  readonly effective_from: Date;
  readonly effective_to: Date | null;
  readonly employment_status: TrustedMemoryAssignment['employmentStatus'];
  readonly org_unit_status: TrustedMemoryAssignment['orgUnitStatus'];
  readonly role_version_status: TrustedMemoryAssignment['roleVersionStatus'];
}

interface TaskGrantRow {
  readonly id: string;
  readonly permission_labels: unknown;
}

interface ConversationGrantRow {
  readonly conversation_id: string;
}
