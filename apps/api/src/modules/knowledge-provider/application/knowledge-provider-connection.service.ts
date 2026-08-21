import { randomUUID } from 'node:crypto';

import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import type {
  CreateLexiangConnectionRequest,
  DiscoverLexiangConnectionRequest,
  KnowledgeProviderConnection,
  KnowledgeProviderConnectionResponse,
  KnowledgeProviderHealthCheckResponse,
  LexiangConnectionDiscoveryResponse,
} from '@enterprise/contracts';
import type { KnowledgeProviderConnection as KnowledgeProviderConnectionRecord } from '@prisma/client';

import { AdminPrismaService } from '../../../database/admin-prisma.service.js';
import type { AdminPrincipal } from '../../admin/admin-access.service.js';
import { recordAdminAudit } from '../../admin/admin-audit.js';
import { LexiangCredentialVault } from '../infrastructure/lexiang/lexiang-credential-vault.js';
import { LexiangSpaceClient } from '../infrastructure/lexiang/lexiang-space.client.js';
import {
  LexiangProviderError,
  LexiangTokenProvider,
} from '../infrastructure/lexiang/lexiang-token.provider.js';

const PROVIDER = 'LEXIANG' as const;
const HEALTHY_CODE = 'LEXIANG_KB_TEAM_OK';

@Injectable()
export class KnowledgeProviderConnectionService {
  constructor(
    @Inject(AdminPrismaService) private readonly prisma: AdminPrismaService,
    @Inject(LexiangCredentialVault) private readonly vault: LexiangCredentialVault,
    @Inject(LexiangTokenProvider) private readonly tokens: LexiangTokenProvider,
    @Inject(LexiangSpaceClient) private readonly spaces: LexiangSpaceClient,
  ) {}

  async get(principal: AdminPrincipal): Promise<KnowledgeProviderConnectionResponse> {
    const connection = await this.prisma.withTenant(principal.tenantId, (transaction) =>
      transaction.knowledgeProviderConnection.findUnique({
        where: { tenantId_provider: { tenantId: principal.tenantId, provider: PROVIDER } },
      }),
    );
    return { connection: connection === null ? null : mapConnection(connection) };
  }

  async discover(
    request: DiscoverLexiangConnectionRequest,
  ): Promise<LexiangConnectionDiscoveryResponse> {
    const connectionId = randomUUID();
    const credential = { appKey: request.appKey, appSecret: request.appSecret };
    try {
      await this.tokens.get(connectionId, credential, true);
    } catch (error) {
      this.tokens.invalidate(connectionId);
      throw new BadRequestException(connectionFailureMessage(error));
    }
    const context = { connectionId, credential };
    try {
      const [teamResult, operatorResult] = await Promise.all([
        this.discoverItems(() => this.spaces.listTeams(context)),
        this.discoverItems(() => this.spaces.listTenantManagers(context)),
      ]);
      return {
        teamStatus: teamResult.status,
        operatorStatus: operatorResult.status,
        teams: [...teamResult.items],
        operators: [...operatorResult.items],
      };
    } finally {
      this.tokens.invalidate(connectionId);
    }
  }

  async connect(
    principal: AdminPrincipal,
    request: CreateLexiangConnectionRequest,
  ): Promise<KnowledgeProviderConnectionResponse> {
    const existing = await this.prisma.withTenant(principal.tenantId, (transaction) =>
      transaction.knowledgeProviderConnection.findUnique({
        where: { tenantId_provider: { tenantId: principal.tenantId, provider: PROVIDER } },
        select: { id: true, appKey: true, teamId: true, operatorStaffId: true },
      }),
    );
    const connectionId = existing?.id ?? randomUUID();
    if (existing !== null && existing !== undefined) {
      const activeSpaces = await this.prisma.withTenant(principal.tenantId, (transaction) =>
        transaction.knowledgeExternalSpaceBinding.count({
          where: {
            tenantId: principal.tenantId,
            connectionId,
            status: { not: 'DELETED' },
          },
        }),
      );
      if (
        activeSpaces > 0 &&
        (existing.appKey !== request.appKey ||
          existing.teamId !== request.teamId ||
          existing.operatorStaffId !== request.operatorStaffId)
      ) {
        throw new ConflictException(
          '当前连接仍管理乐享知识库，只能轮换同一应用、团队和操作账号的 AppSecret。',
        );
      }
    }
    try {
      const credential = { appKey: request.appKey, appSecret: request.appSecret };
      await this.tokens.get(connectionId, credential, true);
      await this.spaces.verifyTeam({
        connectionId,
        credential,
        teamId: request.teamId,
      });
    } catch (error) {
      throw new BadRequestException(connectionFailureMessage(error));
    }

    const checkedAt = new Date();
    const credentialCiphertext = this.vault.encrypt(request.appSecret, {
      tenantId: principal.tenantId,
      appKey: request.appKey,
    });
    const connection = await this.prisma.withTenant(principal.tenantId, async (transaction) => {
      const saved = await transaction.knowledgeProviderConnection.upsert({
        where: { tenantId_provider: { tenantId: principal.tenantId, provider: PROVIDER } },
        create: {
          id: connectionId,
          tenantId: principal.tenantId,
          provider: PROVIDER,
          status: 'ACTIVE',
          appKey: request.appKey,
          teamId: request.teamId,
          operatorStaffId: request.operatorStaffId,
          credentialCiphertext,
          lastHealthAt: checkedAt,
          lastHealthCode: HEALTHY_CODE,
        },
        update: {
          status: 'ACTIVE',
          appKey: request.appKey,
          teamId: request.teamId,
          operatorStaffId: request.operatorStaffId,
          credentialCiphertext,
          lastHealthAt: checkedAt,
          lastHealthCode: HEALTHY_CODE,
          version: { increment: 1 },
        },
      });
      await recordAdminAudit(
        transaction,
        principal,
        'admin.knowledge-provider.lexiang.connected',
        'knowledge_provider_connection',
        saved.id,
        {
          appKeyHint: appKeyHint(saved.appKey),
          teamId: saved.teamId,
          operatorStaffId: saved.operatorStaffId,
          healthCode: HEALTHY_CODE,
        },
      );
      return saved;
    });
    return { connection: mapConnection(connection) };
  }

  async checkHealth(principal: AdminPrincipal): Promise<KnowledgeProviderHealthCheckResponse> {
    const current = await this.prisma.withTenant(principal.tenantId, (transaction) =>
      transaction.knowledgeProviderConnection.findUnique({
        where: { tenantId_provider: { tenantId: principal.tenantId, provider: PROVIDER } },
      }),
    );
    if (current === null) throw new BadRequestException('请先连接腾讯乐享。');

    const checkedAt = new Date();
    let reachable = false;
    let healthCode = current.status === 'DISABLED' ? 'LEXIANG_DISABLED' : HEALTHY_CODE;
    if (
      current.credentialCiphertext !== null &&
      current.teamId !== null &&
      current.operatorStaffId !== null
    ) {
      try {
        const appSecret = this.vault.decrypt(current.credentialCiphertext, {
          tenantId: principal.tenantId,
          appKey: current.appKey,
        });
        await this.tokens.get(current.id, { appKey: current.appKey, appSecret }, true);
        await this.spaces.verifyTeam({
          connectionId: current.id,
          credential: { appKey: current.appKey, appSecret },
          teamId: current.teamId,
        });
        reachable = true;
      } catch (error) {
        healthCode = safeHealthCode(error);
      }
    }

    const connection = await this.prisma.withTenant(principal.tenantId, async (transaction) => {
      const updated = await transaction.knowledgeProviderConnection.update({
        where: { id: current.id },
        data: {
          status: reachable ? 'ACTIVE' : current.status === 'DISABLED' ? 'DISABLED' : 'UNAVAILABLE',
          lastHealthAt: checkedAt,
          lastHealthCode: healthCode,
          version: { increment: 1 },
        },
      });
      await recordAdminAudit(
        transaction,
        principal,
        'admin.knowledge-provider.lexiang.health-checked',
        'knowledge_provider_connection',
        updated.id,
        { healthCode, reachable },
      );
      return updated;
    });
    return {
      connection: mapConnection(connection),
      reachable,
      checkedAt: checkedAt.toISOString(),
      message: healthMessage(healthCode, reachable),
    };
  }

  async disable(principal: AdminPrincipal): Promise<KnowledgeProviderConnectionResponse> {
    const activeSpaces = await this.prisma.withTenant(principal.tenantId, (transaction) =>
      transaction.knowledgeExternalSpaceBinding.count({
        where: { tenantId: principal.tenantId, status: { not: 'DELETED' } },
      }),
    );
    if (activeSpaces > 0) {
      throw new ConflictException('请先删除所有由本连接管理的乐享知识库，再停用连接。');
    }
    const connection = await this.prisma.withTenant(principal.tenantId, async (transaction) => {
      const current = await transaction.knowledgeProviderConnection.findUnique({
        where: { tenantId_provider: { tenantId: principal.tenantId, provider: PROVIDER } },
      });
      if (current === null) throw new BadRequestException('腾讯乐享连接尚未配置。');
      const updated = await transaction.knowledgeProviderConnection.update({
        where: { id: current.id },
        data: {
          status: 'DISABLED',
          credentialCiphertext: null,
          lastHealthCode: 'LEXIANG_DISABLED',
          version: { increment: 1 },
        },
      });
      await recordAdminAudit(
        transaction,
        principal,
        'admin.knowledge-provider.lexiang.disabled',
        'knowledge_provider_connection',
        updated.id,
      );
      return updated;
    });
    this.tokens.invalidate(connection.id);
    return { connection: mapConnection(connection) };
  }

  private async discoverItems<T>(operation: () => Promise<readonly T[]>): Promise<{
    readonly status: 'AVAILABLE' | 'FORBIDDEN';
    readonly items: readonly T[];
  }> {
    try {
      return { status: 'AVAILABLE', items: await operation() };
    } catch (error) {
      if (error instanceof LexiangProviderError && error.status === 403) {
        return { status: 'FORBIDDEN', items: [] };
      }
      throw new BadRequestException(connectionFailureMessage(error));
    }
  }
}

function mapConnection(record: KnowledgeProviderConnectionRecord): KnowledgeProviderConnection {
  return {
    id: record.id,
    provider: record.provider,
    status: record.status,
    appKeyHint: appKeyHint(record.appKey),
    teamId: record.teamId,
    operatorStaffId: record.operatorStaffId,
    credentialsConfigured: record.credentialCiphertext !== null,
    lastHealthAt: record.lastHealthAt?.toISOString() ?? null,
    lastHealthCode: record.lastHealthCode,
  };
}

function appKeyHint(appKey: string): string {
  const normalized = appKey.trim();
  if (normalized.length <= 6) return `${normalized.slice(0, 1)}…${normalized.slice(-1)}`;
  return `${normalized.slice(0, 4)}…${normalized.slice(-4)}`;
}

function safeHealthCode(error: unknown): string {
  return error instanceof LexiangProviderError ? error.code : 'LEXIANG_CREDENTIAL_UNAVAILABLE';
}

function connectionFailureMessage(error: unknown): string {
  if (error instanceof LexiangProviderError && error.status === 403) {
    return '乐享拒绝了当前应用，请检查应用权限和可信 IP。';
  }
  return '无法验证乐享应用凭据，请检查 AppKey、AppSecret 和乐享应用状态。';
}

function healthMessage(code: string, reachable: boolean): string {
  if (reachable) return '凭据有效，已成功连接腾讯乐享。';
  if (code === 'LEXIANG_DISABLED') return '腾讯乐享连接已停用，请重新输入凭据后连接。';
  if (code === 'LEXIANG_FORBIDDEN') return '乐享拒绝了当前应用，请检查应用权限和可信 IP。';
  return '当前无法访问乐享，请检查凭据、网络和应用权限。';
}
