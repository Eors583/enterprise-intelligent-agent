import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, PrismaClient } from '@prisma/client';

import type { EnvironmentVariables } from '../config/environment.js';

/**
 * Least-privilege database capability for RoleAssignment lifecycle work.
 *
 * Production uses a dedicated login from LIFECYCLE_DATABASE_URL. The login may
 * SET ROLE enterprise_agent_lifecycle only; it is intentionally separate from
 * API, auth, admin, outbox, and provisioning credentials.
 */
@Injectable()
export class LifecyclePrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  readonly enabled: boolean;

  constructor(@Inject(ConfigService) config: ConfigService<EnvironmentVariables, true>) {
    const datasourceUrl = config.get<string>('LIFECYCLE_DATABASE_URL');
    super(datasourceUrl === undefined ? undefined : { datasourceUrl });
    this.enabled = config.get('REPOSITORY_DRIVER', { infer: true }) === 'prisma';
  }

  async onModuleInit(): Promise<void> {
    if (this.enabled) await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.enabled) await this.$disconnect();
  }

  async withTenant<T>(
    tenantId: string,
    operation: (transaction: Prisma.TransactionClient) => Promise<T>,
    options?: { readonly maxWait?: number; readonly timeout?: number },
  ): Promise<T> {
    if (!this.enabled) {
      throw new Error('Lifecycle database access requires the Prisma repository adapter.');
    }
    return this.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_lifecycle');
      await transaction.$queryRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      return operation(transaction);
    }, options);
  }

  async listActiveTenantIds(): Promise<readonly string[]> {
    if (!this.enabled) return [];
    return this.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_lifecycle');
      const tenants = await transaction.tenant.findMany({
        where: { status: 'ACTIVE' },
        select: { id: true },
        orderBy: { id: 'asc' },
      });
      return tenants.map((tenant) => tenant.id);
    });
  }
}
