import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const apiRoot = process.cwd().endsWith(path.join('apps', 'api'))
  ? process.cwd()
  : path.resolve(process.cwd(), 'apps/api');
const migration = readFileSync(
  path.join(apiRoot, 'prisma/migrations/20260729000500_finops_cost_verification/migration.sql'),
  'utf8',
);

describe('FIN-001 independent cost verification foundation', () => {
  it('adds an immutable, tenant-scoped maker-checker review ledger', () => {
    expect(migration).toContain('CREATE TABLE public."finops_cost_verification_reviews"');
    expect(migration).toContain('FOREIGN KEY ("tenant_id", "cost_entry_id")');
    expect(migration).toContain('FOREIGN KEY ("tenant_id", "reviewer_user_id")');
    expect(migration).toContain('FOREIGN KEY ("tenant_id", "evidence_id", "evidence_version")');
    expect(migration).toContain('cost_entry."recorded_by_user_id" = NEW."reviewer_user_id"');
    expect(migration).toContain('"finops_cost_verification_reviews_append_only"');
    expect(migration).toContain('pg_advisory_xact_lock');
    expect(migration).toContain('UNIQUE ("tenant_id", "cost_entry_id", "revision")');
    expect(migration).toContain('UNIQUE ("tenant_id", "idempotency_key")');
  });

  it('promotes cost only through active verified Evidence or an immutable trusted source', () => {
    for (const required of [
      `source_evidence."status" <> 'ACTIVE'`,
      `source_evidence."trust_level" <> 'VERIFIED'`,
      `source_evidence."verified_at" IS NULL`,
      `source_evidence."activated_at" IS NULL`,
      `source_evidence."revoked_at" IS NOT NULL`,
      `'RUNTIME_ATTESTED'`,
      `'PROVIDER_BILL'`,
      `'TRUSTED_SYSTEM'`,
      `review."decision" IN ('DISPUTED', 'REJECTED')`,
      `ELSE 'DISPUTED'::public."FinopsVerificationStatus"`,
    ]) {
      expect(migration).toContain(required);
    }
    expect(migration).toContain('WITH (security_barrier = true, security_invoker = true)');
    expect(migration).toContain('finops_effective_cost_verification_status');
  });

  it('forces RLS and exposes exact read/insert-only admin ACL', () => {
    expect(migration).toContain(
      'ALTER TABLE public."finops_cost_verification_reviews" ENABLE ROW LEVEL SECURITY',
    );
    expect(migration).toContain(
      'ALTER TABLE public."finops_cost_verification_reviews" FORCE ROW LEVEL SECURITY',
    );
    expect(migration).toContain('AS RESTRICTIVE');
    expect(migration).toContain('TO PUBLIC');
    expect(migration).toContain('TO enterprise_agent_admin');
    expect(migration).toContain('REVOKE ALL ON TABLE public."finops_cost_verification_reviews"');
    expect(migration).toContain(
      'GRANT SELECT, INSERT ON TABLE public."finops_cost_verification_reviews"',
    );
    expect(migration).not.toContain(
      'GRANT SELECT, INSERT, UPDATE ON TABLE public."finops_cost_verification_reviews"',
    );
  });

  it('makes ROI and budget consumers depend on effective verification', () => {
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.finops_budget_event_guard()');
    expect(migration).toContain('Settlement requires an effectively verified Cost Entry');
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION public.finops_budget_alert_projector()',
    );
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION public.finops_cost_review_budget_alert_projector()',
    );
  });
});
