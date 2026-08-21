import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const apiRoot = process.cwd().endsWith(path.join('apps', 'api'))
  ? process.cwd()
  : path.resolve(process.cwd(), 'apps/api');
const migration = readFileSync(
  path.join(apiRoot, 'prisma/migrations/20260728002500_finops_auto_projection/migration.sql'),
  'utf8',
);
const compatibilityHardeningMigration = readFileSync(
  path.join(
    apiRoot,
    'prisma/migrations/20260729000900_finops_projection_rls_compatibility_hardening/migration.sql',
  ),
  'utf8',
);

describe('trusted automatic FinOps projection database boundary', () => {
  it('creates tenant-isolated jobs and governable diagnostics', () => {
    expect(migration).toContain('CREATE TABLE public."finops_projection_jobs"');
    expect(migration).toContain('CREATE TABLE public."finops_projection_diagnostics"');
    expect(migration).toContain(
      'ALTER TABLE public."finops_projection_jobs" FORCE ROW LEVEL SECURITY',
    );
    expect(migration).toContain(
      'ALTER TABLE public."finops_projection_diagnostics" FORCE ROW LEVEL SECURITY',
    );
    expect(migration.match(/CREATE POLICY "tenant_isolation"/gu)).toHaveLength(2);
    expect(migration).toContain('guard_finops_projection_diagnostic');
  });

  it('uses a non-login, non-bypass projector with append-only ledger privileges', () => {
    expect(migration).toContain(
      'NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS',
    );
    expect(migration).toContain('GRANT SELECT ON TABLE');
    expect(migration).toContain('public."finops_price_snapshots"');
    expect(migration).toContain('GRANT INSERT ON TABLE');
    expect(migration).toContain('public."finops_cost_entries"');
    expect(migration).not.toMatch(
      /GRANT\s+UPDATE[\s\S]*public\."finops_price_snapshots"[\s\S]*TO enterprise_agent_finops_projector/u,
    );
    expect(migration).not.toMatch(/GRANT\s+DELETE[\s\S]*TO enterprise_agent_finops_projector/u);
  });

  it('enumerates source tenants through a controlled security-definer boundary', () => {
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public."finops_projection_tenants"()');
    expect(migration).toContain('SECURITY DEFINER');
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public."finops_projection_tenants"() FROM PUBLIC',
    );
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION public."finops_projection_tenants"()');
  });

  it('admits only verified runtime-attested costs and exact service events', () => {
    expect(migration).toContain(`"verification_status" = 'VERIFIED'`);
    expect(migration).toContain(`"source_authority" = 'RUNTIME_ATTESTED'`);
    expect(migration).toContain(`"idempotency_key" LIKE 'auto-finops:%'`);
    expect(migration).toContain(`"actor_id" = '00000000-0000-7000-8000-00000000f017'::uuid`);
    expect(migration).toContain(`'finops.cost.auto_projected.v1'`);
    expect(migration).toContain(`'finops.projection.blocked.v1'`);
    expect(migration).toContain(`'finops.projection.resolved.v1'`);
  });

  it('verifies approved prices without requiring mutation rights on the catalog', () => {
    const verifier = migration.slice(
      migration.indexOf('CREATE OR REPLACE FUNCTION public."finops_prepare_cost_entry"()'),
      migration.indexOf('DO $role$'),
    );
    expect(verifier).toContain(`price."status" <> 'APPROVED'`);
    expect(verifier).not.toContain('FOR SHARE');
  });

  it('admits approved-price Tool projections without weakening Agent Run attestation', () => {
    expect(compatibilityHardeningMigration).toContain('DROP POLICY "finops_projector_cost_insert"');
    expect(compatibilityHardeningMigration).toContain(`"source_system" = 'agent-runtime'`);
    expect(compatibilityHardeningMigration).toContain(`"source_authority" = 'RUNTIME_ATTESTED'`);
    expect(compatibilityHardeningMigration).toContain(`"source_system" = 'tool-gateway'`);
    expect(compatibilityHardeningMigration).toContain(
      `"source_authority" IN ('RUNTIME_ATTESTED', 'TRUSTED_SYSTEM')`,
    );
    expect(compatibilityHardeningMigration).toContain(`"agent_run_id" IS NOT NULL`);
    expect(compatibilityHardeningMigration).toContain(`"tool_invocation_id" IS NOT NULL`);
    expect(compatibilityHardeningMigration).toContain(
      'FROM public."tool_execution_receipts" receipt',
    );
    expect(compatibilityHardeningMigration).toContain(`receipt."cost_attestation" = 'UNATTESTED'`);
    expect(compatibilityHardeningMigration).toContain(`'PROVIDER_ATTESTED'`);
    expect(compatibilityHardeningMigration).toContain(`'GATEWAY_ATTESTED'`);
    expect(compatibilityHardeningMigration).not.toContain(`"source_system" IN`);
  });

  it('keeps immutable Cost Entry review reads within the exact admin ACL', () => {
    const reviewTrigger = compatibilityHardeningMigration.slice(
      compatibilityHardeningMigration.indexOf(
        'CREATE OR REPLACE FUNCTION public.finops_prepare_cost_verification_review()',
      ),
      compatibilityHardeningMigration.indexOf('DROP POLICY "finops_projector_cost_insert"'),
    );
    const costEntryRead = reviewTrigger.slice(
      reviewTrigger.indexOf('FROM public."finops_cost_entries" cost'),
      reviewTrigger.indexOf('IF NOT FOUND'),
    );
    expect(costEntryRead).toContain('cost."id" = NEW."cost_entry_id"');
    expect(costEntryRead).not.toContain('FOR SHARE');
    expect(reviewTrigger).toContain('pg_advisory_xact_lock');
    expect(reviewTrigger).toContain('FROM public."evidence" evidence');
  });
});
