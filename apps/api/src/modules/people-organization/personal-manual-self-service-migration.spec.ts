import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(
    process.cwd(),
    'prisma/migrations/20260811000100_member_profile_self_service/migration.sql',
  ),
  'utf8',
);
const ownershipMigration = readFileSync(
  resolve(
    process.cwd(),
    'prisma/migrations/20260811000200_member_profile_self_owned/migration.sql',
  ),
  'utf8',
);

describe('member profile self-service migration', () => {
  it('grants only insert/update and binds both policies to the current user', () => {
    expect(migration).toContain(
      'GRANT INSERT, UPDATE ON public."member_profiles" TO enterprise_agent_app',
    );
    expect(migration).not.toContain(
      'GRANT DELETE ON public."member_profiles" TO enterprise_agent_app',
    );
    expect(migration).toContain('enterprise_agent_app_self_insert');
    expect(migration).toContain('enterprise_agent_app_self_update');
    expect(migration.match(/current_setting\('app\.user_id', true\)/g)).toHaveLength(3);
  });

  it('revokes administrator writes while preserving tenant-scoped read access', () => {
    expect(ownershipMigration).toContain(
      'REVOKE INSERT, UPDATE, DELETE ON public."member_profiles" FROM enterprise_agent_admin',
    );
    expect(ownershipMigration).toContain('DROP POLICY IF EXISTS enterprise_agent_admin_access');
    expect(ownershipMigration).toContain('enterprise_agent_admin_read');
    expect(ownershipMigration).not.toContain('FOR ALL TO enterprise_agent_admin');
  });
});
