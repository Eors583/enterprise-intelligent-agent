import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, PrismaClient } from '@prisma/client';

import type { EnvironmentVariables } from '../config/environment.js';

export const REQUIRED_APPLICATION_SCHEMA_COLUMNS = [
  { tableName: 'tenants', columnName: 'agent_run_monthly_token_limit' },
  { tableName: 'users', columnName: 'id' },
  { tableName: 'conversations', columnName: 'id' },
  { tableName: 'messages', columnName: 'id' },
  { tableName: 'outbox_events', columnName: 'provider_receipt' },
  { tableName: 'password_credentials', columnName: 'password_hash' },
  { tableName: 'auth_sessions', columnName: 'refresh_token_hash' },
  { tableName: 'org_units', columnName: 'status' },
  { tableName: 'knowledge_bases', columnName: 'id' },
  { tableName: 'knowledge_base_org_units', columnName: 'include_children' },
  { tableName: 'knowledge_documents', columnName: 'current_version_id' },
  { tableName: 'knowledge_document_versions', columnName: 'status' },
  { tableName: 'knowledge_chunks', columnName: 'content_hash' },
  { tableName: 'knowledge_ingestion_jobs', columnName: 'status' },
  { tableName: 'knowledge_chunk_embeddings', columnName: 'embedding_model' },
  { tableName: 'agent_versions', columnName: 'knowledge_scope' },
  { tableName: 'agent_runs', columnName: 'cost_recorded_at' },
  { tableName: 'auth_login_rate_limits', columnName: 'blocked_until' },
  { tableName: 'auth_action_tokens', columnName: 'delivery_status' },
] as const;

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  readonly enabled: boolean;

  constructor(@Inject(ConfigService) config: ConfigService<EnvironmentVariables, true>) {
    super();
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
  ): Promise<T> {
    if (!this.enabled) {
      throw new Error('Prisma repository access is disabled for the current adapter.');
    }

    return this.$transaction(async (transaction) => {
      // A superuser/migration login can bypass RLS. Every application query is
      // deliberately demoted to the fixed NOLOGIN/NOBYPASSRLS role first.
      await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_app');
      await transaction.$queryRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      return operation(transaction);
    });
  }

  async ping(): Promise<void> {
    if (!this.enabled) return;

    await this.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_app');
      const requiredSchemaColumns = Prisma.join(
        REQUIRED_APPLICATION_SCHEMA_COLUMNS.map(
          ({ tableName, columnName }) => Prisma.sql`(${tableName}, ${columnName})`,
        ),
      );
      const [state] = await transaction.$queryRaw<
        Array<{
          role: string;
          table_count: number;
          forced_rls_count: number;
          policy_count: number;
          missing_schema_columns: string[];
        }>
      >`
        SELECT
          current_user::text AS role,
          (
            SELECT count(*)::int
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public'
              AND c.relname IN ('users', 'conversations', 'messages')
          ) AS table_count,
          (
            SELECT count(*)::int
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public'
              AND c.relname IN ('users', 'conversations', 'messages')
              AND c.relrowsecurity
              AND c.relforcerowsecurity
          ) AS forced_rls_count,
          (
            SELECT count(*)::int
            FROM pg_policies
            WHERE schemaname = 'public'
              AND tablename IN ('users', 'conversations', 'messages')
              AND policyname = 'tenant_isolation'
          ) AS policy_count,
          ARRAY(
            SELECT required.table_name || '.' || required.column_name
            FROM (
              VALUES ${requiredSchemaColumns}
            ) AS required(table_name, column_name)
            WHERE NOT EXISTS (
              SELECT 1
              FROM pg_class c
              JOIN pg_namespace n ON n.oid = c.relnamespace
              JOIN pg_attribute a ON a.attrelid = c.oid
              WHERE n.nspname = 'public'
                AND c.relname = required.table_name
                AND c.relkind IN ('r', 'p')
                AND a.attname = required.column_name
                AND a.attnum > 0
                AND NOT a.attisdropped
            )
            ORDER BY required.table_name, required.column_name
          ) AS missing_schema_columns
      `;

      if (
        state?.role !== 'enterprise_agent_app' ||
        state.table_count !== 3 ||
        state.forced_rls_count !== 3 ||
        state.policy_count !== 3 ||
        state.missing_schema_columns.length !== 0
      ) {
        throw new Error('Database security or application schema baseline is incomplete.');
      }

      // No app.tenant_id is set in readiness. A protected query must therefore
      // succeed at the SQL level while returning no tenant rows.
      if ((await transaction.user.count()) !== 0) {
        throw new Error('Database tenant policy is not default-deny.');
      }
    });
  }
}
