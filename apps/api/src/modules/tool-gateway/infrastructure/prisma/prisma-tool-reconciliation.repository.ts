import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { PrismaService } from '../../../../database/prisma.service.js';
import {
  jsonObject,
  runtimeHash,
  stringArray,
} from '../../../process-orchestration/infrastructure/prisma/runtime-prisma.support.js';
import type {
  ClaimedToolReconciliationEvent,
  ParsedToolReconciliationEvent,
  PreparedToolReconciliation,
  ToolReconciliationCompletion,
  ToolReconciliationEligibility,
  ToolReconciliationPreparation,
  ToolReconciliationResolution,
} from '../../domain/tool-reconciliation.models.js';
import { ToolReconciliationRepository } from '../../domain/tool-reconciliation.repository.js';
import type { ToolInvocationRow } from './tool-gateway-prisma.support.js';
import { withToolTenant } from './tool-gateway-prisma.support.js';

const TOOL_GATEWAY_SERVICE_PRINCIPAL_ID = '00000000-0000-7000-8000-00000000a004';

interface ReconciliationInvocationRow extends ToolInvocationRow {
  readonly endpoint_ref: string;
  readonly output_schema: unknown;
  readonly timeout_ms: number;
  readonly allowed_host_patterns: unknown;
}

interface AttemptRow {
  readonly id: string;
  readonly outbox_event_id: string;
  readonly requested_revision: number;
  readonly eligibility: ToolReconciliationEligibility;
  readonly endpoint_ref_hash: string;
  readonly requested_at: Date;
}

interface ReceiptRow {
  readonly resolution: 'SUCCEEDED' | 'FAILED' | 'INCONCLUSIVE';
  readonly reason_code: string;
  readonly invocation_revision: number;
}

@Injectable()
export class PrismaToolReconciliationRepository extends ToolReconciliationRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {
    super();
  }

  prepare(
    event: ClaimedToolReconciliationEvent,
    request: ParsedToolReconciliationEvent,
  ): Promise<ToolReconciliationPreparation> {
    return withToolTenant(
      this.prisma,
      event.tenantId,
      TOOL_GATEWAY_SERVICE_PRINCIPAL_ID,
      'enterprise_agent_tool_gateway',
      async (transaction) => {
        const prior = await loadReceiptByEvent(transaction, event.tenantId, event.id);
        if (prior !== null) {
          const provider = await loadProviderRequestId(
            transaction,
            event.tenantId,
            request.invocationId,
          );
          return {
            kind: 'already_completed',
            providerRequestId: provider,
            outcome: prior.resolution === 'INCONCLUSIVE' ? 'inconclusive' : 'reconciled',
            reasonCode: prior.reason_code,
          };
        }
        const current = await loadInvocation(
          transaction,
          event.tenantId,
          request.invocationId,
          true,
        );
        if (current === null) {
          return {
            kind: 'skip',
            providerRequestId: null,
            reasonCode: 'INVOCATION_NOT_FOUND',
          };
        }
        if (current.status !== 'UNKNOWN') {
          return {
            kind: 'skip',
            providerRequestId: current.provider_request_id,
            reasonCode: 'INVOCATION_NOT_UNKNOWN',
          };
        }
        if (current.provider_request_id === null) {
          return {
            kind: 'skip',
            providerRequestId: null,
            reasonCode: 'PROVIDER_REQUEST_ID_MISSING',
          };
        }
        if (current.revision !== request.expectedRevision) {
          return {
            kind: 'skip',
            providerRequestId: current.provider_request_id,
            reasonCode: 'STALE_RECONCILIATION_REQUEST',
          };
        }
        const eligibility = reconciliationEligibility(current);
        const attemptId = randomUUID();
        const endpointRefHash = runtimeHash(current.endpoint_ref);
        await transaction.$executeRaw(Prisma.sql`
          INSERT INTO public."tool_reconciliation_attempts" (
            "id", "tenant_id", "tool_invocation_id", "tool_version_id",
            "outbox_event_id", "requested_revision", "provider_request_id",
            "input_hash", "eligibility",
            "endpoint_ref_hash", "requested_at"
          ) VALUES (
            ${attemptId}::uuid,
            ${event.tenantId}::uuid,
            ${current.id}::uuid,
            ${current.tool_version_id}::uuid,
            ${event.id}::uuid,
            ${request.expectedRevision},
            ${current.provider_request_id},
            ${current.input_hash},
            ${eligibility}::public."ToolReconciliationEligibility",
            ${endpointRefHash},
            ${event.createdAt}
          )
          ON CONFLICT ("outbox_event_id") DO NOTHING
        `);
        const attempts = await transaction.$queryRaw<AttemptRow[]>(Prisma.sql`
          SELECT
            "id"::text AS id,
            "outbox_event_id"::text AS outbox_event_id,
            "requested_revision",
            "eligibility"::text AS eligibility,
            "endpoint_ref_hash",
            "requested_at"
          FROM public."tool_reconciliation_attempts"
          WHERE "tenant_id" = ${event.tenantId}::uuid
            AND "outbox_event_id" = ${event.id}::uuid
          LIMIT 1
        `);
        const attempt = attempts[0];
        if (attempt === undefined) {
          throw new Error('Tool reconciliation attempt was not persisted.');
        }
        return {
          kind: 'ready',
          reconciliation: {
            attemptId: attempt.id,
            outboxEventId: attempt.outbox_event_id,
            tenantId: current.tenant_id,
            invocationId: current.id,
            expectedRevision: attempt.requested_revision,
            toolVersionId: current.tool_version_id,
            endpointRef: current.endpoint_ref,
            riskClass: current.risk_class,
            idempotencyMode: current.idempotency_mode,
            eligibility: attempt.eligibility,
            requesterUserId: current.requester_user_id,
            roleAssignmentId: current.role_assignment_id,
            taskId: current.task_id,
            correlationId: current.correlation_id,
            providerRequestId: current.provider_request_id,
            inputHash: current.input_hash,
            outputSchema: jsonObject(current.output_schema),
            timeoutMs: current.timeout_ms,
            allowedHostPatterns: stringArray(current.allowed_host_patterns),
            startedAt: attempt.requested_at,
          },
        };
      },
    );
  }

  complete(
    reconciliation: PreparedToolReconciliation,
    requestedResolution: ToolReconciliationResolution,
  ): Promise<ToolReconciliationCompletion> {
    return withToolTenant(
      this.prisma,
      reconciliation.tenantId,
      TOOL_GATEWAY_SERVICE_PRINCIPAL_ID,
      'enterprise_agent_tool_gateway',
      async (transaction) => {
        const prior = await loadReceiptByAttempt(
          transaction,
          reconciliation.tenantId,
          reconciliation.attemptId,
        );
        if (prior !== null) return completionFromReceipt(prior);

        const current = await loadInvocation(
          transaction,
          reconciliation.tenantId,
          reconciliation.invocationId,
          true,
        );
        const stale =
          current === null ||
          current.status !== 'UNKNOWN' ||
          current.revision !== reconciliation.expectedRevision ||
          current.provider_request_id !== reconciliation.providerRequestId;
        const resolution =
          stale || reconciliation.eligibility === 'INELIGIBLE'
            ? inconclusiveResolution(
                requestedResolution,
                stale ? 'TOOL_RECONCILIATION_STALE' : 'TOOL_RECONCILIATION_REPLAY_PROOF_REQUIRED',
              )
            : requestedResolution;
        const resultRevision =
          current !== null && resolution.kind !== 'INCONCLUSIVE'
            ? current.revision + 1
            : (current?.revision ?? reconciliation.expectedRevision);
        const receiptId = randomUUID();
        const receiptHash = runtimeHash({
          attemptId: reconciliation.attemptId,
          invocationId: reconciliation.invocationId,
          invocationRevision: resultRevision,
          resolution: resolution.kind,
          reasonCode: resolution.reasonCode,
          providerRequestId: reconciliation.providerRequestId,
          proofType: resolution.proofType,
          proofId: resolution.proofId,
          proofHash: resolution.proofHash,
          outputHash: resolution.outputHash,
          errorCode: resolution.kind === 'FAILED' ? resolution.errorCode : null,
          startedAt: resolution.startedAt.toISOString(),
          completedAt: resolution.completedAt.toISOString(),
        });
        await transaction.$executeRaw(Prisma.sql`
          INSERT INTO public."tool_reconciliation_receipts" (
            "id", "tenant_id", "attempt_id", "tool_invocation_id",
            "invocation_revision", "resolution", "reason_code",
            "proof_type", "proof_id", "provider_request_id",
            "provider_observed_at", "proof_hash", "output_hash", "error_code",
            "started_at", "completed_at", "receipt_hash"
          ) VALUES (
            ${receiptId}::uuid,
            ${reconciliation.tenantId}::uuid,
            ${reconciliation.attemptId}::uuid,
            ${reconciliation.invocationId}::uuid,
            ${resultRevision},
            ${resolution.kind}::public."ToolReconciliationResolution",
            ${safeCode(resolution.reasonCode)},
            ${resolution.proofType}::public."ToolReconciliationProofType",
            ${resolution.proofId},
            ${reconciliation.providerRequestId},
            ${resolution.providerObservedAt},
            ${resolution.proofHash},
            ${resolution.outputHash},
            ${resolution.kind === 'FAILED' ? safeCode(resolution.errorCode) : null},
            ${resolution.startedAt},
            ${resolution.completedAt},
            ${receiptHash}
          )
        `);
        if (current !== null && resolution.kind !== 'INCONCLUSIVE') {
          await insertReconciliationCommand(transaction, current, reconciliation, resolution);
          const output = resolution.kind === 'SUCCEEDED' ? JSON.stringify(resolution.output) : null;
          const outputHash = resolution.kind === 'SUCCEEDED' ? resolution.outputHash : null;
          const errorCode = resolution.kind === 'FAILED' ? safeCode(resolution.errorCode) : null;
          const errorDetail =
            resolution.kind === 'FAILED'
              ? 'Provider status proof confirmed that the original execution failed.'
              : null;
          const updated = await transaction.$executeRaw(Prisma.sql`
            UPDATE public."tool_invocations"
            SET
              "status" = ${resolution.kind}::public."ToolInvocationStatus",
              "revision" = "revision" + 1,
              "output" = ${output}::jsonb,
              "output_hash" = ${outputHash},
              "error_code" = ${errorCode},
              "error_detail" = ${errorDetail},
              "completed_at" = ${resolution.completedAt},
              "updated_at" = ${resolution.completedAt}
            WHERE "tenant_id" = ${current.tenant_id}::uuid
              AND "id" = ${current.id}::uuid
              AND "revision" = ${current.revision}
              AND "status" = 'UNKNOWN'::public."ToolInvocationStatus"
              AND "provider_request_id" = ${reconciliation.providerRequestId}
          `);
          if (updated !== 1) {
            throw new Error('Tool reconciliation lost its Invocation revision.');
          }
        } else {
          await recordInconclusiveSideEffects(
            transaction,
            reconciliation,
            receiptId,
            resolution.reasonCode,
            resolution.completedAt,
          );
        }
        return {
          invocationStatus: resolution.kind === 'INCONCLUSIVE' ? 'UNKNOWN' : resolution.kind,
          invocationRevision: resultRevision,
          outcome: resolution.kind === 'INCONCLUSIVE' ? 'inconclusive' : 'reconciled',
          reasonCode: resolution.reasonCode,
        };
      },
    );
  }
}

async function loadInvocation(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  invocationId: string,
  lock: boolean,
): Promise<ReconciliationInvocationRow | null> {
  const rows = await transaction.$queryRaw<ReconciliationInvocationRow[]>(Prisma.sql`
    SELECT
      invocation.*,
      version."endpoint_ref",
      version."output_schema",
      version."timeout_ms",
      version."allowed_host_patterns"
    FROM public."tool_invocations" invocation
    JOIN public."tool_versions" version
      ON version."tenant_id" = invocation."tenant_id"
     AND version."id" = invocation."tool_version_id"
     AND version."configuration_hash" = invocation."tool_configuration_hash"
    WHERE invocation."tenant_id" = ${tenantId}::uuid
      AND invocation."id" = ${invocationId}::uuid
    LIMIT 1
    ${lock ? Prisma.sql`FOR UPDATE OF invocation` : Prisma.empty}
  `);
  return rows[0] ?? null;
}

async function loadProviderRequestId(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  invocationId: string,
): Promise<string | null> {
  const rows = await transaction.$queryRaw<Array<{ provider_request_id: string | null }>>(
    Prisma.sql`
      SELECT "provider_request_id"
      FROM public."tool_invocations"
      WHERE "tenant_id" = ${tenantId}::uuid
        AND "id" = ${invocationId}::uuid
      LIMIT 1
    `,
  );
  return rows[0]?.provider_request_id ?? null;
}

async function loadReceiptByEvent(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  eventId: string,
): Promise<ReceiptRow | null> {
  const rows = await transaction.$queryRaw<ReceiptRow[]>(Prisma.sql`
    SELECT
      receipt."resolution"::text AS resolution,
      receipt."reason_code",
      receipt."invocation_revision"
    FROM public."tool_reconciliation_attempts" attempt
    JOIN public."tool_reconciliation_receipts" receipt
      ON receipt."tenant_id" = attempt."tenant_id"
     AND receipt."attempt_id" = attempt."id"
    WHERE attempt."tenant_id" = ${tenantId}::uuid
      AND attempt."outbox_event_id" = ${eventId}::uuid
    LIMIT 1
  `);
  return rows[0] ?? null;
}

async function loadReceiptByAttempt(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  attemptId: string,
): Promise<ReceiptRow | null> {
  const rows = await transaction.$queryRaw<ReceiptRow[]>(Prisma.sql`
    SELECT
      "resolution"::text AS resolution,
      "reason_code",
      "invocation_revision"
    FROM public."tool_reconciliation_receipts"
    WHERE "tenant_id" = ${tenantId}::uuid
      AND "attempt_id" = ${attemptId}::uuid
    LIMIT 1
  `);
  return rows[0] ?? null;
}

function completionFromReceipt(receipt: ReceiptRow): ToolReconciliationCompletion {
  return {
    invocationStatus: receipt.resolution === 'INCONCLUSIVE' ? 'UNKNOWN' : receipt.resolution,
    invocationRevision: receipt.invocation_revision,
    outcome: receipt.resolution === 'INCONCLUSIVE' ? 'inconclusive' : 'reconciled',
    reasonCode: receipt.reason_code,
  };
}

function reconciliationEligibility(
  invocation: ReconciliationInvocationRow,
): ToolReconciliationEligibility {
  if (invocation.risk_class === 'READ_ONLY') return 'READ_ONLY';
  return invocation.idempotency_mode === 'REQUIRED' ||
    invocation.idempotency_mode === 'PROVIDER_SUPPORTED'
    ? 'PROVIDER_IDEMPOTENT'
    : 'INELIGIBLE';
}

async function insertReconciliationCommand(
  transaction: Prisma.TransactionClient,
  current: ReconciliationInvocationRow,
  reconciliation: PreparedToolReconciliation,
  resolution: Exclude<ToolReconciliationResolution, { kind: 'INCONCLUSIVE' }>,
): Promise<void> {
  const command = resolution.kind === 'SUCCEEDED' ? 'SUCCEED' : 'FAIL';
  const providerProof = {
    tenantId: current.tenant_id,
    invocationId: current.id,
    toolVersionId: current.tool_version_id,
    inputHash: current.input_hash,
    providerRequestId: reconciliation.providerRequestId,
    outcome: resolution.kind,
    reconciliationReceiptId: reconciliation.attemptId,
  };
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
      ${command}::public."ToolInvocationCommandType",
      ${current.revision},
      ${current.revision + 1},
      'PROVIDER'::public."ToolInvocationActorType",
      NULL,
      NULL,
      ${TOOL_GATEWAY_SERVICE_PRINCIPAL_ID}::uuid,
      'Provider reconciliation proof resolved the previously unknown outcome.',
      NULL,
      NULL,
      NULL,
      ${JSON.stringify(providerProof)}::jsonb,
      NULL,
      ${`tool-reconciliation:${reconciliation.attemptId}`},
      ${current.input_hash},
      ${resolution.completedAt}
    )
  `);
}

async function recordInconclusiveSideEffects(
  transaction: Prisma.TransactionClient,
  reconciliation: PreparedToolReconciliation,
  receiptId: string,
  reasonCode: string,
  occurredAt: Date,
): Promise<void> {
  const metadata = {
    attemptId: reconciliation.attemptId,
    receiptId,
    expectedRevision: reconciliation.expectedRevision,
    reasonCode: safeCode(reasonCode),
  };
  await transaction.$executeRaw(Prisma.sql`
    INSERT INTO public."audit_events" (
      "id", "tenant_id", "actor_type", "actor_id", "action",
      "resource_type", "resource_id", "metadata", "occurred_at"
    ) VALUES (
      ${randomUUID()}::uuid,
      ${reconciliation.tenantId}::uuid,
      'SERVICE'::public."AuditActorType",
      ${TOOL_GATEWAY_SERVICE_PRINCIPAL_ID}::uuid,
      'tool.invocation.reconciliation_inconclusive',
      'tool_invocation',
      ${reconciliation.invocationId}::uuid,
      ${JSON.stringify(metadata)}::jsonb,
      ${occurredAt}
    )
  `);
  await transaction.$executeRaw(Prisma.sql`
    INSERT INTO public."outbox_events" (
      "id", "tenant_id", "aggregate_type", "aggregate_id", "event_type",
      "payload", "status", "attempts", "available_at", "created_at"
    ) VALUES (
      ${randomUUID()}::uuid,
      ${reconciliation.tenantId}::uuid,
      'TOOL_INVOCATION',
      ${reconciliation.invocationId}::uuid,
      'ToolInvocation.ReconciliationInconclusive',
      ${JSON.stringify(metadata)}::jsonb,
      'PENDING'::public."OutboxEventStatus",
      0,
      ${occurredAt},
      ${occurredAt}
    )
  `);
}

function inconclusiveResolution(
  resolution: ToolReconciliationResolution,
  reasonCode: string,
): Extract<ToolReconciliationResolution, { kind: 'INCONCLUSIVE' }> {
  return {
    kind: 'INCONCLUSIVE',
    output: null,
    outputHash: null,
    reasonCode,
    startedAt: resolution.startedAt,
    completedAt: resolution.completedAt,
    proofHash: resolution.proofHash,
    proofType: resolution.proofType,
    proofId: resolution.proofId,
    providerObservedAt: resolution.providerObservedAt,
  };
}

function safeCode(value: string): string {
  return /^[A-Z0-9_]{1,120}$/u.test(value) ? value : 'TOOL_RECONCILIATION_FAILED';
}
