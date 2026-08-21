import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const apiRoot = process.cwd().endsWith(path.join('apps', 'api'))
  ? process.cwd()
  : path.resolve(process.cwd(), 'apps/api');
const moduleRoot = path.join(apiRoot, 'src/modules/business-semantics');
const migration = readFileSync(
  path.join(
    apiRoot,
    'prisma/migrations/20260728000400_business_semantics_foundation/migration.sql',
  ),
  'utf8',
);

const semanticTables = [
  'value_definitions',
  'value_versions',
  'value_metrics',
  'value_constraints',
  'strategies',
  'strategy_value_versions',
  'objectives',
  'objective_value_versions',
  'objective_role_assignments',
  'objective_relations',
  'metric_definitions',
  'objective_metric_definitions',
  'process_definitions',
  'process_versions',
  'process_nodes',
  'tasks',
  'task_dependencies',
  'deliverables',
  'acceptances',
  'evidence',
  'metric_observations',
  'evidence_links',
  'metric_observation_evidence',
  'deliverable_evidence',
  'acceptance_evidence',
] as const;

describe('business semantics database foundation', () => {
  it('creates every tenant-owned table and applies the fixed RLS/ACL boundary', () => {
    expect(semanticTables).toHaveLength(25);
    for (const table of semanticTables) {
      expect(migration).toContain(`CREATE TABLE public."${table}"`);
      expect(migration).toContain(`'${table}'`);
    }
    expect(migration).toContain('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY');
    expect(migration).toContain('CREATE POLICY tenant_isolation ON public.%I');
    expect(migration).toContain('CREATE POLICY enterprise_agent_access ON public.%I');
    expect(migration).toContain('CREATE POLICY enterprise_agent_admin_access ON public.%I');
    expect(migration).toContain('GRANT SELECT ON TABLE public.%I TO enterprise_agent_app');
    expect(migration).toContain(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO enterprise_agent_admin',
    );
  });

  it('binds task process identity and AgentRun context with composite foreign keys', () => {
    for (const constraint of [
      'tasks_objective_value_fkey',
      'tasks_process_definition_fkey',
      'tasks_process_version_fkey',
      'tasks_process_node_fkey',
      'agent_runs_tenant_task_id_fkey',
    ]) {
      expect(migration).toContain(`ADD CONSTRAINT "${constraint}"`);
    }
    expect(migration).toContain('ADD COLUMN "task_id" UUID');
    expect(migration).toContain('CREATE INDEX "agent_runs_tenant_task_id_idx"');
    expect(migration).toContain('CREATE TRIGGER "agent_runs_task_id_immutability_trigger"');
  });

  it('defers terminal completeness and reverse evidence checks until commit', () => {
    for (const trigger of [
      'tasks_completion_integrity_trigger',
      'deliverables_task_completion_reverse_trigger',
      'deliverable_evidence_task_completion_reverse_trigger',
      'acceptances_task_completion_reverse_trigger',
      'acceptance_evidence_task_completion_reverse_trigger',
      'metric_observation_evidence_parent_complete_trigger',
      'deliverable_evidence_parent_complete_trigger',
      'acceptance_evidence_parent_complete_trigger',
    ]) {
      expect(migration).toContain(`CREATE CONSTRAINT TRIGGER "${trigger}"`);
    }
    expect(migration.match(/DEFERRABLE INITIALLY DEFERRED/g)?.length ?? 0).toBeGreaterThanOrEqual(
      15,
    );
    expect(migration).toContain('assert_task_completion_integrity');
    expect(migration).toContain("task_status NOT IN ('DELIVERED', 'ACCEPTED', 'REJECTED')");
    expect(migration).toContain('validate_evidence_association_parent');
  });

  it('guards lifecycle eligibility, graph cycles, and exact active process identity', () => {
    for (const required of [
      'tasks_reference_eligibility_trigger',
      'objectives_parent_cycle_trigger',
      'task_dependencies_cycle_trigger',
      'process_definitions_active_current_version_trigger',
      'process_versions_active_definition_reverse_trigger',
      'value_versions_open_tasks_retirement_trigger',
      'strategies_open_tasks_retirement_trigger',
      'objectives_open_tasks_retirement_trigger',
      'process_definitions_open_tasks_retirement_trigger',
      'process_versions_open_tasks_retirement_trigger',
      'process_versions_one_published_per_definition_idx',
    ]) {
      expect(migration).toContain(required);
    }
    expect(migration).toContain("CONSTRAINT = 'process_definitions_active_current_version_check'");
    expect(migration).toContain("\"status\" NOT IN ('ACCEPTED', 'REJECTED', 'CANCELLED')");
  });

  it('compares polymorphic publication statuses as text instead of cross-casting enum literals', () => {
    for (const comparison of [
      `NEW."status"::text = 'PUBLISHED'`,
      `OLD."status"::text <> 'PUBLISHED'`,
      `NEW."status"::text = 'ACTIVE'`,
      `OLD."status"::text <> 'ACTIVE'`,
      `NEW."status"::text IN ('ACTIVE', 'AT_RISK')`,
      `OLD."status"::text = 'DRAFT'`,
    ]) {
      expect(migration).toContain(comparison);
    }
    expect(migration).toContain('definition."current_version_id"');
    expect(migration).toContain('process_version."id" = current_version_id');
  });
});

describe('business semantics service boundaries', () => {
  const mutationPolicyCounts = new Map<string, number>([
    ['value-admin.service.ts', 5],
    ['strategy-admin.service.ts', 3],
    ['objective-admin.service.ts', 3],
    ['metric-admin.service.ts', 3],
    ['process-admin.service.ts', 5],
    ['task-admin.service.ts', 3],
    ['evidence-admin.service.ts', 3],
    ['objective-relation-admin.service.ts', 3],
    ['metric-observation-admin.service.ts', 2],
    ['task-dependency-admin.service.ts', 3],
    ['deliverable-acceptance-admin.service.ts', 6],
    ['evidence-link-admin.service.ts', 3],
  ]);

  it('keeps resources split and policy-gates every mutation entry point', () => {
    expect(existsSync(path.join(moduleRoot, 'business-semantics-admin.service.ts'))).toBe(false);
    let total = 0;
    for (const [file, expectedCount] of mutationPolicyCounts) {
      const fullPath = path.join(moduleRoot, file);
      const source = readFileSync(fullPath, 'utf8');
      const count = source.match(/this\.policy\.requireWrite/g)?.length ?? 0;
      expect(count, file).toBe(expectedCount);
      expect(statSync(fullPath).size, file).toBeLessThan(40_000);
      total += count;
    }
    expect(total).toBe(42);
  });

  it('uses an optional idempotency header on every create route', () => {
    const controllerFiles = [
      'value-admin.controller.ts',
      'strategy-admin.controller.ts',
      'objective-admin.controller.ts',
      'metric-admin.controller.ts',
      'process-admin.controller.ts',
      'task-admin.controller.ts',
      'deliverable-acceptance-admin.controller.ts',
      'evidence-admin.controller.ts',
    ];
    const headerCount = controllerFiles.reduce((count, file) => {
      const source = readFileSync(path.join(moduleRoot, file), 'utf8');
      return count + (source.match(/@Headers\('idempotency-key'\)/g)?.length ?? 0);
    }, 0);
    expect(headerCount).toBe(16);
  });
});
