import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const migrationUrl = new URL(
  '../../../prisma/migrations/20260804000200_employment_work_email_override/migration.sql',
  import.meta.url,
);

describe('member email persistence contract', () => {
  it('persists directory overrides and makes action delivery evidence immutable', async () => {
    const migration = await readFile(migrationUrl, 'utf8');

    expect(migration).toContain('"work_email_overridden" boolean NOT NULL DEFAULT false');
    expect(migration).toContain('"delivery_target_evidence" varchar(24)');
    expect(migration).toContain("'LEGACY_INFERRED'");
    expect(migration).toContain("'ISSUED'");
    expect(migration).toContain('auth_action_tokens_delivery_target_immutable');
    expect(migration).toContain('IS DISTINCT FROM OLD."delivery_target_email"');
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public."enforce_auth_action_token_delivery_target_immutable"() FROM PUBLIC',
    );
  });
});
