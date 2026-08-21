import { PrismaClient } from '@prisma/client';

import { cleanupDisposableTenants } from './database-test-harness.js';

const enabled = process.env.RUN_DATABASE_TESTS === 'true';

const tenantAId = '00000000-0000-7000-8000-00000000e901';
const tenantBId = '00000000-0000-7000-8000-00000000e902';
const runId = '00000000-0000-7000-8000-00000000e911';

describe.runIf(enabled)('PostgreSQL AI Runtime durable store boundary', () => {
  const administrator = new PrismaClient();

  beforeAll(async () => {
    await cleanupDisposableTenants(administrator, [tenantAId, tenantBId]);
    await administrator.tenant.createMany({
      data: [
        { id: tenantAId, slug: 'runtime-store-a', name: 'Runtime store A' },
        { id: tenantBId, slug: 'runtime-store-b', name: 'Runtime store B' },
      ],
      skipDuplicates: true,
    });
    await administrator.$executeRawUnsafe(
      'DELETE FROM public.ai_runtime_runs WHERE tenant_id IN ($1::uuid, $2::uuid)',
      tenantAId,
      tenantBId,
    );
  });

  afterAll(async () => {
    await cleanupDisposableTenants(administrator, [tenantAId, tenantBId]);
    await administrator.$disconnect();
  });

  it('persists only tenant-matching records through the dedicated runtime role', async () => {
    const record = runtimeRecord({ tenantId: tenantAId, runId, status: 'queued', version: 1 });

    await administrator.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_runtime');
      await transaction.$queryRaw`SELECT set_config('app.tenant_id', ${tenantAId}, true)`;
      await transaction.$executeRawUnsafe(
        `
          INSERT INTO public.ai_runtime_runs (
            tenant_id, run_id, status, version, record, created_at, updated_at
          )
          VALUES ($1::uuid, $2::uuid, 'queued', 1, $3::jsonb, now(), now())
        `,
        tenantAId,
        runId,
        JSON.stringify(record),
      );
    });

    const ownCount = await countAsRole('enterprise_agent_runtime', tenantAId);
    const otherTenantCount = await countAsRole('enterprise_agent_runtime', tenantBId);
    expect(ownCount).toBe(1);
    expect(otherTenantCount).toBe(0);
  });

  it('default-denies reads and cross-tenant writes when tenant context is absent or mismatched', async () => {
    const noContextCount = await administrator.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_runtime');
      const rows = await transaction.$queryRaw<Array<{ count: number }>>`
        SELECT count(*)::int AS count FROM public.ai_runtime_runs
      `;
      return rows[0]?.count ?? -1;
    });
    expect(noContextCount).toBe(0);

    await expect(
      administrator.$transaction(async (transaction) => {
        await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_runtime');
        await transaction.$queryRaw`SELECT set_config('app.tenant_id', ${tenantAId}, true)`;
        const crossTenantRunId = '00000000-0000-7000-8000-00000000e912';
        await transaction.$executeRawUnsafe(
          `
            INSERT INTO public.ai_runtime_runs (
              tenant_id, run_id, status, version, record, created_at, updated_at
            )
            VALUES ($1::uuid, $2::uuid, 'queued', 1, $3::jsonb, now(), now())
          `,
          tenantBId,
          crossTenantRunId,
          JSON.stringify(
            runtimeRecord({
              tenantId: tenantBId,
              runId: crossTenantRunId,
              status: 'queued',
              version: 1,
            }),
          ),
        );
      }),
    ).rejects.toThrow();
  });

  it('enforces immutable record mirrors and keeps the admin role read-only', async () => {
    await expect(
      administrator.$transaction(async (transaction) => {
        await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_runtime');
        await transaction.$queryRaw`SELECT set_config('app.tenant_id', ${tenantAId}, true)`;
        await transaction.$executeRawUnsafe(
          `
            UPDATE public.ai_runtime_runs
            SET status = 'running',
                version = 2,
                updated_at = now()
            WHERE tenant_id = $1::uuid AND run_id = $2::uuid
          `,
          tenantAId,
          runId,
        );
      }),
    ).rejects.toThrow();

    const visibleToAdmin = await countAsRole('enterprise_agent_admin', tenantAId);
    expect(visibleToAdmin).toBe(1);

    await expect(
      administrator.$transaction(async (transaction) => {
        await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_admin');
        await transaction.$queryRaw`SELECT set_config('app.tenant_id', ${tenantAId}, true)`;
        await transaction.$executeRawUnsafe(
          `
            UPDATE public.ai_runtime_runs
            SET updated_at = now()
            WHERE tenant_id = $1::uuid AND run_id = $2::uuid
          `,
          tenantAId,
          runId,
        );
      }),
    ).rejects.toThrow();
  });

  it('has an exact least-privilege ACL and hardened capability role', async () => {
    const acl = await administrator.$queryRaw<
      Array<{ grantee: string; privilegeType: string; grantable: boolean }>
    >`
      SELECT
        grantee,
        privilege_type AS "privilegeType",
        is_grantable = 'YES' AS grantable
      FROM information_schema.role_table_grants
      WHERE table_schema = 'public'
        AND table_name = 'ai_runtime_runs'
        AND grantee IN ('enterprise_agent_runtime', 'enterprise_agent_admin')
      ORDER BY grantee, privilege_type
    `;
    expect(acl).toEqual([
      { grantee: 'enterprise_agent_admin', privilegeType: 'SELECT', grantable: false },
      { grantee: 'enterprise_agent_runtime', privilegeType: 'INSERT', grantable: false },
      { grantee: 'enterprise_agent_runtime', privilegeType: 'SELECT', grantable: false },
      { grantee: 'enterprise_agent_runtime', privilegeType: 'UPDATE', grantable: false },
    ]);

    const roles = await administrator.$queryRaw<
      Array<{
        login: boolean;
        superuser: boolean;
        inherit: boolean;
        bypassRls: boolean;
      }>
    >`
      SELECT
        rolcanlogin AS login,
        rolsuper AS superuser,
        rolinherit AS inherit,
        rolbypassrls AS "bypassRls"
      FROM pg_roles
      WHERE rolname = 'enterprise_agent_runtime'
    `;
    expect(roles).toEqual([{ login: false, superuser: false, inherit: false, bypassRls: false }]);
  });

  async function countAsRole(role: string, tenantId: string): Promise<number> {
    return administrator.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe(`SET LOCAL ROLE ${role}`);
      await transaction.$queryRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      const rows = await transaction.$queryRaw<Array<{ count: number }>>`
        SELECT count(*)::int AS count FROM public.ai_runtime_runs
      `;
      return rows[0]?.count ?? -1;
    });
  }
});

function runtimeRecord(input: {
  tenantId: string;
  runId: string;
  status: 'queued' | 'running';
  version: number;
}): Record<string, unknown> {
  return {
    run_id: input.runId,
    tenant_id: input.tenantId,
    status: input.status,
    version: input.version,
  };
}
