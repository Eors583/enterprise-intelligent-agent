import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';

import type { EnvironmentVariables } from '../config/environment.js';

/**
 * Uses a separately configurable database login so a production API login
 * never needs membership in the cross-tenant outbox capability role.
 */
@Injectable()
export class OutboxPrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  readonly enabled: boolean;

  constructor(@Inject(ConfigService) config: ConfigService<EnvironmentVariables, true>) {
    const datasourceUrl = config.get('OUTBOX_DATABASE_URL', { infer: true });
    super(datasourceUrl === undefined ? undefined : { datasourceUrl });
    this.enabled =
      config.get('IM_OUTBOX_ENABLED', { infer: true }) ||
      config.get('AGENT_RUN_WORKER_ENABLED', { infer: true }) ||
      config.get('TOOL_EXECUTION_WORKER_ENABLED', { infer: true }) ||
      config.get('KNOWLEDGE_INGESTION_WORKER_ENABLED', { infer: true }) ||
      config.get('FEISHU_SYNC_WORKER_ENABLED', { infer: true });
  }

  async onModuleInit(): Promise<void> {
    if (this.enabled) await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.enabled) await this.$disconnect();
  }
}
