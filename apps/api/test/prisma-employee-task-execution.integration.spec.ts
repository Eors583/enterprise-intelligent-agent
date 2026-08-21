import { PrismaClient } from '@prisma/client';

const databaseTestsEnabled = process.env.RUN_DATABASE_TESTS === 'true';

describe.runIf(databaseTestsEnabled)('PostgreSQL employee Task execution boundary', () => {
  const prisma = new PrismaClient();

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('keeps the executor non-login, non-bypass and outside every broader application role', async () => {
    const [role] = await prisma.$queryRaw<
      Array<{
        canLogin: boolean;
        isSuperuser: boolean;
        bypassRls: boolean;
        inherit: boolean;
        memberships: string[];
      }>
    >`
      SELECT
        executor.rolcanlogin AS "canLogin",
        executor.rolsuper AS "isSuperuser",
        executor.rolbypassrls AS "bypassRls",
        executor.rolinherit AS "inherit",
        COALESCE(
          array_agg(parent.rolname ORDER BY parent.rolname)
            FILTER (WHERE parent.rolname IS NOT NULL),
          ARRAY[]::text[]
        )::text[] AS "memberships"
      FROM pg_catalog.pg_roles executor
      LEFT JOIN pg_catalog.pg_auth_members membership
        ON membership.member = executor.oid
      LEFT JOIN pg_catalog.pg_roles parent
        ON parent.oid = membership.roleid
      WHERE executor.rolname = 'enterprise_agent_task_executor'
      GROUP BY executor.rolcanlogin, executor.rolsuper,
               executor.rolbypassrls, executor.rolinherit
    `;

    expect(role).toEqual({
      canLogin: false,
      isSuperuser: false,
      bypassRls: false,
      inherit: false,
      memberships: [],
    });
  });

  it('grants only bounded Task and Deliverable update columns and no direct Evidence mutation', async () => {
    const updateColumns = await prisma.$queryRaw<Array<{ tableName: string; columnName: string }>>`
      SELECT table_name AS "tableName", column_name AS "columnName"
      FROM information_schema.column_privileges
      WHERE grantee = 'enterprise_agent_task_executor'
        AND table_schema = 'public'
        AND privilege_type = 'UPDATE'
        AND table_name IN ('tasks', 'deliverables')
      ORDER BY table_name, column_name
    `;
    expect(updateColumns).toEqual([
      { tableName: 'deliverables', columnName: 'artifact_uri' },
      { tableName: 'deliverables', columnName: 'content_hash' },
      { tableName: 'deliverables', columnName: 'evidence_sealed_at' },
      { tableName: 'deliverables', columnName: 'revision' },
      { tableName: 'deliverables', columnName: 'status' },
      { tableName: 'deliverables', columnName: 'submitted_at' },
      { tableName: 'deliverables', columnName: 'updated_at' },
      { tableName: 'tasks', columnName: 'delivered_at' },
      { tableName: 'tasks', columnName: 'ready_at' },
      { tableName: 'tasks', columnName: 'revision' },
      { tableName: 'tasks', columnName: 'started_at' },
      { tableName: 'tasks', columnName: 'status' },
      { tableName: 'tasks', columnName: 'updated_at' },
    ]);

    const prohibited = await prisma.$queryRaw<Array<{ tableName: string; privilege: string }>>`
      SELECT table_name AS "tableName", privilege_type AS "privilege"
      FROM information_schema.table_privileges
      WHERE grantee = 'enterprise_agent_task_executor'
        AND table_schema = 'public'
        AND (
          privilege_type IN ('DELETE', 'TRUNCATE', 'TRIGGER', 'REFERENCES', 'UPDATE')
          OR (
            privilege_type = 'INSERT'
            AND table_name IN (
              'evidence', 'evidence_links', 'acceptances', 'acceptance_evidence',
              'tasks', 'deliverables'
            )
          )
        )
      ORDER BY table_name, privilege_type
    `;
    expect(prohibited).toEqual([]);
  });

  it('forces tenant RLS, installs append-only triggers and revokes PUBLIC function execution', async () => {
    const tables = await prisma.$queryRaw<
      Array<{
        tableName: string;
        rlsEnabled: boolean;
        rlsForced: boolean;
        triggerCount: number;
      }>
    >`
      SELECT
        relation.relname AS "tableName",
        relation.relrowsecurity AS "rlsEnabled",
        relation.relforcerowsecurity AS "rlsForced",
        (
          SELECT count(*)::int
          FROM pg_catalog.pg_trigger trigger_row
          WHERE trigger_row.tgrelid = relation.oid
            AND NOT trigger_row.tgisinternal
            AND trigger_row.tgname IN (
              relation.relname || '_append_only',
              relation.relname || '_reject_truncate'
            )
        ) AS "triggerCount"
      FROM pg_catalog.pg_class relation
      JOIN pg_catalog.pg_namespace namespace
        ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND relation.relname IN (
          'employee_task_commands',
          'employee_task_acceptance_requests'
        )
      ORDER BY relation.relname
    `;
    expect(tables).toEqual([
      {
        tableName: 'employee_task_acceptance_requests',
        rlsEnabled: true,
        rlsForced: true,
        triggerCount: 2,
      },
      {
        tableName: 'employee_task_commands',
        rlsEnabled: true,
        rlsForced: true,
        triggerCount: 2,
      },
    ]);

    const functions = await prisma.$queryRaw<
      Array<{
        name: string;
        securityDefiner: boolean;
        settings: string[] | null;
        publicExecute: boolean;
        executorExecute: boolean;
      }>
    >`
      SELECT
        procedure.proname AS "name",
        procedure.prosecdef AS "securityDefiner",
        procedure.proconfig::text[] AS "settings",
        has_function_privilege('public', procedure.oid, 'EXECUTE') AS "publicExecute",
        has_function_privilege(
          'enterprise_agent_task_executor',
          procedure.oid,
          'EXECUTE'
        ) AS "executorExecute"
      FROM pg_catalog.pg_proc procedure
      JOIN pg_catalog.pg_namespace namespace
        ON namespace.oid = procedure.pronamespace
      WHERE namespace.nspname = 'public'
        AND procedure.proname IN (
          'employee_task_action_authorized',
          'employee_submit_task_evidence',
          'reject_employee_task_ledger_mutation'
        )
      ORDER BY procedure.proname
    `;
    expect(functions.map((row) => row.name)).toEqual([
      'employee_submit_task_evidence',
      'employee_task_action_authorized',
      'reject_employee_task_ledger_mutation',
    ]);
    expect(
      functions.map(({ name, securityDefiner, settings, publicExecute }) => ({
        name,
        securityDefiner,
        settings,
        publicExecute,
      })),
    ).toEqual(
      functions.map((row) => ({
        name: row.name,
        securityDefiner: true,
        settings: ['search_path=pg_catalog, public'],
        publicExecute: false,
      })),
    );
    expect(
      functions.find((row) => row.name === 'employee_task_action_authorized')?.executorExecute,
    ).toBe(true);
    expect(
      functions.find((row) => row.name === 'employee_submit_task_evidence')?.executorExecute,
    ).toBe(true);
    expect(
      functions.find((row) => row.name === 'reject_employee_task_ledger_mutation')?.executorExecute,
    ).toBe(false);
  });

  it('fails closed with no server-established tenant, user, assignment and action context', async () => {
    await expect(
      prisma.$transaction(async (transaction) => {
        await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_task_executor');
        const [counts] = await transaction.$queryRaw<
          Array<{ tasks: number; commands: number; requests: number }>
        >`
          SELECT
            (SELECT count(*)::int FROM public."tasks") AS "tasks",
            (SELECT count(*)::int FROM public."employee_task_commands") AS "commands",
            (
              SELECT count(*)::int
              FROM public."employee_task_acceptance_requests"
            ) AS "requests"
        `;
        expect(counts).toEqual({ tasks: 0, commands: 0, requests: 0 });
      }),
    ).resolves.toBeUndefined();

    await expect(
      prisma.$transaction(async (transaction) => {
        await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_task_executor');
        await transaction.$executeRaw`
          INSERT INTO public."employee_task_commands" (
            "tenant_id", "task_id", "actor_user_id",
            "actor_role_assignment_id", "action",
            "idempotency_key", "request_hash", "response_payload"
          ) VALUES (
            gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
            gen_random_uuid(), 'business.task.execute',
            'missing-context', ${'a'.repeat(64)}, '{}'::jsonb
          )
        `;
      }),
    ).rejects.toMatchObject({
      code: 'P2010',
      meta: expect.objectContaining({ code: '42501' }),
    });
  });
});
