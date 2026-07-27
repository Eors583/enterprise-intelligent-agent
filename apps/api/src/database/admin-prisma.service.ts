import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, PrismaClient } from '@prisma/client';

import type { EnvironmentVariables } from '../config/environment.js';

/**
 * Database capability used exclusively by tenant administration endpoints.
 *
 * Production deployments should provide ADMIN_DATABASE_URL with a login that
 * can only SET ROLE enterprise_agent_admin. Keeping it separate prevents the
 * regular API login from acquiring directory and knowledge write privileges.
 */
@Injectable()
export class AdminPrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  readonly enabled: boolean;

  constructor(@Inject(ConfigService) config: ConfigService<EnvironmentVariables, true>) {
    const datasourceUrl = config.get<string>('ADMIN_DATABASE_URL');
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
      throw new Error('Admin database access requires the Prisma repository adapter.');
    }

    return this.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_admin');
      await transaction.$queryRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      return operation(transaction);
    }, options);
  }
}
