import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL(
    '../../../prisma/migrations/20260728002300_employee_experience_usage_access/migration.sql',
    import.meta.url,
  ),
  'utf8',
);
const repository = readFileSync(
  new URL('./infrastructure/prisma-employee-insights.repository.ts', import.meta.url),
  'utf8',
);

describe('employee Experience and AI usage access gate', () => {
  it('uses an independent non-bypass role and never elevates employee reads to admin', () => {
    expect(migration).toContain('CREATE ROLE enterprise_agent_employee_insights');
    expect(migration).toContain('NOINHERIT NOBYPASSRLS');
    expect(repository).toContain('SET LOCAL ROLE enterprise_agent_employee_insights');
    expect(repository).not.toContain('AdminPrismaService');
    expect(repository).not.toContain('enterprise_agent_admin');
  });

  it('limits candidate writes to append-only contribution and excludes governance tables', () => {
    expect(migration).toContain('GRANT SELECT, INSERT ON TABLE\n  public."experience_candidates"');
    expect(migration).not.toMatch(
      /GRANT\s+(?:[^;]*\s)?UPDATE[^;]*TO enterprise_agent_employee_insights/iu,
    );
    expect(migration).not.toMatch(
      /GRANT\s+(?:[^;]*\s)?DELETE[^;]*TO enterprise_agent_employee_insights/iu,
    );
    for (const table of [
      'experience_commands',
      'experience_review_evidence',
      'experience_validations',
      'experience_publications',
    ]) {
      expect(migration).not.toContain(`GRANT SELECT, INSERT ON TABLE\n  public."${table}"`);
    }
  });

  it('binds every employee policy to both tenant and current user context', () => {
    expect(migration).toContain("current_setting('app.tenant_id', true)");
    expect(migration).toContain("current_setting('app.user_id', true)");
    expect(migration).toContain('"contributor_user_id" =');
    expect(migration).toContain('"requester_user_id" =');
    expect(migration).toContain('employee_insights_task_authorized');
    expect(migration).toContain('employee_insights_evidence_authorized');
    expect(migration).toContain('employee_insights_candidate_select');
    expect(migration).toContain('employee_insights_run_select');
  });

  it('treats terminal 0/0/0 token rows as unreported rather than trusted usage', () => {
    expect(repository).toContain('run."usage_recorded_at" IS NOT NULL');
    expect(repository).toContain('run."input_tokens" > 0');
    expect(repository).toContain('run."output_tokens" > 0');
    expect(repository).toContain('run."total_tokens" > 0');
    expect(repository).toContain('run."input_tokens" = 0');
    expect(repository).toContain('run."output_tokens" = 0');
    expect(repository).toContain('run."total_tokens" = 0');
  });
});
