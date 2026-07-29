import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationPath = resolve(
  process.cwd(),
  'prisma/migrations/20260729001800_process_step_task_lifecycle_guard/migration.sql',
);

describe('Process Step Task lifecycle hardening migration', () => {
  const migration = readFileSync(migrationPath, 'utf8');

  it('allows ordinary progression only while the Task is active', () => {
    expect(migration).toContain(`task_status NOT IN ('READY', 'IN_PROGRESS', 'BLOCKED')`);
    expect(migration).toContain('process_step_task_lifecycle_active');
    expect(migration).toContain('JOIN public."tasks" task');
  });

  it('keeps cancellation and compensation as explicit terminal-Task paths', () => {
    expect(migration).toContain(`NEW."status" IN (`);
    expect(migration).toContain(`'CANCELLED'`);
    expect(migration).toContain(`'COMPENSATING'`);
    expect(migration).toContain(`NEW."compensation_for_step_id" IS NOT NULL`);
    expect(migration).toContain(`node_type = 'COMPENSATION'`);
  });

  it('guards both new steps and status transitions without changing historical migrations', () => {
    expect(migration).toContain('process_step_task_lifecycle_insert_trigger');
    expect(migration).toContain('process_step_task_lifecycle_transition_trigger');
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.guard_process_step_task_lifecycle() FROM PUBLIC',
    );
  });
});
