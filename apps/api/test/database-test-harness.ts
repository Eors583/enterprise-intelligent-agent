import { Prisma, type PrismaClient } from '@prisma/client';

const protectedDatabaseNames = new Set([
  'enterprise_agent_acceptance',
  'enterprise_agent_vector_acceptance',
]);
const disposableDatabaseNamePattern =
  /(?:^|_)(?:test|retest|acceptance|gate|integration|defect_fix|temporary|temp)(?:_|$)/i;

interface DatabaseBoundary {
  databaseName: string;
  currentUser: string;
  isSuperuser: boolean;
}

interface TenantScopedTable {
  tableName: string;
}

/**
 * Removes test-owned tenants from a dedicated disposable integration database.
 *
 * Production audit/session ledgers remain append-only. The harness temporarily
 * disables origin triggers only inside a transaction owned by the disposable
 * database superuser, deletes every tenant-scoped row discovered from the
 * catalog, and then deletes the tenant roots.
 */
export async function cleanupDisposableTenants(
  client: PrismaClient,
  tenantIds: readonly string[],
): Promise<void> {
  if (tenantIds.length === 0) return;
  if (process.env.RUN_DATABASE_TESTS !== 'true') {
    throw new Error('Disposable database cleanup requires RUN_DATABASE_TESTS=true.');
  }

  const [boundary] = await client.$queryRaw<DatabaseBoundary[]>`
    SELECT
      current_database() AS "databaseName",
      current_user AS "currentUser",
      role.rolsuper AS "isSuperuser"
    FROM pg_catalog.pg_roles role
    WHERE role.rolname = current_user
  `;
  if (boundary === undefined) {
    throw new Error('Unable to verify the disposable database boundary.');
  }
  if (
    protectedDatabaseNames.has(boundary.databaseName) ||
    !disposableDatabaseNamePattern.test(boundary.databaseName)
  ) {
    throw new Error(
      `Refusing destructive test cleanup for non-disposable database ${boundary.databaseName}.`,
    );
  }
  if (!boundary.isSuperuser) {
    throw new Error(
      `Disposable cleanup user ${boundary.currentUser} must be a test-only superuser.`,
    );
  }

  await client.$transaction(async (transaction) => {
    await transaction.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
    const tenantUuidList = Prisma.join(tenantIds.map((tenantId) => Prisma.sql`${tenantId}::uuid`));
    const tables = await transaction.$queryRaw<TenantScopedTable[]>`
      SELECT DISTINCT table_row.relname AS "tableName"
      FROM pg_catalog.pg_class table_row
      JOIN pg_catalog.pg_namespace namespace
        ON namespace.oid = table_row.relnamespace
      JOIN pg_catalog.pg_attribute attribute
        ON attribute.attrelid = table_row.oid
      WHERE namespace.nspname = 'public'
        AND table_row.relkind IN ('r', 'p')
        AND attribute.attname = 'tenant_id'
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
      ORDER BY table_row.relname
    `;

    for (const { tableName } of tables) {
      const qualifiedTable = `"public"."${tableName.replaceAll('"', '""')}"`;
      await transaction.$executeRaw(
        Prisma.sql`DELETE FROM ${Prisma.raw(qualifiedTable)}
          WHERE "tenant_id" IN (${tenantUuidList})`,
      );
    }
    await transaction.$executeRaw(
      Prisma.sql`DELETE FROM public."tenants"
        WHERE "id" IN (${tenantUuidList})`,
    );
  });
}
