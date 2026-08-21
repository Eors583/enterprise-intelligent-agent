import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL(
    '../../../../../prisma/migrations/20260729002200_process_collaboration_scope_runtime_fix/migration.sql',
    import.meta.url,
  ),
  'utf8',
);
const deployedFixMigration = readFileSync(
  new URL(
    '../../../../../prisma/migrations/20260729002500_process_collaboration_scope_lock_fix/migration.sql',
    import.meta.url,
  ),
  'utf8',
);

describe('process collaboration runtime scope fix migration', () => {
  it('is one forward-only atomic function replacement', () => {
    expect(migration.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(migration.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION public.build_trusted_assignment_snapshot(',
    );
    expect(migration).not.toContain('ALTER TYPE');
    expect(migration).not.toContain('DROP TABLE');
    expect(migration).not.toContain('TRUNCATE');
  });

  it('derives a missing Task organization snapshot only through its trusted owner Assignment', () => {
    expect(migration).toContain('LEFT JOIN public."role_assignments" task_owner_assignment');
    expect(migration).toContain('task_owner_assignment."id" = task."owner_role_assignment_id"');
    expect(migration).toContain('LEFT JOIN public."employments" task_owner_employment');
    expect(migration).toContain(
      'task_owner_employment."id" = task_owner_assignment."employment_id"',
    );
    expect(migration).toContain('resolved_owner_unit."status" AS resolved_owner_org_unit_status');
    expect(migration).toContain(`task_record."resolved_owner_org_unit_status" <> 'ACTIVE'`);
    expect(migration).toContain('Task owner Assignment and explicit organization scope disagree.');
    expect(migration).toContain('Task has no trusted owner organization context.');
  });

  it('keeps exact Task, action, label, organization and org-unit checks', () => {
    expect(migration).toContain(`task_record."status" NOT IN ('READY', 'IN_PROGRESS', 'BLOCKED')`);
    expect(migration).toContain(`assignment_record."permission_scope"->'taskIds'`);
    expect(migration).toContain(`assignment_record."permission_scope"->'actions'`);
    expect(migration).toContain(`assignment_record."permission_scope"->'dataLabels'`);
    expect(migration).toContain(`assignment_record."organization_scope"->'organizationIds'`);
    expect(migration).toContain(`assignment_record."organization_scope"->'orgUnitIds'`);
    expect(migration).toContain('jsonb_build_array(task_organization_id::text)');
    expect(migration).toContain('jsonb_build_array(task_org_unit_id::text)');
    expect(migration).toContain('trusted_assignment_task_action_scope_check');
    expect(migration).toContain('trusted_assignment_organization_scope_check');
    expect(migration).toContain('trusted_assignment_org_unit_scope_check');
  });

  it('retains the process-only helper ACL boundary', () => {
    expect(migration).toContain('FROM PUBLIC, enterprise_agent_app, enterprise_agent_admin,');
    expect(migration).toContain('TO enterprise_agent_process;');
  });

  it('forward-replaces the full resolver for databases that applied the first 022 draft', () => {
    expect(deployedFixMigration.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(deployedFixMigration.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(deployedFixMigration).toContain(
      'CREATE OR REPLACE FUNCTION public.build_trusted_assignment_snapshot(',
    );
    expect(deployedFixMigration).toContain('FOR SHARE OF task;');
    expect(deployedFixMigration).not.toMatch(/FOR SHARE OF\s+task,\s+explicit_owner_unit/u);
    expect(deployedFixMigration).toContain(
      'Task owner Assignment and explicit organization scope disagree.',
    );
    expect(deployedFixMigration).toContain('trusted_assignment_task_action_scope_check');
    expect(deployedFixMigration).toContain('trusted_assignment_org_unit_scope_check');
    expect(deployedFixMigration).toContain('TO enterprise_agent_process;');
  });
});
