import { ConflictException } from '@nestjs/common';
import type { ToolDefinition, ToolInvocation, ToolVersion } from '@enterprise/contracts';
import type { Prisma } from '@prisma/client';

import type { PrismaService } from '../../../../database/prisma.service.js';
import {
  jsonObject,
  nullableJsonObject,
  stringArray,
} from '../../../process-orchestration/infrastructure/prisma/runtime-prisma.support.js';

export async function withToolTenant<T>(
  prisma: PrismaService,
  tenantId: string,
  userId: string,
  role: 'enterprise_agent_admin' | 'enterprise_agent_tool_gateway',
  operation: (transaction: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  if (!prisma.enabled) {
    throw new Error('Prisma Tool Gateway access is disabled for the current adapter.');
  }
  return prisma.$transaction(async (transaction) => {
    await transaction.$executeRawUnsafe(`SET LOCAL ROLE ${role}`);
    await transaction.$queryRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    await transaction.$queryRaw`SELECT set_config('app.user_id', ${userId}, true)`;
    return operation(transaction);
  });
}

export function mapToolDefinitionRow(row: ToolDefinitionRow): ToolDefinition {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    key: row.key,
    name: row.name,
    description: row.description,
    ownerUserId: row.owner_user_id,
    status: row.status,
    currentVersionId: row.current_version_id,
    currentVersion: row.current_version,
    revision: row.revision,
    permissionLabels: stringArray(row.permission_labels),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export function mapToolVersionRow(row: ToolVersionRow): ToolVersion {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    toolId: row.tool_id,
    key: row.key,
    name: row.name,
    description: row.description,
    ownerUserId: row.owner_user_id,
    version: row.version,
    status: row.status,
    adapter: row.adapter,
    endpointRef: row.endpoint_ref,
    inputSchema: jsonObject(row.input_schema),
    outputSchema: jsonObject(row.output_schema),
    riskClass: row.risk_class,
    dataClassification: row.data_classification,
    timeoutMs: row.timeout_ms,
    maxAttempts: row.max_attempts,
    idempotencyMode: row.idempotency_mode,
    dryRunMode: row.dry_run_mode,
    allowedHttpMethods: stringArray(row.allowed_http_methods) as ToolVersion['allowedHttpMethods'],
    allowedHostPatterns: stringArray(row.allowed_host_patterns),
    compensationToolVersionId: row.compensation_tool_version_id,
    configurationHash: row.configuration_hash,
    effectiveFrom: row.effective_from.toISOString(),
    effectiveTo: iso(row.effective_to),
    publishedAt: iso(row.published_at),
    retiredAt: iso(row.retired_at),
    createdAt: row.created_at.toISOString(),
  };
}

export function mapToolInvocationRow(row: ToolInvocationRow): ToolInvocation {
  const confirmation =
    row.confirmed_by_user_id === null
      ? null
      : {
          confirmedByUserId: row.confirmed_by_user_id,
          confirmedAt: requiredIso(row.confirmed_at, 'confirmed_at'),
          reason: requiredText(row.confirmation_reason, 'confirmation_reason'),
        };
  const approval =
    row.approver_user_id === null
      ? null
      : {
          approverUserId: row.approver_user_id,
          approverRoleAssignmentId: requiredText(
            row.approver_role_assignment_id,
            'approver_role_assignment_id',
          ),
          decision: requiredText(row.approval_decision, 'approval_decision') as
            'APPROVED' | 'REJECTED',
          decidedAt: requiredIso(row.approval_decided_at, 'approval_decided_at'),
          reason: requiredText(row.approval_reason, 'approval_reason'),
        };
  return {
    id: row.id,
    tenantId: row.tenant_id,
    toolId: row.tool_id,
    toolVersionId: row.tool_version_id,
    toolVersion: row.tool_version,
    requesterUserId: row.requester_user_id,
    roleAssignmentId: row.role_assignment_id,
    taskId: row.task_id,
    processInstanceId: row.process_instance_id,
    processStepInstanceId: row.process_step_instance_id,
    agentRunId: row.agent_run_id,
    correlationId: row.correlation_id,
    causationId: row.causation_id,
    retryOfInvocationId: row.retry_of_invocation_id,
    compensationForInvocationId: row.compensation_for_invocation_id,
    riskClass: row.risk_class,
    status: row.status,
    revision: row.revision,
    dryRun: row.dry_run,
    input: jsonObject(row.input),
    inputHash: row.input_hash,
    policyDecisionId: row.policy_decision_id,
    policySnapshot: jsonObject(row.policy_snapshot),
    confirmation,
    approval,
    executionAttempt: row.execution_attempt,
    providerRequestId: row.provider_request_id,
    output: nullableJsonObject(row.output),
    outputHash: row.output_hash,
    errorCode: row.error_code,
    errorDetail: row.error_detail,
    startedAt: iso(row.started_at),
    completedAt: iso(row.completed_at),
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function iso(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

function requiredIso(value: Date | null, column: string): string {
  if (value === null) {
    throw new ConflictException(`Persisted Tool Gateway column ${column} is missing.`);
  }
  return value.toISOString();
}

function requiredText<T extends string>(value: T | null, column: string): T {
  if (value === null) {
    throw new ConflictException(`Persisted Tool Gateway column ${column} is missing.`);
  }
  return value;
}

export interface ToolDefinitionRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly owner_user_id: string;
  readonly status: ToolDefinition['status'];
  readonly current_version_id: string | null;
  readonly current_version: number | null;
  readonly revision: number;
  readonly permission_labels: unknown;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export interface ToolVersionRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly tool_id: string;
  readonly version: number;
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly owner_user_id: string;
  readonly status: ToolVersion['status'];
  readonly adapter: ToolVersion['adapter'];
  readonly endpoint_ref: string;
  readonly input_schema: unknown;
  readonly output_schema: unknown;
  readonly risk_class: ToolVersion['riskClass'];
  readonly data_classification: ToolVersion['dataClassification'];
  readonly timeout_ms: number;
  readonly max_attempts: number;
  readonly idempotency_mode: ToolVersion['idempotencyMode'];
  readonly dry_run_mode: ToolVersion['dryRunMode'];
  readonly allowed_http_methods: unknown;
  readonly allowed_host_patterns: unknown;
  readonly sensitive_input_paths: unknown;
  readonly compensation_tool_version_id: string | null;
  readonly configuration_hash: string;
  readonly effective_from: Date;
  readonly effective_to: Date | null;
  readonly published_at: Date | null;
  readonly retired_at: Date | null;
  readonly created_by_user_id: string;
  readonly created_at: Date;
}

export interface ToolInvocationRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly tool_id: string;
  readonly tool_version_id: string;
  readonly tool_version: number;
  readonly tool_configuration_hash: string;
  readonly adapter: ToolVersion['adapter'];
  readonly risk_class: ToolInvocation['riskClass'];
  readonly data_classification: ToolVersion['dataClassification'];
  readonly idempotency_mode: ToolVersion['idempotencyMode'];
  readonly dry_run_mode: ToolVersion['dryRunMode'];
  readonly requester_user_id: string;
  readonly role_assignment_id: string;
  readonly task_id: string;
  readonly process_instance_id: string | null;
  readonly process_step_instance_id: string | null;
  readonly agent_run_id: string | null;
  readonly correlation_id: string;
  readonly causation_id: string | null;
  readonly retry_of_invocation_id: string | null;
  readonly compensation_for_invocation_id: string | null;
  readonly status: ToolInvocation['status'];
  readonly revision: number;
  readonly dry_run: boolean;
  readonly provider_dispatch_allowed: boolean;
  readonly provider_dry_run: boolean;
  readonly input: unknown;
  readonly input_hash: string;
  readonly redacted_input_summary: unknown;
  readonly policy_decision_id: string;
  readonly policy_snapshot: unknown;
  readonly confirmed_by_user_id: string | null;
  readonly confirmed_by_role_assignment_id: string | null;
  readonly confirmed_at: Date | null;
  readonly confirmation_reason: string | null;
  readonly confirmation_proof_hash: string | null;
  readonly confirmation_issued_at: Date | null;
  readonly confirmation_expires_at: Date | null;
  readonly approver_user_id: string | null;
  readonly approver_role_assignment_id: string | null;
  readonly approval_decision: 'APPROVED' | 'REJECTED' | null;
  readonly approval_decided_at: Date | null;
  readonly approval_reason: string | null;
  readonly approval_proof_hash: string | null;
  readonly approval_issued_at: Date | null;
  readonly approval_expires_at: Date | null;
  readonly execution_attempt: number;
  readonly provider_request_id: string | null;
  readonly output: unknown | null;
  readonly output_hash: string | null;
  readonly error_code: string | null;
  readonly error_detail: string | null;
  readonly started_at: Date | null;
  readonly completed_at: Date | null;
  readonly idempotency_key: string;
  readonly created_at: Date;
  readonly updated_at: Date;
}
