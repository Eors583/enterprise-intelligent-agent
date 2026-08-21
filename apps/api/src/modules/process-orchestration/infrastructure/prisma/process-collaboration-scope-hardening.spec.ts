import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL(
    '../../../../../prisma/migrations/20260729002100_process_collaboration_scope_hardening/migration.sql',
    import.meta.url,
  ),
  'utf8',
);

describe('process collaboration scope hardening migration', () => {
  it('is one forward-only atomic migration', () => {
    expect(migration.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(migration.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(migration).not.toContain('ALTER TYPE');
    expect(migration).not.toContain('DROP TABLE');
    expect(migration).not.toContain('TRUNCATE');
  });

  it('enforces evidence JSON and normalized-row bijection from both sides', () => {
    const start = migration.indexOf(
      'CREATE OR REPLACE FUNCTION public.validate_process_collaboration_evidence_bijection()',
    );
    const end = migration.indexOf(
      'CREATE CONSTRAINT TRIGGER "business_events_scope_evidence_bijection_trigger"',
      start,
    );
    const validator = migration.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(validator).toContain('trigger_row := to_jsonb(OLD)');
    expect(validator).toContain('trigger_row := to_jsonb(NEW)');
    expect(validator).toContain(`parent_id := nullif(trigger_row->>TG_ARGV[1], '')::uuid`);
    expect(validator).not.toMatch(/(?:OLD|NEW)\."/);
    for (const trigger of [
      'business_events_scope_evidence_bijection_trigger',
      'business_event_evidence_scope_bijection_trigger',
      'correction_cases_scope_evidence_bijection_trigger',
      'correction_case_evidence_scope_bijection_trigger',
      'correction_feedback_scope_evidence_bijection_trigger',
      'correction_feedback_evidence_scope_bijection_trigger',
      'collaboration_messages_scope_evidence_bijection_trigger',
      'collaboration_message_evidence_scope_bijection_trigger',
    ]) {
      expect(migration).toContain(`CREATE CONSTRAINT TRIGGER "${trigger}"`);
    }
    expect(migration.match(/DEFERRABLE INITIALLY DEFERRED/g)).toHaveLength(10);
    expect(migration).toContain('duplicate_count <> 0');
    expect(migration).toContain(
      'json_count <> join_count OR missing_count <> 0 OR extra_count <> 0',
    );
    expect(migration).toContain('Evidence JSON and normalized rows must be an exact bijection.');
    expect(migration).toContain(`'BUSINESS_EVENT', 'business_event_id'`);
    expect(migration).toContain(`'CORRECTION_CASE', 'correction_case_id'`);
    expect(migration).toContain(`'CORRECTION_FEEDBACK', 'correction_feedback_id'`);
    expect(migration).toContain(`'COLLABORATION_MESSAGE', 'collaboration_message_id'`);
  });

  it('validates Task, action, organization and organization-unit scope independently', () => {
    const start = migration.indexOf(
      'CREATE OR REPLACE FUNCTION public.build_trusted_assignment_snapshot(',
    );
    const end = migration.indexOf('-- The schema represents the current attempt', start);
    const resolver = migration.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(resolver).toContain(`task_record."status" NOT IN ('READY', 'IN_PROGRESS', 'BLOCKED')`);
    expect(resolver).toContain(`"permission_scope"->'taskIds'`);
    expect(resolver).toContain(`"permission_scope"->'actions'`);
    expect(resolver).toContain(`"organization_scope"->'organizationIds'`);
    expect(resolver).toContain(`"organization_scope"->'orgUnitIds'`);
    expect(resolver).toContain(`jsonb_build_array(task_record."owner_organization_id"::text)`);
    expect(resolver).toContain(`jsonb_build_array(task_record."owner_org_unit_id"::text)`);
    expect(resolver).toContain('trusted_assignment_task_action_scope_check');
    expect(resolver).toContain('trusted_assignment_organization_scope_check');
    expect(resolver).toContain('trusted_assignment_org_unit_scope_check');
    expect(resolver).toMatch(
      /assignment_record\."permission_scope"->'taskIds'[\s\S]*?@> jsonb_build_array\(p_task_id::text\)/,
    );
    expect(resolver).toMatch(
      /IF assignment_record\."organization_scope" \? 'organizationIds' THEN[\s\S]*?END IF;\s+IF assignment_record\."organization_scope" \? 'orgUnitIds' THEN/,
    );
  });

  it('uses immutable RETRY commands as the aggregate attempt invariant', () => {
    const start = migration.indexOf(
      'CREATE OR REPLACE FUNCTION public.validate_process_step_retry_attempt_contract()',
    );
    const end = migration.indexOf(
      'CREATE CONSTRAINT TRIGGER "process_step_instances_retry_attempt_contract_trigger"',
      start,
    );
    const validator = migration.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(validator).toContain('trigger_row := to_jsonb(OLD)');
    expect(validator).toContain('trigger_row := to_jsonb(NEW)');
    expect(validator).not.toMatch(/(?:OLD|NEW)\."/);
    expect(migration).toMatch(
      /command\."command" = 'RETRY'[\s\S]*?step_record\."attempt" <> retry_count \+ 1/,
    );
    expect(migration).toContain('process_step_instances_retry_attempt_contract_trigger');
    expect(migration).toContain('process_step_commands_retry_attempt_contract_trigger');
    expect(migration).toContain(`step_record."status" <> 'READY'`);
    expect(migration).toContain(`command_kind <> 'RETRY' AND command_payload ? 'attempt'`);
    expect(migration).toContain(`'COMMAND', 'process_step_instance_id'`);
    expect(migration).toContain('A declared RETRY attempt must equal the aggregate attempt.');
  });

  it('requires reviewers for new Corrections while preserving a bounded legacy terminal path', () => {
    expect(migration).toContain('CREATE TRIGGER "correction_cases_reviewer_liveness_trigger"');
    expect(migration).toContain('jsonb_array_length(NEW."required_role_assignment_ids") = 0');
    expect(migration).toContain('legacy_independent_reviewer boolean;');
    expect(migration).toMatch(
      /legacy_independent_reviewer :=[\s\S]*?jsonb_array_length\(correction_record\."required_role_assignment_ids"\) = 0[\s\S]*?AND NOT high_impact[\s\S]*?AND NOT actor_is_subject[\s\S]*?actor_user IS DISTINCT FROM subject_user_id/,
    );
    expect(migration).toMatch(
      /NEW\."action" IN \('ACCEPT', 'RESOLVE', 'CANCEL'\)[\s\S]*?AND NOT actor_is_reviewer[\s\S]*?AND NOT legacy_independent_reviewer/,
    );
  });

  it('blocks Correction feedback after its Task becomes terminal', () => {
    expect(migration).toContain(`task_status NOT IN ('READY', 'IN_PROGRESS', 'BLOCKED')`);
    expect(migration).toContain('correction_feedback_active_task_check');
    expect(migration).toContain('A terminal or missing Task cannot advance a Correction.');
  });

  it('serializes active participants by resolved human and Agent identity', () => {
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "collaboration_participants_scope_active_user_key"',
    );
    expect(migration).toMatch(/"tenant_id", "collaboration_id", "user_id"[\s\S]*?WHERE "active"/);
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "collaboration_participants_scope_active_agent_key"',
    );
    expect(migration).toMatch(
      /"tenant_id", "collaboration_id", "agent_id"[\s\S]*?WHERE "active" AND "agent_id" IS NOT NULL/,
    );
  });

  it('requires exact replay actor, timestamp and capability authorization', () => {
    const start = migration.indexOf(
      'CREATE OR REPLACE FUNCTION public.guard_event_delivery_replay_attribution_v3()',
    );
    const end = migration.indexOf(
      'CREATE TRIGGER "business_event_deliveries_replay_attribution_v3_trigger"',
      start,
    );
    const guard = migration.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(guard).toContain("nullif(current_setting('app.tenant_id', true), '')::uuid");
    expect(guard).toContain("nullif(current_setting('app.user_id', true), '')::uuid");
    expect(guard).toContain("pg_has_role(current_user, 'enterprise_agent_process', 'USAGE')");
    expect(guard).toContain('NEW."replayed_by_user_id" IS DISTINCT FROM session_user_id');
    expect(guard).toContain('NEW."replayed_at" IS DISTINCT FROM statement_timestamp()');
    expect(guard).toContain(`replay_actor."role" IN ('OWNER', 'ADMIN')`);
    expect(guard).toContain(`replay_actor."status" = 'ACTIVE'`);
    expect(guard).not.toContain(`interval '5 minutes'`);
  });
});
