import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL(
    '../../../../../prisma/migrations/20260729000400_process_collaboration_integrity_hardening/migration.sql',
    import.meta.url,
  ),
  'utf8',
);
const deployedCompatibilityMigration = readFileSync(
  new URL(
    '../../../../../prisma/migrations/20260729000700_process_collaboration_deployed_integrity_hardening/migration.sql',
    import.meta.url,
  ),
  'utf8',
);

describe('process and collaboration additive integrity hardening', () => {
  it('is one additive atomic migration', () => {
    expect(migration.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(migration.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(migration).not.toContain('DROP TABLE');
    expect(migration).not.toContain('ALTER TYPE');
  });

  it('enforces evidence JSON-to-join bijection from both mutation directions', () => {
    expect(migration).toContain('validate_business_ledger_parent_bijection');
    for (const table of [
      'business_event_evidence',
      'correction_case_evidence',
      'correction_feedback_evidence',
    ]) {
      expect(migration).toContain(`CREATE CONSTRAINT TRIGGER "${table}_parent_bijection_trigger"`);
    }
    expect(migration.match(/DEFERRABLE INITIALLY DEFERRED/g)).toHaveLength(3);
    expect(migration).toContain(`CONSTRAINT = TG_TABLE_NAME || '_parent_bijection'`);
    expect(migration).toContain('parent_count <> join_count');
    expect(migration).toContain('mismatch_count <> 0');
  });

  it('fails closed unless task, action and canonical or legacy organization scope match', () => {
    const start = migration.indexOf(
      'CREATE OR REPLACE FUNCTION public.build_trusted_assignment_snapshot(',
    );
    const end = migration.indexOf(
      'CREATE OR REPLACE FUNCTION public.guard_process_step_attempt_integrity()',
      start,
    );
    const resolver = migration.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(resolver).toContain(`"permission_scope"->'taskIds'`);
    expect(resolver).toContain(`"permission_scope"->'actions'`);
    expect(resolver).toContain(`"organization_scope"->'organizationIds'`);
    expect(resolver).toContain(`"organization_scope"->'orgUnitIds'`);
    expect(resolver).toContain('OR p_task_id IS NULL');
    expect(resolver).toContain('OR p_required_action IS NULL');
    expect(resolver).toMatch(
      /NOT \(assignment_record\."organization_scope" \? 'organizationIds'\)[\s\S]*?NOT \(assignment_record\."organization_scope" \? 'orgUnitIds'\)/,
    );
    expect(resolver).not.toContain(`AND p_required_action <> 'business.task.execute'`);
    expect(resolver).toContain(
      'Role Assignment is outside the trusted Task/action/organization scope.',
    );
  });

  it('applies the same canonical and legacy organization scope rules to process steps', () => {
    const start = migration.indexOf(
      'CREATE OR REPLACE FUNCTION public.build_process_step_assignment_snapshot(',
    );
    const end = migration.indexOf(
      'CREATE OR REPLACE FUNCTION public.build_trusted_assignment_snapshot(',
      start,
    );
    const resolver = migration.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(resolver).toContain(`"permission_scope"->'taskIds'`);
    expect(resolver).toContain(`"permission_scope"->'actions'`);
    expect(resolver).toContain(`"organization_scope"->'organizationIds'`);
    expect(resolver).toContain(`"organization_scope"->'orgUnitIds'`);
    expect(resolver).toContain(`OR required_action IS NULL`);
  });

  it('starts at attempt one and clears all previous-attempt state on RETRY', () => {
    expect(migration).toContain('process_step_instances_initial_attempt_check');
    expect(migration).toContain('process_step_instances_retry_reset_check');
    expect(migration).toMatch(
      /OLD\."status" IN \('REJECTED', 'TIMED_OUT', 'FAILED'\)[\s\S]*?NEW\."status" = 'READY'[\s\S]*?NEW\."attempt" <> OLD\."attempt" \+ 1/,
    );
    for (const field of [
      'output',
      'failure_code',
      'failure_detail',
      'claimed_at',
      'started_at',
      'completed_at',
      'timed_out_at',
    ]) {
      expect(migration).toContain(`NEW."${field}" IS NOT NULL`);
    }
    expect(migration).toContain(
      'CREATE TRIGGER "process_step_instances_attempt_integrity_trigger"',
    );
    const transitionStart = migration.indexOf(
      'CREATE OR REPLACE FUNCTION public.guard_process_step_transition()',
    );
    const transitionEnd = migration.indexOf(
      '-- A LOW correction may be closed directly',
      transitionStart,
    );
    const transition = migration.slice(transitionStart, transitionEnd);
    expect(transitionStart).toBeGreaterThanOrEqual(0);
    expect(transitionEnd).toBeGreaterThan(transitionStart);
    expect(transition).toContain('is_retry boolean;');
    expect(transition.match(/AND NOT is_retry/g)).toHaveLength(6);
  });

  it('allows only an independent nominated reviewer to close an OPEN LOW correction', () => {
    expect(migration).toMatch(
      /NEW\."action" = 'RESOLVE'[\s\S]*?correction_record\."severity" = 'LOW'[\s\S]*?correction_record\."status" = 'OPEN'/,
    );
    expect(migration).toMatch(
      /NEW\."action" IN \('ACCEPT', 'RESOLVE', 'CANCEL'\)[\s\S]*?AND NOT actor_is_reviewer/,
    );
    expect(migration).toContain(
      `correction_record."required_role_assignment_ids"\n      ? NEW."actor_role_assignment_id"::text`,
    );
    expect(migration).toContain(`NEW."action" IN ('REJECT', 'EXPLAIN', 'ESCALATE', 'RESOLVE')`);
    expect(migration).toMatch(/OLD\."severity" = 'LOW' AND OLD\."status" = 'OPEN'/);
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.validate_correction_trace()');
    expect(migration).toMatch(/current_record\."severity" = 'LOW' AND replay_status = 'OPEN'/);
  });
});

describe('deployed process and collaboration compatibility hardening', () => {
  it('is one atomic additive migration that can follow an already-installed foundation', () => {
    expect(deployedCompatibilityMigration.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(deployedCompatibilityMigration.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(deployedCompatibilityMigration).not.toContain('DROP TABLE');
    expect(deployedCompatibilityMigration).not.toContain('ALTER TYPE');
    expect(deployedCompatibilityMigration).not.toContain(
      '20260728000600_business_event_collaboration_foundation',
    );
  });

  it('serializes active participant identity by resolved user and Agent', () => {
    expect(deployedCompatibilityMigration).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "collaboration_participants_active_user_key"',
    );
    expect(deployedCompatibilityMigration).toMatch(
      /"tenant_id", "collaboration_id", "user_id"[\s\S]*?WHERE "active"/,
    );
    expect(deployedCompatibilityMigration).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "collaboration_participants_active_agent_key"',
    );
    expect(deployedCompatibilityMigration).toMatch(
      /"tenant_id", "collaboration_id", "agent_id"[\s\S]*?WHERE "active" AND "agent_id" IS NOT NULL/,
    );
  });

  it('prevents new reviewer-less corrections and gives only legacy low-impact rows a bounded path', () => {
    expect(deployedCompatibilityMigration).toContain(
      'CREATE TRIGGER "correction_cases_reviewer_liveness_trigger"',
    );
    expect(deployedCompatibilityMigration).toContain(
      'jsonb_array_length(NEW."required_role_assignment_ids") = 0',
    );
    expect(deployedCompatibilityMigration).toContain('legacy_independent_reviewer boolean;');
    expect(deployedCompatibilityMigration).toMatch(
      /jsonb_array_length\(correction_record\."required_role_assignment_ids"\) = 0[\s\S]*?AND NOT high_impact[\s\S]*?AND NOT actor_is_subject[\s\S]*?actor_user IS DISTINCT FROM subject_user_id/,
    );
    expect(deployedCompatibilityMigration).toMatch(
      /requires_evidence :=[\s\S]*?OR legacy_independent_reviewer/,
    );
    expect(deployedCompatibilityMigration).toMatch(
      /NEW\."action" IN \('ACCEPT', 'RESOLVE', 'CANCEL'\)[\s\S]*?AND NOT actor_is_reviewer[\s\S]*?AND NOT legacy_independent_reviewer/,
    );
  });

  it('binds every dead-letter replay to the active tenant administrator and bounded time', () => {
    expect(deployedCompatibilityMigration).toContain(
      'CREATE TRIGGER "business_event_deliveries_replay_attribution_v2_trigger"',
    );
    expect(deployedCompatibilityMigration).toContain(
      "nullif(current_setting('app.tenant_id', true), '')::uuid",
    );
    expect(deployedCompatibilityMigration).toContain(
      "nullif(current_setting('app.user_id', true), '')::uuid",
    );
    expect(deployedCompatibilityMigration).toContain(
      'NEW."replayed_by_user_id" IS DISTINCT FROM session_user_id',
    );
    expect(deployedCompatibilityMigration).toContain(`replay_actor."role" IN ('OWNER', 'ADMIN')`);
    expect(deployedCompatibilityMigration).toContain(`replay_actor."status" = 'ACTIVE'`);
    expect(deployedCompatibilityMigration).toContain(
      `statement_timestamp() - interval '5 minutes'`,
    );
    expect(deployedCompatibilityMigration).toContain(
      'NEW."available_at" IS DISTINCT FROM NEW."replayed_at"',
    );
  });
});
