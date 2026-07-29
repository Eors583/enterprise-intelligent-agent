import { createHash, randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import {
  decideFinopsAutoProjection,
  type AgentRunProjectionSource,
  type FinopsAutoProjectionDecision,
  type FinopsProjectionPrice,
  type FinopsProjectionSource,
  type ToolReceiptProjectionSource,
} from './finops-auto-projection.policy.js';
import { hashStable } from './finance-finops.persistence.js';
import { PrismaService } from '../../database/prisma.service.js';

const FINOPS_PROJECTOR_ROLE = 'enterprise_agent_finops_projector';
const FINOPS_PROJECTOR_ACTOR_ID = '00000000-0000-7000-8000-00000000f017';
const BLOCKED_RETRY_MS = 60_000;

interface TenantRow {
  readonly tenant_id: string;
}

interface ProjectionJobRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly source_kind: 'AGENT_RUN' | 'TOOL_RECEIPT';
  readonly source_id: string;
  readonly source_version: string;
  readonly source_hash: string;
  readonly projected_source_hash: string | null;
  readonly projected_entry_ids: unknown;
  readonly projected_at: Date | null;
}

interface AgentRunRow {
  readonly id: string;
  readonly version: number;
  readonly status: AgentRunProjectionSource['status'];
  readonly requester_user_id: string;
  readonly task_id: string | null;
  readonly agent_id: string;
  readonly agent_version_id: string;
  readonly runtime_provider: string | null;
  readonly runtime_model: string | null;
  readonly token_evidence: AgentRunProjectionSource['tokenEvidence'];
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly total_tokens: number;
  readonly tool_calls: number;
  readonly cost_micros: bigint;
  readonly latency_ms: number | null;
  readonly usage_recorded_at: Date | null;
  readonly cost_recorded_at: Date | null;
  readonly finished_at: Date | null;
}

interface ToolReceiptRow {
  readonly id: string;
  readonly receipt_hash: string;
  readonly tool_invocation_id: string;
  readonly invocation_status: string;
  readonly requester_user_id: string;
  readonly role_assignment_id: string;
  readonly task_id: string;
  readonly process_instance_id: string | null;
  readonly process_step_instance_id: string | null;
  readonly agent_run_id: string | null;
  readonly tool_version_id: string;
  readonly tool_version: number;
  readonly tool_key: string;
  readonly adapter: string;
  readonly source: ToolReceiptProjectionSource['source'];
  readonly outcome: ToolReceiptProjectionSource['outcome'];
  readonly provider_request_id: string | null;
  readonly provider_dry_run: boolean;
  readonly execution_attempt: number;
  readonly started_at: Date;
  readonly completed_at: Date;
  readonly latency_ms: number;
  readonly cost_attestation: ToolReceiptProjectionSource['costAttestation'];
  readonly cost_micros: bigint | null;
}

interface PriceRow {
  readonly id: string;
  readonly version: number;
  readonly resource_kind: FinopsProjectionPrice['resourceKind'];
  readonly provider: string;
  readonly sku: string;
  readonly currency: string;
  readonly billing_unit: FinopsProjectionPrice['billingUnit'];
  readonly unit_size: Prisma.Decimal;
  readonly unit_price: Prisma.Decimal;
  readonly effective_from: Date;
  readonly effective_to: Date | null;
  readonly approved_at: Date | null;
}

interface IdRow {
  readonly id: string;
}

export abstract class FinopsAutoProjectionReconciler {
  abstract reconcileBatch(input: {
    readonly workerId: string;
    readonly batchSize: number;
    readonly claimTtlMs: number;
  }): Promise<number>;
}

@Injectable()
export class PrismaFinopsAutoProjectionReconciler extends FinopsAutoProjectionReconciler {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {
    super();
  }

  async reconcileBatch(input: {
    readonly workerId: string;
    readonly batchSize: number;
    readonly claimTtlMs: number;
  }): Promise<number> {
    if (!this.prisma.enabled) return 0;
    const tenantIds = await this.projectionTenantIds();
    for (const tenantId of tenantIds) {
      await this.discoverTenant(tenantId, Math.max(input.batchSize * 4, 20));
    }

    let processed = 0;
    for (const tenantId of tenantIds) {
      if (processed >= input.batchSize) break;
      const claims = await this.claimTenant(tenantId, {
        workerId: input.workerId,
        batchSize: input.batchSize - processed,
        claimTtlMs: input.claimTtlMs,
      });
      for (const claim of claims) {
        await this.processClaim(tenantId, claim, input.workerId);
        processed += 1;
      }
    }
    return processed;
  }

  private async projectionTenantIds(): Promise<readonly string[]> {
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe(`SET LOCAL ROLE ${FINOPS_PROJECTOR_ROLE}`);
      const rows = await transaction.$queryRaw<TenantRow[]>`
        SELECT "tenant_id"::text AS "tenant_id"
        FROM public."finops_projection_tenants"()
        ORDER BY "tenant_id"
      `;
      return rows.map(({ tenant_id: tenantId }) => tenantId);
    });
  }

  private async discoverTenant(tenantId: string, limit: number): Promise<void> {
    await this.withTenant(tenantId, async (transaction) => {
      const [runRows, receiptRows] = await Promise.all([
        transaction.$queryRaw<AgentRunRow[]>(Prisma.sql`
          SELECT
            run."id"::text AS "id",
            run."version",
            run."status"::text AS "status",
            run."requester_user_id"::text AS "requester_user_id",
            run."task_id"::text AS "task_id",
            run."agent_id"::text AS "agent_id",
            run."agent_version_id"::text AS "agent_version_id",
            run."runtime_provider",
            run."runtime_model",
            run."token_evidence"::text AS "token_evidence",
            run."input_tokens",
            run."output_tokens",
            run."total_tokens",
            run."tool_calls",
            run."cost_micros",
            run."latency_ms",
            run."usage_recorded_at",
            run."cost_recorded_at",
            run."finished_at"
          FROM public."agent_runs" run
          LEFT JOIN public."finops_projection_jobs" job
            ON job."tenant_id" = run."tenant_id"
           AND job."source_kind" = 'AGENT_RUN'::public."FinopsProjectionSourceKind"
           AND job."source_id" = run."id"
          WHERE run."tenant_id" = ${tenantId}::uuid
            AND run."status" IN (
              'SUCCEEDED'::public."AgentRunStatus",
              'FAILED'::public."AgentRunStatus",
              'UNKNOWN'::public."AgentRunStatus",
              'CANCELLED'::public."AgentRunStatus"
            )
            AND (
              job."id" IS NULL
              OR job."status" <> 'PROJECTED'::public."FinopsProjectionStatus"
              OR job."source_version" <> run."version"::text
            )
          ORDER BY run."updated_at", run."id"
          LIMIT ${limit}
        `),
        transaction.$queryRaw<ToolReceiptRow[]>(Prisma.sql`
          SELECT
            receipt."id"::text AS "id",
            receipt."receipt_hash",
            receipt."tool_invocation_id"::text AS "tool_invocation_id",
            invocation."status"::text AS "invocation_status",
            invocation."requester_user_id"::text AS "requester_user_id",
            invocation."role_assignment_id"::text AS "role_assignment_id",
            invocation."task_id"::text AS "task_id",
            invocation."process_instance_id"::text AS "process_instance_id",
            invocation."process_step_instance_id"::text AS "process_step_instance_id",
            invocation."agent_run_id"::text AS "agent_run_id",
            invocation."tool_version_id"::text AS "tool_version_id",
            invocation."tool_version",
            version."key" AS "tool_key",
            invocation."adapter"::text AS "adapter",
            receipt."source"::text AS "source",
            receipt."outcome"::text AS "outcome",
            receipt."provider_request_id",
            receipt."provider_dry_run",
            receipt."execution_attempt",
            receipt."started_at",
            receipt."completed_at",
            receipt."latency_ms",
            receipt."cost_attestation"::text AS "cost_attestation",
            receipt."cost_micros"
          FROM public."tool_execution_receipts" receipt
          JOIN public."tool_invocations" invocation
            ON invocation."tenant_id" = receipt."tenant_id"
           AND invocation."id" = receipt."tool_invocation_id"
          JOIN public."tool_versions" version
            ON version."tenant_id" = invocation."tenant_id"
           AND version."id" = invocation."tool_version_id"
          LEFT JOIN public."finops_projection_jobs" job
            ON job."tenant_id" = receipt."tenant_id"
           AND job."source_kind" = 'TOOL_RECEIPT'::public."FinopsProjectionSourceKind"
           AND job."source_id" = receipt."id"
          WHERE receipt."tenant_id" = ${tenantId}::uuid
            AND receipt."source" IN (
              'PROVIDER'::public."ToolExecutionReceiptSource",
              'COMPENSATOR'::public."ToolExecutionReceiptSource"
            )
            AND (
              job."id" IS NULL
              OR job."status" <> 'PROJECTED'::public."FinopsProjectionStatus"
              OR job."source_version" <> receipt."receipt_hash"
            )
          ORDER BY receipt."created_at", receipt."id"
          LIMIT ${limit}
        `),
      ]);

      for (const row of runRows) {
        const source = mapAgentRun(row);
        await upsertDiscoveredSource(transaction, tenantId, source, source.version.toString());
      }
      for (const row of receiptRows) {
        const source = mapToolReceipt(row);
        await upsertDiscoveredSource(transaction, tenantId, source, source.receiptHash);
      }
    });
  }

  private async claimTenant(
    tenantId: string,
    input: { readonly workerId: string; readonly batchSize: number; readonly claimTtlMs: number },
  ): Promise<readonly ProjectionJobRow[]> {
    return this.withTenant(tenantId, async (transaction) => {
      const lockedUntil = new Date(Date.now() + input.claimTtlMs);
      return transaction.$queryRaw<ProjectionJobRow[]>(Prisma.sql`
        WITH candidates AS (
          SELECT job."id"
          FROM public."finops_projection_jobs" job
          WHERE job."tenant_id" = ${tenantId}::uuid
            AND job."status" IN (
              'PENDING'::public."FinopsProjectionStatus",
              'BLOCKED'::public."FinopsProjectionStatus"
            )
            AND job."available_at" <= CURRENT_TIMESTAMP
            AND (
              job."locked_until" IS NULL
              OR job."locked_until" <= CURRENT_TIMESTAMP
            )
          ORDER BY job."available_at", job."created_at", job."id"
          FOR UPDATE SKIP LOCKED
          LIMIT ${input.batchSize}
        )
        UPDATE public."finops_projection_jobs" job
        SET
          "locked_by" = ${input.workerId},
          "locked_until" = ${lockedUntil},
          "attempts" = job."attempts" + 1,
          "updated_at" = CURRENT_TIMESTAMP
        FROM candidates
        WHERE job."tenant_id" = ${tenantId}::uuid
          AND job."id" = candidates."id"
        RETURNING
          job."id"::text AS "id",
          job."tenant_id"::text AS "tenant_id",
          job."source_kind"::text AS "source_kind",
          job."source_id"::text AS "source_id",
          job."source_version",
          job."source_hash",
          job."projected_source_hash",
          job."projected_entry_ids",
          job."projected_at"
      `);
    });
  }

  private async processClaim(
    tenantId: string,
    claim: ProjectionJobRow,
    workerId: string,
  ): Promise<void> {
    await this.withTenant(tenantId, async (transaction) => {
      const rows = await transaction.$queryRaw<ProjectionJobRow[]>(Prisma.sql`
        SELECT
          job."id"::text AS "id",
          job."tenant_id"::text AS "tenant_id",
          job."source_kind"::text AS "source_kind",
          job."source_id"::text AS "source_id",
          job."source_version",
          job."source_hash",
          job."projected_source_hash",
          job."projected_entry_ids",
          job."projected_at"
        FROM public."finops_projection_jobs" job
        WHERE job."tenant_id" = ${tenantId}::uuid
          AND job."id" = ${claim.id}::uuid
          AND job."locked_by" = ${workerId}
          AND job."locked_until" > CURRENT_TIMESTAMP
        FOR UPDATE
      `);
      const job = rows[0];
      if (job === undefined) return;

      if (job.projected_source_hash !== null && job.projected_source_hash !== job.source_hash) {
        await this.blockJob(transaction, job, {
          kind: 'BLOCKED',
          code: 'SOURCE_MUTATED_AFTER_PROJECTION',
          detail:
            'A terminal source changed after projection. Existing ledger entries remain immutable and no replacement was created.',
          metadata: {
            projectedSourceHash: job.projected_source_hash,
            currentSourceHash: job.source_hash,
          },
        });
        return;
      }

      const source = await loadSource(transaction, tenantId, job);
      if (source === null) {
        await this.blockJob(transaction, job, {
          kind: 'BLOCKED',
          code: 'SOURCE_RECEIPT_INVALID',
          detail: 'The governed source no longer resolves inside this tenant.',
          metadata: {},
        });
        return;
      }
      const currentHash = projectionSourceHash(source);
      if (currentHash !== job.source_hash) {
        await transaction.$executeRaw(Prisma.sql`
          UPDATE public."finops_projection_jobs"
          SET
            "source_hash" = ${currentHash},
            "source_version" = ${sourceVersion(source)},
            "status" = CASE
              WHEN "projected_source_hash" IS NULL
                THEN 'PENDING'::public."FinopsProjectionStatus"
              ELSE 'BLOCKED'::public."FinopsProjectionStatus"
            END,
            "diagnostic_code" = CASE
              WHEN "projected_source_hash" IS NULL THEN NULL
              ELSE 'SOURCE_MUTATED_AFTER_PROJECTION'
            END,
            "diagnostic_detail" = CASE
              WHEN "projected_source_hash" IS NULL THEN NULL
              ELSE 'A terminal source changed after projection.'
            END,
            "locked_by" = NULL,
            "locked_until" = NULL,
            "available_at" = CURRENT_TIMESTAMP,
            "updated_at" = CURRENT_TIMESTAMP
          WHERE "tenant_id" = ${tenantId}::uuid
            AND "id" = ${job.id}::uuid
        `);
        return;
      }

      const prices = await loadPrices(transaction, tenantId, source);
      const decision = decideFinopsAutoProjection(source, prices);
      if (decision.kind === 'BLOCKED') {
        await this.blockJob(transaction, job, decision);
        return;
      }
      await this.projectJob(transaction, job, source, decision);
    });
  }

  private async blockJob(
    transaction: Prisma.TransactionClient,
    job: ProjectionJobRow,
    decision: Extract<FinopsAutoProjectionDecision, { readonly kind: 'BLOCKED' }>,
  ): Promise<void> {
    const diagnosticId = randomUUID();
    const inserted = await transaction.$queryRaw<IdRow[]>(Prisma.sql`
      INSERT INTO public."finops_projection_diagnostics" (
        "id", "tenant_id", "job_id", "source_kind", "source_id",
        "source_version", "source_hash", "code", "detail", "metadata"
      ) VALUES (
        ${diagnosticId}::uuid,
        ${job.tenant_id}::uuid,
        ${job.id}::uuid,
        ${job.source_kind}::public."FinopsProjectionSourceKind",
        ${job.source_id}::uuid,
        ${job.source_version},
        ${job.source_hash},
        ${decision.code},
        ${decision.detail},
        ${JSON.stringify(decision.metadata)}::jsonb
      )
      ON CONFLICT (
        "tenant_id", "source_kind", "source_id", "source_version", "code"
      ) DO NOTHING
      RETURNING "id"::text AS "id"
    `);
    await transaction.$executeRaw(Prisma.sql`
      UPDATE public."finops_projection_jobs"
      SET
        "status" = 'BLOCKED'::public."FinopsProjectionStatus",
        "diagnostic_code" = ${decision.code},
        "diagnostic_detail" = ${decision.detail},
        "locked_by" = NULL,
        "locked_until" = NULL,
        "available_at" = CURRENT_TIMESTAMP + (${BLOCKED_RETRY_MS} * INTERVAL '1 millisecond'),
        "updated_at" = CURRENT_TIMESTAMP
      WHERE "tenant_id" = ${job.tenant_id}::uuid
        AND "id" = ${job.id}::uuid
    `);
    if (inserted.length === 1) {
      await recordProjectionEvent(transaction, {
        tenantId: job.tenant_id,
        aggregateType: 'FINOPS_PROJECTION_DIAGNOSTIC',
        aggregateId: diagnosticId,
        action: 'finops.projection.blocked',
        eventType: 'finops.projection.blocked.v1',
        metadata: {
          jobId: job.id,
          sourceKind: job.source_kind,
          sourceId: job.source_id,
          sourceVersion: job.source_version,
          code: decision.code,
        },
      });
    }
  }

  private async projectJob(
    transaction: Prisma.TransactionClient,
    job: ProjectionJobRow,
    source: FinopsProjectionSource,
    decision: Extract<FinopsAutoProjectionDecision, { readonly kind: 'PROJECT' }>,
  ): Promise<void> {
    const entryIds: string[] = [];
    for (const line of decision.lines) {
      const component = line.billingUnit.toLowerCase();
      const idempotencyKey = `auto-finops:${source.kind.toLowerCase()}:${source.id}:${component}`;
      const sourceRecordVersion = `${sourceVersion(source)}:${line.billingUnit}`;
      const rawUsage = {
        sourceKind: source.kind,
        sourceId: source.id,
        sourceVersion: sourceVersion(source),
        provider: decision.provider,
        sku: decision.sku,
        billingUnit: line.billingUnit,
        quantity: line.quantity.toFixed(),
        expectedCostMicros: decision.expectedCostMicros.toString(),
        sourceAuthority: decision.sourceAuthority,
        incurredAt: decision.incurredAt.toISOString(),
        dimensions: decision.dimensions,
        priceSnapshot: {
          id: line.price.id,
          version: line.price.version,
          unitSize: line.price.unitSize,
          unitPrice: line.price.unitPrice,
          currency: line.price.currency,
        },
      };
      const sourceContentHash = hashStable({
        sourceHash: job.source_hash,
        sourceRecordVersion,
        rawUsage,
      });
      const requestHash = hashStable({
        idempotencyKey,
        sourceContentHash,
        priceSnapshotId: line.price.id,
        priceSnapshotVersion: line.price.version,
        quantity: line.quantity.toFixed(),
        calculatedAmount: line.calculatedAmount.toFixed(),
      });
      const entryId = randomUUID();
      const subjectId = source.kind === 'AGENT_RUN' ? source.id : source.invocationId;
      const inserted = await transaction.$queryRaw<IdRow[]>(Prisma.sql`
        INSERT INTO public."finops_cost_entries" (
          "id", "tenant_id", "subject_type", "subject_id",
          "agent_run_id", "tool_invocation_id",
          "knowledge_document_version_id", "human_user_id",
          "price_snapshot_id", "price_snapshot_version", "resource_kind",
          "quantity", "raw_usage", "formula_code", "formula_version",
          "formula_expression", "currency", "calculated_amount",
          "verification_status", "source_authority", "source_system",
          "source_record_id", "source_record_version", "source_content_hash",
          "source_evidence_id", "source_evidence_version", "incurred_at",
          "recorded_by_user_id", "idempotency_key", "request_hash"
        ) VALUES (
          ${entryId}::uuid,
          ${job.tenant_id}::uuid,
          ${source.kind === 'AGENT_RUN' ? 'AGENT_RUN' : 'TOOL_INVOCATION'}
            ::public."FinopsCostSubjectType",
          ${subjectId},
          ${source.kind === 'AGENT_RUN' ? source.id : null}::uuid,
          ${source.kind === 'TOOL_RECEIPT' ? source.invocationId : null}::uuid,
          NULL, NULL,
          ${line.price.id}::uuid,
          ${line.price.version},
          ${line.price.resourceKind}::public."FinopsResourceKind",
          ${line.quantity.toFixed()}::numeric,
          ${JSON.stringify(rawUsage)}::jsonb,
          'APPROVED_PRICE_SNAPSHOT',
          1,
          '(quantity / unitSize) * unitPrice',
          ${decision.currency},
          ${line.calculatedAmount.toFixed()}::numeric,
          'VERIFIED'::public."FinopsVerificationStatus",
          ${decision.sourceAuthority}::public."FinopsSourceAuthority",
          ${source.kind === 'AGENT_RUN' ? 'agent-runtime' : 'tool-gateway'},
          ${source.id},
          ${sourceRecordVersion},
          ${sourceContentHash},
          NULL, NULL,
          ${decision.incurredAt},
          ${decision.recordedByUserId}::uuid,
          ${idempotencyKey},
          ${requestHash}
        )
        ON CONFLICT ("tenant_id", "idempotency_key") DO NOTHING
        RETURNING "id"::text AS "id"
      `);
      const persistedId =
        inserted[0]?.id ??
        (
          await transaction.$queryRaw<IdRow[]>(Prisma.sql`
            SELECT entry."id"::text AS "id"
            FROM public."finops_cost_entries" entry
            WHERE entry."tenant_id" = ${job.tenant_id}::uuid
              AND entry."idempotency_key" = ${idempotencyKey}
              AND entry."request_hash" = ${requestHash}
              AND entry."source_content_hash" = ${sourceContentHash}
              AND entry."price_snapshot_id" = ${line.price.id}::uuid
              AND entry."price_snapshot_version" = ${line.price.version}
          `)
        )[0]?.id;
      if (persistedId === undefined) {
        throw new Error('Automatic FinOps idempotency replay did not match the trusted source.');
      }
      entryIds.push(persistedId);
      if (inserted.length === 1) {
        await recordProjectionEvent(transaction, {
          tenantId: job.tenant_id,
          aggregateType: 'FINOPS_COST_ENTRY',
          aggregateId: persistedId,
          action: 'finops.cost.auto_projected',
          eventType: 'finops.cost.auto_projected.v1',
          metadata: {
            jobId: job.id,
            sourceKind: source.kind,
            sourceId: source.id,
            billingUnit: line.billingUnit,
            priceSnapshotId: line.price.id,
            priceSnapshotVersion: line.price.version,
            currency: decision.currency,
            calculatedAmount: line.calculatedAmount.toFixed(),
          },
        });
      }
    }

    const resolved = await transaction.$queryRaw<IdRow[]>(Prisma.sql`
      UPDATE public."finops_projection_diagnostics"
      SET
        "status" = 'RESOLVED'::public."FinopsAlertStatus",
        "resolved_at" = CURRENT_TIMESTAMP
      WHERE "tenant_id" = ${job.tenant_id}::uuid
        AND "job_id" = ${job.id}::uuid
        AND "status" = 'OPEN'::public."FinopsAlertStatus"
      RETURNING "id"::text AS "id"
    `);
    for (const diagnostic of resolved) {
      await recordProjectionEvent(transaction, {
        tenantId: job.tenant_id,
        aggregateType: 'FINOPS_PROJECTION_DIAGNOSTIC',
        aggregateId: diagnostic.id,
        action: 'finops.projection.resolved',
        eventType: 'finops.projection.resolved.v1',
        metadata: { jobId: job.id, sourceKind: source.kind, sourceId: source.id },
      });
    }
    await transaction.$executeRaw(Prisma.sql`
      UPDATE public."finops_projection_jobs"
      SET
        "status" = 'PROJECTED'::public."FinopsProjectionStatus",
        "projected_source_hash" = "source_hash",
        "projected_entry_ids" = ${JSON.stringify(entryIds)}::jsonb,
        "projected_at" = COALESCE("projected_at", CURRENT_TIMESTAMP),
        "diagnostic_code" = NULL,
        "diagnostic_detail" = NULL,
        "locked_by" = NULL,
        "locked_until" = NULL,
        "updated_at" = CURRENT_TIMESTAMP
      WHERE "tenant_id" = ${job.tenant_id}::uuid
        AND "id" = ${job.id}::uuid
    `);
  }

  private withTenant<T>(
    tenantId: string,
    operation: (transaction: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe(`SET LOCAL ROLE ${FINOPS_PROJECTOR_ROLE}`);
      await transaction.$queryRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      return operation(transaction);
    });
  }
}

async function upsertDiscoveredSource(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  source: FinopsProjectionSource,
  version: string,
): Promise<void> {
  const hash = projectionSourceHash(source);
  await transaction.$executeRaw(Prisma.sql`
    INSERT INTO public."finops_projection_jobs" (
      "id", "tenant_id", "source_kind", "source_id",
      "source_version", "source_hash"
    ) VALUES (
      ${randomUUID()}::uuid,
      ${tenantId}::uuid,
      ${source.kind}::public."FinopsProjectionSourceKind",
      ${source.id}::uuid,
      ${version},
      ${hash}
    )
    ON CONFLICT ("tenant_id", "source_kind", "source_id")
    DO UPDATE SET
      "source_version" = EXCLUDED."source_version",
      "source_hash" = EXCLUDED."source_hash",
      "status" = CASE
        WHEN "finops_projection_jobs"."projected_source_hash" IS NOT NULL
         AND "finops_projection_jobs"."projected_source_hash" <> EXCLUDED."source_hash"
          THEN 'BLOCKED'::public."FinopsProjectionStatus"
        WHEN "finops_projection_jobs"."projected_source_hash" = EXCLUDED."source_hash"
          THEN 'PROJECTED'::public."FinopsProjectionStatus"
        WHEN "finops_projection_jobs"."source_hash" <> EXCLUDED."source_hash"
          THEN 'PENDING'::public."FinopsProjectionStatus"
        ELSE "finops_projection_jobs"."status"
      END,
      "diagnostic_code" = CASE
        WHEN "finops_projection_jobs"."projected_source_hash" IS NOT NULL
         AND "finops_projection_jobs"."projected_source_hash" <> EXCLUDED."source_hash"
          THEN 'SOURCE_MUTATED_AFTER_PROJECTION'
        WHEN "finops_projection_jobs"."source_hash" <> EXCLUDED."source_hash"
          THEN NULL
        ELSE "finops_projection_jobs"."diagnostic_code"
      END,
      "diagnostic_detail" = CASE
        WHEN "finops_projection_jobs"."projected_source_hash" IS NOT NULL
         AND "finops_projection_jobs"."projected_source_hash" <> EXCLUDED."source_hash"
          THEN 'A terminal source changed after projection.'
        WHEN "finops_projection_jobs"."source_hash" <> EXCLUDED."source_hash"
          THEN NULL
        ELSE "finops_projection_jobs"."diagnostic_detail"
      END,
      "available_at" = CASE
        WHEN "finops_projection_jobs"."source_hash" <> EXCLUDED."source_hash"
          THEN CURRENT_TIMESTAMP
        ELSE "finops_projection_jobs"."available_at"
      END,
      "updated_at" = CURRENT_TIMESTAMP
  `);
}

async function loadSource(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  job: ProjectionJobRow,
): Promise<FinopsProjectionSource | null> {
  if (job.source_kind === 'AGENT_RUN') {
    const rows = await transaction.$queryRaw<AgentRunRow[]>(Prisma.sql`
      SELECT
        run."id"::text AS "id",
        run."version",
        run."status"::text AS "status",
        run."requester_user_id"::text AS "requester_user_id",
        run."task_id"::text AS "task_id",
        run."agent_id"::text AS "agent_id",
        run."agent_version_id"::text AS "agent_version_id",
        run."runtime_provider",
        run."runtime_model",
        run."token_evidence"::text AS "token_evidence",
        run."input_tokens",
        run."output_tokens",
        run."total_tokens",
        run."tool_calls",
        run."cost_micros",
        run."latency_ms",
        run."usage_recorded_at",
        run."cost_recorded_at",
        run."finished_at"
      FROM public."agent_runs" run
      WHERE run."tenant_id" = ${tenantId}::uuid
        AND run."id" = ${job.source_id}::uuid
    `);
    return rows[0] === undefined ? null : mapAgentRun(rows[0]);
  }
  const rows = await transaction.$queryRaw<ToolReceiptRow[]>(Prisma.sql`
    SELECT
      receipt."id"::text AS "id",
      receipt."receipt_hash",
      receipt."tool_invocation_id"::text AS "tool_invocation_id",
      invocation."status"::text AS "invocation_status",
      invocation."requester_user_id"::text AS "requester_user_id",
      invocation."role_assignment_id"::text AS "role_assignment_id",
      invocation."task_id"::text AS "task_id",
      invocation."process_instance_id"::text AS "process_instance_id",
      invocation."process_step_instance_id"::text AS "process_step_instance_id",
      invocation."agent_run_id"::text AS "agent_run_id",
      invocation."tool_version_id"::text AS "tool_version_id",
      invocation."tool_version",
      version."key" AS "tool_key",
      invocation."adapter"::text AS "adapter",
      receipt."source"::text AS "source",
      receipt."outcome"::text AS "outcome",
      receipt."provider_request_id",
      receipt."provider_dry_run",
      receipt."execution_attempt",
      receipt."started_at",
      receipt."completed_at",
      receipt."latency_ms",
      receipt."cost_attestation"::text AS "cost_attestation",
      receipt."cost_micros"
    FROM public."tool_execution_receipts" receipt
    JOIN public."tool_invocations" invocation
      ON invocation."tenant_id" = receipt."tenant_id"
     AND invocation."id" = receipt."tool_invocation_id"
    JOIN public."tool_versions" version
      ON version."tenant_id" = invocation."tenant_id"
     AND version."id" = invocation."tool_version_id"
    WHERE receipt."tenant_id" = ${tenantId}::uuid
      AND receipt."id" = ${job.source_id}::uuid
  `);
  return rows[0] === undefined ? null : mapToolReceipt(rows[0]);
}

async function loadPrices(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  source: FinopsProjectionSource,
): Promise<readonly FinopsProjectionPrice[]> {
  const provider = source.kind === 'AGENT_RUN' ? source.runtimeProvider : source.adapter;
  const sku = source.kind === 'AGENT_RUN' ? source.runtimeModel : source.toolKey;
  if (provider === null || sku === null) return [];
  const rows = await transaction.$queryRaw<PriceRow[]>(Prisma.sql`
    SELECT
      price."id"::text AS "id",
      price."version",
      price."resource_kind"::text AS "resource_kind",
      price."provider",
      price."sku",
      price."currency",
      price."billing_unit"::text AS "billing_unit",
      price."unit_size",
      price."unit_price",
      price."effective_from",
      price."effective_to",
      price."approved_at"
    FROM public."finops_price_snapshots" price
    WHERE price."tenant_id" = ${tenantId}::uuid
      AND price."resource_kind" =
        ${source.kind === 'AGENT_RUN' ? 'MODEL' : 'TOOL'}::public."FinopsResourceKind"
      AND price."provider" = ${provider.trim()}
      AND price."sku" = ${sku.trim()}
      AND price."status" = 'APPROVED'::public."FinopsApprovalStatus"
    ORDER BY price."effective_from" DESC, price."version" DESC, price."id"
  `);
  return rows.map((row) => ({
    id: row.id,
    version: row.version,
    resourceKind: row.resource_kind,
    provider: row.provider,
    sku: row.sku,
    currency: row.currency,
    billingUnit: row.billing_unit,
    unitSize: row.unit_size.toFixed(),
    unitPrice: row.unit_price.toFixed(),
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    approvedAt: row.approved_at,
  }));
}

function mapAgentRun(row: AgentRunRow): AgentRunProjectionSource {
  return {
    kind: 'AGENT_RUN',
    id: row.id,
    version: row.version,
    status: row.status,
    requesterUserId: row.requester_user_id,
    taskId: row.task_id,
    agentId: row.agent_id,
    agentVersionId: row.agent_version_id,
    runtimeProvider: row.runtime_provider,
    runtimeModel: row.runtime_model,
    tokenEvidence: row.token_evidence,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    totalTokens: row.total_tokens,
    toolCalls: row.tool_calls,
    costMicros: row.cost_micros,
    latencyMs: row.latency_ms,
    usageRecordedAt: row.usage_recorded_at,
    costRecordedAt: row.cost_recorded_at,
    finishedAt: row.finished_at,
  };
}

function mapToolReceipt(row: ToolReceiptRow): ToolReceiptProjectionSource {
  return {
    kind: 'TOOL_RECEIPT',
    id: row.id,
    receiptHash: row.receipt_hash,
    invocationId: row.tool_invocation_id,
    invocationStatus: row.invocation_status,
    requesterUserId: row.requester_user_id,
    roleAssignmentId: row.role_assignment_id,
    taskId: row.task_id,
    processInstanceId: row.process_instance_id,
    processStepInstanceId: row.process_step_instance_id,
    agentRunId: row.agent_run_id,
    toolVersionId: row.tool_version_id,
    toolVersion: row.tool_version,
    toolKey: row.tool_key,
    adapter: row.adapter,
    source: row.source,
    outcome: row.outcome,
    providerRequestId: row.provider_request_id,
    providerDryRun: row.provider_dry_run,
    executionAttempt: row.execution_attempt,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    latencyMs: row.latency_ms,
    costAttestation: row.cost_attestation,
    costMicros: row.cost_micros,
  };
}

function projectionSourceHash(source: FinopsProjectionSource): string {
  const normalized =
    source.kind === 'AGENT_RUN'
      ? {
          ...source,
          costMicros: source.costMicros.toString(),
          usageRecordedAt: source.usageRecordedAt?.toISOString() ?? null,
          costRecordedAt: source.costRecordedAt?.toISOString() ?? null,
          finishedAt: source.finishedAt?.toISOString() ?? null,
        }
      : {
          ...source,
          costMicros: source.costMicros?.toString() ?? null,
          startedAt: source.startedAt.toISOString(),
          completedAt: source.completedAt.toISOString(),
        };
  return createHash('sha256').update(hashStable(normalized)).digest('hex');
}

function sourceVersion(source: FinopsProjectionSource): string {
  return source.kind === 'AGENT_RUN' ? source.version.toString() : source.receiptHash;
}

async function recordProjectionEvent(
  transaction: Prisma.TransactionClient,
  input: {
    readonly tenantId: string;
    readonly aggregateType: 'FINOPS_COST_ENTRY' | 'FINOPS_PROJECTION_DIAGNOSTIC';
    readonly aggregateId: string;
    readonly action:
      'finops.cost.auto_projected' | 'finops.projection.blocked' | 'finops.projection.resolved';
    readonly eventType:
      | 'finops.cost.auto_projected.v1'
      | 'finops.projection.blocked.v1'
      | 'finops.projection.resolved.v1';
    readonly metadata: Readonly<Record<string, string | number | boolean | null>>;
  },
): Promise<void> {
  const eventId = randomUUID();
  await transaction.$executeRaw(Prisma.sql`
    INSERT INTO public."audit_events" (
      "id", "tenant_id", "actor_type", "actor_id", "action",
      "resource_type", "resource_id", "metadata", "occurred_at"
    ) VALUES (
      ${randomUUID()}::uuid,
      ${input.tenantId}::uuid,
      'SERVICE'::public."AuditActorType",
      ${FINOPS_PROJECTOR_ACTOR_ID}::uuid,
      ${input.action},
      ${input.aggregateType},
      ${input.aggregateId}::uuid,
      ${JSON.stringify(input.metadata)}::jsonb,
      CURRENT_TIMESTAMP
    )
  `);
  await transaction.$executeRaw(Prisma.sql`
    INSERT INTO public."outbox_events" (
      "id", "tenant_id", "aggregate_type", "aggregate_id",
      "event_type", "payload", "available_at", "created_at"
    ) VALUES (
      ${eventId}::uuid,
      ${input.tenantId}::uuid,
      ${input.aggregateType},
      ${input.aggregateId}::uuid,
      ${input.eventType},
      ${JSON.stringify({
        eventId,
        tenantId: input.tenantId,
        actorId: FINOPS_PROJECTOR_ACTOR_ID,
        source: 'finops-auto-projector',
        metadata: input.metadata,
      })}::jsonb,
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    )
  `);
}
