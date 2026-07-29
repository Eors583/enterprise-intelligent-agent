import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(
    process.cwd(),
    'prisma/migrations/20260729002800_process_instance_task_lifecycle_guard/migration.sql',
  ),
  'utf8',
);
const repository = readFileSync(
  new URL('./infrastructure/prisma/prisma-process-runtime.repository.ts', import.meta.url),
  'utf8',
);

describe('Process Instance Task lifecycle hardening', () => {
  it('blocks ordinary Process Instance progression after the Task becomes terminal', () => {
    expect(migration).toContain(`task_status NOT IN ('READY', 'IN_PROGRESS', 'BLOCKED')`);
    expect(migration).toContain('process_instances_task_lifecycle_active');
    expect(migration).toContain('BEFORE UPDATE OF "status" ON public."process_instances"');
  });

  it('preserves only cancellation and compensation as terminal-Task paths', () => {
    for (const status of [
      `'CANCELLED'`,
      `'COMPENSATING'`,
      `'COMPENSATED'`,
      `'COMPENSATION_FAILED'`,
    ]) {
      expect(migration).toContain(status);
    }
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.guard_process_instance_task_lifecycle() FROM PUBLIC',
    );
  });

  it('fails early in the repository while retaining the database trigger as the final guard', () => {
    expect(repository).toContain('loadProcessTaskStatus(');
    expect(repository).toContain('ACTIVE_PROCESS_TASK_STATUSES');
    expect(repository).toContain('PROCESS_TASK_TERMINATION_COMMANDS');
    expect(repository).toContain('permits only cancellation or compensation commands');
  });
});
