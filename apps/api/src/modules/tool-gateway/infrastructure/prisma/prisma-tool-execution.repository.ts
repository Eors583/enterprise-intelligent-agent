import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import type { EnvironmentVariables } from '../../../../config/environment.js';
import { PrismaService } from '../../../../database/prisma.service.js';
import {
  jsonObject,
  runtimeHash,
  stringArray,
} from '../../../process-orchestration/infrastructure/prisma/runtime-prisma.support.js';
import {
  decideToolInvocationTransition,
  type ToolInvocationCommand,
  type TrustedToolCompensationTransitionProof,
  type TrustedToolProviderTransitionProof,
  type TrustedToolTransitionActor,
} from '../../domain/tool-invocation-state-machine.js';
import { ToolExecutionRepository } from '../../domain/tool-execution.repository.js';
import {
  decideToolExecutionEvent,
  type ParsedToolCommandEvent,
  type PreparedToolExecution,
  type ToolDnsProofInput,
  type ToolExecutionInspection,
  type ToolExecutionSettlement,
  type ToolExecutionStartResult,
} from '../../domain/tool-execution.models.js';
import type { PreparedHttpTarget } from '../../tool-execution.port.js';
import { type ToolInvocationRow, withToolTenant } from './tool-gateway-prisma.support.js';

const TOOL_GATEWAY_SERVICE_PRINCIPAL_ID = '00000000-0000-7000-8000-00000000a004';
const PROVIDER_REQUEST_PREFIX = 'tool-provider:';

interface ExecutionRow extends ToolInvocationRow {
  readonly endpoint_ref: string;
  readonly output_schema: unknown;
  readonly timeout_ms: number;
  readonly max_attempts: number;
  readonly allowed_http_methods: unknown;
  readonly allowed_host_patterns: unknown;
}

interface CompensationOriginalRow extends ToolInvocationRow {
  readonly bound_original_tool_version_id: string;
  readonly bound_compensation_tool_version_id: string;
  readonly bound_original_input_hash: string;
  readonly bound_original_provider_request_id: string;
  readonly bound_original_output_hash: string;
  readonly bound_compensation_input_hash: string;
}

@Injectable()
export class PrismaToolExecutionRepository extends ToolExecutionRepository {
  private readonly maxConcurrentPerVersion: number;
  private readonly maxStartsPerMinutePerVersion: number;
  private readonly capacityRetryMs: number;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ConfigService) config: ConfigService<EnvironmentVariables, true>,
  ) {
    super();
    this.maxConcurrentPerVersion = config.get('TOOL_MAX_CONCURRENT_PER_VERSION', {
      infer: true,
    });
    this.maxStartsPerMinutePerVersion = config.get('TOOL_MAX_STARTS_PER_MINUTE_PER_VERSION', {
      infer: true,
    });
    this.capacityRetryMs = Math.max(
      250,
      config.get('TOOL_EXECUTION_POLL_INTERVAL_MS', { infer: true }),
    );
  }

  inspect(
    tenantId: string,
    invocationId: string,
    event: ParsedToolCommandEvent,
  ): Promise<ToolExecutionInspection> {
    return withToolTenant(
      this.prisma,
      tenantId,
      TOOL_GATEWAY_SERVICE_PRINCIPAL_ID,
      'enterprise_agent_tool_gateway',
      async (transaction) => {
        const row = await loadExecutionRow(transaction, tenantId, invocationId, false);
        if (row === null) {
          return {
            kind: 'skip',
            reasonCode: 'STALE_EXECUTION_EVENT',
            providerRequestId: null,
          };
        }
        const providerRequestId = row.provider_request_id ?? `${PROVIDER_REQUEST_PREFIX}${row.id}`;
        const decision = decideToolExecutionEvent({
          command: event.command,
          eventResultRevision: event.resultRevision,
          currentStatus: row.status,
          currentRevision: row.revision,
          providerRequestId: row.provider_request_id,
          providerDispatchAllowed: row.provider_dispatch_allowed,
          dryRun: row.dry_run,
          dryRunMode: row.dry_run_mode,
        });
        if (decision.kind === 'skip') {
          return {
            kind: 'skip',
            reasonCode: decision.reasonCode,
            providerRequestId: row.provider_request_id,
          };
        }
        if (decision.kind === 'ready') {
          return { kind: 'ready', execution: mapPreparedExecution(row, providerRequestId) };
        }
        return {
          kind: 'ambiguous_dispatch',
          execution: mapPreparedExecution(row, providerRequestId),
          reasonCode: 'TOOL_PROVIDER_DISPATCH_AMBIGUOUS',
        };
      },
    );
  }

  start(execution: PreparedToolExecution): Promise<ToolExecutionStartResult> {
    return withToolTenant(
      this.prisma,
      execution.tenantId,
      TOOL_GATEWAY_SERVICE_PRINCIPAL_ID,
      'enterprise_agent_tool_gateway',
      async (transaction) => {
        const current = await loadExecutionRow(transaction, execution.tenantId, execution.id, true);
        if (
          current === null ||
          current.status !== 'APPROVED' ||
          current.revision !== execution.revision ||
          current.tool_version_id !== execution.toolVersionId ||
          current.tool_configuration_hash !== execution.configurationHash ||
          !current.provider_dispatch_allowed
        ) {
          return { kind: 'stale' };
        }
        const now = new Date();
        await transaction.$queryRaw(Prisma.sql`
          SELECT pg_advisory_xact_lock(
            hashtextextended(
              ${`tool-capacity:${current.tenant_id}:${current.tool_version_id}`},
              0
            )
          )
        `);
        const capacityRows = await transaction.$queryRaw<
          Array<{
            executing_count: bigint;
            recent_starts: bigint;
            oldest_recent_start: Date | null;
          }>
        >(Prisma.sql`
          SELECT
            count(*) FILTER (
              WHERE invocation."status" = 'EXECUTING'::public."ToolInvocationStatus"
            )::bigint AS executing_count,
            count(*) FILTER (
              WHERE invocation."started_at" >= ${now} - INTERVAL '1 minute'
            )::bigint AS recent_starts,
            min(invocation."started_at") FILTER (
              WHERE invocation."started_at" >= ${now} - INTERVAL '1 minute'
            ) AS oldest_recent_start
          FROM public."tool_invocations" invocation
          WHERE invocation."tenant_id" = ${current.tenant_id}::uuid
            AND invocation."tool_version_id" = ${current.tool_version_id}::uuid
        `);
        const capacity = capacityRows[0];
        if (
          capacity !== undefined &&
          capacity.executing_count >= BigInt(this.maxConcurrentPerVersion)
        ) {
          return {
            kind: 'deferred',
            reasonCode: 'TOOL_CONCURRENCY_LIMIT',
            availableAt: new Date(now.getTime() + this.capacityRetryMs),
          };
        }
        if (
          capacity !== undefined &&
          capacity.recent_starts >= BigInt(this.maxStartsPerMinutePerVersion)
        ) {
          const oldest = capacity.oldest_recent_start?.getTime() ?? now.getTime();
          return {
            kind: 'deferred',
            reasonCode: 'TOOL_RATE_LIMIT',
            availableAt: new Date(Math.max(now.getTime() + this.capacityRetryMs, oldest + 60_000)),
          };
        }
        if (
          current.compensation_for_invocation_id !== null &&
          !(await beginOriginalCompensation(transaction, current, now))
        ) {
          throw new Error(
            'Compensation execution could not bind and transition its immutable original invocation.',
          );
        }
        const actor = systemActor(current.tenant_id);
        const policyProof = {
          tenantId: current.tenant_id,
          invocationId: current.id,
          toolVersionId: current.tool_version_id,
          taskId: current.task_id,
          inputHash: current.input_hash,
          policyDecisionId: current.policy_decision_id,
          riskClass: current.risk_class,
          dryRun: current.dry_run,
          decision: 'ALLOW' as const,
          issuedAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + current.timeout_ms + 60_000).toISOString(),
        };
        const decision = decideToolInvocationTransition({
          tenantId: current.tenant_id,
          invocationId: current.id,
          inputHash: current.input_hash,
          policyDecisionId: current.policy_decision_id,
          dryRun: current.dry_run,
          status: current.status,
          command: 'START',
          riskClass: current.risk_class,
          requesterUserId: current.requester_user_id,
          requesterRoleAssignmentId: current.role_assignment_id,
          actor,
          policyProof,
          now,
        });
        if (!decision.allowed || decision.nextStatus !== 'EXECUTING') {
          return { kind: 'stale' };
        }
        await insertCommand(transaction, current, {
          command: 'START',
          actor,
          reason: 'Tool Execution Worker accepted the approved invocation.',
          policyProof,
          providerProof: null,
          occurredAt: now,
        });
        const providerRequestId = `${PROVIDER_REQUEST_PREFIX}${current.id}`;
        const rows = await transaction.$queryRaw<ExecutionRow[]>(Prisma.sql`
          UPDATE public."tool_invocations"
          SET
            "status" = 'EXECUTING'::public."ToolInvocationStatus",
            "revision" = "revision" + 1,
            "execution_attempt" = "execution_attempt" + 1,
            "provider_request_id" = ${providerRequestId},
            "started_at" = ${now},
            "updated_at" = ${now}
          WHERE "tenant_id" = ${current.tenant_id}::uuid
            AND "id" = ${current.id}::uuid
            AND "revision" = ${current.revision}
            AND "status" = 'APPROVED'::public."ToolInvocationStatus"
          RETURNING *,
            ${current.endpoint_ref}::varchar AS endpoint_ref,
            ${JSON.stringify(jsonObject(current.output_schema))}::jsonb AS output_schema,
            ${current.timeout_ms}::integer AS timeout_ms,
            ${current.max_attempts}::integer AS max_attempts,
            ${JSON.stringify(stringArray(current.allowed_http_methods))}::jsonb
              AS allowed_http_methods,
            ${JSON.stringify(stringArray(current.allowed_host_patterns))}::jsonb
              AS allowed_host_patterns
        `);
        const updated = rows[0];
        return updated === undefined
          ? { kind: 'stale' }
          : {
              kind: 'started',
              execution: mapPreparedExecution(updated, providerRequestId),
            };
      },
    );
  }

  recordDnsProof(input: ToolDnsProofInput): Promise<void> {
    return withToolTenant(
      this.prisma,
      input.tenantId,
      TOOL_GATEWAY_SERVICE_PRINCIPAL_ID,
      'enterprise_agent_tool_gateway',
      async (transaction) => {
        const requestedUrlHash = runtimeHash(input.requestedUrl);
        const proofHash = runtimeHash({
          tenantId: input.tenantId,
          invocationId: input.invocationId,
          invocationRevision: input.invocationRevision,
          requestedUrlHash,
          hostname: input.hostname,
          tlsServerName: input.tlsServerName,
          addresses: [...input.addresses].sort(),
          pinnedIpAddress: input.pinnedIpAddress,
          resolverName: input.resolverName,
          ttlSeconds: input.ttlSeconds,
          decision: input.decision,
          decisionReason: input.decisionReason,
          resolvedAt: input.resolvedAt.toISOString(),
          expiresAt: input.expiresAt.toISOString(),
        });
        await transaction.$executeRaw(Prisma.sql`
          INSERT INTO public."tool_dns_resolution_proofs" (
            "id", "tenant_id", "tool_invocation_id", "invocation_revision",
            "redirect_index", "requested_url_hash", "redirect_from_url_hash",
            "hostname", "port", "tls_server_name", "resolved_ip_addresses",
            "pinned_ip_address", "resolver_name", "ttl_seconds", "decision",
            "decision_reason", "resolved_at", "expires_at", "proof_hash"
          ) VALUES (
            ${randomUUID()}::uuid,
            ${input.tenantId}::uuid,
            ${input.invocationId}::uuid,
            ${input.invocationRevision},
            0,
            ${requestedUrlHash},
            NULL,
            ${input.hostname},
            443,
            ${input.tlsServerName},
            ${JSON.stringify(input.addresses)}::jsonb,
            ${input.pinnedIpAddress}::inet,
            ${input.resolverName},
            ${input.ttlSeconds},
            ${input.decision}::public."ToolDnsDecision",
            ${input.decisionReason},
            ${input.resolvedAt},
            ${input.expiresAt},
            ${proofHash}
          )
        `);
      },
    );
  }

  settle(
    execution: PreparedToolExecution,
    settlement: ToolExecutionSettlement,
    target: PreparedHttpTarget | null,
  ): Promise<boolean> {
    return withToolTenant(
      this.prisma,
      execution.tenantId,
      TOOL_GATEWAY_SERVICE_PRINCIPAL_ID,
      'enterprise_agent_tool_gateway',
      async (transaction) => {
        const current = await loadExecutionRow(transaction, execution.tenantId, execution.id, true);
        if (
          current === null ||
          current.status !== 'EXECUTING' ||
          current.revision !== execution.revision ||
          current.provider_request_id !== execution.providerRequestId ||
          settlement.providerRequestId !== execution.providerRequestId
        ) {
          return false;
        }
        if (current.adapter === 'HTTP' && target === null) return false;
        const command = settlementCommand(settlement.outcome);
        const actor = providerActor(current.tenant_id);
        const providerProof: ProviderProof = {
          tenantId: current.tenant_id,
          invocationId: current.id,
          toolVersionId: current.tool_version_id,
          inputHash: current.input_hash,
          providerRequestId: settlement.providerRequestId,
          outcome: settlement.outcome,
        };
        const decision = decideToolInvocationTransition({
          tenantId: current.tenant_id,
          invocationId: current.id,
          inputHash: current.input_hash,
          policyDecisionId: current.policy_decision_id,
          dryRun: current.dry_run,
          status: current.status,
          command,
          riskClass: current.risk_class,
          requesterUserId: current.requester_user_id,
          requesterRoleAssignmentId: current.role_assignment_id,
          actor,
          providerProof,
          now: settlement.completedAt,
        });
        if (!decision.allowed) return false;

        const outputHash =
          settlement.outcome === 'SUCCEEDED' && settlement.output !== null
            ? runtimeHash(settlement.output)
            : null;
        const responseHash =
          outputHash ??
          runtimeHash({
            outcome: settlement.outcome,
            errorCode: settlement.errorCode,
            providerRequestId: settlement.providerRequestId,
          });
        const requestHash = runtimeHash({
          invocationId: current.id,
          providerRequestId: settlement.providerRequestId,
          inputHash: current.input_hash,
          toolConfigurationHash: current.tool_configuration_hash,
          providerDryRun: current.provider_dry_run,
        });
        const latencyMs = Math.max(
          0,
          settlement.completedAt.getTime() - settlement.startedAt.getTime(),
        );
        const costMicros =
          settlement.cost.kind === 'UNATTESTED' ? null : settlement.cost.costMicros;
        const costAttestation = settlement.cost.kind;
        const draftOutput =
          settlement.output !== null && settlement.output.artifactMode === 'DRAFT';
        const receiptHash = runtimeHash({
          invocationId: current.id,
          invocationRevision: current.revision + 1,
          executionAttempt: current.execution_attempt,
          outcome: settlement.outcome,
          providerRequestId: settlement.providerRequestId,
          inputHash: current.input_hash,
          requestHash,
          responseHash,
          providerDryRun: current.provider_dry_run,
          draftOutput,
          startedAt: settlement.startedAt.toISOString(),
          completedAt: settlement.completedAt.toISOString(),
          latencyMs,
          costAttestation,
          costMicros: costMicros?.toString() ?? null,
        });
        await transaction.$executeRaw(Prisma.sql`
          INSERT INTO public."tool_execution_receipts" (
            "id", "tenant_id", "tool_invocation_id", "invocation_revision",
            "execution_attempt", "source", "outcome", "provider_request_id",
            "input_hash", "request_hash", "response_hash", "provider_dry_run",
            "draft_output", "started_at", "completed_at", "latency_ms",
            "cost_micros", "cost_attestation", "receipt_hash"
          ) VALUES (
            ${randomUUID()}::uuid,
            ${current.tenant_id}::uuid,
            ${current.id}::uuid,
            ${current.revision + 1},
            ${current.execution_attempt},
            'PROVIDER'::public."ToolExecutionReceiptSource",
            ${settlement.outcome}::public."ToolExecutionReceiptOutcome",
            ${settlement.providerRequestId},
            ${current.input_hash},
            ${requestHash},
            ${responseHash},
            ${current.provider_dry_run},
            ${draftOutput},
            ${settlement.startedAt},
            ${settlement.completedAt},
            ${latencyMs},
            ${costMicros},
            ${costAttestation}::public."ToolCostAttestation",
            ${receiptHash}
          )
        `);
        if (
          settlement.outcome !== 'UNKNOWN' &&
          current.compensation_for_invocation_id !== null &&
          !(await finalizeOriginalCompensation(transaction, current, {
            outcome: settlement.outcome,
            compensationReceiptHash: receiptHash,
            childProviderRequestId: settlement.providerRequestId,
            completedAt: settlement.completedAt,
            errorCode: settlement.errorCode,
            errorDetail: settlement.errorDetail,
          }))
        ) {
          throw new Error(
            'Compensation provider result could not finalize its immutable original invocation.',
          );
        }
        await insertCommand(transaction, current, {
          command,
          actor,
          reason: settlementReason(settlement),
          policyProof: null,
          providerProof,
          occurredAt: settlement.completedAt,
        });
        const outputJson =
          settlement.outcome === 'SUCCEEDED' && settlement.output !== null
            ? JSON.stringify(settlement.output)
            : null;
        const errorCode =
          settlement.outcome === 'SUCCEEDED'
            ? null
            : safeCode(settlement.errorCode ?? `TOOL_PROVIDER_${settlement.outcome}`);
        const errorDetail =
          settlement.outcome === 'SUCCEEDED'
            ? null
            : safeDetail(
                settlement.errorDetail ??
                  'The provider did not return a trusted successful result.',
              );
        const rows = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          UPDATE public."tool_invocations"
          SET
            "status" = ${decision.nextStatus}::public."ToolInvocationStatus",
            "revision" = "revision" + 1,
            "output" = ${outputJson}::jsonb,
            "output_hash" = ${outputHash},
            "error_code" = ${errorCode},
            "error_detail" = ${errorDetail},
            "completed_at" = ${settlement.completedAt},
            "updated_at" = ${settlement.completedAt}
          WHERE "tenant_id" = ${current.tenant_id}::uuid
            AND "id" = ${current.id}::uuid
            AND "revision" = ${current.revision}
            AND "status" = 'EXECUTING'::public."ToolInvocationStatus"
          RETURNING "id"::text AS id
        `);
        return rows.length === 1;
      },
    );
  }

  failBeforeDispatch(
    execution: PreparedToolExecution,
    reasonCode: string,
    detail: string,
  ): Promise<boolean> {
    return withToolTenant(
      this.prisma,
      execution.tenantId,
      TOOL_GATEWAY_SERVICE_PRINCIPAL_ID,
      'enterprise_agent_tool_gateway',
      async (transaction) => {
        const current = await loadExecutionRow(transaction, execution.tenantId, execution.id, true);
        if (
          current === null ||
          current.status !== 'EXECUTING' ||
          current.revision !== execution.revision ||
          current.provider_request_id !== execution.providerRequestId
        ) {
          return current?.status === 'FAILED';
        }
        const now = new Date();
        const actor = providerActor(current.tenant_id);
        const providerProof: ProviderProof = {
          tenantId: current.tenant_id,
          invocationId: current.id,
          toolVersionId: current.tool_version_id,
          inputHash: current.input_hash,
          providerRequestId: execution.providerRequestId,
          outcome: 'FAILED',
        };
        const decision = decideToolInvocationTransition({
          tenantId: current.tenant_id,
          invocationId: current.id,
          inputHash: current.input_hash,
          policyDecisionId: current.policy_decision_id,
          dryRun: current.dry_run,
          status: current.status,
          command: 'FAIL',
          riskClass: current.risk_class,
          requesterUserId: current.requester_user_id,
          requesterRoleAssignmentId: current.role_assignment_id,
          actor,
          providerProof,
          now,
        });
        if (!decision.allowed) return false;
        const startedAt = current.started_at ?? now;
        const latencyMs = Math.max(0, now.getTime() - startedAt.getTime());
        const requestHash = runtimeHash({
          invocationId: current.id,
          providerRequestId: null,
          inputHash: current.input_hash,
          toolConfigurationHash: current.tool_configuration_hash,
          failureBoundary: 'PRE_DISPATCH',
          reasonCode: safeCode(reasonCode),
        });
        const receiptHash = runtimeHash({
          invocationId: current.id,
          invocationRevision: current.revision + 1,
          executionAttempt: current.execution_attempt,
          source: 'GATEWAY_VALIDATOR',
          outcome: 'FAILED',
          inputHash: current.input_hash,
          requestHash,
          responseHash: null,
          providerDryRun: current.provider_dry_run,
          startedAt: startedAt.toISOString(),
          completedAt: now.toISOString(),
          latencyMs,
          costAttestation: 'GATEWAY_ATTESTED',
          costMicros: '0',
        });
        await transaction.$executeRaw(Prisma.sql`
          INSERT INTO public."tool_execution_receipts" (
            "id", "tenant_id", "tool_invocation_id", "invocation_revision",
            "execution_attempt", "source", "outcome", "provider_request_id",
            "input_hash", "request_hash", "response_hash", "provider_dry_run",
            "draft_output", "started_at", "completed_at", "latency_ms",
            "cost_micros", "cost_attestation", "receipt_hash"
          ) VALUES (
            ${randomUUID()}::uuid,
            ${current.tenant_id}::uuid,
            ${current.id}::uuid,
            ${current.revision + 1},
            ${current.execution_attempt},
            'GATEWAY_VALIDATOR'::public."ToolExecutionReceiptSource",
            'FAILED'::public."ToolExecutionReceiptOutcome",
            NULL,
            ${current.input_hash},
            ${requestHash},
            NULL,
            ${current.provider_dry_run},
            false,
            ${startedAt},
            ${now},
            ${latencyMs},
            0,
            'GATEWAY_ATTESTED'::public."ToolCostAttestation",
            ${receiptHash}
          )
        `);
        if (
          current.compensation_for_invocation_id !== null &&
          !(await finalizeOriginalCompensation(transaction, current, {
            outcome: 'FAILED',
            compensationReceiptHash: receiptHash,
            childProviderRequestId: execution.providerRequestId,
            completedAt: now,
            errorCode: safeCode(reasonCode),
            errorDetail: safeDetail(detail),
          }))
        ) {
          throw new Error(
            'Failed compensation could not finalize its immutable original invocation.',
          );
        }
        await insertCommand(transaction, current, {
          command: 'FAIL',
          actor,
          reason: 'Tool Gateway rejected the execution before provider dispatch.',
          policyProof: null,
          providerProof,
          occurredAt: now,
        });
        const updated = await transaction.$executeRaw(Prisma.sql`
          UPDATE public."tool_invocations"
          SET
            "status" = 'FAILED'::public."ToolInvocationStatus",
            "revision" = "revision" + 1,
            "error_code" = ${safeCode(reasonCode)},
            "error_detail" = ${safeDetail(detail)},
            "completed_at" = ${now},
            "updated_at" = ${now}
          WHERE "tenant_id" = ${current.tenant_id}::uuid
            AND "id" = ${current.id}::uuid
            AND "revision" = ${current.revision}
            AND "status" = 'EXECUTING'::public."ToolInvocationStatus"
        `);
        return updated === 1;
      },
    );
  }

  markAmbiguous(execution: PreparedToolExecution, reasonCode: string): Promise<boolean> {
    return withToolTenant(
      this.prisma,
      execution.tenantId,
      TOOL_GATEWAY_SERVICE_PRINCIPAL_ID,
      'enterprise_agent_tool_gateway',
      async (transaction) => {
        const current = await loadExecutionRow(transaction, execution.tenantId, execution.id, true);
        if (
          current === null ||
          current.status !== 'EXECUTING' ||
          current.provider_request_id !== execution.providerRequestId
        ) {
          return current?.status === 'UNKNOWN';
        }
        const now = new Date();
        const actor = providerActor(current.tenant_id);
        const providerProof: ProviderProof = {
          tenantId: current.tenant_id,
          invocationId: current.id,
          toolVersionId: current.tool_version_id,
          inputHash: current.input_hash,
          providerRequestId: execution.providerRequestId,
          outcome: 'UNKNOWN',
        };
        const decision = decideToolInvocationTransition({
          tenantId: current.tenant_id,
          invocationId: current.id,
          inputHash: current.input_hash,
          policyDecisionId: current.policy_decision_id,
          dryRun: current.dry_run,
          status: current.status,
          command: 'MARK_UNKNOWN',
          riskClass: current.risk_class,
          requesterUserId: current.requester_user_id,
          requesterRoleAssignmentId: current.role_assignment_id,
          actor,
          providerProof,
          now,
        });
        if (!decision.allowed) return false;
        await insertCommand(transaction, current, {
          command: 'MARK_UNKNOWN',
          actor,
          reason: 'Worker lease recovery found an ambiguous provider dispatch boundary.',
          policyProof: null,
          providerProof,
          occurredAt: now,
        });
        const updated = await transaction.$executeRaw(Prisma.sql`
          UPDATE public."tool_invocations"
          SET
            "status" = 'UNKNOWN'::public."ToolInvocationStatus",
            "revision" = "revision" + 1,
            "error_code" = ${safeCode(reasonCode)},
            "error_detail" =
              'Provider delivery could not be proven after worker recovery; reconcile before retry.',
            "completed_at" = ${now},
            "updated_at" = ${now}
          WHERE "tenant_id" = ${current.tenant_id}::uuid
            AND "id" = ${current.id}::uuid
            AND "revision" = ${current.revision}
            AND "status" = 'EXECUTING'::public."ToolInvocationStatus"
        `);
        return updated === 1;
      },
    );
  }
}

async function beginOriginalCompensation(
  transaction: Prisma.TransactionClient,
  child: ExecutionRow,
  now: Date,
): Promise<boolean> {
  const original = await loadCompensationOriginal(transaction, child, true);
  if (
    original === null ||
    original.status !== 'SUCCEEDED' ||
    original.dry_run ||
    original.provider_request_id === null ||
    original.output_hash === null
  ) {
    return false;
  }
  const actor = compensationActor(original.tenant_id);
  const proof = compensationProof(original, child, 'BEGIN_COMPENSATION', null);
  const decision = decideToolInvocationTransition({
    tenantId: original.tenant_id,
    invocationId: original.id,
    inputHash: original.input_hash,
    policyDecisionId: original.policy_decision_id,
    dryRun: original.dry_run,
    status: original.status,
    command: 'BEGIN_COMPENSATION',
    riskClass: original.risk_class,
    requesterUserId: original.requester_user_id,
    requesterRoleAssignmentId: original.role_assignment_id,
    actor,
    compensationProof: proof,
    now,
  });
  if (!decision.allowed || decision.nextStatus !== 'COMPENSATING') return false;
  await insertCommand(transaction, original, {
    command: 'BEGIN_COMPENSATION',
    actor,
    reason: `Compensation invocation ${child.id} started governed execution.`,
    policyProof: null,
    providerProof: null,
    compensationProof: proof,
    occurredAt: now,
  });
  const updated = await transaction.$executeRaw(Prisma.sql`
    UPDATE public."tool_invocations"
    SET "status" = 'COMPENSATING'::public."ToolInvocationStatus",
        "revision" = "revision" + 1,
        "updated_at" = ${now}
    WHERE "tenant_id" = ${original.tenant_id}::uuid
      AND "id" = ${original.id}::uuid
      AND "revision" = ${original.revision}
      AND "status" = 'SUCCEEDED'::public."ToolInvocationStatus"
  `);
  return updated === 1;
}

async function finalizeOriginalCompensation(
  transaction: Prisma.TransactionClient,
  child: ExecutionRow,
  result: {
    readonly outcome: 'SUCCEEDED' | 'FAILED';
    readonly compensationReceiptHash: string;
    readonly childProviderRequestId: string;
    readonly completedAt: Date;
    readonly errorCode: string | null;
    readonly errorDetail: string | null;
  },
): Promise<boolean> {
  const original = await loadCompensationOriginal(transaction, child, true);
  if (
    original === null ||
    original.status !== 'COMPENSATING' ||
    original.provider_request_id === null ||
    original.output_hash === null ||
    child.started_at === null
  ) {
    return false;
  }
  const command = result.outcome === 'SUCCEEDED' ? 'COMPLETE_COMPENSATION' : 'FAIL_COMPENSATION';
  const nextStatus = result.outcome === 'SUCCEEDED' ? 'COMPENSATED' : 'COMPENSATION_FAILED';
  const actor = compensationActor(original.tenant_id);
  const proof = compensationProof(original, child, command, result.compensationReceiptHash);
  const decision = decideToolInvocationTransition({
    tenantId: original.tenant_id,
    invocationId: original.id,
    inputHash: original.input_hash,
    policyDecisionId: original.policy_decision_id,
    dryRun: original.dry_run,
    status: original.status,
    command,
    riskClass: original.risk_class,
    requesterUserId: original.requester_user_id,
    requesterRoleAssignmentId: original.role_assignment_id,
    actor,
    compensationProof: proof,
    now: result.completedAt,
  });
  if (!decision.allowed || decision.nextStatus !== nextStatus) return false;

  const requestHash = runtimeHash({
    originalInvocationId: original.id,
    originalProviderRequestId: original.provider_request_id,
    originalInputHash: original.input_hash,
    childInvocationId: child.id,
    compensationToolVersionId: child.tool_version_id,
    compensationInputHash: child.input_hash,
    childProviderRequestId: result.childProviderRequestId,
  });
  const latencyMs = Math.max(0, result.completedAt.getTime() - child.started_at.getTime());
  const receiptHash = runtimeHash({
    originalInvocationId: original.id,
    originalRevision: original.revision + 1,
    originalExecutionAttempt: original.execution_attempt,
    outcome: nextStatus,
    requestHash,
    childReceiptHash: result.compensationReceiptHash,
    childProviderRequestId: result.childProviderRequestId,
    startedAt: child.started_at.toISOString(),
    completedAt: result.completedAt.toISOString(),
  });
  await transaction.$executeRaw(Prisma.sql`
    INSERT INTO public."tool_execution_receipts" (
      "id", "tenant_id", "tool_invocation_id", "invocation_revision",
      "execution_attempt", "source", "outcome", "provider_request_id",
      "input_hash", "request_hash", "response_hash", "provider_dry_run",
      "draft_output", "started_at", "completed_at", "latency_ms",
      "cost_micros", "cost_attestation", "receipt_hash"
    ) VALUES (
      ${randomUUID()}::uuid,
      ${original.tenant_id}::uuid,
      ${original.id}::uuid,
      ${original.revision + 1},
      ${original.execution_attempt},
      'COMPENSATOR'::public."ToolExecutionReceiptSource",
      ${nextStatus}::public."ToolExecutionReceiptOutcome",
      ${result.childProviderRequestId},
      ${original.input_hash},
      ${requestHash},
      ${result.compensationReceiptHash},
      ${original.provider_dry_run},
      false,
      ${child.started_at},
      ${result.completedAt},
      ${latencyMs},
      0,
      'GATEWAY_ATTESTED'::public."ToolCostAttestation",
      ${receiptHash}
    )
  `);
  await insertCommand(transaction, original, {
    command,
    actor,
    reason:
      result.outcome === 'SUCCEEDED'
        ? `Compensation invocation ${child.id} completed with a trusted receipt.`
        : `Compensation invocation ${child.id} returned a trusted failure receipt.`,
    policyProof: null,
    providerProof: null,
    compensationProof: proof,
    occurredAt: result.completedAt,
  });
  const failureDetail =
    result.outcome === 'FAILED'
      ? safeDetail(
          `Compensation invocation ${child.id} failed: ${result.errorCode ?? 'TOOL_PROVIDER_FAILED'} — ${
            result.errorDetail ?? 'No provider detail was returned.'
          }`,
        )
      : null;
  const updated = await transaction.$executeRaw(Prisma.sql`
    UPDATE public."tool_invocations"
    SET "status" = ${nextStatus}::public."ToolInvocationStatus",
        "revision" = "revision" + 1,
        "error_code" = ${result.outcome === 'FAILED' ? 'TOOL_COMPENSATION_FAILED' : null},
        "error_detail" = ${failureDetail},
        "completed_at" = ${result.completedAt},
        "updated_at" = ${result.completedAt}
    WHERE "tenant_id" = ${original.tenant_id}::uuid
      AND "id" = ${original.id}::uuid
      AND "revision" = ${original.revision}
      AND "status" = 'COMPENSATING'::public."ToolInvocationStatus"
  `);
  return updated === 1;
}

async function loadCompensationOriginal(
  transaction: Prisma.TransactionClient,
  child: ToolInvocationRow,
  lock: boolean,
): Promise<CompensationOriginalRow | null> {
  if (child.compensation_for_invocation_id === null) return null;
  const rows = await transaction.$queryRaw<CompensationOriginalRow[]>(Prisma.sql`
    SELECT original.*,
           binding."original_tool_version_id"
             AS bound_original_tool_version_id,
           binding."compensation_tool_version_id"
             AS bound_compensation_tool_version_id,
           binding."original_input_hash" AS bound_original_input_hash,
           binding."original_provider_request_id"
             AS bound_original_provider_request_id,
           binding."original_output_hash" AS bound_original_output_hash,
           binding."compensation_input_hash" AS bound_compensation_input_hash
    FROM public."tool_compensation_bindings" binding
    JOIN public."tool_invocations" original
      ON original."tenant_id" = binding."tenant_id"
     AND original."id" = binding."original_invocation_id"
    WHERE binding."tenant_id" = ${child.tenant_id}::uuid
      AND binding."original_invocation_id" =
          ${child.compensation_for_invocation_id}::uuid
      AND binding."compensation_invocation_id" = ${child.id}::uuid
      AND binding."compensation_tool_version_id" =
          ${child.tool_version_id}::uuid
      AND binding."compensation_input_hash" = ${child.input_hash}
      AND original."tool_version_id" = binding."original_tool_version_id"
      AND original."input_hash" = binding."original_input_hash"
      AND original."provider_request_id" =
          binding."original_provider_request_id"
      AND original."output_hash" = binding."original_output_hash"
    LIMIT 1
    ${lock ? Prisma.sql`FOR UPDATE OF original` : Prisma.empty}
  `);
  return rows[0] ?? null;
}

function compensationProof(
  original: CompensationOriginalRow,
  child: ToolInvocationRow,
  command: 'BEGIN_COMPENSATION' | 'COMPLETE_COMPENSATION' | 'FAIL_COMPENSATION',
  compensationReceiptHash: string | null,
): TrustedToolCompensationTransitionProof {
  return {
    tenantId: original.tenant_id,
    invocationId: original.id,
    toolVersionId: original.tool_version_id,
    inputHash: original.input_hash,
    compensationInvocationId: child.id,
    compensationToolVersionId: child.tool_version_id,
    compensationInputHash: child.input_hash,
    originalProviderRequestId: original.provider_request_id ?? '',
    originalOutputHash: original.output_hash ?? '',
    compensationReceiptHash,
    authorizedCommand: command,
  };
}

async function loadExecutionRow(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  invocationId: string,
  lock: boolean,
): Promise<ExecutionRow | null> {
  const rows = await transaction.$queryRaw<ExecutionRow[]>(Prisma.sql`
    SELECT invocation.*,
           version."endpoint_ref",
           version."output_schema",
           version."timeout_ms",
           version."max_attempts",
           version."allowed_http_methods",
           version."allowed_host_patterns"
    FROM public."tool_invocations" invocation
    JOIN public."tool_versions" version
      ON version."tenant_id" = invocation."tenant_id"
     AND version."tool_id" = invocation."tool_id"
     AND version."id" = invocation."tool_version_id"
     AND version."version" = invocation."tool_version"
     AND version."configuration_hash" = invocation."tool_configuration_hash"
    WHERE invocation."tenant_id" = ${tenantId}::uuid
      AND invocation."id" = ${invocationId}::uuid
    LIMIT 1
    ${lock ? Prisma.sql`FOR UPDATE OF invocation` : Prisma.empty}
  `);
  return rows[0] ?? null;
}

function mapPreparedExecution(row: ExecutionRow, providerRequestId: string): PreparedToolExecution {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    toolId: row.tool_id,
    toolVersionId: row.tool_version_id,
    toolVersion: row.tool_version,
    configurationHash: row.tool_configuration_hash,
    endpointRef: row.endpoint_ref,
    adapter: row.adapter,
    riskClass: row.risk_class,
    dataClassification: row.data_classification,
    idempotencyMode: row.idempotency_mode,
    dryRunMode: row.dry_run_mode,
    requesterUserId: row.requester_user_id,
    roleAssignmentId: row.role_assignment_id,
    taskId: row.task_id,
    correlationId: row.correlation_id,
    status: row.status,
    revision: row.revision,
    providerRequestId,
    providerDryRun: row.provider_dry_run,
    input: jsonObject(row.input),
    inputHash: row.input_hash,
    outputSchema: jsonObject(row.output_schema),
    timeoutMs: row.timeout_ms,
    maxAttempts: row.max_attempts,
    allowedHttpMethods: stringArray(row.allowed_http_methods),
    allowedHostPatterns: stringArray(row.allowed_host_patterns),
    executionAttempt: row.execution_attempt,
    startedAt: row.started_at,
  };
}

async function insertCommand(
  transaction: Prisma.TransactionClient,
  current: ToolInvocationRow,
  input: {
    readonly command: ToolInvocationCommand;
    readonly actor: TrustedToolTransitionActor;
    readonly reason: string;
    readonly policyProof: unknown | null;
    readonly providerProof: TrustedToolProviderTransitionProof | null;
    readonly compensationProof?: TrustedToolCompensationTransitionProof | null;
    readonly occurredAt: Date;
  },
): Promise<void> {
  const idempotencyKey = `tool-worker:${runtimeHash({
    invocationId: current.id,
    revision: current.revision,
    command: input.command,
    providerRequestId: input.providerProof?.providerRequestId ?? null,
  })}`;
  await transaction.$executeRaw(Prisma.sql`
    INSERT INTO public."tool_invocation_commands" (
      "id", "tenant_id", "tool_invocation_id", "command",
      "expected_revision", "result_revision", "actor_type",
      "actor_user_id", "actor_role_assignment_id",
      "actor_service_principal_id", "reason", "policy_proof",
      "confirmation_proof", "approval_proof", "provider_proof",
      "compensation_proof", "idempotency_key", "request_hash", "occurred_at"
    ) VALUES (
      ${randomUUID()}::uuid,
      ${current.tenant_id}::uuid,
      ${current.id}::uuid,
      ${input.command}::public."ToolInvocationCommandType",
      ${current.revision},
      ${current.revision + 1},
      ${input.actor.type}::public."ToolInvocationActorType",
      NULL,
      NULL,
      ${input.actor.servicePrincipalId}::uuid,
      ${input.reason},
      ${jsonOrNull(input.policyProof)}::jsonb,
      NULL,
      NULL,
      ${jsonOrNull(input.providerProof)}::jsonb,
      ${jsonOrNull(input.compensationProof)}::jsonb,
      ${idempotencyKey},
      ${current.input_hash},
      ${input.occurredAt}
    )
  `);
}

function providerActor(tenantId: string): TrustedToolTransitionActor {
  return {
    type: 'PROVIDER',
    tenantId,
    userId: null,
    servicePrincipalId: TOOL_GATEWAY_SERVICE_PRINCIPAL_ID,
    roleAssignment: null,
    capabilityActions: ['tool.policy.transition', 'tool.provider.transition'],
  };
}

function systemActor(tenantId: string): TrustedToolTransitionActor {
  return {
    type: 'SYSTEM',
    tenantId,
    userId: null,
    servicePrincipalId: TOOL_GATEWAY_SERVICE_PRINCIPAL_ID,
    roleAssignment: null,
    capabilityActions: ['tool.policy.transition', 'tool.provider.transition', 'tool.compensate'],
  };
}

function compensationActor(tenantId: string): TrustedToolTransitionActor {
  return {
    type: 'SYSTEM',
    tenantId,
    userId: null,
    servicePrincipalId: TOOL_GATEWAY_SERVICE_PRINCIPAL_ID,
    roleAssignment: null,
    capabilityActions: ['tool.compensate'],
  };
}

function settlementCommand(
  outcome: ToolExecutionSettlement['outcome'],
): Extract<ToolInvocationCommand, 'SUCCEED' | 'FAIL' | 'MARK_UNKNOWN'> {
  if (outcome === 'SUCCEEDED') return 'SUCCEED';
  if (outcome === 'FAILED') return 'FAIL';
  return 'MARK_UNKNOWN';
}

function settlementReason(settlement: ToolExecutionSettlement): string {
  if (settlement.outcome === 'SUCCEEDED') return 'Provider execution completed successfully.';
  if (settlement.outcome === 'FAILED') return 'Provider returned a trusted failure result.';
  return 'Provider delivery or response could not be proven; reconciliation is required.';
}

function safeCode(value: string): string {
  return /^[A-Z0-9_]{1,120}$/u.test(value) ? value : 'TOOL_PROVIDER_FAILED';
}

function safeDetail(value: string): string {
  const normalized = value.replace(/[\u0000-\u001f\u007f]/gu, ' ').trim();
  return (normalized.length === 0 ? 'Tool provider execution failed.' : normalized).slice(0, 2_000);
}

function jsonOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

type ProviderProof = TrustedToolProviderTransitionProof & {
  readonly toolVersionId: string;
};
