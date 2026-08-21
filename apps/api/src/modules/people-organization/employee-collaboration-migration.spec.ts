import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(
    process.cwd(),
    'prisma/migrations/20260813000400_employee_agent_collaboration_p0/migration.sql',
  ),
  'utf8',
);

describe('employee collaboration P0 migration', () => {
  it('keeps every historical manual section private by default', () => {
    expect(migration).toContain(
      `'{"IDENTITY":"SELF_ONLY","RESPONSIBILITIES":"SELF_ONLY","COLLABORATION":"SELF_ONLY","RESOURCES":"SELF_ONLY","INTERESTS":"SELF_ONLY","FAQ":"SELF_ONLY"}'::jsonb`,
    );
    expect(migration).toContain('"manual_sharing_enabled" boolean NOT NULL DEFAULT false');
    expect(migration).toContain('"availability_sharing_enabled" boolean NOT NULL DEFAULT false');
  });

  it('allows application writes only for the current user and keeps administrators read-only', () => {
    expect(migration).toContain(
      'ALTER TABLE public."work_availabilities" FORCE ROW LEVEL SECURITY',
    );
    expect(migration).toContain('work_availabilities_app_self_insert');
    expect(migration).toContain('work_availabilities_app_self_update');
    expect(migration.match(/current_setting\('app\.user_id', true\)/g)).toHaveLength(3);
    expect(migration).toContain(
      'GRANT SELECT ON public."work_availabilities" TO enterprise_agent_admin',
    );
    expect(migration).not.toContain(
      'GRANT INSERT, UPDATE ON public."work_availabilities" TO enterprise_agent_admin',
    );
  });

  it('stores only a collaboration snapshot on Agent Run rather than granting employee permissions', () => {
    expect(migration).toContain('ADD COLUMN "collaboration_context_snapshot" jsonb');
    expect(migration).not.toMatch(/permission.*grant|delegated.*permission/iu);
  });
});
