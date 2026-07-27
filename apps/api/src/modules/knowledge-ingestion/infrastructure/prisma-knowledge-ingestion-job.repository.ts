import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { OutboxPrismaService } from '../../../database/outbox-prisma.service.js';
import {
  KnowledgeIngestionJobRepository,
  type ClaimedKnowledgeIngestionJob,
} from '../domain/knowledge-ingestion-job.repository.js';

interface ClaimedRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly document_version_id: string;
  readonly attempts: number;
  readonly lease_expires_at: Date;
  readonly created_at: Date;
}

@Injectable()
export class PrismaKnowledgeIngestionJobRepository extends KnowledgeIngestionJobRepository {
  constructor(@Inject(OutboxPrismaService) private readonly prisma: OutboxPrismaService) {
    super();
  }

  claim(input: {
    readonly workerId: string;
    readonly batchSize: number;
    readonly claimTtlMs: number;
  }): Promise<readonly ClaimedKnowledgeIngestionJob[]> {
    return this.withWorkerRole(async (transaction) => {
      const rows = await transaction.$queryRaw<ClaimedRow[]>(Prisma.sql`
        WITH candidates AS MATERIALIZED (
          SELECT job."id"
          FROM public."knowledge_ingestion_jobs" AS job
          WHERE (
            (
              job."status" = 'PENDING'::"KnowledgeIngestionStatus"
              AND job."available_at" <= clock_timestamp()
            )
            OR (
              job."status" = 'RUNNING'::"KnowledgeIngestionStatus"
              AND job."lease_expires_at" <= clock_timestamp()
            )
          )
          ORDER BY job."available_at", job."created_at", job."id"
          LIMIT ${input.batchSize}
          FOR UPDATE SKIP LOCKED
        )
        UPDATE public."knowledge_ingestion_jobs" AS job
        SET
          "status" = 'RUNNING'::"KnowledgeIngestionStatus",
          "claimed_by" = ${input.workerId},
          "lease_expires_at" =
            clock_timestamp() + ${input.claimTtlMs} * INTERVAL '1 millisecond',
          "attempts" = job."attempts" + 1,
          "started_at" = COALESCE(job."started_at", clock_timestamp()),
          "finished_at" = NULL,
          "error_code" = NULL,
          "error_message" = NULL,
          "updated_at" = clock_timestamp()
        FROM candidates
        WHERE job."id" = candidates."id"
        RETURNING
          job."id"::text AS id,
          job."tenant_id"::text AS tenant_id,
          job."document_version_id"::text AS document_version_id,
          job."attempts" AS attempts,
          job."lease_expires_at" AS lease_expires_at,
          job."created_at" AS created_at
      `);
      return rows.map((row) => ({
        id: row.id,
        tenantId: row.tenant_id,
        documentVersionId: row.document_version_id,
        attempts: row.attempts,
        leaseExpiresAt: row.lease_expires_at,
        createdAt: row.created_at,
      }));
    });
  }

  renewLease(input: {
    readonly jobId: string;
    readonly workerId: string;
    readonly claimTtlMs: number;
  }): Promise<boolean> {
    return this.withWorkerRole(async (transaction) => {
      const updated = await transaction.$executeRaw(Prisma.sql`
        UPDATE public."knowledge_ingestion_jobs"
        SET
          "lease_expires_at" =
            clock_timestamp() + ${input.claimTtlMs} * INTERVAL '1 millisecond',
          "updated_at" = clock_timestamp()
        WHERE "id" = ${input.jobId}::uuid
          AND "status" = 'RUNNING'::"KnowledgeIngestionStatus"
          AND "claimed_by" = ${input.workerId}
          AND "lease_expires_at" > clock_timestamp()
      `);
      return updated === 1;
    });
  }

  releaseForRetry(input: {
    readonly jobId: string;
    readonly workerId: string;
    readonly availableAt: Date;
    readonly errorCode: string;
    readonly errorMessage: string;
  }): Promise<boolean> {
    return this.withWorkerRole(async (transaction) => {
      const updated = await transaction.$executeRaw(Prisma.sql`
        UPDATE public."knowledge_ingestion_jobs"
        SET
          "stage" = 'UPLOADED'::"KnowledgeIngestionStage",
          "status" = 'PENDING'::"KnowledgeIngestionStatus",
          "progress" = 5,
          "available_at" = ${input.availableAt},
          "claimed_by" = NULL,
          "lease_expires_at" = NULL,
          "error_code" = ${input.errorCode},
          "error_message" = ${input.errorMessage},
          "finished_at" = NULL,
          "updated_at" = clock_timestamp()
        WHERE "id" = ${input.jobId}::uuid
          AND "status" = 'RUNNING'::"KnowledgeIngestionStatus"
          AND "claimed_by" = ${input.workerId}
          AND "lease_expires_at" > clock_timestamp()
      `);
      return updated === 1;
    });
  }

  private withWorkerRole<T>(
    operation: (transaction: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    if (!this.prisma.enabled) {
      throw new Error('The knowledge ingestion worker requires the Prisma repository adapter.');
    }
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_outbox');
      return operation(transaction);
    });
  }
}
