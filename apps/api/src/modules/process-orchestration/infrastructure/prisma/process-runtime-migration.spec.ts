import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL(
    '../../../../../prisma/migrations/20260728000500_process_runtime_foundation/migration.sql',
    import.meta.url,
  ),
  'utf8',
);

describe('process runtime migration/domain parity', () => {
  it('selects the START UUID through an aggregate supported by PostgreSQL', () => {
    expect(migration).toContain(`(min("id"::text) FILTER (WHERE "type" = 'START'))::uuid`);
    expect(migration).not.toContain(`min("id") FILTER (WHERE "type" = 'START')`);
    expect(migration).toContain(
      `(row_data->>'tenant_id') || ':process-graph:' || (row_data->>'process_version_id')`,
    );
  });

  it('permits the READY TIMEOUT transition implemented by the domain state machine', () => {
    const start = migration.indexOf(
      'CREATE OR REPLACE FUNCTION public.guard_process_step_transition()',
    );
    const end = migration.indexOf(
      'CREATE TRIGGER "process_step_instances_transition_trigger"',
      start,
    );
    const guard = migration.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(guard).toMatch(
      /OLD\."status" = 'READY'[\s\S]*?NEW\."status" IN \([\s\S]*?'RUNNING', 'TIMED_OUT', 'CANCELLED', 'SKIPPED'/,
    );
  });
});
