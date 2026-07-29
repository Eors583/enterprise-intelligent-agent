import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(
    process.cwd(),
    'prisma/migrations/20260728001400_marketing_management_foundation/migration.sql',
  ),
  'utf8',
);

const TABLES = [
  'marketing_observations',
  'marketing_observation_evidence',
  'marketing_insights',
  'marketing_insight_observations',
  'marketing_products',
  'marketing_regions',
  'marketing_customer_segments',
  'marketing_targets',
  'marketing_action_plans',
  'marketing_action_items',
  'marketing_action_item_contributors',
  'marketing_action_item_dependencies',
] as const;

describe('marketing management database foundation', () => {
  it('creates relational master, matrix, evidence and action-plan records', () => {
    for (const table of TABLES) {
      expect(migration).toContain(`CREATE TABLE public.${table}`);
      expect(migration).toContain(`ALTER TABLE public.%I FORCE ROW LEVEL SECURITY`);
    }
    expect(migration).toContain('marketing_targets_objective_value_fkey');
    expect(migration).toContain('marketing_targets_objective_role_fkey');
    expect(migration).toContain('marketing_targets_objective_metric_fkey');
    expect(migration).toContain('marketing_action_items_task_fkey');
    expect(migration).toContain('marketing_products_governance_trigger');
  });

  it('keeps evidence/history append-only and enforces maker-checker publication', () => {
    expect(migration).toContain('marketing_observation_evidence_snapshot_trigger');
    expect(migration).toContain('Marketing insight requires an independent human reviewer');
    expect(migration).toContain('Marketing insight publisher must be independent from the maker');
    expect(migration).toContain('Marketing insight version content is immutable');
    expect(migration).toContain(
      'GRANT SELECT, INSERT ON TABLE public.%I TO enterprise_agent_admin',
    );
    expect(migration).not.toContain('GRANT DELETE');
  });

  it('guards activation, budget, task identity, acceptance and dependency cycles', () => {
    expect(migration).toContain('marketing_targets_activation_trigger');
    expect(migration).toContain('Marketing Action Plan exceeds Target period or budget');
    expect(migration).toContain(
      'Linked Task must bind the exact Target Strategy, Objective and Value Version',
    );
    expect(migration).toContain('Completed Marketing Action Item requires acceptance Evidence');
    expect(migration).toContain('marketing_action_dependencies_cycle_trigger');
    expect(migration).toContain('Completed Marketing Action Plan requires accepted terminal items');
  });
});
