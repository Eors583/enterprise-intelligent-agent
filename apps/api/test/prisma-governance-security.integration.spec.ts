import { PrismaClient } from '@prisma/client';

const databaseTestsEnabled = process.env.RUN_DATABASE_TESTS === 'true';

describe.runIf(databaseTestsEnabled)('PostgreSQL governance security discovery gate', () => {
  const prisma = new PrismaClient();

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('forces RLS with a tenant policy and no PUBLIC DML on every tenant-scoped table', async () => {
    const tables = await prisma.$queryRaw<
      Array<{
        tableName: string;
        rlsEnabled: boolean;
        rlsForced: boolean;
        policyCount: number;
        publicDmlCount: number;
      }>
    >`
      SELECT
        relation.relname AS "tableName",
        relation.relrowsecurity AS "rlsEnabled",
        relation.relforcerowsecurity AS "rlsForced",
        (
          SELECT count(*)::int
          FROM pg_catalog.pg_policy policy
          WHERE policy.polrelid = relation.oid
        ) AS "policyCount",
        (
          SELECT count(*)::int
          FROM aclexplode(
            COALESCE(
              relation.relacl,
              acldefault('r', relation.relowner)
            )
          ) acl
          WHERE acl.grantee = 0
            AND acl.privilege_type IN (
              'SELECT',
              'INSERT',
              'UPDATE',
              'DELETE',
              'TRUNCATE',
              'REFERENCES',
              'TRIGGER'
            )
        ) AS "publicDmlCount"
      FROM pg_catalog.pg_class relation
      JOIN pg_catalog.pg_namespace namespace
        ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND relation.relkind IN ('r', 'p')
        AND EXISTS (
          SELECT 1
          FROM pg_catalog.pg_attribute attribute
          WHERE attribute.attrelid = relation.oid
            AND attribute.attname = 'tenant_id'
            AND attribute.attnum > 0
            AND NOT attribute.attisdropped
        )
      ORDER BY relation.relname
    `;

    expect(tables.length).toBeGreaterThan(0);
    expect(
      tables
        .filter(
          (table) =>
            !table.rlsEnabled ||
            !table.rlsForced ||
            table.policyCount < 1 ||
            table.publicDmlCount !== 0,
        )
        .map((table) => table.tableName),
    ).toEqual([]);
  });

  it('requires tenant_id in every foreign key between two tenant-scoped tables', async () => {
    const foreignKeys = await prisma.$queryRaw<
      Array<{
        constraintName: string;
        childTable: string;
        parentTable: string;
        childColumns: string[];
        parentColumns: string[];
      }>
    >`
      SELECT
        constraint_row.conname AS "constraintName",
        child.relname AS "childTable",
        parent.relname AS "parentTable",
        array_agg(child_attribute.attname ORDER BY key_pair.ordinality)::text[] AS "childColumns",
        array_agg(parent_attribute.attname ORDER BY key_pair.ordinality)::text[] AS "parentColumns"
      FROM pg_catalog.pg_constraint constraint_row
      JOIN pg_catalog.pg_class child
        ON child.oid = constraint_row.conrelid
      JOIN pg_catalog.pg_namespace child_namespace
        ON child_namespace.oid = child.relnamespace
      JOIN pg_catalog.pg_class parent
        ON parent.oid = constraint_row.confrelid
      JOIN pg_catalog.pg_namespace parent_namespace
        ON parent_namespace.oid = parent.relnamespace
      CROSS JOIN LATERAL unnest(
        constraint_row.conkey,
        constraint_row.confkey
      ) WITH ORDINALITY AS key_pair(child_number, parent_number, ordinality)
      JOIN pg_catalog.pg_attribute child_attribute
        ON child_attribute.attrelid = child.oid
       AND child_attribute.attnum = key_pair.child_number
      JOIN pg_catalog.pg_attribute parent_attribute
        ON parent_attribute.attrelid = parent.oid
       AND parent_attribute.attnum = key_pair.parent_number
      WHERE constraint_row.contype = 'f'
        AND child_namespace.nspname = 'public'
        AND parent_namespace.nspname = 'public'
        AND EXISTS (
          SELECT 1
          FROM pg_catalog.pg_attribute attribute
          WHERE attribute.attrelid = child.oid
            AND attribute.attname = 'tenant_id'
            AND attribute.attnum > 0
            AND NOT attribute.attisdropped
        )
        AND EXISTS (
          SELECT 1
          FROM pg_catalog.pg_attribute attribute
          WHERE attribute.attrelid = parent.oid
            AND attribute.attname = 'tenant_id'
            AND attribute.attnum > 0
            AND NOT attribute.attisdropped
        )
      GROUP BY constraint_row.conname, child.relname, parent.relname
      ORDER BY child.relname, constraint_row.conname
    `;

    expect(foreignKeys.length).toBeGreaterThan(0);
    expect(
      foreignKeys
        .filter(
          (foreignKey) =>
            !foreignKey.childColumns.includes('tenant_id') ||
            !foreignKey.parentColumns.includes('tenant_id'),
        )
        .map(
          (foreignKey) =>
            `${foreignKey.childTable}.${foreignKey.constraintName}->${foreignKey.parentTable}`,
        ),
    ).toEqual([]);
  });

  it('locks every public SECURITY DEFINER function to a fixed search_path and revokes PUBLIC', async () => {
    const functions = await prisma.$queryRaw<
      Array<{
        signature: string;
        settings: string[] | null;
        publicExecuteCount: number;
      }>
    >`
      SELECT
        function_row.oid::regprocedure::text AS "signature",
        function_row.proconfig::text[] AS "settings",
        (
          SELECT count(*)::int
          FROM aclexplode(
            COALESCE(
              function_row.proacl,
              acldefault('f', function_row.proowner)
            )
          ) acl
          WHERE acl.grantee = 0
            AND acl.privilege_type = 'EXECUTE'
        ) AS "publicExecuteCount"
      FROM pg_catalog.pg_proc function_row
      JOIN pg_catalog.pg_namespace namespace
        ON namespace.oid = function_row.pronamespace
      WHERE namespace.nspname = 'public'
        AND function_row.prosecdef
      ORDER BY function_row.oid::regprocedure::text
    `;

    expect(functions.length).toBeGreaterThan(0);
    expect(
      functions
        .filter((functionRow) => {
          const searchPath = functionRow.settings?.find((setting) =>
            setting.startsWith('search_path='),
          );
          return (
            searchPath === undefined ||
            searchPath.replaceAll(' ', '') !== 'search_path=pg_catalog,public' ||
            functionRow.publicExecuteCount !== 0
          );
        })
        .map((functionRow) => functionRow.signature),
    ).toEqual([]);
  });
});
