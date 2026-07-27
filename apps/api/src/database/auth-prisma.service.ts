import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, PrismaClient } from '@prisma/client';

import type { EnvironmentVariables } from '../config/environment.js';

/**
 * Database capability dedicated to authentication. It intentionally has
 * cross-tenant access only to the small identity/session surface granted by
 * the database migration.
 */
@Injectable()
export class AuthPrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  readonly enabled: boolean;

  constructor(@Inject(ConfigService) config: ConfigService<EnvironmentVariables, true>) {
    const datasourceUrl = config.get('AUTH_DATABASE_URL', { infer: true });
    super(datasourceUrl === undefined ? undefined : { datasourceUrl });
    this.enabled = config.get('REPOSITORY_DRIVER', { infer: true }) === 'prisma';
  }

  async onModuleInit(): Promise<void> {
    if (this.enabled) await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.enabled) await this.$disconnect();
  }

  withAuth<T>(operation: (transaction: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    if (!this.enabled) {
      throw new Error('Authentication persistence requires the Prisma repository adapter.');
    }

    return this.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_auth');
      return operation(transaction);
    });
  }
}
