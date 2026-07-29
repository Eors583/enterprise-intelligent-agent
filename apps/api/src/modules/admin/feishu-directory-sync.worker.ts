import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import type { EnvironmentVariables } from '../../config/environment.js';
import { OutboxPrismaService } from '../../database/outbox-prisma.service.js';
import { OUTBOX_CONSUMER, OUTBOX_LANE } from '../../database/outbox-routing.js';
import {
  type DirectorySyncWorkerClaim,
  FeishuDirectorySyncService,
} from './feishu-directory-sync.service.js';

const DIRECTORY_SYNC_EVENT_TYPE = 'admin.directory.feishu.sync.requested.v1';

type ClaimedRow = {
  id: string;
  tenantId: string;
  integrationId: string;
  organizationId: string;
  previewId: string;
  requestedById: string;
  expectedSnapshotCursor: string;
  attempts: number;
  maxAttempts: number;
  leaseExpiresAt: Date;
};

@Injectable()
export class FeishuDirectorySyncWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(FeishuDirectorySyncWorker.name);
  private readonly enabled: boolean;
  private readonly pollIntervalMs: number;
  private readonly batchSize: number;
  private readonly leaseMs: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly workerId = `feishu-directory:${process.pid}:${randomUUID()}`;
  private stopped = true;
  private timer: NodeJS.Timeout | undefined;
  private activeTick: Promise<void> | undefined;

  constructor(
    @Inject(ConfigService) config: ConfigService<EnvironmentVariables, true>,
    @Inject(OutboxPrismaService) private readonly outbox: OutboxPrismaService,
    @Inject(FeishuDirectorySyncService)
    private readonly synchronization: FeishuDirectorySyncService,
  ) {
    this.enabled = config.get('FEISHU_SYNC_WORKER_ENABLED', { infer: true });
    this.pollIntervalMs = config.get('FEISHU_SYNC_WORKER_POLL_INTERVAL_MS', { infer: true });
    this.batchSize = config.get('FEISHU_SYNC_WORKER_BATCH_SIZE', { infer: true });
    this.leaseMs = config.get('FEISHU_SYNC_LEASE_MS', { infer: true });
    this.retryBaseMs = config.get('FEISHU_SYNC_RETRY_BASE_MS', { infer: true });
    this.retryMaxMs = config.get('FEISHU_SYNC_RETRY_MAX_MS', { infer: true });
  }

  onApplicationBootstrap(): void {
    if (!this.enabled) {
      this.logger.log('Feishu directory synchronization worker is disabled.');
      return;
    }
    this.stopped = false;
    this.logger.log(`Starting Feishu directory synchronization worker ${this.workerId}.`);
    this.schedule(0);
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    await this.activeTick;
  }

  async runOnce(): Promise<number> {
    if (!this.enabled) return 0;
    const claims = await claimDirectorySyncRuns(
      this.outbox,
      this.workerId,
      this.batchSize,
      this.leaseMs,
    );
    const results = await Promise.allSettled(claims.map((claim) => this.processClaim(claim)));
    for (const result of results) {
      if (result.status === 'rejected') {
        this.logger.error(
          `Unable to persist Feishu sync transition (${errorKind(result.reason)}).`,
        );
      }
    }
    return claims.length;
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      const tick = this.tick();
      this.activeTick = tick;
      void tick.finally(() => {
        if (this.activeTick === tick) this.activeTick = undefined;
      });
    }, delayMs);
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    try {
      await this.runOnce();
    } catch (error) {
      this.logger.error(`Feishu directory polling failed (${errorKind(error)}).`);
    } finally {
      this.schedule(this.pollIntervalMs);
    }
  }

  private async processClaim(claim: DirectorySyncWorkerClaim): Promise<void> {
    const heartbeat = this.startHeartbeat(claim);
    let failure: unknown;
    try {
      await this.synchronization.executeWorkerClaim(claim);
    } catch (error) {
      failure = error;
    } finally {
      await heartbeat.stop();
    }
    if (heartbeat.lost()) return;
    if (failure === undefined) {
      await markDirectoryDeliveryPublished(this.outbox, claim);
      return;
    }
    const retryAt =
      claim.attempts >= claim.maxAttempts
        ? null
        : new Date(
            Date.now() +
              calculateDirectorySyncRetryDelay(claim.attempts, this.retryBaseMs, this.retryMaxMs),
          );
    await this.synchronization.failWorkerClaim(claim, failure, retryAt);
    await markDirectoryDeliveryFailedOrDeferred(this.outbox, claim, retryAt, failure);
  }

  private startHeartbeat(claim: DirectorySyncWorkerClaim): {
    readonly lost: () => boolean;
    readonly stop: () => Promise<void>;
  } {
    let lost = false;
    let activeRenewal: Promise<void> = Promise.resolve();
    const intervalMs = Math.max(1_000, Math.floor(this.leaseMs / 3));
    const timer = setInterval(() => {
      activeRenewal = activeRenewal.then(async () => {
        try {
          const renewed = await this.synchronization.renewWorkerLease(
            claim,
            new Date(Date.now() + this.leaseMs),
          );
          if (
            !renewed ||
            !(await renewDirectoryDelivery(this.outbox, claim, new Date(Date.now() + this.leaseMs)))
          ) {
            lost = true;
          }
        } catch (error) {
          this.logger.error(`Feishu sync lease renewal failed (${errorKind(error)}).`);
        }
      });
    }, intervalMs);
    timer.unref();
    return {
      lost: () => lost,
      stop: async () => {
        clearInterval(timer);
        await activeRenewal;
      },
    };
  }
}

async function claimDirectorySyncRuns(
  prisma: PrismaClient,
  workerId: string,
  batchSize: number,
  leaseMs: number,
): Promise<readonly DirectorySyncWorkerClaim[]> {
  const leaseExpiresAt = new Date(Date.now() + leaseMs);
  return prisma.$transaction(async (transaction) => {
    const rows = await transaction.$queryRaw<ClaimedRow[]>(Prisma.sql`
      WITH candidates AS (
        SELECT run.id
        FROM public.directory_sync_runs run
        WHERE (
          (run.status = 'QUEUED'::public."DirectorySyncRunStatus"
            AND run.next_attempt_at <= CURRENT_TIMESTAMP)
          OR
          (run.status = 'RUNNING'::public."DirectorySyncRunStatus"
            AND run.lease_expires_at <= CURRENT_TIMESTAMP)
        )
        AND EXISTS (
          SELECT 1
          FROM public.outbox_event_deliveries delivery
          JOIN public.outbox_events event
            ON event.tenant_id = delivery.tenant_id
           AND event.id = delivery.event_id
          WHERE delivery.tenant_id = run.tenant_id
            AND delivery.consumer_key = ${OUTBOX_CONSUMER.feishuDirectory}
            AND delivery.lane = ${OUTBOX_LANE.feishuDirectorySync}
            AND event.aggregate_type = 'directory_sync_run'
            AND event.aggregate_id = run.id
            AND event.event_type = ${DIRECTORY_SYNC_EVENT_TYPE}
            AND delivery.status IN (
              'PENDING'::public."OutboxEventStatus",
              'FAILED'::public."OutboxEventStatus"
            )
            AND delivery.available_at <= CURRENT_TIMESTAMP
            AND (
              delivery.locked_until IS NULL
              OR delivery.locked_until <= CURRENT_TIMESTAMP
            )
        )
        ORDER BY run.next_attempt_at ASC, run.created_at ASC, run.id ASC
        FOR UPDATE SKIP LOCKED
        LIMIT ${batchSize}
      )
      UPDATE public.directory_sync_runs run
      SET status = 'RUNNING'::public."DirectorySyncRunStatus",
          attempts = run.attempts + 1,
          lease_owner = ${workerId},
          lease_expires_at = ${leaseExpiresAt},
          started_at = COALESCE(run.started_at, CURRENT_TIMESTAMP),
          finished_at = NULL,
          updated_at = CURRENT_TIMESTAMP
      FROM candidates
      WHERE run.id = candidates.id
      RETURNING
        run.id,
        run.tenant_id AS "tenantId",
        run.integration_id AS "integrationId",
        run.organization_id AS "organizationId",
        run.preview_id AS "previewId",
        run.requested_by_id AS "requestedById",
        run.expected_snapshot_cursor AS "expectedSnapshotCursor",
        run.attempts,
        run.max_attempts AS "maxAttempts",
        run.lease_expires_at AS "leaseExpiresAt"
    `);
    if (rows.length === 0) return [];
    const ids = rows.map((row) => Prisma.sql`${row.id}::uuid`);
    await transaction.$executeRaw(Prisma.sql`
      UPDATE public.outbox_event_deliveries delivery
      SET status = 'PENDING'::public."OutboxEventStatus",
          locked_by = ${workerId},
          locked_until = ${leaseExpiresAt},
          attempts = delivery.attempts + 1,
          first_attempted_at = COALESCE(delivery.first_attempted_at, CURRENT_TIMESTAMP),
          last_error = NULL,
          updated_at = CURRENT_TIMESTAMP
      FROM public.outbox_events event
      WHERE event.tenant_id = delivery.tenant_id
        AND event.id = delivery.event_id
        AND delivery.consumer_key = ${OUTBOX_CONSUMER.feishuDirectory}
        AND delivery.lane = ${OUTBOX_LANE.feishuDirectorySync}
        AND event.aggregate_type = 'directory_sync_run'
        AND event.aggregate_id IN (${Prisma.join(ids)})
        AND event.event_type = ${DIRECTORY_SYNC_EVENT_TYPE}
        AND delivery.status IN (
          'PENDING'::public."OutboxEventStatus",
          'FAILED'::public."OutboxEventStatus"
        )
    `);
    return rows.map((row) => ({ ...row, workerId }));
  });
}

async function renewDirectoryDelivery(
  prisma: PrismaClient,
  claim: DirectorySyncWorkerClaim,
  leaseExpiresAt: Date,
): Promise<boolean> {
  const updated = await prisma.$executeRaw(Prisma.sql`
    UPDATE public.outbox_event_deliveries delivery
    SET locked_until = ${leaseExpiresAt},
        updated_at = CURRENT_TIMESTAMP
    FROM public.outbox_events event
    WHERE event.tenant_id = delivery.tenant_id
      AND event.id = delivery.event_id
      AND delivery.tenant_id = ${claim.tenantId}::uuid
      AND delivery.consumer_key = ${OUTBOX_CONSUMER.feishuDirectory}
      AND delivery.lane = ${OUTBOX_LANE.feishuDirectorySync}
      AND event.aggregate_type = 'directory_sync_run'
      AND event.aggregate_id = ${claim.id}::uuid
      AND delivery.status = 'PENDING'::public."OutboxEventStatus"
      AND delivery.locked_by = ${claim.workerId}
  `);
  return updated === 1;
}

async function markDirectoryDeliveryPublished(
  prisma: PrismaClient,
  claim: DirectorySyncWorkerClaim,
): Promise<void> {
  await prisma.$executeRaw(Prisma.sql`
    UPDATE public.outbox_event_deliveries delivery
    SET status = 'PUBLISHED'::public."OutboxEventStatus",
        acknowledged_at = CURRENT_TIMESTAMP,
        provider_name = 'feishu-directory-sync',
        provider_receipt = ${JSON.stringify({
          outcome: 'applied',
          runId: claim.id,
          previewId: claim.previewId,
        })}::jsonb,
        locked_by = NULL,
        locked_until = NULL,
        last_error = NULL,
        updated_at = CURRENT_TIMESTAMP
    FROM public.outbox_events event
    WHERE event.tenant_id = delivery.tenant_id
      AND event.id = delivery.event_id
      AND delivery.tenant_id = ${claim.tenantId}::uuid
      AND delivery.consumer_key = ${OUTBOX_CONSUMER.feishuDirectory}
      AND delivery.lane = ${OUTBOX_LANE.feishuDirectorySync}
      AND event.aggregate_type = 'directory_sync_run'
      AND event.aggregate_id = ${claim.id}::uuid
      AND delivery.status = 'PENDING'::public."OutboxEventStatus"
      AND delivery.locked_by = ${claim.workerId}
  `);
}

async function markDirectoryDeliveryFailedOrDeferred(
  prisma: PrismaClient,
  claim: DirectorySyncWorkerClaim,
  retryAt: Date | null,
  error: unknown,
): Promise<void> {
  const errorCode = errorKind(error).slice(0, 120);
  await prisma.$executeRaw(Prisma.sql`
    UPDATE public.outbox_event_deliveries delivery
    SET status = ${
      retryAt === null
        ? Prisma.sql`'FAILED'::public."OutboxEventStatus"`
        : Prisma.sql`'PENDING'::public."OutboxEventStatus"`
    },
        available_at = ${retryAt ?? new Date()},
        acknowledged_at = NULL,
        locked_by = NULL,
        locked_until = NULL,
        last_error = ${errorCode},
        updated_at = CURRENT_TIMESTAMP
    FROM public.outbox_events event
    WHERE event.tenant_id = delivery.tenant_id
      AND event.id = delivery.event_id
      AND delivery.tenant_id = ${claim.tenantId}::uuid
      AND delivery.consumer_key = ${OUTBOX_CONSUMER.feishuDirectory}
      AND delivery.lane = ${OUTBOX_LANE.feishuDirectorySync}
      AND event.aggregate_type = 'directory_sync_run'
      AND event.aggregate_id = ${claim.id}::uuid
      AND delivery.status = 'PENDING'::public."OutboxEventStatus"
      AND delivery.locked_by = ${claim.workerId}
  `);
}

export function calculateDirectorySyncRetryDelay(
  attempt: number,
  baseMs: number,
  maximumMs: number,
  random: () => number = Math.random,
): number {
  const exponent = Math.max(0, Math.min(attempt - 1, 30));
  const delay = Math.min(maximumMs, baseMs * 2 ** exponent);
  const randomValue = random();
  const jitter =
    0.8 + (Number.isFinite(randomValue) ? Math.max(0, Math.min(1, randomValue)) : 0.5) * 0.4;
  return Math.min(maximumMs, Math.round(delay * jitter));
}

function errorKind(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
