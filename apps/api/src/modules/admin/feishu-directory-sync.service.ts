import { createHash, randomUUID } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  type ApplyFeishuDirectoryPreviewRequest,
  adminMemberSchema,
  type BindFeishuOrganizationRequest,
  type FeishuDirectoryPreview,
  type FeishuDirectorySyncRunDetail,
  type FeishuDirectorySyncRunList,
  type FeishuOrganizationSyncStatus,
} from '@enterprise/contracts';
import { Prisma } from '@prisma/client';

import type { EnvironmentVariables } from '../../config/environment.js';
import { AdminPrismaService } from '../../database/admin-prisma.service.js';
import { DirectoryPersonalAgentProvisioner } from '../agent-control/infrastructure/prisma/directory-personal-agent.provisioner.js';
import { AdminAccessService, type AdminPrincipal } from './admin-access.service.js';
import { recordAdminAudit } from './admin-audit.js';
import { lockOrganizationDirectory } from './organization-directory-lock.js';
import {
  cancelAssignedAgentRuns,
  cascadeAssignmentDescendants,
  disableAgentInstanceWithoutEffectiveAssignments,
} from './role-assignment-admin.service.js';
import { FeishuDirectoryClient } from './feishu/feishu-directory.client.js';
import { FeishuCredentialVault } from './feishu/feishu-credential-vault.js';
import {
  FEISHU_ROOT_DEPARTMENT_ID as ROOT_DEPARTMENT_ID,
  InvalidFeishuSnapshotError,
  validateFeishuDirectorySnapshot,
} from './feishu/feishu-directory-snapshot.validator.js';
import type {
  FeishuDirectoryDepartment,
  FeishuDirectorySnapshot,
  FeishuDirectoryUser,
} from './feishu/feishu-directory.models.js';
import { FeishuDirectoryError } from './feishu/feishu-directory.models.js';

const APPLY_TRANSACTION_TIMEOUT_MS = 600_000;
const REMOVAL_CONFIRMATION_DELAY_MS = 60 * 60_000;
const DIRECTORY_SYNC_EVENT_TYPE = 'admin.directory.feishu.sync.requested.v1';

interface SyncCounters {
  readonly departments: {
    created: number;
    updated: number;
    archived: number;
    unchanged: number;
    failed: number;
  };
  readonly members: {
    created: number;
    updated: number;
    deactivated: number;
    unchanged: number;
    failed: number;
  };
  conflictCount: number;
}

interface ClaimedSync {
  readonly principal: AdminPrincipal;
  readonly organizationId: string;
  readonly organizationName: string;
  readonly integrationId: string;
  readonly leaseOwner: string;
  readonly startedAt: Date;
  readonly previousSuccessfulAt: Date | null;
  readonly client: FeishuDirectoryClient;
}

export interface DirectorySyncWorkerClaim {
  readonly id: string;
  readonly tenantId: string;
  readonly integrationId: string;
  readonly organizationId: string;
  readonly previewId: string;
  readonly requestedById: string;
  readonly expectedSnapshotCursor: string;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly workerId: string;
  readonly leaseExpiresAt: Date;
}

interface FeishuConnection {
  readonly source: 'ADMIN' | 'ENVIRONMENT';
  readonly appId: string;
  readonly fingerprint: string;
  readonly client: FeishuDirectoryClient;
}

@Injectable()
export class FeishuDirectorySyncService {
  private readonly logger = new Logger(FeishuDirectorySyncService.name);
  private readonly leaseMs: number;
  private readonly reconcileRemovals: boolean;
  private readonly environmentAppId: string | undefined;
  private readonly environmentAppSecret: string | undefined;
  private readonly environmentTenantSlug: string | undefined;
  private readonly apiBaseUrl: string;
  private readonly httpTimeoutMs: number;
  private readonly previewTtlMs: number;
  private readonly workerEnabled: boolean;
  private readonly maxAttempts: number;

  constructor(
    @Inject(AdminPrismaService) private readonly prisma: AdminPrismaService,
    @Inject(AdminAccessService) private readonly access: AdminAccessService,
    @Inject(FeishuDirectoryClient) private readonly feishu: FeishuDirectoryClient,
    @Inject(FeishuCredentialVault) private readonly vault: FeishuCredentialVault,
    @Inject(DirectoryPersonalAgentProvisioner)
    private readonly personalAgents: DirectoryPersonalAgentProvisioner,
    @Inject(ConfigService) config: ConfigService<EnvironmentVariables, true>,
  ) {
    this.leaseMs = config.get('FEISHU_SYNC_LEASE_MS', { infer: true });
    this.reconcileRemovals = config.get('FEISHU_DIRECTORY_RECONCILE_REMOVALS', {
      infer: true,
    });
    this.environmentAppId = config.get('FEISHU_APP_ID', { infer: true });
    this.environmentAppSecret = config.get('FEISHU_APP_SECRET', { infer: true });
    this.environmentTenantSlug = config.get('FEISHU_DIRECTORY_TARGET_TENANT_SLUG', {
      infer: true,
    });
    this.apiBaseUrl = config.get('FEISHU_API_BASE_URL', { infer: true });
    this.httpTimeoutMs = config.get('FEISHU_HTTP_TIMEOUT_MS', { infer: true });
    this.previewTtlMs = config.get('FEISHU_SYNC_PREVIEW_TTL_MS', { infer: true });
    this.workerEnabled = config.get('FEISHU_SYNC_WORKER_ENABLED', { infer: true });
    this.maxAttempts = config.get('FEISHU_SYNC_MAX_ATTEMPTS', { infer: true });
  }

  async getStatus(): Promise<FeishuOrganizationSyncStatus> {
    const principal = this.access.requireDirectoryWrite();
    return this.prisma.withTenant(principal.tenantId, async (transaction) => {
      const organization = await transaction.organization.findFirstOrThrow({
        where: { tenantId: principal.tenantId },
        orderBy: { createdAt: 'asc' },
        select: { id: true, name: true, externalKey: true },
      });
      const integration = await transaction.directoryIntegration.findFirst({
        where: { tenantId: principal.tenantId, provider: 'FEISHU' },
      });

      const connection = this.resolveConnection(organization.externalKey, integration);
      if (connection === null) {
        return notConfiguredStatus(organization.name);
      }
      if (
        integration !== null &&
        integration.connectorFingerprint !== null &&
        integration.connectorFingerprint !== connection.fingerprint
      ) {
        return connectorMismatchStatus(organization.name, integration);
      }
      return withConnection(mapStatus(organization.name, integration), connection);
    });
  }

  async bind(request: BindFeishuOrganizationRequest): Promise<FeishuOrganizationSyncStatus> {
    const principal = this.access.requireDirectoryWrite();
    const organization = await this.prisma.withTenant(principal.tenantId, (transaction) =>
      transaction.organization.findFirstOrThrow({
        where: { tenantId: principal.tenantId },
        orderBy: { createdAt: 'asc' },
        select: { id: true, name: true, externalKey: true },
      }),
    );
    const fingerprint = fingerprintFor(request.appId);
    const client = this.createClient(
      request.appId,
      request.appSecret,
      organization.externalKey ?? principal.tenantId,
    );
    try {
      await client.verifyConnection();
    } catch (error) {
      if (error instanceof FeishuDirectoryError) {
        throw new BadRequestException(
          '无法验证飞书应用凭据，请检查 App ID、App Secret 和应用状态。',
        );
      }
      throw error;
    }
    const encryptedSecret = this.vault.encrypt(request.appSecret, {
      tenantId: principal.tenantId,
      appId: request.appId,
    });

    await this.prisma.withTenant(principal.tenantId, async (transaction) => {
      const existing = await transaction.directoryIntegration.findFirst({
        where: { tenantId: principal.tenantId, provider: 'FEISHU' },
      });
      if (existing?.status === 'RUNNING') {
        throw new ConflictException('飞书组织同步正在执行，完成后才能更新连接。');
      }
      if (
        existing?.connectorFingerprint &&
        existing.connectorFingerprint !== fingerprint &&
        existing.lastSuccessfulSyncAt !== null
      ) {
        throw new ConflictException(
          '已同步过其他飞书应用。为避免覆盖组织数据，不能直接更换 App ID。',
        );
      }
      const integration = await transaction.directoryIntegration.upsert({
        where: { tenantId_provider: { tenantId: principal.tenantId, provider: 'FEISHU' } },
        create: {
          tenantId: principal.tenantId,
          organizationId: organization.id,
          provider: 'FEISHU',
          connectorFingerprint: fingerprint,
          connectorAppId: request.appId,
          connectorSecret: encryptedSecret,
          status: 'IDLE',
        },
        update: {
          organizationId: organization.id,
          connectorFingerprint: fingerprint,
          connectorAppId: request.appId,
          connectorSecret: encryptedSecret,
          lastErrorCode: null,
          version: { increment: 1 },
        },
      });
      await recordAdminAudit(
        transaction,
        principal,
        'admin.directory.feishu.connection.bound',
        'directory_integration',
        integration.id,
        { appIdMasked: maskAppId(request.appId) },
      );
    });
    return this.getStatus();
  }

  async createPreview(): Promise<FeishuDirectoryPreview> {
    const principal = this.access.requireDirectoryWrite();
    const context = await this.prisma.withTenant(principal.tenantId, async (transaction) => {
      const organization = await transaction.organization.findFirstOrThrow({
        where: { tenantId: principal.tenantId },
        orderBy: { createdAt: 'asc' },
        select: { id: true, externalKey: true },
      });
      let integration = await transaction.directoryIntegration.findFirst({
        where: { tenantId: principal.tenantId, provider: 'FEISHU' },
      });
      const connection = this.resolveConnection(organization.externalKey, integration);
      if (connection === null) {
        throw new BadRequestException('请先绑定并验证飞书企业自建应用。');
      }
      // Environment-managed credentials are a supported connection source, but
      // previews and runs still need a durable integration identity. Materialize
      // it without persisting the environment secret in the database.
      if (integration === null) {
        integration = await transaction.directoryIntegration.upsert({
          where: {
            tenantId_provider: {
              tenantId: principal.tenantId,
              provider: 'FEISHU',
            },
          },
          create: {
            tenantId: principal.tenantId,
            organizationId: organization.id,
            provider: 'FEISHU',
            connectorFingerprint: connection.fingerprint,
            status: 'IDLE',
          },
          update: { organizationId: organization.id },
        });
      }
      if (
        integration.connectorFingerprint !== null &&
        integration.connectorFingerprint !== connection.fingerprint
      ) {
        throw new ConflictException('飞书应用与当前通讯录绑定不一致，已拒绝生成预览。');
      }
      return { organization, integration, connection };
    });

    const snapshot = validateFeishuDirectorySnapshot(
      await context.connection.client.fetchSnapshot(),
    );
    const cursor = snapshotCursor(snapshot);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.previewTtlMs);
    try {
      return await this.prisma.withTenant(principal.tenantId, async (transaction) => {
        const existing = await transaction.directorySyncPreview.findFirst({
          where: {
            tenantId: principal.tenantId,
            integrationId: context.integration.id,
            snapshotCursor: cursor,
            status: 'READY',
            expiresAt: { gt: now },
          },
          include: { items: { orderBy: { sequence: 'asc' } } },
        });
        if (existing !== null) return mapPreview(existing);

        await transaction.directorySyncPreview.updateMany({
          where: {
            tenantId: principal.tenantId,
            integrationId: context.integration.id,
            status: 'READY',
          },
          data: { status: 'EXPIRED' },
        });
        const previewBuild = await buildPreviewChanges(transaction, {
          tenantId: principal.tenantId,
          integrationId: context.integration.id,
          snapshot,
          now,
          reconcileRemovals: this.reconcileRemovals,
        });
        const summary = summarizePreview(previewBuild.changes, previewBuild.unchanged);
        const preview = await transaction.directorySyncPreview.create({
          data: {
            tenantId: principal.tenantId,
            integrationId: context.integration.id,
            organizationId: context.organization.id,
            requestedById: principal.userId,
            snapshotCursor: cursor,
            summary: summary as unknown as Prisma.InputJsonObject,
            expiresAt,
            items: {
              create: previewBuild.changes.map((change, sequence) => ({
                sequence,
                ...change,
                fieldChanges: change.fieldChanges as Prisma.InputJsonObject,
              })),
            },
          },
          include: { items: { orderBy: { sequence: 'asc' } } },
        });
        await transaction.directoryIntegration.update({
          where: { id: context.integration.id },
          data: { lastPreviewCursor: cursor, version: { increment: 1 } },
        });
        await recordAdminAudit(
          transaction,
          principal,
          'admin.directory.feishu.preview.created',
          'directory_sync_preview',
          preview.id,
          {
            snapshotCursor: cursor,
            expiresAt: expiresAt.toISOString(),
            summary,
          } as unknown as Prisma.InputJsonObject,
        );
        return mapPreview(preview);
      });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
        throw error;
      }
      const winner = await this.prisma.withTenant(principal.tenantId, (transaction) =>
        transaction.directorySyncPreview.findFirst({
          where: {
            tenantId: principal.tenantId,
            integrationId: context.integration.id,
            snapshotCursor: cursor,
            status: 'READY',
            expiresAt: { gt: new Date() },
          },
          include: { items: { orderBy: { sequence: 'asc' } } },
        }),
      );
      if (winner === null) {
        throw new ConflictException('飞书快照已变化，请重新生成差异预览。');
      }
      return mapPreview(winner);
    }
  }

  async getCurrentPreview(): Promise<FeishuDirectoryPreview | null> {
    const principal = this.access.requireDirectoryRead();
    return this.prisma.withTenant(principal.tenantId, async (transaction) => {
      const now = new Date();
      await transaction.directorySyncPreview.updateMany({
        where: { tenantId: principal.tenantId, status: 'READY', expiresAt: { lte: now } },
        data: { status: 'EXPIRED' },
      });
      const preview = await transaction.directorySyncPreview.findFirst({
        where: { tenantId: principal.tenantId },
        orderBy: { createdAt: 'desc' },
        include: { items: { orderBy: { sequence: 'asc' } } },
      });
      return preview === null ? null : mapPreview(preview);
    });
  }

  async enqueuePreview(
    request: ApplyFeishuDirectoryPreviewRequest,
  ): Promise<FeishuDirectorySyncRunDetail> {
    if (!this.workerEnabled) {
      throw new ServiceUnavailableException('飞书通讯录后台同步 Worker 尚未启用。');
    }
    const principal = this.access.requireDirectoryWrite();
    const requestHash = stableHash(JSON.stringify({ previewId: request.previewId }), 64);
    try {
      return await this.prisma.withTenant(principal.tenantId, async (transaction) => {
        const existing = await transaction.directorySyncRun.findUnique({
          where: {
            tenantId_idempotencyKey: {
              tenantId: principal.tenantId,
              idempotencyKey: request.idempotencyKey,
            },
          },
        });
        if (existing !== null) {
          if (existing.requestHash !== requestHash) {
            throw new ConflictException('该幂等键已用于不同的飞书同步请求。');
          }
          return mapRun(existing);
        }
        const preview = await transaction.directorySyncPreview.findFirst({
          where: {
            id: request.previewId,
            tenantId: principal.tenantId,
            status: 'READY',
            expiresAt: { gt: new Date() },
          },
        });
        if (preview === null) {
          throw new ConflictException('同步预览不存在、已过期或已被应用，请重新生成预览。');
        }
        const run = await transaction.directorySyncRun.create({
          data: {
            tenantId: principal.tenantId,
            integrationId: preview.integrationId,
            organizationId: preview.organizationId,
            previewId: preview.id,
            requestedById: principal.userId,
            idempotencyKey: request.idempotencyKey,
            requestHash,
            expectedSnapshotCursor: preview.snapshotCursor,
            maxAttempts: this.maxAttempts,
          },
        });
        await transaction.outboxEvent.create({
          data: {
            tenantId: principal.tenantId,
            aggregateType: 'directory_sync_run',
            aggregateId: run.id,
            eventType: DIRECTORY_SYNC_EVENT_TYPE,
            payload: {
              runId: run.id,
              previewId: preview.id,
              expectedSnapshotCursor: preview.snapshotCursor,
            },
          },
        });
        await recordAdminAudit(
          transaction,
          principal,
          'admin.directory.feishu.sync.queued',
          'directory_sync_run',
          run.id,
          { previewId: preview.id, snapshotCursor: preview.snapshotCursor },
        );
        return mapRun(run);
      });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
        throw error;
      }
      const existing = await this.prisma.withTenant(principal.tenantId, (transaction) =>
        transaction.directorySyncRun.findUnique({
          where: {
            tenantId_idempotencyKey: {
              tenantId: principal.tenantId,
              idempotencyKey: request.idempotencyKey,
            },
          },
        }),
      );
      if (existing === null || existing.requestHash !== requestHash) {
        throw new ConflictException('该幂等键已用于不同的飞书同步请求。');
      }
      return mapRun(existing);
    }
  }

  async listRuns(): Promise<FeishuDirectorySyncRunList> {
    const principal = this.access.requireDirectoryRead();
    const items = await this.prisma.withTenant(principal.tenantId, (transaction) =>
      transaction.directorySyncRun.findMany({
        where: { tenantId: principal.tenantId },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
    );
    return { items: items.map(mapRun) };
  }

  async startSync(): Promise<FeishuOrganizationSyncStatus> {
    const principal = this.access.requireDirectoryWrite();
    let claim: ClaimedSync;
    try {
      claim = await this.claim(principal);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('飞书组织同步正在执行，请等待当前任务完成。');
      }
      throw error;
    }

    await this.execute(claim);

    return this.getStatus();
  }

  async executeWorkerClaim(claim: DirectorySyncWorkerClaim): Promise<void> {
    const record = await this.prisma.withTenant(claim.tenantId, (transaction) =>
      transaction.directorySyncRun.findFirstOrThrow({
        where: {
          id: claim.id,
          tenantId: claim.tenantId,
          status: 'RUNNING',
          leaseOwner: claim.workerId,
          leaseExpiresAt: { gt: new Date() },
        },
        include: {
          integration: {
            include: { organization: { select: { externalKey: true } } },
          },
          preview: true,
          requestedBy: { select: { id: true, role: true } },
        },
      }),
    );
    if (record.preview.status !== 'READY' || record.preview.expiresAt <= new Date()) {
      throw new DirectorySyncExecutionError('PREVIEW_EXPIRED', false);
    }
    const connection = this.resolveConnection(
      record.integration.organization.externalKey,
      record.integration,
    );
    if (connection === null) {
      throw new DirectorySyncExecutionError('FEISHU_NOT_CONFIGURED', false);
    }
    const snapshot = validateFeishuDirectorySnapshot(await connection.client.fetchSnapshot());
    const cursor = snapshotCursor(snapshot);
    if (cursor !== record.expectedSnapshotCursor) {
      throw new DirectorySyncExecutionError('SNAPSHOT_CHANGED', false);
    }

    const startedAt = record.startedAt ?? new Date();
    const integrationLease = await this.prisma.withTenant(claim.tenantId, (transaction) =>
      transaction.directoryIntegration.updateMany({
        where: {
          id: claim.integrationId,
          tenantId: claim.tenantId,
          OR: [
            { status: { not: 'RUNNING' } },
            { leaseOwner: claim.workerId },
            { leaseExpiresAt: { lte: new Date() } },
          ],
        },
        data: {
          status: 'RUNNING',
          leaseOwner: claim.workerId,
          leaseExpiresAt: claim.leaseExpiresAt,
          lastSyncStartedAt: startedAt,
          lastSyncFinishedAt: null,
          lastErrorCode: null,
          version: { increment: 1 },
        },
      }),
    );
    if (integrationLease.count !== 1) {
      throw new DirectorySyncExecutionError('SYNC_LEASE_BUSY', true);
    }

    await this.applySnapshot(
      {
        principal: {
          tenantId: claim.tenantId,
          userId: record.requestedBy.id,
          role: record.requestedBy.role,
          authenticationSource: 'session',
        },
        organizationId: claim.organizationId,
        organizationName: '',
        integrationId: claim.integrationId,
        leaseOwner: claim.workerId,
        startedAt,
        previousSuccessfulAt: record.integration.lastSuccessfulSyncAt,
        client: connection.client,
      },
      snapshot,
      { runId: claim.id, previewId: claim.previewId, cursor },
    );
  }

  async renewWorkerLease(claim: DirectorySyncWorkerClaim, leaseExpiresAt: Date): Promise<boolean> {
    return this.prisma.withTenant(claim.tenantId, async (transaction) => {
      const renewed = await transaction.directorySyncRun.updateMany({
        where: {
          id: claim.id,
          tenantId: claim.tenantId,
          status: 'RUNNING',
          leaseOwner: claim.workerId,
          leaseExpiresAt: { gt: new Date() },
        },
        data: { leaseExpiresAt },
      });
      if (renewed.count !== 1) return false;
      await transaction.directoryIntegration.updateMany({
        where: {
          id: claim.integrationId,
          tenantId: claim.tenantId,
          status: 'RUNNING',
          leaseOwner: claim.workerId,
        },
        data: { leaseExpiresAt },
      });
      return true;
    });
  }

  async failWorkerClaim(
    claim: DirectorySyncWorkerClaim,
    error: unknown,
    retryAt: Date | null,
  ): Promise<void> {
    const described = describeDirectorySyncExecutionError(error);
    await this.prisma.withTenant(claim.tenantId, async (transaction) => {
      const shouldRetry =
        described.retryable && retryAt !== null && claim.attempts < claim.maxAttempts;
      const status = shouldRetry
        ? ('QUEUED' as const)
        : claim.attempts >= claim.maxAttempts
          ? ('DEAD_LETTER' as const)
          : ('FAILED' as const);
      const runClockFloor = shouldRetry
        ? null
        : await transaction.directorySyncRun.findFirst({
            where: { id: claim.id, tenantId: claim.tenantId },
            select: {
              startedAt: true,
              integration: { select: { lastSyncStartedAt: true } },
            },
          });
      const finishedAt = shouldRetry
        ? null
        : new Date(
            Math.max(
              Date.now(),
              (runClockFloor?.startedAt?.getTime() ?? 0) + 1,
              (runClockFloor?.integration.lastSyncStartedAt?.getTime() ?? 0) + 1,
            ),
          );
      const updated = await transaction.directorySyncRun.updateMany({
        where: {
          id: claim.id,
          tenantId: claim.tenantId,
          status: 'RUNNING',
          leaseOwner: claim.workerId,
        },
        data: {
          status,
          leaseOwner: null,
          leaseExpiresAt: null,
          nextAttemptAt: retryAt ?? new Date(),
          lastErrorCode: described.code,
          finishedAt,
        },
      });
      if (updated.count !== 1) return;
      await transaction.directoryIntegration.updateMany({
        where: {
          id: claim.integrationId,
          tenantId: claim.tenantId,
          status: 'RUNNING',
          leaseOwner: claim.workerId,
        },
        data: {
          status: shouldRetry ? 'IDLE' : 'FAILED',
          leaseOwner: null,
          leaseExpiresAt: null,
          ...(shouldRetry ? {} : { lastSyncFinishedAt: finishedAt }),
          lastErrorCode: described.code,
          version: { increment: 1 },
        },
      });
      await transaction.directorySyncPreviewItem.updateMany({
        where: {
          tenantId: claim.tenantId,
          previewId: claim.previewId,
          applyStatus: 'PENDING',
        },
        data: shouldRetry
          ? { diagnosticCode: described.code }
          : { applyStatus: 'FAILED', diagnosticCode: described.code },
      });
    });
  }

  private async claim(principal: AdminPrincipal): Promise<ClaimedSync> {
    const startedAt = new Date();
    const leaseOwner = randomUUID();
    const leaseExpiresAt = new Date(startedAt.getTime() + this.leaseMs);

    return this.prisma.withTenant(principal.tenantId, async (transaction) => {
      const organization = await transaction.organization.findFirstOrThrow({
        where: { tenantId: principal.tenantId },
        orderBy: { createdAt: 'asc' },
        select: { id: true, name: true, externalKey: true },
      });
      let integration = await transaction.directoryIntegration.findFirst({
        where: { tenantId: principal.tenantId, provider: 'FEISHU' },
      });
      const connection = this.resolveConnection(organization.externalKey, integration);
      if (connection === null) {
        throw new BadRequestException('飞书组织同步尚未配置，或配置未绑定到当前租户。');
      }
      if (
        integration !== null &&
        integration.connectorFingerprint !== null &&
        integration.connectorFingerprint !== connection.fingerprint
      ) {
        throw new ConflictException(
          '飞书 App ID 与现有目录绑定不一致。为避免覆盖其他企业数据，已拒绝同步。',
        );
      }
      if (
        integration !== null &&
        integration.status === 'RUNNING' &&
        integration.leaseExpiresAt !== null &&
        integration.leaseExpiresAt > startedAt
      ) {
        throw new ConflictException('飞书组织同步正在执行，请等待当前任务完成。');
      }

      if (integration === null) {
        integration = await transaction.directoryIntegration.create({
          data: {
            tenantId: principal.tenantId,
            organizationId: organization.id,
            provider: 'FEISHU',
            connectorFingerprint: connection.fingerprint,
            status: 'RUNNING',
            leaseOwner,
            leaseExpiresAt,
            lastSyncStartedAt: startedAt,
          },
        });
      } else {
        const claimed = await transaction.directoryIntegration.updateMany({
          where: {
            id: integration.id,
            tenantId: principal.tenantId,
            version: integration.version,
          },
          data: {
            organizationId: organization.id,
            connectorFingerprint: connection.fingerprint,
            status: 'RUNNING',
            leaseOwner,
            leaseExpiresAt,
            lastSyncStartedAt: startedAt,
            lastSyncFinishedAt: null,
            lastErrorCode: null,
            lastSummary: Prisma.JsonNull,
            version: { increment: 1 },
          },
        });
        if (claimed.count !== 1) {
          throw new ConflictException('飞书组织同步状态已变化，请刷新后重试。');
        }
        integration = await transaction.directoryIntegration.findFirstOrThrow({
          where: { id: integration.id, tenantId: principal.tenantId },
        });
      }

      await recordAdminAudit(
        transaction,
        principal,
        'admin.directory.feishu.sync.started',
        'directory_integration',
        integration.id,
        {},
      );

      return {
        principal,
        organizationId: organization.id,
        organizationName: organization.name,
        integrationId: integration.id,
        leaseOwner,
        startedAt,
        previousSuccessfulAt: integration.lastSuccessfulSyncAt,
        client: connection.client,
      };
    });
  }

  private async execute(claim: ClaimedSync): Promise<void> {
    try {
      const snapshot = await claim.client.fetchSnapshot();
      const validated = validateFeishuDirectorySnapshot(snapshot);
      await this.renewLease(claim);
      await this.applySnapshot(claim, validated);
    } catch (error) {
      const code = safeSyncErrorCode(error);
      try {
        await this.recordFailure(claim, code);
      } catch {
        this.logger.error(`Feishu directory sync failure could not be persisted (code=${code}).`);
      }
      this.logger.warn(`Feishu directory sync failed (code=${code}).`);
    }
  }

  private async applySnapshot(
    claim: ClaimedSync,
    snapshot: FeishuDirectorySnapshot,
    durableRun?: {
      readonly runId: string;
      readonly previewId: string;
      readonly cursor: string;
    },
  ): Promise<void> {
    await this.prisma.withTenant(
      claim.principal.tenantId,
      async (transaction) => {
        const integration = await transaction.directoryIntegration.findFirst({
          where: {
            id: claim.integrationId,
            tenantId: claim.principal.tenantId,
            status: 'RUNNING',
            leaseOwner: claim.leaseOwner,
            leaseExpiresAt: { gt: new Date() },
          },
        });
        if (integration === null) throw new SyncLeaseLostError();
        if (durableRun !== undefined) {
          const validPreview = await transaction.directorySyncPreview.count({
            where: {
              id: durableRun.previewId,
              tenantId: claim.principal.tenantId,
              integrationId: claim.integrationId,
              status: 'READY',
              snapshotCursor: durableRun.cursor,
              expiresAt: { gt: new Date() },
            },
          });
          if (validPreview !== 1) {
            throw new DirectorySyncExecutionError('PREVIEW_EXPIRED', false);
          }
        }
        await lockOrganizationDirectory(
          transaction,
          claim.principal.tenantId,
          claim.organizationId,
        );

        const summary = emptyCounters();
        const root = await this.requireLocalRoot(transaction, claim);
        const localDepartmentIds = await this.applyDepartments(
          transaction,
          claim,
          root.id,
          snapshot.departments,
          summary,
        );
        await this.applyUsers(transaction, claim, localDepartmentIds, snapshot.users, summary);
        await this.reconcileMissingDepartments(transaction, claim, summary);

        if (
          summary.departments.created +
            summary.departments.updated +
            summary.departments.archived +
            summary.members.created +
            summary.members.updated +
            summary.members.deactivated >
          0
        ) {
          await transaction.organization.updateMany({
            where: { id: claim.organizationId, tenantId: claim.principal.tenantId },
            data: { version: { increment: 1 } },
          });
        }

        // The database and API hosts can differ slightly in wall-clock time.
        // Never persist a finish timestamp before the database-originated
        // start timestamp (including sub-millisecond precision lost in JS).
        const finishedAt = new Date(Math.max(Date.now(), claim.startedAt.getTime() + 1));
        const completed = await transaction.directoryIntegration.updateMany({
          where: {
            id: claim.integrationId,
            tenantId: claim.principal.tenantId,
            status: 'RUNNING',
            leaseOwner: claim.leaseOwner,
            leaseExpiresAt: { gt: finishedAt },
          },
          data: {
            status: 'SUCCEEDED',
            leaseOwner: null,
            leaseExpiresAt: null,
            lastSyncFinishedAt: finishedAt,
            lastSuccessfulSyncAt: finishedAt,
            lastErrorCode: null,
            lastSummary: summary as unknown as Prisma.InputJsonObject,
            ...(durableRun === undefined ? {} : { lastAppliedCursor: durableRun.cursor }),
            version: { increment: 1 },
          },
        });
        if (completed.count !== 1) throw new SyncLeaseLostError();

        if (durableRun !== undefined) {
          const completedRun = await transaction.directorySyncRun.updateMany({
            where: {
              id: durableRun.runId,
              tenantId: claim.principal.tenantId,
              status: 'RUNNING',
              leaseOwner: claim.leaseOwner,
              leaseExpiresAt: { gt: finishedAt },
            },
            data: {
              status: 'SUCCEEDED',
              leaseOwner: null,
              leaseExpiresAt: null,
              lastErrorCode: null,
              summary: summary as unknown as Prisma.InputJsonObject,
              finishedAt,
            },
          });
          if (completedRun.count !== 1) throw new SyncLeaseLostError();
          await transaction.directorySyncPreview.update({
            where: {
              tenantId_id: { tenantId: claim.principal.tenantId, id: durableRun.previewId },
            },
            data: { status: 'APPLIED', appliedAt: finishedAt },
          });
          await transaction.directorySyncPreviewItem.updateMany({
            where: {
              tenantId: claim.principal.tenantId,
              previewId: durableRun.previewId,
            },
            data: { applyStatus: 'APPLIED', diagnosticCode: null },
          });
          await transaction.directorySyncPreviewItem.updateMany({
            where: {
              tenantId: claim.principal.tenantId,
              previewId: durableRun.previewId,
              action: 'CONFLICT',
            },
            data: { applyStatus: 'FAILED', diagnosticCode: 'LOCAL_DATA_CONFLICT' },
          });
        }

        await recordAdminAudit(
          transaction,
          claim.principal,
          'admin.directory.feishu.sync.succeeded',
          'directory_integration',
          claim.integrationId,
          summary as unknown as Prisma.InputJsonObject,
        );
      },
      { maxWait: 10_000, timeout: APPLY_TRANSACTION_TIMEOUT_MS },
    );
  }

  private async requireLocalRoot(
    transaction: Prisma.TransactionClient,
    claim: ClaimedSync,
  ): Promise<{ readonly id: string }> {
    let root = await transaction.orgUnit.findFirst({
      where: {
        tenantId: claim.principal.tenantId,
        organizationId: claim.organizationId,
        parentId: null,
        status: 'ACTIVE',
      },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      select: { id: true },
    });
    if (root === null) {
      root = await transaction.orgUnit.create({
        data: {
          tenantId: claim.principal.tenantId,
          organizationId: claim.organizationId,
          name: claim.organizationName,
          parentId: null,
          sortOrder: 0,
          status: 'ACTIVE',
        },
        select: { id: true },
      });
    }

    await transaction.directoryOrgUnitBinding.upsert({
      where: {
        tenantId_integrationId_externalDepartmentId: {
          tenantId: claim.principal.tenantId,
          integrationId: claim.integrationId,
          externalDepartmentId: ROOT_DEPARTMENT_ID,
        },
      },
      create: {
        tenantId: claim.principal.tenantId,
        integrationId: claim.integrationId,
        organizationId: claim.organizationId,
        externalDepartmentId: ROOT_DEPARTMENT_ID,
        orgUnitId: root.id,
        lastSeenAt: claim.startedAt,
      },
      update: { orgUnitId: root.id, lastSeenAt: claim.startedAt, missingSinceAt: null },
    });
    return root;
  }

  private async applyDepartments(
    transaction: Prisma.TransactionClient,
    claim: ClaimedSync,
    rootOrgUnitId: string,
    departments: readonly FeishuDirectoryDepartment[],
    summary: SyncCounters,
  ): Promise<Map<string, string>> {
    const bindings = await transaction.directoryOrgUnitBinding.findMany({
      where: {
        tenantId: claim.principal.tenantId,
        integrationId: claim.integrationId,
      },
      include: { orgUnit: true },
    });
    const byExternalId = new Map(
      bindings.map((binding) => [binding.externalDepartmentId, binding]),
    );
    const localIds = new Map<string, string>([[ROOT_DEPARTMENT_ID, rootOrgUnitId]]);

    for (const department of departments) {
      const parentExternalId = department.parentExternalId ?? ROOT_DEPARTMENT_ID;
      const parentId = localIds.get(parentExternalId);
      if (parentId === undefined) throw new InvalidFeishuSnapshotError('DEPARTMENT_PARENT_MISSING');

      const binding = byExternalId.get(department.externalId);
      if (binding === undefined) {
        const sortOrder = department.sortOrder ?? 0;
        const unit = await transaction.orgUnit.create({
          data: {
            tenantId: claim.principal.tenantId,
            organizationId: claim.organizationId,
            parentId,
            name: department.name,
            sortOrder,
            status: 'ACTIVE',
          },
          select: { id: true },
        });
        await transaction.directoryOrgUnitBinding.create({
          data: {
            tenantId: claim.principal.tenantId,
            integrationId: claim.integrationId,
            organizationId: claim.organizationId,
            externalDepartmentId: department.externalId,
            orgUnitId: unit.id,
            lastSeenAt: claim.startedAt,
          },
        });
        localIds.set(department.externalId, unit.id);
        summary.departments.created += 1;
        continue;
      }

      const sortOrder = department.sortOrder ?? binding.orgUnit.sortOrder;
      const changed =
        binding.orgUnit.name !== department.name ||
        binding.orgUnit.parentId !== parentId ||
        binding.orgUnit.sortOrder !== sortOrder ||
        binding.orgUnit.status !== 'ACTIVE';
      if (changed) {
        await transaction.orgUnit.update({
          where: { id: binding.orgUnitId },
          data: {
            name: department.name,
            parentId,
            sortOrder,
            status: 'ACTIVE',
            version: { increment: 1 },
          },
        });
        summary.departments.updated += 1;
      } else {
        summary.departments.unchanged += 1;
      }
      await transaction.directoryOrgUnitBinding.update({
        where: { id: binding.id },
        data: { lastSeenAt: claim.startedAt, missingSinceAt: null },
      });
      localIds.set(department.externalId, binding.orgUnitId);
    }
    return localIds;
  }

  private async applyUsers(
    transaction: Prisma.TransactionClient,
    claim: ClaimedSync,
    departmentIds: ReadonlyMap<string, string>,
    users: readonly FeishuDirectoryUser[],
    summary: SyncCounters,
  ): Promise<void> {
    const [userBindings, employmentBindings, agentPlan] = await Promise.all([
      transaction.directoryUserBinding.findMany({
        where: {
          tenantId: claim.principal.tenantId,
          integrationId: claim.integrationId,
        },
        include: {
          user: true,
        },
      }),
      transaction.directoryEmploymentBinding.findMany({
        where: {
          tenantId: claim.principal.tenantId,
          integrationId: claim.integrationId,
        },
        include: { employment: { include: { position: true } } },
      }),
      this.personalAgents.prepare(transaction, {
        tenantId: claim.principal.tenantId,
        actorUserId: claim.principal.userId,
      }),
    ]);
    const usersByExternalId = new Map(
      userBindings.map((binding) => [binding.externalUserId, binding]),
    );
    const employmentsByExternalKey = new Map(
      employmentBindings.map((binding) => [
        membershipKey(binding.externalUserId, binding.externalDepartmentId),
        binding,
      ]),
    );
    const employmentBindingsByUser = new Map<string, Array<(typeof employmentBindings)[number]>>();
    for (const binding of employmentBindings) {
      const owned = employmentBindingsByUser.get(binding.externalUserId) ?? [];
      owned.push(binding);
      employmentBindingsByUser.set(binding.externalUserId, owned);
    }
    const seenUsers = new Set<string>();
    const seenMemberships = new Set<string>();
    const memberWasUpdated = new Map<string, boolean>();
    const reconciledUsers = new Set<string>();

    for (const remote of users) {
      seenUsers.add(remote.externalId);
      const binding = usersByExternalId.get(remote.externalId);
      const remoteMayDeactivateAccount = binding === undefined || binding.user.role !== 'OWNER';
      const desiredUserStatus =
        binding?.user.status === 'LOCKED'
          ? 'LOCKED'
          : remote.active
            ? 'ACTIVE'
            : remoteMayDeactivateAccount
              ? 'INACTIVE'
              : (binding?.user.status ?? 'ACTIVE');
      const desiredAvatarUrl =
        remote.avatarUrl === undefined ? (binding?.user.avatarUrl ?? null) : remote.avatarUrl;
      const desiredOpenId = remote.openId === undefined ? (binding?.openId ?? null) : remote.openId;
      const desiredUnionId =
        remote.unionId === undefined ? (binding?.unionId ?? null) : remote.unionId;
      let localUserId: string;
      let memberChanged = false;

      if (binding === undefined) {
        const placeholderEmail = placeholderEmailFor(claim.principal.tenantId, remote.externalId);
        const user = await transaction.user.create({
          data: {
            tenantId: claim.principal.tenantId,
            email: placeholderEmail,
            emailNormalized: placeholderEmail,
            displayName: remote.name,
            avatarUrl: desiredAvatarUrl,
            status: desiredUserStatus,
            role: 'MEMBER',
          },
          select: { id: true },
        });
        localUserId = user.id;
        await transaction.directoryUserBinding.create({
          data: {
            tenantId: claim.principal.tenantId,
            integrationId: claim.integrationId,
            externalUserId: remote.externalId,
            userId: localUserId,
            openId: desiredOpenId,
            unionId: desiredUnionId,
            lastSeenAt: claim.startedAt,
          },
        });
        summary.members.created += 1;
        memberChanged = true;
      } else {
        localUserId = binding.userId;
        memberChanged =
          binding.user.displayName !== remote.name ||
          binding.user.avatarUrl !== desiredAvatarUrl ||
          binding.user.status !== desiredUserStatus ||
          binding.openId !== desiredOpenId ||
          binding.unionId !== desiredUnionId;
        if (binding.user.status === 'ACTIVE' && desiredUserStatus !== 'ACTIVE') {
          summary.members.deactivated += 1;
        }
        await transaction.user.update({
          where: { id: localUserId },
          data: {
            displayName: remote.name,
            avatarUrl: desiredAvatarUrl,
            status: desiredUserStatus,
          },
        });
        await transaction.directoryUserBinding.update({
          where: { id: binding.id },
          data: {
            openId: desiredOpenId,
            unionId: desiredUnionId,
            lastSeenAt: claim.startedAt,
            missingSinceAt: null,
          },
        });
      }

      await this.personalAgents.reconcileMember(transaction, agentPlan, {
        userId: localUserId,
        displayName: remote.name,
        active: remote.active,
      });

      if (desiredUserStatus !== 'ACTIVE' && remoteMayDeactivateAccount) {
        const revokedAt = new Date();
        await transaction.authSession.updateMany({
          where: {
            tenantId: claim.principal.tenantId,
            userId: localUserId,
            revokedAt: null,
          },
          data: { revokedAt },
        });
        await revokeDirectoryRoleAssignments(
          transaction,
          claim,
          localUserId,
          'DIRECTORY_ACCOUNT_DEACTIVATED',
          revokedAt,
        );
      }

      const remoteDepartmentIds =
        remote.departmentExternalIds.length === 0
          ? [ROOT_DEPARTMENT_ID]
          : [...new Set(remote.departmentExternalIds)];
      const primaryExternalId =
        remote.primaryDepartmentExternalId !== undefined &&
        remoteDepartmentIds.includes(remote.primaryDepartmentExternalId)
          ? remote.primaryDepartmentExternalId
          : (remoteDepartmentIds[0] ?? ROOT_DEPARTMENT_ID);
      const primaryOrgUnitId = departmentIds.get(primaryExternalId);
      if (primaryOrgUnitId === undefined)
        throw new InvalidFeishuSnapshotError('USER_DEPARTMENT_MISSING');

      const ownedEmploymentBindings = employmentBindingsByUser.get(remote.externalId) ?? [];
      const ownedEmploymentIds = ownedEmploymentBindings.map((candidate) => candidate.employmentId);
      const previousPrimaryEmployment = ownedEmploymentBindings.find(
        (candidate) => candidate.employment.isPrimary,
      )?.employment;
      if (ownedEmploymentIds.length > 0) {
        await transaction.employment.updateMany({
          where: { id: { in: ownedEmploymentIds }, tenantId: claim.principal.tenantId },
          data: { isPrimary: false, employeeNumber: null },
        });
      }

      const positionId = await this.upsertRemotePosition(
        transaction,
        claim,
        remote,
        localUserId,
        primaryOrgUnitId,
        previousPrimaryEmployment?.positionId ?? null,
      );
      const remoteWorkEmail =
        remote.email === undefined ? undefined : normalizeWorkEmail(remote.email);
      const employeeNumber = await this.availableEmployeeNumber(
        transaction,
        claim.principal.tenantId,
        localUserId,
        remote.employeeNumber ?? previousPrimaryEmployment?.employeeNumber ?? undefined,
      );
      if (remote.employeeNumber !== undefined && employeeNumber === null) {
        summary.conflictCount += 1;
      }

      for (const externalDepartmentId of remoteDepartmentIds) {
        const orgUnitId = departmentIds.get(externalDepartmentId);
        if (orgUnitId === undefined)
          throw new InvalidFeishuSnapshotError('USER_DEPARTMENT_MISSING');
        const key = membershipKey(remote.externalId, externalDepartmentId);
        seenMemberships.add(key);
        const existingBinding = employmentsByExternalKey.get(key);
        const isPrimary = externalDepartmentId === primaryExternalId;
        const desiredEmploymentStatus = remote.active ? 'ACTIVE' : 'SUSPENDED';
        const desiredPositionId = isPrimary ? positionId : null;
        const desiredEmployeeNumber = isPrimary ? employeeNumber : null;

        let employment = existingBinding?.employment;
        if (employment === undefined) {
          employment =
            (await transaction.employment.findUnique({
              where: {
                tenantId_userId_organizationId_orgUnitId: {
                  tenantId: claim.principal.tenantId,
                  userId: localUserId,
                  organizationId: claim.organizationId,
                  orgUnitId,
                },
              },
              include: { position: true },
            })) ?? undefined;
        }
        if (existingBinding === undefined && employment !== undefined) {
          throw new InvalidFeishuSnapshotError('LOCAL_EMPLOYMENT_OWNERSHIP_CONFLICT');
        }
        const desiredWorkEmail =
          remoteWorkEmail === undefined ? (employment?.workEmail ?? null) : remoteWorkEmail;

        if (employment === null || employment === undefined) {
          employment = await transaction.employment.create({
            data: {
              tenantId: claim.principal.tenantId,
              userId: localUserId,
              organizationId: claim.organizationId,
              orgUnitId,
              positionId: desiredPositionId,
              employeeNumber: desiredEmployeeNumber,
              workEmail: desiredWorkEmail,
              status: desiredEmploymentStatus,
              isPrimary,
            },
            include: { position: true },
          });
          memberChanged = true;
        } else {
          const employmentChanged =
            employment.orgUnitId !== orgUnitId ||
            employment.positionId !== desiredPositionId ||
            employment.employeeNumber !== desiredEmployeeNumber ||
            employment.workEmail !== desiredWorkEmail ||
            employment.status !== desiredEmploymentStatus ||
            employment.isPrimary !== isPrimary;
          // Primary flags and employee numbers are cleared before membership
          // reconciliation so a moved primary department cannot violate the
          // partial unique index. Always restore the desired primary row even
          // when the pre-clear snapshot already matched it.
          if (employmentChanged || isPrimary) {
            employment = await transaction.employment.update({
              where: { id: employment.id },
              data: {
                orgUnitId,
                positionId: desiredPositionId,
                employeeNumber: desiredEmployeeNumber,
                workEmail: desiredWorkEmail,
                status: desiredEmploymentStatus,
                isPrimary,
              },
              include: { position: true },
            });
            if (employmentChanged) memberChanged = true;
          }
        }

        if (existingBinding === undefined) {
          await transaction.directoryEmploymentBinding.create({
            data: {
              tenantId: claim.principal.tenantId,
              integrationId: claim.integrationId,
              externalUserId: remote.externalId,
              externalDepartmentId,
              employmentId: employment.id,
              userId: localUserId,
              organizationId: claim.organizationId,
              orgUnitId,
              lastSeenAt: claim.startedAt,
            },
          });
        } else {
          await transaction.directoryEmploymentBinding.update({
            where: { id: existingBinding.id },
            data: {
              employmentId: employment.id,
              userId: localUserId,
              organizationId: claim.organizationId,
              orgUnitId,
              lastSeenAt: claim.startedAt,
              missingSinceAt: null,
            },
          });
        }
      }

      if (binding !== undefined) {
        if (memberChanged) summary.members.updated += 1;
        else summary.members.unchanged += 1;
        memberWasUpdated.set(remote.externalId, memberChanged);
      }
    }

    const potentiallyDeactivated = new Set<string>();
    for (const binding of employmentBindings) {
      const key = membershipKey(binding.externalUserId, binding.externalDepartmentId);
      if (seenMemberships.has(key)) continue;
      if (binding.missingSinceAt === null) {
        await transaction.directoryEmploymentBinding.update({
          where: { id: binding.id },
          data: { missingSinceAt: claim.startedAt },
        });
        continue;
      }
      if (!this.reconcileRemovals || !removalConfirmed(binding.missingSinceAt, claim.startedAt)) {
        continue;
      }
      const terminated = await transaction.employment.updateMany({
        where: {
          id: binding.employmentId,
          tenantId: claim.principal.tenantId,
          status: { not: 'TERMINATED' },
        },
        data: { status: 'TERMINATED', isPrimary: false, employeeNumber: null },
      });
      if (terminated.count > 0 && seenUsers.has(binding.externalUserId)) {
        await revokeDirectoryRoleAssignments(
          transaction,
          claim,
          binding.userId,
          'DIRECTORY_EMPLOYMENT_CHANGED',
          new Date(),
          binding.employmentId,
        );
      }
      if (
        terminated.count > 0 &&
        binding.employment.position?.code.startsWith('FEISHU_MEMBER_') === true
      ) {
        const activePositionUses = await transaction.employment.count({
          where: {
            tenantId: claim.principal.tenantId,
            positionId: binding.employment.position.id,
            status: { not: 'TERMINATED' },
          },
        });
        if (activePositionUses === 0) {
          await transaction.position.update({
            where: { id: binding.employment.position.id },
            data: { orgUnitId: null },
          });
        }
      }
      if (terminated.count > 0 && !reconciledUsers.has(binding.externalUserId)) {
        const wasUpdated = memberWasUpdated.get(binding.externalUserId);
        if (wasUpdated === false) summary.members.unchanged -= 1;
        if (wasUpdated !== true) summary.members.updated += 1;
        memberWasUpdated.set(binding.externalUserId, true);
        reconciledUsers.add(binding.externalUserId);
      }
      potentiallyDeactivated.add(binding.externalUserId);
    }

    for (const binding of userBindings) {
      if (seenUsers.has(binding.externalUserId)) continue;
      if (binding.missingSinceAt === null) {
        await transaction.directoryUserBinding.update({
          where: { id: binding.id },
          data: { missingSinceAt: claim.startedAt },
        });
        continue;
      }
      if (!this.reconcileRemovals || !removalConfirmed(binding.missingSinceAt, claim.startedAt)) {
        continue;
      }
      potentiallyDeactivated.add(binding.externalUserId);
    }

    for (const externalUserId of potentiallyDeactivated) {
      const binding = usersByExternalId.get(externalUserId);
      if (binding === undefined) continue;
      if (binding.user.role === 'OWNER') continue;
      const activeEmployments = await transaction.employment.count({
        where: {
          tenantId: claim.principal.tenantId,
          userId: binding.userId,
          status: { in: ['ACTIVE', 'PENDING'] },
        },
      });
      if (activeEmployments > 0 || binding.user.status !== 'ACTIVE') continue;
      await transaction.user.update({
        where: { id: binding.userId },
        data: { status: 'INACTIVE' },
      });
      const revokedAt = new Date();
      await transaction.authSession.updateMany({
        where: {
          tenantId: claim.principal.tenantId,
          userId: binding.userId,
          revokedAt: null,
        },
        data: { revokedAt },
      });
      await revokeDirectoryRoleAssignments(
        transaction,
        claim,
        binding.userId,
        'DIRECTORY_ACCOUNT_REMOVED',
        revokedAt,
      );
      summary.members.deactivated += 1;
    }
  }

  private async reconcileMissingDepartments(
    transaction: Prisma.TransactionClient,
    claim: ClaimedSync,
    summary: SyncCounters,
  ): Promise<void> {
    const [staleBindings, units] = await Promise.all([
      transaction.directoryOrgUnitBinding.findMany({
        where: {
          tenantId: claim.principal.tenantId,
          integrationId: claim.integrationId,
          externalDepartmentId: { not: ROOT_DEPARTMENT_ID },
          lastSeenAt: { lt: claim.startedAt },
        },
        include: { orgUnit: true },
      }),
      transaction.orgUnit.findMany({
        where: {
          tenantId: claim.principal.tenantId,
          organizationId: claim.organizationId,
        },
        select: { id: true, parentId: true },
      }),
    ]);
    const parentById = new Map(units.map((unit) => [unit.id, unit.parentId]));
    staleBindings.sort(
      (left, right) =>
        orgUnitDepth(right.orgUnitId, parentById) - orgUnitDepth(left.orgUnitId, parentById),
    );

    for (const binding of staleBindings) {
      if (binding.orgUnit.status === 'ARCHIVED') continue;
      if (binding.missingSinceAt === null) {
        await transaction.directoryOrgUnitBinding.update({
          where: { id: binding.id },
          data: { missingSinceAt: claim.startedAt },
        });
        continue;
      }
      if (!this.reconcileRemovals || !removalConfirmed(binding.missingSinceAt, claim.startedAt)) {
        continue;
      }
      const [activeChildren, activeEmployments, positions, knowledgeScopes] = await Promise.all([
        transaction.orgUnit.count({
          where: {
            tenantId: claim.principal.tenantId,
            organizationId: claim.organizationId,
            parentId: binding.orgUnitId,
            status: 'ACTIVE',
          },
        }),
        transaction.employment.count({
          where: {
            tenantId: claim.principal.tenantId,
            organizationId: claim.organizationId,
            orgUnitId: binding.orgUnitId,
            status: { not: 'TERMINATED' },
          },
        }),
        transaction.position.count({
          where: {
            tenantId: claim.principal.tenantId,
            organizationId: claim.organizationId,
            orgUnitId: binding.orgUnitId,
          },
        }),
        transaction.knowledgeBaseOrgUnit.count({
          where: {
            tenantId: claim.principal.tenantId,
            orgUnitId: binding.orgUnitId,
          },
        }),
      ]);
      if (activeChildren + activeEmployments + positions + knowledgeScopes > 0) {
        summary.conflictCount += 1;
        continue;
      }
      await transaction.orgUnit.update({
        where: { id: binding.orgUnitId },
        data: { status: 'ARCHIVED', version: { increment: 1 } },
      });
      summary.departments.archived += 1;
    }
  }

  private async upsertRemotePosition(
    transaction: Prisma.TransactionClient,
    claim: ClaimedSync,
    remote: FeishuDirectoryUser,
    localUserId: string,
    orgUnitId: string,
    existingPositionId: string | null,
  ): Promise<string | null> {
    const title = remote.jobTitle?.trim();
    if (title === undefined || title.length === 0) {
      if (existingPositionId !== null) {
        await transaction.position.updateMany({
          where: {
            id: existingPositionId,
            tenantId: claim.principal.tenantId,
            organizationId: claim.organizationId,
          },
          data: { orgUnitId },
        });
      }
      return existingPositionId;
    }
    const code = `FEISHU_MEMBER_${stableHash(localUserId, 48)}`;
    const position = await transaction.position.upsert({
      where: { tenantId_code: { tenantId: claim.principal.tenantId, code } },
      create: {
        tenantId: claim.principal.tenantId,
        organizationId: claim.organizationId,
        orgUnitId,
        code,
        name: title,
      },
      update: { orgUnitId, name: title },
      select: { id: true },
    });
    return position.id;
  }

  private async availableEmployeeNumber(
    transaction: Prisma.TransactionClient,
    tenantId: string,
    userId: string,
    candidate: string | undefined,
  ): Promise<string | null> {
    const normalized = candidate?.trim();
    if (normalized === undefined || normalized.length === 0) return null;
    const conflict = await transaction.employment.findFirst({
      where: { tenantId, employeeNumber: normalized, userId: { not: userId } },
      select: { id: true },
    });
    return conflict === null ? normalized : null;
  }

  private async recordFailure(claim: ClaimedSync, code: string): Promise<void> {
    await this.prisma.withTenant(claim.principal.tenantId, async (transaction) => {
      const failed = await transaction.directoryIntegration.updateMany({
        where: {
          id: claim.integrationId,
          tenantId: claim.principal.tenantId,
          status: 'RUNNING',
          leaseOwner: claim.leaseOwner,
        },
        data: {
          status: 'FAILED',
          leaseOwner: null,
          leaseExpiresAt: null,
          lastSyncFinishedAt: new Date(Math.max(Date.now(), claim.startedAt.getTime() + 1)),
          lastErrorCode: code,
          lastSummary: emptyCounters() as unknown as Prisma.InputJsonObject,
          version: { increment: 1 },
        },
      });
      if (failed.count === 0) return;
      await recordAdminAudit(
        transaction,
        claim.principal,
        'admin.directory.feishu.sync.failed',
        'directory_integration',
        claim.integrationId,
        { errorCode: code },
      );
    });
  }

  private async renewLease(claim: ClaimedSync): Promise<void> {
    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + this.leaseMs);
    const renewed = await this.prisma.withTenant(claim.principal.tenantId, (transaction) =>
      transaction.directoryIntegration.updateMany({
        where: {
          id: claim.integrationId,
          tenantId: claim.principal.tenantId,
          status: 'RUNNING',
          leaseOwner: claim.leaseOwner,
          leaseExpiresAt: { gt: now },
        },
        data: { leaseExpiresAt },
      }),
    );
    if (renewed.count !== 1) throw new SyncLeaseLostError();
  }

  private resolveConnection(
    organizationExternalKey: string | null,
    integration: Prisma.DirectoryIntegrationGetPayload<Record<string, never>> | null,
  ): FeishuConnection | null {
    if (integration?.connectorAppId && integration.connectorSecret) {
      try {
        const appSecret = this.vault.decrypt(integration.connectorSecret, {
          tenantId: integration.tenantId,
          appId: integration.connectorAppId,
        });
        return {
          source: 'ADMIN',
          appId: integration.connectorAppId,
          fingerprint: fingerprintFor(integration.connectorAppId),
          client: this.createClient(
            integration.connectorAppId,
            appSecret,
            organizationExternalKey ?? integration.tenantId,
          ),
        };
      } catch {
        return null;
      }
    }
    if (
      this.environmentAppId &&
      this.environmentAppSecret &&
      this.environmentTenantSlug &&
      this.feishu.isConfiguredForTenant(organizationExternalKey ?? '')
    ) {
      return {
        source: 'ENVIRONMENT',
        appId: this.environmentAppId,
        fingerprint: fingerprintFor(this.environmentAppId),
        client: this.feishu,
      };
    }
    return null;
  }

  private createClient(
    appId: string,
    appSecret: string,
    tenantSlug: string,
  ): FeishuDirectoryClient {
    return new FeishuDirectoryClient({
      enabled: true,
      appId,
      appSecret,
      tenantSlug,
      apiBaseUrl: this.apiBaseUrl,
      requestTimeoutMs: this.httpTimeoutMs,
    });
  }
}

class SyncLeaseLostError extends Error {
  constructor() {
    super('SYNC_LEASE_LOST');
    this.name = 'SyncLeaseLostError';
  }
}

function removalConfirmed(missingSinceAt: Date, now: Date): boolean {
  return now.getTime() - missingSinceAt.getTime() >= REMOVAL_CONFIRMATION_DELAY_MS;
}

function orgUnitDepth(orgUnitId: string, parentById: ReadonlyMap<string, string | null>): number {
  let depth = 0;
  let current = parentById.get(orgUnitId);
  const visited = new Set<string>([orgUnitId]);
  while (current !== null && current !== undefined && !visited.has(current)) {
    visited.add(current);
    depth += 1;
    current = parentById.get(current);
  }
  return depth;
}

function placeholderEmailFor(tenantId: string, externalUserId: string): string {
  return `feishu-${stableHash(`${tenantId}:${externalUserId}`, 32)}@external.invalid`;
}

function stableHash(value: string, length: number): string {
  return createHash('sha256').update(value).digest('hex').slice(0, length);
}

function membershipKey(externalUserId: string, externalDepartmentId: string): string {
  return `${externalUserId}\u0000${externalDepartmentId}`;
}

function normalizeWorkEmail(value: string | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  if (
    normalized === undefined ||
    normalized.length === 0 ||
    normalized.length > 320 ||
    !adminMemberSchema.shape.email.safeParse(normalized).success
  ) {
    return null;
  }
  return normalized;
}

function emptyCounters(): SyncCounters {
  return {
    departments: { created: 0, updated: 0, archived: 0, unchanged: 0, failed: 0 },
    members: { created: 0, updated: 0, deactivated: 0, unchanged: 0, failed: 0 },
    conflictCount: 0,
  };
}

function safeSyncErrorCode(error: unknown): string {
  if (error instanceof FeishuDirectoryError) return truncateErrorCode(error.code);
  if (error instanceof InvalidFeishuSnapshotError) return truncateErrorCode(error.code);
  if (error instanceof SyncLeaseLostError) return 'SYNC_LEASE_LOST';
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return error.code === 'P2002' ? 'LOCAL_DATA_CONFLICT' : 'DATABASE_ERROR';
  }
  return 'SYNC_FAILED';
}

function truncateErrorCode(value: string): string {
  return /^[A-Z0-9_-]{1,120}$/i.test(value) ? value : 'FEISHU_API_ERROR';
}

function safeErrorMessage(code: string | null): string | null {
  if (code === null) return null;
  if (code === 'FEISHU_REQUIRED_FIELD_MISSING') {
    return '飞书应用已绑定，但通讯录字段权限不完整。请在飞书开放平台开通部门名称、用户基本信息与组织架构只读权限，并将应用通讯录数据范围设为全部成员后重新同步。';
  }
  if (code === 'LOCAL_DATA_CONFLICT') return '本地目录存在唯一键冲突，请检查成员工号。';
  if (code === 'SYNC_LEASE_LOST') return '同步执行权已过期，请重新发起同步。';
  if (code === 'LOCAL_EMPLOYMENT_OWNERSHIP_CONFLICT') {
    return 'The Feishu member conflicts with an existing locally owned employment. Local data was not claimed.';
  }
  if (code.startsWith('DEPARTMENT_') || code.startsWith('USER_')) {
    return '飞书返回的组织数据不完整或不合法，本地目录未发生变化。';
  }
  if (code === 'DATABASE_ERROR') return '保存组织目录失败，本地目录未发生变化。';
  return '飞书通讯录拉取失败，请检查应用权限、数据范围或稍后重试。';
}

function mapStatus(
  organizationName: string,
  integration: Prisma.DirectoryIntegrationGetPayload<Record<string, never>> | null,
): FeishuOrganizationSyncStatus {
  if (integration === null || integration.status === 'IDLE') {
    return {
      status: 'READY',
      tenantName: organizationName,
      lastSuccessfulAt: integration?.lastSuccessfulSyncAt?.toISOString() ?? null,
      run: null,
    };
  }

  const leaseExpired =
    integration.status === 'RUNNING' &&
    integration.leaseExpiresAt !== null &&
    integration.leaseExpiresAt <= new Date();
  const status = leaseExpired ? 'FAILED' : integration.status;
  const summary = parseCounters(integration.lastSummary);
  return {
    status,
    tenantName: organizationName,
    lastSuccessfulAt: integration.lastSuccessfulSyncAt?.toISOString() ?? null,
    run: {
      id: integration.id,
      status,
      startedAt:
        integration.lastSyncStartedAt?.toISOString() ?? integration.createdAt.toISOString(),
      finishedAt: integration.lastSyncFinishedAt?.toISOString() ?? null,
      departments: summary.departments,
      members: summary.members,
      conflictCount: summary.conflictCount,
      errorMessage: leaseExpired
        ? '上次同步任务已超时，可以重新发起同步。'
        : status === 'FAILED'
          ? safeErrorMessage(integration.lastErrorCode)
          : null,
    },
  };
}

function runningStatus(claim: ClaimedSync): FeishuOrganizationSyncStatus {
  const summary = emptyCounters();
  return {
    status: 'RUNNING',
    tenantName: claim.organizationName,
    lastSuccessfulAt: claim.previousSuccessfulAt?.toISOString() ?? null,
    run: {
      id: claim.integrationId,
      status: 'RUNNING',
      startedAt: claim.startedAt.toISOString(),
      finishedAt: null,
      departments: summary.departments,
      members: summary.members,
      conflictCount: 0,
      errorMessage: null,
    },
  };
}

function notConfiguredStatus(organizationName: string): FeishuOrganizationSyncStatus {
  return {
    status: 'NOT_CONFIGURED',
    tenantName: organizationName,
    lastSuccessfulAt: null,
    run: null,
  };
}

function fingerprintFor(appId: string): string {
  return createHash('sha256').update(appId).digest('hex');
}

function maskAppId(appId: string): string {
  if (appId.length <= 10) return `${appId.slice(0, 4)}…`;
  return `${appId.slice(0, 7)}…${appId.slice(-4)}`;
}

function withConnection(
  status: FeishuOrganizationSyncStatus,
  connection: FeishuConnection,
): FeishuOrganizationSyncStatus {
  return {
    ...status,
    connectionSource: connection.source,
    appIdMasked: maskAppId(connection.appId),
  };
}

function connectorMismatchStatus(
  organizationName: string,
  integration: Prisma.DirectoryIntegrationGetPayload<Record<string, never>>,
): FeishuOrganizationSyncStatus {
  const summary = parseCounters(integration.lastSummary);
  return {
    status: 'FAILED',
    tenantName: organizationName,
    lastSuccessfulAt: integration.lastSuccessfulSyncAt?.toISOString() ?? null,
    run: {
      id: integration.id,
      status: 'FAILED',
      startedAt:
        integration.lastSyncStartedAt?.toISOString() ?? integration.createdAt.toISOString(),
      finishedAt: integration.lastSyncFinishedAt?.toISOString() ?? null,
      departments: summary.departments,
      members: summary.members,
      conflictCount: summary.conflictCount,
      errorMessage: '飞书 App ID 与现有目录绑定不一致，已阻止同步以避免覆盖其他企业数据。',
    },
  };
}

function parseCounters(value: Prisma.JsonValue | null): SyncCounters {
  const fallback = emptyCounters();
  if (!isObject(value)) return fallback;
  const departments = isObject(value.departments) ? value.departments : {};
  const members = isObject(value.members) ? value.members : {};
  return {
    departments: {
      created: countValue(departments.created),
      updated: countValue(departments.updated),
      archived: countValue(departments.archived),
      unchanged: countValue(departments.unchanged),
      failed: countValue(departments.failed),
    },
    members: {
      created: countValue(members.created),
      updated: countValue(members.updated),
      deactivated: countValue(members.deactivated),
      unchanged: countValue(members.unchanged),
      failed: countValue(members.failed),
    },
    conflictCount: countValue(value.conflictCount),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function countValue(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

export async function revokeDirectoryRoleAssignments(
  transaction: Prisma.TransactionClient,
  claim: ClaimedSync,
  userId: string,
  reason:
    'DIRECTORY_ACCOUNT_DEACTIVATED' | 'DIRECTORY_ACCOUNT_REMOVED' | 'DIRECTORY_EMPLOYMENT_CHANGED',
  revokedAt: Date,
  employmentId?: string,
): Promise<void> {
  const assignments = await transaction.roleAssignment.findMany({
    where: {
      tenantId: claim.principal.tenantId,
      userId,
      ...(employmentId === undefined ? {} : { employmentId }),
      status: { in: ['PENDING', 'ACTIVE', 'SUSPENDED'] },
    },
    select: {
      id: true,
      status: true,
      version: true,
      agentInstanceId: true,
    },
  });
  for (const assignment of assignments) {
    const transitioned = await transaction.roleAssignment.updateMany({
      where: {
        id: assignment.id,
        tenantId: claim.principal.tenantId,
        status: assignment.status,
        version: assignment.version,
      },
      data: {
        status: 'REVOKED',
        revokedAt,
        revokedById: claim.principal.userId,
        revokeReason: reason,
        version: { increment: 1 },
        updatedAt: revokedAt,
      },
    });
    if (transitioned.count !== 1) continue;
    await cancelAssignedAgentRuns(
      transaction,
      claim.principal.tenantId,
      assignment.id,
      assignment.agentInstanceId,
      userId,
      revokedAt,
      {
        errorCode: reason,
        errorMessage: 'Directory authority revoked this role assignment.',
      },
    );
    await disableAgentInstanceWithoutEffectiveAssignments(
      transaction,
      claim.principal.tenantId,
      assignment.id,
      assignment.agentInstanceId,
      revokedAt,
    );
    await cascadeAssignmentDescendants(
      transaction,
      claim.principal.tenantId,
      assignment.id,
      'REVOKED',
      revokedAt,
      {
        revokedById: claim.principal.userId,
        reason: `Directory authority revoked source assignment ${assignment.id}.`,
        errorCode: 'ROLE_ASSIGNMENT_SOURCE_DIRECTORY_REVOKED',
        errorMessage: 'The source role assignment was revoked by directory synchronization.',
      },
    );
    await recordAdminAudit(
      transaction,
      claim.principal,
      'admin.directory.feishu.role_assignment.revoked',
      'role_assignment',
      assignment.id,
      {
        userId,
        employmentId: employmentId ?? null,
        reason,
      },
    );
  }
}

interface DirectoryPreviewChange {
  readonly entityType: 'DEPARTMENT' | 'MEMBER';
  readonly action: 'CREATE' | 'UPDATE' | 'ARCHIVE' | 'DEACTIVATE' | 'CONFLICT';
  readonly externalId: string;
  readonly displayName: string;
  readonly localResourceType: 'org_unit' | 'user' | null;
  readonly localResourceId: string | null;
  readonly fieldChanges: Record<string, unknown>;
  readonly diagnosticCode: string | null;
}

export async function buildPreviewChanges(
  transaction: Prisma.TransactionClient,
  input: {
    readonly tenantId: string;
    readonly integrationId: string;
    readonly snapshot: FeishuDirectorySnapshot;
    readonly now: Date;
    readonly reconcileRemovals: boolean;
  },
): Promise<{ readonly changes: readonly DirectoryPreviewChange[]; readonly unchanged: number }> {
  const [departmentBindings, userBindings, employmentBindings] = await Promise.all([
    transaction.directoryOrgUnitBinding.findMany({
      where: { tenantId: input.tenantId, integrationId: input.integrationId },
      include: { orgUnit: true },
    }),
    transaction.directoryUserBinding.findMany({
      where: { tenantId: input.tenantId, integrationId: input.integrationId },
      include: { user: true },
    }),
    transaction.directoryEmploymentBinding.findMany({
      where: { tenantId: input.tenantId, integrationId: input.integrationId },
      include: {
        employment: {
          include: { position: true },
        },
      },
    }),
  ]);
  const changes: DirectoryPreviewChange[] = [];
  let unchanged = 0;
  const departmentsByExternalId = new Map(
    departmentBindings.map((binding) => [binding.externalDepartmentId, binding]),
  );
  const externalDepartmentByLocalId = new Map(
    departmentBindings.map((binding) => [binding.orgUnitId, binding.externalDepartmentId]),
  );
  const seenDepartments = new Set<string>([ROOT_DEPARTMENT_ID]);
  for (const department of input.snapshot.departments) {
    seenDepartments.add(department.externalId);
    const binding = departmentsByExternalId.get(department.externalId);
    if (binding === undefined) {
      changes.push({
        entityType: 'DEPARTMENT',
        action: 'CREATE',
        externalId: department.externalId,
        displayName: department.name,
        localResourceType: null,
        localResourceId: null,
        fieldChanges: {
          name: { before: null, after: department.name },
          parentExternalId: {
            before: null,
            after: department.parentExternalId ?? ROOT_DEPARTMENT_ID,
          },
          sortOrder: { before: null, after: department.sortOrder ?? 0 },
        },
        diagnosticCode: null,
      });
      continue;
    }
    const desiredParent = department.parentExternalId ?? ROOT_DEPARTMENT_ID;
    const currentParent =
      binding.orgUnit.parentId === null
        ? ROOT_DEPARTMENT_ID
        : (externalDepartmentByLocalId.get(binding.orgUnit.parentId) ?? null);
    const fields: Record<string, unknown> = {};
    if (binding.orgUnit.name !== department.name) {
      fields.name = { before: binding.orgUnit.name, after: department.name };
    }
    if (currentParent !== desiredParent) {
      fields.parentExternalId = { before: currentParent, after: desiredParent };
    }
    const desiredSort = department.sortOrder ?? binding.orgUnit.sortOrder;
    if (binding.orgUnit.sortOrder !== desiredSort) {
      fields.sortOrder = { before: binding.orgUnit.sortOrder, after: desiredSort };
    }
    if (binding.orgUnit.status !== 'ACTIVE') {
      fields.status = { before: binding.orgUnit.status, after: 'ACTIVE' };
    }
    if (Object.keys(fields).length === 0) {
      unchanged += 1;
      continue;
    }
    changes.push({
      entityType: 'DEPARTMENT',
      action: 'UPDATE',
      externalId: department.externalId,
      displayName: department.name,
      localResourceType: 'org_unit',
      localResourceId: binding.orgUnitId,
      fieldChanges: fields,
      diagnosticCode: null,
    });
  }
  for (const binding of departmentBindings) {
    if (
      binding.externalDepartmentId === ROOT_DEPARTMENT_ID ||
      seenDepartments.has(binding.externalDepartmentId) ||
      binding.orgUnit.status === 'ARCHIVED'
    ) {
      continue;
    }
    const confirmed =
      binding.missingSinceAt !== null && removalConfirmed(binding.missingSinceAt, input.now);
    changes.push({
      entityType: 'DEPARTMENT',
      action: 'ARCHIVE',
      externalId: binding.externalDepartmentId,
      displayName: binding.orgUnit.name,
      localResourceType: 'org_unit',
      localResourceId: binding.orgUnitId,
      fieldChanges: { status: { before: binding.orgUnit.status, after: 'ARCHIVED' } },
      diagnosticCode:
        input.reconcileRemovals && confirmed ? null : 'TOMBSTONE_CONFIRMATION_REQUIRED',
    });
  }

  const usersByExternalId = new Map(
    userBindings.map((binding) => [binding.externalUserId, binding]),
  );
  const employmentsByExternalUser = new Map<string, Array<(typeof employmentBindings)[number]>>();
  for (const employment of employmentBindings) {
    const records = employmentsByExternalUser.get(employment.externalUserId) ?? [];
    records.push(employment);
    employmentsByExternalUser.set(employment.externalUserId, records);
  }
  const seenUsers = new Set<string>();
  for (const remote of input.snapshot.users) {
    seenUsers.add(remote.externalId);
    const binding = usersByExternalId.get(remote.externalId);
    if (binding === undefined) {
      changes.push({
        entityType: 'MEMBER',
        action: remote.active ? 'CREATE' : 'DEACTIVATE',
        externalId: remote.externalId,
        displayName: remote.name,
        localResourceType: null,
        localResourceId: null,
        fieldChanges: {
          displayName: { before: null, after: remote.name },
          active: { before: null, after: remote.active },
          departments: { before: [], after: remote.departmentExternalIds },
        },
        diagnosticCode: null,
      });
      continue;
    }
    const desiredStatus =
      binding.user.status === 'LOCKED'
        ? 'LOCKED'
        : remote.active
          ? 'ACTIVE'
          : binding.user.role !== 'OWNER'
            ? 'INACTIVE'
            : binding.user.status;
    const fields: Record<string, unknown> = {};
    if (binding.user.displayName !== remote.name) {
      fields.displayName = { before: binding.user.displayName, after: remote.name };
    }
    if (binding.user.status !== desiredStatus) {
      fields.status = { before: binding.user.status, after: desiredStatus };
    }
    if (remote.avatarUrl !== undefined && binding.user.avatarUrl !== remote.avatarUrl) {
      fields.avatarUrl = { before: binding.user.avatarUrl, after: remote.avatarUrl };
    }
    if (binding.openId !== (remote.openId ?? binding.openId)) {
      fields.openId = { before: binding.openId, after: remote.openId ?? null };
    }
    if (binding.unionId !== (remote.unionId ?? binding.unionId)) {
      fields.unionId = { before: binding.unionId, after: remote.unionId ?? null };
    }
    const currentEmployments = (employmentsByExternalUser.get(remote.externalId) ?? []).filter(
      (record) => record.employment.status !== 'TERMINATED',
    );
    const currentDepartmentIds = currentEmployments
      .map((record) => record.externalDepartmentId)
      .sort();
    const remoteDepartmentIds = (
      remote.departmentExternalIds.length === 0
        ? [ROOT_DEPARTMENT_ID]
        : [...new Set(remote.departmentExternalIds)]
    ).sort();
    if (!equalStrings(currentDepartmentIds, remoteDepartmentIds)) {
      fields.departments = { before: currentDepartmentIds, after: remoteDepartmentIds };
    }
    const currentPrimary = currentEmployments.find((record) => record.employment.isPrimary);
    const desiredPrimary =
      remote.primaryDepartmentExternalId !== undefined &&
      remoteDepartmentIds.includes(remote.primaryDepartmentExternalId)
        ? remote.primaryDepartmentExternalId
        : (remoteDepartmentIds[0] ?? ROOT_DEPARTMENT_ID);
    const currentPrimaryDepartmentId = currentPrimary?.externalDepartmentId ?? null;
    if (currentPrimaryDepartmentId !== desiredPrimary) {
      fields.primaryDepartment = {
        before: currentPrimaryDepartmentId,
        after: desiredPrimary,
      };
    }
    if (remote.jobTitle !== undefined) {
      const currentTitle = currentPrimary?.employment.position?.name ?? null;
      const desiredTitle = remote.jobTitle.trim() || null;
      if (currentTitle !== desiredTitle) {
        fields.jobTitle = { before: currentTitle, after: desiredTitle };
      }
    }
    if (remote.email !== undefined) {
      const currentEmail = currentPrimary?.employment.workEmail ?? null;
      const desiredEmail = normalizeWorkEmail(remote.email);
      if (currentEmail !== desiredEmail) {
        fields.workEmail = { before: currentEmail, after: desiredEmail };
      }
    }
    if (remote.employeeNumber !== undefined) {
      const currentEmployeeNumber = currentPrimary?.employment.employeeNumber ?? null;
      const desiredEmployeeNumber = remote.employeeNumber.trim() || null;
      if (currentEmployeeNumber !== desiredEmployeeNumber) {
        fields.employeeNumber = {
          before: currentEmployeeNumber,
          after: desiredEmployeeNumber,
        };
      }
    }
    if (binding.user.role === 'OWNER' && !remote.active) {
      changes.push({
        entityType: 'MEMBER',
        action: 'CONFLICT',
        externalId: remote.externalId,
        displayName: remote.name,
        localResourceType: 'user',
        localResourceId: binding.userId,
        fieldChanges: fields,
        diagnosticCode: 'PROTECTED_OWNER_OFFBOARDING',
      });
      continue;
    }
    if (Object.keys(fields).length === 0) {
      unchanged += 1;
      continue;
    }
    changes.push({
      entityType: 'MEMBER',
      action: desiredStatus === 'INACTIVE' ? 'DEACTIVATE' : 'UPDATE',
      externalId: remote.externalId,
      displayName: remote.name,
      localResourceType: 'user',
      localResourceId: binding.userId,
      fieldChanges: fields,
      diagnosticCode: null,
    });
  }
  for (const binding of userBindings) {
    if (seenUsers.has(binding.externalUserId) || binding.user.status !== 'ACTIVE') continue;
    if (binding.user.role === 'OWNER') {
      changes.push({
        entityType: 'MEMBER',
        action: 'CONFLICT',
        externalId: binding.externalUserId,
        displayName: binding.user.displayName,
        localResourceType: 'user',
        localResourceId: binding.userId,
        fieldChanges: {},
        diagnosticCode: 'PROTECTED_OWNER_OFFBOARDING',
      });
      continue;
    }
    const confirmed =
      binding.missingSinceAt !== null && removalConfirmed(binding.missingSinceAt, input.now);
    changes.push({
      entityType: 'MEMBER',
      action: 'DEACTIVATE',
      externalId: binding.externalUserId,
      displayName: binding.user.displayName,
      localResourceType: 'user',
      localResourceId: binding.userId,
      fieldChanges: { status: { before: 'ACTIVE', after: 'INACTIVE' } },
      diagnosticCode:
        input.reconcileRemovals && confirmed ? null : 'TOMBSTONE_CONFIRMATION_REQUIRED',
    });
  }
  return { changes, unchanged };
}

function equalStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function summarizePreview(
  changes: readonly DirectoryPreviewChange[],
  unchanged: number,
): {
  readonly created: number;
  readonly updated: number;
  readonly archived: number;
  readonly deactivated: number;
  readonly conflicts: number;
  readonly unchanged: number;
} {
  return {
    created: changes.filter((item) => item.action === 'CREATE').length,
    updated: changes.filter((item) => item.action === 'UPDATE').length,
    archived: changes.filter((item) => item.action === 'ARCHIVE').length,
    deactivated: changes.filter((item) => item.action === 'DEACTIVATE').length,
    conflicts: changes.filter((item) => item.action === 'CONFLICT').length,
    unchanged,
  };
}

function snapshotCursor(snapshot: FeishuDirectorySnapshot): string {
  const canonical = {
    departments: [...snapshot.departments]
      .map((item) => ({
        externalId: item.externalId,
        name: item.name,
        parentExternalId: item.parentExternalId ?? null,
        sortOrder: item.sortOrder ?? null,
      }))
      .sort((left, right) => left.externalId.localeCompare(right.externalId)),
    users: [...snapshot.users]
      .map((item) => ({
        externalId: item.externalId,
        openId: item.openId ?? null,
        unionId: item.unionId ?? null,
        name: item.name,
        email: item.email ?? null,
        avatarUrl: item.avatarUrl ?? null,
        active: item.active,
        jobTitle: item.jobTitle ?? null,
        employeeNumber: item.employeeNumber ?? null,
        primaryDepartmentExternalId: item.primaryDepartmentExternalId ?? null,
        departmentExternalIds: [...item.departmentExternalIds].sort(),
      }))
      .sort((left, right) => left.externalId.localeCompare(right.externalId)),
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

type PreviewRecord = {
  readonly id: string;
  readonly status: 'READY' | 'APPLIED' | 'EXPIRED';
  readonly snapshotCursor: string;
  readonly summary: Prisma.JsonValue;
  readonly expiresAt: Date;
  readonly appliedAt: Date | null;
  readonly createdAt: Date;
  readonly items: ReadonlyArray<{
    readonly id: string;
    readonly sequence: number;
    readonly entityType: 'DEPARTMENT' | 'MEMBER';
    readonly action: 'CREATE' | 'UPDATE' | 'ARCHIVE' | 'DEACTIVATE' | 'CONFLICT';
    readonly externalId: string;
    readonly displayName: string;
    readonly localResourceType: string | null;
    readonly localResourceId: string | null;
    readonly fieldChanges: Prisma.JsonValue;
    readonly diagnosticCode: string | null;
    readonly applyStatus: 'PENDING' | 'APPLIED' | 'FAILED';
  }>;
};

function mapPreview(preview: PreviewRecord): FeishuDirectoryPreview {
  const parsedSummary = isObject(preview.summary) ? preview.summary : {};
  return {
    id: preview.id,
    status: preview.status,
    snapshotCursor: preview.snapshotCursor,
    summary: {
      created: countValue(parsedSummary.created),
      updated: countValue(parsedSummary.updated),
      archived: countValue(parsedSummary.archived),
      deactivated: countValue(parsedSummary.deactivated),
      conflicts: countValue(parsedSummary.conflicts),
      unchanged: countValue(parsedSummary.unchanged),
    },
    expiresAt: preview.expiresAt.toISOString(),
    appliedAt: preview.appliedAt?.toISOString() ?? null,
    createdAt: preview.createdAt.toISOString(),
    items: preview.items.map((item) => ({
      id: item.id,
      sequence: item.sequence,
      entityType: item.entityType,
      action: item.action,
      externalId: item.externalId,
      displayName: item.displayName,
      localResourceType: item.localResourceType,
      localResourceId: item.localResourceId,
      fieldChanges: isObject(item.fieldChanges) ? item.fieldChanges : {},
      diagnosticCode: item.diagnosticCode,
      applyStatus: item.applyStatus,
    })),
  };
}

type RunRecord = {
  readonly id: string;
  readonly previewId: string;
  readonly status: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'DEAD_LETTER';
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly expectedSnapshotCursor: string;
  readonly lastErrorCode: string | null;
  readonly summary: Prisma.JsonValue | null;
  readonly startedAt: Date | null;
  readonly finishedAt: Date | null;
  readonly createdAt: Date;
};

function mapRun(run: RunRecord): FeishuDirectorySyncRunDetail {
  return {
    id: run.id,
    previewId: run.previewId,
    status: run.status,
    attempts: run.attempts,
    maxAttempts: run.maxAttempts,
    expectedSnapshotCursor: run.expectedSnapshotCursor,
    lastErrorCode: run.lastErrorCode,
    summary: run.summary === null ? null : isObject(run.summary) ? run.summary : {},
    startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null,
    createdAt: run.createdAt.toISOString(),
  };
}

class DirectorySyncExecutionError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(code);
    this.name = 'DirectorySyncExecutionError';
  }
}

function describeDirectorySyncExecutionError(error: unknown): {
  readonly code: string;
  readonly retryable: boolean;
} {
  if (error instanceof DirectorySyncExecutionError) {
    return { code: truncateErrorCode(error.code), retryable: error.retryable };
  }
  if (error instanceof FeishuDirectoryError) {
    return { code: truncateErrorCode(error.code), retryable: error.retryable };
  }
  if (error instanceof InvalidFeishuSnapshotError) {
    return { code: truncateErrorCode(error.code), retryable: false };
  }
  if (error instanceof SyncLeaseLostError) {
    return { code: 'SYNC_LEASE_LOST', retryable: true };
  }
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return {
      code: error.code === 'P2002' ? 'LOCAL_DATA_CONFLICT' : 'DATABASE_ERROR',
      retryable: error.code !== 'P2002',
    };
  }
  return { code: 'SYNC_FAILED', retryable: true };
}
