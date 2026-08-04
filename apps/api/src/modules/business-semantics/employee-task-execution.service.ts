import { createHash, randomUUID } from 'node:crypto';

import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import {
  businessPermissionLabelsSchema,
  deliverableSchema,
  employeeAcceptanceRequestSchema,
  employeeTaskExecutionSnapshotSchema,
  evidenceSchema,
  taskSchema,
  type Deliverable,
  type EmployeeAcceptanceRequest,
  type EmployeeAcceptanceRequestInput,
  type EmployeeDeliverableSubmissionCommand,
  type EmployeeDeliverableSubmissionRequest,
  type EmployeeEvidenceContributionCommand,
  type EmployeeEvidenceContributionRequest,
  type EmployeeTaskCapability,
  type EmployeeTaskExecutionSnapshot,
  type EmployeeTaskTransitionRequest,
  type Evidence,
  type Task,
} from '@enterprise/contracts';
import { Prisma, type Deliverable as DbDeliverable, type Task as DbTask } from '@prisma/client';

import { TenantContext, type TenantPrincipal } from '../../common/context/tenant-context.js';
import { PrismaService } from '../../database/prisma.service.js';
import { isBusinessSemanticResourceVisible } from '../authorization/domain/business-semantics.authorization.js';
import { mapDeliverable, mapEvidence, mapTask } from './business-semantics.mapper.js';
import {
  idempotencyIdentity,
  recordBusinessMutation,
  toJson,
} from './business-semantics.mutation.js';
import {
  BusinessSemanticsPolicyService,
  semanticResource,
} from './business-semantics-policy.service.js';
import { staleSemanticRevision, semanticNotFound } from './business-semantics.persistence.js';
import { submitDeliverableWithinTransaction } from './deliverable-acceptance-admin.service.js';
import { assertTaskTransitionEvidence, taskTransitionData } from './task-admin.service.js';

type EmployeeAction = EmployeeTaskCapability['action'];

@Injectable()
export class EmployeeTaskExecutionService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(TenantContext) private readonly context: TenantContext,
    @Inject(BusinessSemanticsPolicyService)
    private readonly policy: BusinessSemanticsPolicyService,
  ) {}

  async getSnapshot(taskId: string): Promise<EmployeeTaskExecutionSnapshot> {
    const principal = this.context.current;
    return this.prisma.withTenant(principal.tenantId, async (transaction) => {
      const task = await transaction.task.findFirst({
        where: { tenantId: principal.tenantId, id: taskId },
      });
      if (task === null) throw semanticNotFound('Task');
      const responsibleRoleAssignmentIds = await taskResponsibleRoleAssignmentIds(
        transaction,
        task,
      );
      const readFilter = await this.policy.requireReadFilter(
        transaction,
        principal,
        'business.task.read',
      );
      if (
        !isBusinessSemanticResourceVisible(
          semanticResource('TASK', task, {
            taskId: task.id,
            responsibleRoleAssignmentIds,
          }),
          readFilter,
        )
      ) {
        throw semanticNotFound('Task');
      }

      const deliverables = await transaction.deliverable.findMany({
        where: { tenantId: principal.tenantId, taskId: task.id, taskVersion: task.version },
        orderBy: [{ code: 'asc' }, { version: 'desc' }, { id: 'asc' }],
        take: 10_000,
      });
      const evidenceIds = await taskEvidenceIds(
        transaction,
        principal.tenantId,
        task.id,
        deliverables,
      );
      const evidence = await transaction.evidence.findMany({
        where: { tenantId: principal.tenantId, id: { in: evidenceIds } },
        orderBy: [{ observedAt: 'desc' }, { id: 'asc' }],
        take: 20_000,
      });
      const capabilities = await this.capabilities(
        transaction,
        principal,
        task,
        responsibleRoleAssignmentIds,
      );
      const acceptanceRequests = await loadAcceptanceRequests(
        transaction,
        principal.tenantId,
        task.id,
      );
      return employeeTaskExecutionSnapshotSchema.parse({
        task: mapTask(task),
        capabilities,
        deliverables: deliverables.map(mapDeliverable),
        evidence: evidence.map(mapEvidence),
        acceptanceRequests,
      });
    });
  }

  async transitionTask(
    taskId: string,
    request: EmployeeTaskTransitionRequest,
    suppliedKey?: string,
  ): Promise<Task> {
    const principal = this.context.current;
    const task = await this.authorizeTaskMutation(
      principal,
      taskId,
      request.roleAssignmentId,
      'business.task.execute',
    );
    if (task.processInstanceId !== null) {
      throw new ConflictException(
        'This Task is controlled by a Process Instance and cannot be advanced outside the process engine.',
      );
    }
    const identity = idempotencyIdentity({ taskId, request }, suppliedKey);
    return this.withExecutor(
      principal,
      request.roleAssignmentId,
      'business.task.execute',
      async (transaction) => {
        await lockEmployeeCommand(transaction, principal.tenantId, identity.key);
        const replay = await readCommandReplay(transaction, principal, identity.key);
        if (replay !== null) {
          assertReplayHash(replay.requestHash, identity.requestHash);
          return taskSchema.parse(replay.responsePayload);
        }
        const current = await transaction.task.findFirst({
          where: { tenantId: principal.tenantId, id: taskId },
        });
        if (current === null) throw semanticNotFound('Task');
        if (current.revision !== request.expectedRevision) throw staleSemanticRevision('Task');
        await assertTaskTransitionEvidence(
          transaction,
          principal.tenantId,
          current,
          request.action,
        );
        const result = await transaction.task.updateMany({
          where: {
            tenantId: principal.tenantId,
            id: taskId,
            revision: request.expectedRevision,
            status: current.status,
          },
          data: {
            ...taskTransitionData(current, request.action, new Date(request.effectiveAt)),
            revision: { increment: 1 },
          },
        });
        if (result.count !== 1) throw staleSemanticRevision('Task');
        const updated = mapTask(
          await transaction.task.findFirstOrThrow({
            where: { tenantId: principal.tenantId, id: taskId },
          }),
        );
        await recordEmployeeCommand(
          transaction,
          principal,
          request.roleAssignmentId,
          'business.task.execute',
          taskId,
          identity,
          updated,
        );
        await recordBusinessMutation(
          transaction,
          principal,
          `business_semantics.employee.task.${request.action.toLowerCase()}`,
          'task',
          taskId,
          {
            roleAssignmentId: request.roleAssignmentId,
            reason: request.reason,
            revision: updated.revision,
          },
        );
        return updated;
      },
    );
  }

  async submitDeliverable(
    taskId: string,
    deliverableId: string,
    request: EmployeeDeliverableSubmissionRequest,
    suppliedKey?: string,
  ): Promise<Deliverable> {
    const principal = this.context.current;
    const { task } = await this.authorizeDeliverableSubmission(
      principal,
      taskId,
      deliverableId,
      request,
    );
    if (task.processInstanceId !== null) {
      throw new ConflictException(
        'This Task is controlled by a Process Instance; submit through its assigned process step.',
      );
    }
    if (task.status !== 'IN_PROGRESS') {
      throw new ConflictException(
        'A Deliverable can be submitted only while its Task is in progress.',
      );
    }
    const identity = idempotencyIdentity({ taskId, deliverableId, request }, suppliedKey);
    return this.withExecutor(
      principal,
      request.roleAssignmentId,
      'business.deliverable.submit',
      async (transaction) => {
        await lockEmployeeCommand(transaction, principal.tenantId, identity.key);
        const replay = await readCommandReplay(transaction, principal, identity.key);
        if (replay !== null) {
          assertReplayHash(replay.requestHash, identity.requestHash);
          return deliverableSchema.parse(replay.responsePayload);
        }
        const current = await transaction.deliverable.findFirst({
          where: { tenantId: principal.tenantId, id: deliverableId, taskId },
        });
        if (current === null) throw semanticNotFound('Deliverable');
        if (current.revision !== request.expectedRevision) {
          throw staleSemanticRevision('Deliverable');
        }
        await submitDeliverableWithinTransaction(transaction, principal.tenantId, taskId, current, {
          action: 'SUBMIT',
          expectedRevision: request.expectedRevision,
          submittedAt: request.submittedAt,
          artifactUri: request.artifactUri,
          contentHash: request.contentHash,
          evidenceIds: request.evidenceIds,
        });
        const updated = mapDeliverable(
          await transaction.deliverable.findFirstOrThrow({
            where: { tenantId: principal.tenantId, id: deliverableId },
          }),
        );
        await recordEmployeeCommand(
          transaction,
          principal,
          request.roleAssignmentId,
          'business.deliverable.submit',
          taskId,
          identity,
          updated,
        );
        await recordBusinessMutation(
          transaction,
          principal,
          'business_semantics.employee.deliverable.submitted',
          'deliverable',
          deliverableId,
          {
            taskId,
            roleAssignmentId: request.roleAssignmentId,
            evidenceCount: request.evidenceIds.length,
            revision: updated.revision,
          },
        );
        return updated;
      },
    );
  }

  async submitDeliverableCommand(
    taskId: string,
    deliverableId: string,
    request: EmployeeDeliverableSubmissionCommand,
    suppliedKey?: string,
  ): Promise<Deliverable> {
    const principal = this.context.current;
    const { task } = await this.authorizeDeliverableSubmission(
      principal,
      taskId,
      deliverableId,
      request,
    );
    assertEmployeeDeliverableTaskState(task);
    const identity = idempotencyIdentity({ taskId, deliverableId, command: request }, suppliedKey);
    return this.withExecutor(
      principal,
      request.roleAssignmentId,
      'business.deliverable.submit',
      async (transaction) => {
        await lockEmployeeCommand(transaction, principal.tenantId, identity.key);
        const replay = await readCommandReplay(transaction, principal, identity.key);
        if (replay !== null) {
          assertReplayHash(replay.requestHash, identity.requestHash);
          return deliverableSchema.parse(replay.responsePayload);
        }
        const [currentTask, current] = await Promise.all([
          transaction.task.findFirst({
            where: { tenantId: principal.tenantId, id: taskId },
          }),
          transaction.deliverable.findFirst({
            where: { tenantId: principal.tenantId, id: deliverableId, taskId },
          }),
        ]);
        if (currentTask === null || current === null) throw semanticNotFound('Deliverable');
        assertEmployeeDeliverableTaskState(currentTask);
        await assertEvidenceLinkedToTask(
          transaction,
          principal.tenantId,
          taskId,
          request.evidenceIds,
        );
        const submittedAt = new Date();
        const contentHash = serverContentHash({
          schema: 'employee-deliverable-submission-command.v1',
          tenantId: principal.tenantId,
          taskId,
          deliverableId,
          roleAssignmentId: request.roleAssignmentId,
          businessDescription: request.businessDescription,
          sourceType: request.sourceType,
          sourceUri: request.sourceUri,
          evidenceIds: [...request.evidenceIds].sort(),
        });
        const artifactUri =
          request.sourceUri ??
          `urn:enterprise-agent:deliverable:${deliverableId}:submission:${contentHash}`;
        const effectivePermissionLabels = employeePermissionLabels(
          currentTask.permissionLabels,
          current.permissionLabels,
        );
        await submitDeliverableWithinTransaction(transaction, principal.tenantId, taskId, current, {
          action: 'SUBMIT',
          expectedRevision: current.revision,
          submittedAt: submittedAt.toISOString(),
          artifactUri,
          contentHash,
          evidenceIds: request.evidenceIds,
          effectivePermissionLabels,
        });
        const updated = mapDeliverable(
          await transaction.deliverable.findFirstOrThrow({
            where: { tenantId: principal.tenantId, id: deliverableId, taskId },
          }),
        );
        await recordEmployeeCommand(
          transaction,
          principal,
          request.roleAssignmentId,
          'business.deliverable.submit',
          taskId,
          identity,
          updated,
        );
        await recordBusinessMutation(
          transaction,
          principal,
          'business_semantics.employee.deliverable.submitted',
          'deliverable',
          deliverableId,
          {
            taskId,
            roleAssignmentId: request.roleAssignmentId,
            sourceType: request.sourceType,
            sourceUri: request.sourceUri,
            businessDescription: request.businessDescription,
            effectivePermissionLabels,
            evidenceCount: request.evidenceIds.length,
            revision: updated.revision,
            serverGeneratedMetadata: true,
          },
        );
        return updated;
      },
    );
  }

  async contributeEvidence(
    taskId: string,
    request: EmployeeEvidenceContributionRequest,
    suppliedKey?: string,
  ): Promise<Evidence> {
    const principal = this.context.current;
    await this.authorizeVirtualMutation(
      principal,
      taskId,
      request.roleAssignmentId,
      'business.evidence.contribute',
      request.permissionLabels,
    );
    const identity = idempotencyIdentity({ taskId, request }, suppliedKey);
    return this.withExecutor(
      principal,
      request.roleAssignmentId,
      'business.evidence.contribute',
      async (transaction) => {
        await lockEmployeeCommand(transaction, principal.tenantId, identity.key);
        const replay = await readCommandReplay(transaction, principal, identity.key);
        if (replay !== null) {
          assertReplayHash(replay.requestHash, identity.requestHash);
          return evidenceSchema.parse(replay.responsePayload);
        }
        const rows = await transaction.$queryRaw<Array<{ evidenceId: string }>>`
          SELECT public.employee_submit_task_evidence(
            ${principal.tenantId}::uuid,
            ${taskId}::uuid,
            ${request.code},
            ${request.sourceType}::public."EvidenceSourceType",
            ${request.sourceSystem},
            ${request.sourceRecordId},
            ${request.sourceVersion},
            ${request.sourceUri},
            ${new Date(request.observedAt)},
            ${request.contentHash},
            ${request.summary},
            ${new Date(request.effectiveFrom)},
            ${request.effectiveTo === null ? null : new Date(request.effectiveTo)},
            ${toJson(request.permissionLabels)}::jsonb,
            ${identity.key},
            ${identity.requestHash}
          ) AS "evidenceId"
        `;
        const evidenceId = rows[0]?.evidenceId;
        if (evidenceId === undefined) {
          throw new ConflictException('Evidence contribution did not return a durable identity.');
        }
        const created = mapEvidence(
          await transaction.evidence.findFirstOrThrow({
            where: { tenantId: principal.tenantId, id: evidenceId },
          }),
        );
        await recordEmployeeCommand(
          transaction,
          principal,
          request.roleAssignmentId,
          'business.evidence.contribute',
          taskId,
          identity,
          created,
        );
        await recordBusinessMutation(
          transaction,
          principal,
          'business_semantics.employee.evidence.contributed',
          'evidence',
          evidenceId,
          {
            taskId,
            roleAssignmentId: request.roleAssignmentId,
            status: created.status,
            trustLevel: created.trustLevel,
          },
        );
        return created;
      },
    );
  }

  async contributeEvidenceCommand(
    taskId: string,
    request: EmployeeEvidenceContributionCommand,
    suppliedKey?: string,
  ): Promise<Evidence> {
    const principal = this.context.current;
    await this.authorizeVirtualMutation(
      principal,
      taskId,
      request.roleAssignmentId,
      'business.evidence.contribute',
      [],
    );
    const identity = idempotencyIdentity({ taskId, command: request }, suppliedKey);
    return this.withExecutor(
      principal,
      request.roleAssignmentId,
      'business.evidence.contribute',
      async (transaction) => {
        await lockEmployeeCommand(transaction, principal.tenantId, identity.key);
        const replay = await readCommandReplay(transaction, principal, identity.key);
        if (replay !== null) {
          assertReplayHash(replay.requestHash, identity.requestHash);
          return evidenceSchema.parse(replay.responsePayload);
        }
        const task = await transaction.task.findFirst({
          where: { tenantId: principal.tenantId, id: taskId },
        });
        if (task === null) throw semanticNotFound('Task');
        const generatedIdentity = serverContentHash({
          schema: 'employee-evidence-identity.v1',
          tenantId: principal.tenantId,
          taskId,
          idempotencyKey: identity.key,
          requestHash: identity.requestHash,
        });
        const observedAt = new Date();
        const contentHash = serverContentHash({
          schema: 'employee-evidence-content.v1',
          tenantId: principal.tenantId,
          taskId,
          roleAssignmentId: request.roleAssignmentId,
          businessDescription: request.businessDescription,
          sourceType: request.sourceType,
          sourceUri: request.sourceUri,
        });
        const permissionLabels = employeePermissionLabels(task.permissionLabels);
        const code = `EVD:${generatedIdentity.slice(0, 32).toUpperCase()}`;
        const sourceSystem =
          request.sourceType === 'DOCUMENT' ? 'EMPLOYEE.DOCUMENT' : 'EMPLOYEE.ATTESTATION';
        const sourceRecordId = `task:${taskId}:contribution:${generatedIdentity}`;
        const rows = await transaction.$queryRaw<Array<{ evidenceId: string }>>`
          SELECT public.employee_submit_task_evidence(
            ${principal.tenantId}::uuid,
            ${taskId}::uuid,
            ${code},
            ${request.sourceType}::public."EvidenceSourceType",
            ${sourceSystem},
            ${sourceRecordId},
            ${'1'},
            ${request.sourceUri},
            ${observedAt},
            ${contentHash},
            ${request.businessDescription},
            ${observedAt},
            ${null},
            ${toJson(permissionLabels)}::jsonb,
            ${identity.key},
            ${identity.requestHash}
          ) AS "evidenceId"
        `;
        const evidenceId = rows[0]?.evidenceId;
        if (evidenceId === undefined) {
          throw new ConflictException('Evidence contribution did not return a durable identity.');
        }
        const created = mapEvidence(
          await transaction.evidence.findFirstOrThrow({
            where: { tenantId: principal.tenantId, id: evidenceId },
          }),
        );
        await recordEmployeeCommand(
          transaction,
          principal,
          request.roleAssignmentId,
          'business.evidence.contribute',
          taskId,
          identity,
          created,
        );
        await recordBusinessMutation(
          transaction,
          principal,
          'business_semantics.employee.evidence.contributed',
          'evidence',
          evidenceId,
          {
            taskId,
            roleAssignmentId: request.roleAssignmentId,
            sourceType: request.sourceType,
            sourceUri: request.sourceUri,
            status: created.status,
            trustLevel: created.trustLevel,
            effectivePermissionLabels: permissionLabels,
            serverGeneratedMetadata: true,
          },
        );
        return created;
      },
    );
  }

  async requestAcceptance(
    taskId: string,
    deliverableId: string,
    request: EmployeeAcceptanceRequestInput,
    suppliedKey?: string,
  ): Promise<EmployeeAcceptanceRequest> {
    const principal = this.context.current;
    await this.authorizeVirtualMutation(
      principal,
      taskId,
      request.roleAssignmentId,
      'business.acceptance.request',
      [],
    );
    const dueAt = new Date(request.dueAt);
    if (dueAt <= new Date()) {
      throw new BadRequestException('Acceptance request dueAt must be in the future.');
    }
    const identity = idempotencyIdentity({ taskId, deliverableId, request }, suppliedKey);
    return this.withExecutor(
      principal,
      request.roleAssignmentId,
      'business.acceptance.request',
      async (transaction) => {
        await lockEmployeeCommand(transaction, principal.tenantId, identity.key);
        const replay = await readCommandReplay(transaction, principal, identity.key);
        if (replay !== null) {
          assertReplayHash(replay.requestHash, identity.requestHash);
          return employeeAcceptanceRequestSchema.parse(replay.responsePayload);
        }
        const deliverable = await transaction.deliverable.findFirst({
          where: {
            tenantId: principal.tenantId,
            id: deliverableId,
            taskId,
            status: 'SUBMITTED',
            evidenceSealedAt: { not: null },
          },
        });
        if (deliverable === null) {
          throw new ConflictException(
            'Acceptance can be requested only for a submitted Deliverable with sealed Evidence.',
          );
        }
        if (deliverable.revision !== request.expectedDeliverableRevision) {
          throw staleSemanticRevision('Deliverable');
        }
        const task = await transaction.task.findFirst({
          where: { tenantId: principal.tenantId, id: taskId },
        });
        if (task === null) throw semanticNotFound('Task');
        if (task.effectiveTo !== null && dueAt > task.effectiveTo) {
          throw new ConflictException(
            'Acceptance request dueAt must fit the Task effective period.',
          );
        }
        const requestId = randomUUID();
        const rows = await transaction.$queryRaw<AcceptanceRequestRow[]>`
          INSERT INTO public."employee_task_acceptance_requests" (
            "id", "tenant_id", "task_id", "task_version",
            "deliverable_id", "deliverable_version",
            "requested_by_user_id", "requested_by_role_assignment_id",
            "reason", "due_at", "idempotency_key", "request_hash"
          ) VALUES (
            ${requestId}::uuid, ${principal.tenantId}::uuid,
            ${task.id}::uuid, ${task.version},
            ${deliverable.id}::uuid, ${deliverable.version},
            ${principal.userId}::uuid, ${request.roleAssignmentId}::uuid,
            ${request.reason}, ${dueAt}, ${identity.key}, ${identity.requestHash}
          )
          RETURNING
            "id", "tenant_id", "task_id", "task_version",
            "deliverable_id", "deliverable_version",
            "requested_by_user_id", "requested_by_role_assignment_id",
            "revision", "reason", "due_at", "requested_at"
        `;
        const created = acceptanceRequestFromRow(rows[0]);
        await recordEmployeeCommand(
          transaction,
          principal,
          request.roleAssignmentId,
          'business.acceptance.request',
          taskId,
          identity,
          created,
        );
        await recordBusinessMutation(
          transaction,
          principal,
          'business_semantics.employee.acceptance.requested',
          'acceptance_request',
          requestId,
          {
            taskId,
            deliverableId,
            roleAssignmentId: request.roleAssignmentId,
            dueAt: request.dueAt,
          },
        );
        return created;
      },
    );
  }

  private async authorizeTaskMutation(
    principal: TenantPrincipal,
    taskId: string,
    roleAssignmentId: string,
    action: EmployeeAction,
  ) {
    return this.prisma.withTenant(principal.tenantId, async (transaction) => {
      const task = await transaction.task.findFirst({
        where: { tenantId: principal.tenantId, id: taskId },
      });
      if (task === null) throw semanticNotFound('Task');
      const responsibleRoleAssignmentIds = await taskResponsibleRoleAssignmentIds(
        transaction,
        task,
      );
      await this.policy.requireEmployeeWrite(transaction, principal, action, {
        roleAssignmentId,
        resource: employeeTaskScopedResource(
          action,
          task,
          responsibleRoleAssignmentIds,
          task.permissionLabels,
          task.id,
        ),
        mutation: { proposedTaskId: taskId },
      });
      return task;
    });
  }

  private async authorizeDeliverableSubmission(
    principal: TenantPrincipal,
    taskId: string,
    deliverableId: string,
    request: {
      readonly roleAssignmentId: string;
      readonly evidenceIds: readonly string[];
    },
  ): Promise<{ readonly task: DbTask; readonly deliverable: DbDeliverable }> {
    return this.prisma.withTenant(principal.tenantId, async (transaction) => {
      const [task, deliverable] = await Promise.all([
        transaction.task.findFirst({
          where: { tenantId: principal.tenantId, id: taskId },
        }),
        transaction.deliverable.findFirst({
          where: { tenantId: principal.tenantId, id: deliverableId, taskId },
        }),
      ]);
      if (task === null || deliverable === null) throw semanticNotFound('Deliverable');
      const responsibleRoleAssignmentIds = await taskResponsibleRoleAssignmentIds(
        transaction,
        task,
      );
      await this.policy.requireEmployeeWrite(
        transaction,
        principal,
        'business.deliverable.submit',
        {
          roleAssignmentId: request.roleAssignmentId,
          resource: employeeTaskScopedResource(
            'business.deliverable.submit',
            task,
            responsibleRoleAssignmentIds,
            employeePermissionLabels(task.permissionLabels, deliverable.permissionLabels),
            deliverable.id,
          ),
          mutation: { proposedTaskId: taskId },
        },
      );
      await assertEvidenceLinkedToTask(
        transaction,
        principal.tenantId,
        taskId,
        request.evidenceIds,
      );
      return { task, deliverable };
    });
  }

  private async authorizeVirtualMutation(
    principal: TenantPrincipal,
    taskId: string,
    roleAssignmentId: string,
    action: EmployeeAction,
    permissionLabels: readonly string[],
  ): Promise<void> {
    await this.prisma.withTenant(principal.tenantId, async (transaction) => {
      const task = await transaction.task.findFirst({
        where: { tenantId: principal.tenantId, id: taskId },
      });
      if (task === null) throw semanticNotFound('Task');
      const responsibleRoleAssignmentIds = await taskResponsibleRoleAssignmentIds(
        transaction,
        task,
      );
      await this.policy.requireEmployeeWrite(transaction, principal, action, {
        roleAssignmentId,
        resource: employeeTaskScopedResource(
          action,
          task,
          responsibleRoleAssignmentIds,
          employeePermissionLabels(task.permissionLabels, permissionLabels),
          task.id,
        ),
        mutation: {
          proposedPermissionLabels: [...permissionLabels],
          proposedTaskId: taskId,
        },
      });
    });
  }

  private async capabilities(
    transaction: Prisma.TransactionClient,
    principal: TenantPrincipal,
    task: Parameters<typeof mapTask>[0],
    responsibleRoleAssignmentIds: readonly string[],
  ): Promise<EmployeeTaskCapability[]> {
    const inputs: Array<{
      action: EmployeeAction;
      resource: ReturnType<typeof semanticResource> | null;
    }> = [
      {
        action: 'business.task.execute',
        resource: employeeTaskScopedResource(
          'business.task.execute',
          task,
          responsibleRoleAssignmentIds,
          task.permissionLabels,
          task.id,
        ),
      },
      {
        action: 'business.deliverable.submit',
        resource: employeeTaskScopedResource(
          'business.deliverable.submit',
          task,
          responsibleRoleAssignmentIds,
          task.permissionLabels,
          task.id,
        ),
      },
      {
        action: 'business.evidence.contribute',
        resource: employeeTaskScopedResource(
          'business.evidence.contribute',
          task,
          responsibleRoleAssignmentIds,
          task.permissionLabels,
          task.id,
        ),
      },
      {
        action: 'business.acceptance.request',
        resource: employeeTaskScopedResource(
          'business.acceptance.request',
          task,
          responsibleRoleAssignmentIds,
          task.permissionLabels,
          task.id,
        ),
      },
    ];
    const capabilities: EmployeeTaskCapability[] = [];
    for (const input of inputs) {
      const roleAssignmentIds = await this.policy.listEmployeeWriteRoleAssignments(
        transaction,
        principal,
        input.action,
        {
          resource: input.resource,
          mutation: { proposedTaskId: task.id },
        },
      );
      for (const roleAssignmentId of roleAssignmentIds) {
        capabilities.push({ action: input.action, roleAssignmentId });
      }
    }
    return capabilities;
  }

  private async withExecutor<T>(
    principal: TenantPrincipal,
    roleAssignmentId: string,
    action: EmployeeAction,
    operation: (transaction: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    if (!this.prisma.enabled) {
      throw new Error('Employee task execution requires the Prisma repository adapter.');
    }
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_task_executor');
      await transaction.$queryRaw`SELECT set_config('app.tenant_id', ${principal.tenantId}, true)`;
      await transaction.$queryRaw`SELECT set_config('app.user_id', ${principal.userId}, true)`;
      await transaction.$queryRaw`
        SELECT set_config('app.role_assignment_id', ${roleAssignmentId}, true)
      `;
      await transaction.$queryRaw`SELECT set_config('app.action', ${action}, true)`;
      return operation(transaction);
    });
  }
}

async function taskEvidenceIds(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  taskId: string,
  deliverables: readonly DbDeliverable[],
): Promise<string[]> {
  const [direct, sealed] = await Promise.all([
    transaction.evidenceLink.findMany({
      where: { tenantId, targetTaskId: taskId, status: 'ACTIVE' },
      select: { evidenceId: true },
      take: 20_000,
    }),
    transaction.deliverableEvidence.findMany({
      where: {
        tenantId,
        deliverableId: { in: deliverables.map((deliverable) => deliverable.id) },
      },
      select: { evidenceId: true },
      take: 20_000,
    }),
  ]);
  return [...new Set([...direct, ...sealed].map((link) => link.evidenceId))];
}

async function loadAcceptanceRequests(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  taskId: string,
): Promise<EmployeeAcceptanceRequest[]> {
  const rows = await transaction.$queryRaw<AcceptanceRequestDecisionRow[]>`
    SELECT
      request."id", request."tenant_id", request."task_id", request."task_version",
      request."deliverable_id", request."deliverable_version",
      request."requested_by_user_id", request."requested_by_role_assignment_id",
      request."revision", request."reason", request."due_at", request."requested_at",
      decision."id" AS "acceptance_id",
      decision."version" AS "acceptance_version",
      decision."decision"::text AS "acceptance_decision",
      decision."comment" AS "decision_comment"
    FROM public."employee_task_acceptance_requests" request
    LEFT JOIN LATERAL (
      SELECT acceptance."id", acceptance."version",
             acceptance."decision", acceptance."comment"
      FROM public."acceptances" acceptance
      WHERE acceptance."tenant_id" = request."tenant_id"
        AND acceptance."deliverable_id" = request."deliverable_id"
        AND acceptance."deliverable_version" = request."deliverable_version"
        AND acceptance."status" = 'ACTIVE'
      ORDER BY acceptance."version" DESC, acceptance."id" ASC
      LIMIT 1
    ) decision ON true
    WHERE request."tenant_id" = ${tenantId}::uuid
      AND request."task_id" = ${taskId}::uuid
    ORDER BY request."requested_at" DESC, request."id" ASC
    LIMIT 10000
  `;
  return rows.map((row) =>
    employeeAcceptanceRequestSchema.parse({
      ...acceptanceRequestBase(row),
      status: row.acceptance_decision ?? 'REQUESTED',
      acceptanceId: row.acceptance_id,
      acceptanceVersion: row.acceptance_version,
      decisionComment: row.decision_comment,
    }),
  );
}

function acceptanceRequestFromRow(
  row: AcceptanceRequestRow | undefined,
): EmployeeAcceptanceRequest {
  if (row === undefined) {
    throw new ConflictException('Acceptance Request was not persisted.');
  }
  return employeeAcceptanceRequestSchema.parse({
    ...acceptanceRequestBase(row),
    status: 'REQUESTED',
    acceptanceId: null,
    acceptanceVersion: null,
    decisionComment: null,
  });
}

function acceptanceRequestBase(row: AcceptanceRequestRow) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    taskId: row.task_id,
    taskVersion: row.task_version,
    deliverableId: row.deliverable_id,
    deliverableVersion: row.deliverable_version,
    requestedByUserId: row.requested_by_user_id,
    requestedByRoleAssignmentId: row.requested_by_role_assignment_id,
    revision: row.revision,
    reason: row.reason,
    dueAt: row.due_at.toISOString(),
    requestedAt: row.requested_at.toISOString(),
  };
}

async function lockEmployeeCommand(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  key: string,
): Promise<void> {
  await transaction.$executeRaw`
    SELECT pg_advisory_xact_lock(
      hashtextextended(${`${tenantId}:employee-task:${key}`}, 0)
    )
  `;
}

async function readCommandReplay(
  transaction: Prisma.TransactionClient,
  principal: TenantPrincipal,
  key: string,
): Promise<{ readonly requestHash: string; readonly responsePayload: unknown } | null> {
  const rows = await transaction.$queryRaw<
    Array<{ request_hash: string; response_payload: Prisma.JsonValue }>
  >`
    SELECT "request_hash", "response_payload"
    FROM public."employee_task_commands"
    WHERE "tenant_id" = ${principal.tenantId}::uuid
      AND "idempotency_key" = ${key}
    LIMIT 1
  `;
  const row = rows[0];
  return row === undefined
    ? null
    : { requestHash: row.request_hash, responsePayload: row.response_payload };
}

async function recordEmployeeCommand(
  transaction: Prisma.TransactionClient,
  principal: TenantPrincipal,
  roleAssignmentId: string,
  action: EmployeeAction,
  taskId: string,
  identity: { readonly key: string; readonly requestHash: string },
  response: unknown,
): Promise<void> {
  await transaction.$executeRaw`
    INSERT INTO public."employee_task_commands" (
      "tenant_id", "task_id", "actor_user_id", "actor_role_assignment_id",
      "action", "idempotency_key", "request_hash", "response_payload"
    ) VALUES (
      ${principal.tenantId}::uuid, ${taskId}::uuid, ${principal.userId}::uuid,
      ${roleAssignmentId}::uuid, ${action}, ${identity.key},
      ${identity.requestHash}, ${toJson(response)}::jsonb
    )
  `;
}

function assertReplayHash(actual: string, expected: string): void {
  if (actual !== expected) {
    throw new ConflictException('The idempotency key was already used for a different request.');
  }
}

interface AcceptanceRequestRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly task_id: string;
  readonly task_version: number;
  readonly deliverable_id: string;
  readonly deliverable_version: number;
  readonly requested_by_user_id: string;
  readonly requested_by_role_assignment_id: string;
  readonly revision: number;
  readonly reason: string;
  readonly due_at: Date;
  readonly requested_at: Date;
}

interface AcceptanceRequestDecisionRow extends AcceptanceRequestRow {
  readonly acceptance_id: string | null;
  readonly acceptance_version: number | null;
  readonly acceptance_decision: 'ACCEPTED' | 'REJECTED' | 'CHANGES_REQUESTED' | null;
  readonly decision_comment: string | null;
}

function employeeTaskScopedResource(
  action: EmployeeAction,
  task: DbTask,
  responsibleRoleAssignmentIds: readonly string[],
  permissionLabels: unknown,
  resourceId: string,
) {
  let type: 'TASK' | 'DELIVERABLE' | 'EVIDENCE' | 'ACCEPTANCE';
  switch (action) {
    case 'business.task.execute':
      type = 'TASK';
      break;
    case 'business.deliverable.submit':
      type = 'DELIVERABLE';
      break;
    case 'business.evidence.contribute':
      type = 'EVIDENCE';
      break;
    case 'business.acceptance.request':
      type = 'ACCEPTANCE';
      break;
  }
  return {
    ...semanticResource(type, task, {
      taskId: task.id,
      responsibleRoleAssignmentIds,
    }),
    id: resourceId,
    permissionLabels: businessPermissionLabelsSchema.parse(permissionLabels),
  };
}

async function taskResponsibleRoleAssignmentIds(
  transaction: Prisma.TransactionClient,
  task: DbTask,
): Promise<string[]> {
  const links = await transaction.objectiveRoleAssignment.findMany({
    where: {
      tenantId: task.tenantId,
      objectiveId: task.objectiveId,
      objectiveVersion: task.objectiveVersion,
    },
    select: { roleAssignmentId: true },
    take: 10_000,
  });
  return [...new Set(links.map((link) => link.roleAssignmentId))].sort();
}

function employeePermissionLabels(...values: readonly unknown[]): string[] {
  return [
    ...new Set(values.flatMap((value) => [...businessPermissionLabelsSchema.parse(value)])),
  ].sort();
}

async function assertEvidenceLinkedToTask(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  taskId: string,
  evidenceIds: readonly string[],
): Promise<void> {
  const activeLinks = await transaction.evidenceLink.findMany({
    where: {
      tenantId,
      targetTaskId: taskId,
      status: 'ACTIVE',
      evidenceId: { in: [...evidenceIds] },
    },
    select: { evidenceId: true },
  });
  if (new Set(activeLinks.map((link) => link.evidenceId)).size !== evidenceIds.length) {
    throw new ConflictException(
      'Every submission Evidence item must already be linked to this Task.',
    );
  }
}

function assertEmployeeDeliverableTaskState(
  task: Pick<DbTask, 'processInstanceId' | 'status'>,
): void {
  if (task.processInstanceId !== null) {
    throw new ConflictException(
      'This Task is controlled by a Process Instance; submit through its assigned process step.',
    );
  }
  if (task.status !== 'IN_PROGRESS') {
    throw new ConflictException(
      'A Deliverable can be submitted only while its Task is in progress.',
    );
  }
}

function serverContentHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
