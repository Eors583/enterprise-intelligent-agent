import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  join(process.cwd(), 'prisma/migrations/20260729001600_agent_run_token_evidence/migration.sql'),
  'utf8',
);

describe('Agent Run token evidence migration', () => {
  it('keeps provider usage, conservative quota charges, and unreported usage distinct', () => {
    expect(migration).toContain('AgentRunTokenEvidence');
    expect(migration).toContain("'PROVIDER_REPORTED'");
    expect(migration).toContain("'QUOTA_UPPER_BOUND'");
    expect(migration).toContain('"quota_charged_tokens"');
    expect(migration).toContain('"quota_settled_at"');
    expect(migration).toContain('"usage_recorded_at" IS NULL');
  });

  it('converts only confirmed terminal reservations and preserves UNKNOWN holds', () => {
    expect(migration).toMatch(
      /"status" IN \([\s\S]*?'SUCCEEDED'[\s\S]*?'FAILED'[\s\S]*?'CANCELLED'[\s\S]*?\)[\s\S]*?"reserved_tokens" > 0/u,
    );
    expect(migration).toContain('"status" <> \'UNKNOWN\'::public."AgentRunStatus"');
    expect(migration).toContain('agent_runs_unknown_quota_hold_check');
  });

  it('does not infer trusted provider evidence from legacy all-zero usage', () => {
    expect(migration).toMatch(/"token_evidence" = 'PROVIDER_REPORTED'[\s\S]*?"total_tokens" > 0/u);
    expect(migration).not.toMatch(/SET\s+"input_tokens"\s*=\s*0[\s\S]*?"usage_recorded_at"/u);
  });
});
