import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const apiRoot = process.cwd().endsWith(path.join('apps', 'api'))
  ? process.cwd()
  : path.resolve(process.cwd(), 'apps/api');
const migration = readFileSync(
  path.join(apiRoot, 'prisma/migrations/20260728001700_finance_finops_foundation/migration.sql'),
  'utf8',
);

const TABLES = [
  'finops_price_snapshots',
  'finops_cost_entries',
  'finops_allocation_rules',
  'finops_dimension_members',
  'finops_allocation_sets',
  'finops_cost_allocations',
  'finops_benefit_claims',
  'finops_roi_formula_versions',
  'finops_roi_snapshots',
  'finops_budgets',
  'finops_budget_events',
  'finops_budget_alerts',
  'finops_model_routing_suggestions',
  'finops_commands',
] as const;

describe('FIN-001 database foundation', () => {
  it('creates the complete pricing, ledger, allocation, value, ROI and budget model', () => {
    for (const table of TABLES) {
      expect(migration).toContain(`CREATE TABLE public.${table}`);
    }
    for (const kind of ['MODEL', 'EMBEDDING', 'RERANK', 'TOOL', 'API', 'STORAGE', 'HUMAN_REVIEW']) {
      expect(migration).toContain(`'${kind}'`);
    }
  });

  it('keeps prices, ledger, allocation lines, ROI snapshots and budget events immutable', () => {
    expect(migration).toContain('Price snapshot content is immutable; create a new version');
    expect(migration).toContain('finops_cost_entries_append_only');
    expect(migration).toContain('finops_cost_allocations_append_only');
    expect(migration).toContain('finops_roi_snapshots_append_only');
    expect(migration).toContain('finops_budget_events_append_only');
    expect(migration).not.toContain('GRANT DELETE');
  });

  it('requires exact tenant-scoped business attribution and independent review', () => {
    for (const constraint of [
      'finops_cost_allocations_employee_fkey',
      'finops_cost_allocations_role_fkey',
      'finops_cost_allocations_task_fkey',
      'finops_cost_allocations_process_version_fkey',
      'finops_cost_allocations_customer_fkey',
      'finops_cost_allocations_project_fkey',
      'finops_cost_allocations_department_fkey',
      'finops_benefit_claims_deliverable_fkey',
      'finops_benefit_claims_acceptance_fkey',
      'finops_benefit_claims_evidence_fkey',
      'finops_benefit_claims_value_version_fkey',
      'finops_benefit_claims_objective_fkey',
    ]) {
      expect(migration).toContain(constraint);
    }
    expect(migration).toContain('Cost allocation requires independent human confirmation');
    expect(migration).toContain('Benefit requires an independent human checker');
  });

  it('recomputes ROI only from verified costs and confirmed benefits and rejects division by zero', () => {
    expect(migration).toContain(`c.verification_status = 'VERIFIED'`);
    expect(migration).toContain(`b.status = 'CONFIRMED'`);
    expect(migration).toContain(
      'ROI inputs must be recomputed from verified Costs and confirmed Benefits',
    );
    expect(migration).toContain('finops_roi_snapshots_zero_division_check');
    expect(migration).toContain(`NEW.status := 'INVALID_ZERO_COST'`);
  });

  it('enforces reservation hard limits while preserving settlement alerts and advisory routing', () => {
    expect(migration).toContain('Budget reservation would exceed the active hard limit');
    expect(migration).toContain('Settlement and release total cannot exceed the reservation');
    expect(migration).toContain('finops_budget_events_one_settlement_per_cost_idx');
    expect(migration).toContain('SETTLEMENT_MISMATCH');
    expect(migration).toContain('UNVERIFIED_COST');
    expect(migration).toContain('HARD_LIMIT_EXCEEDED');
    expect(migration).toContain('FinOps model routing is advisory and can never auto-apply');
    expect(migration).toContain('auto_applied = FALSE');
  });

  it('forces tenant RLS and exposes write capability only to the admin database role', () => {
    expect(migration).toContain('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY');
    expect(migration).toContain('AS RESTRICTIVE FOR ALL TO PUBLIC');
    expect(migration).toContain(
      'REVOKE ALL ON TABLE public.%I FROM PUBLIC, enterprise_agent_app, enterprise_agent_admin',
    );
    expect(migration).not.toContain(
      'GRANT SELECT, INSERT, UPDATE ON TABLE public.%I TO enterprise_agent_app',
    );
  });
});
