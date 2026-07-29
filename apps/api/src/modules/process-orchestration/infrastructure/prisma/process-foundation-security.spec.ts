import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const processMigration = readFileSync(
  new URL(
    '../../../../../prisma/migrations/20260728000500_process_runtime_foundation/migration.sql',
    import.meta.url,
  ),
  'utf8',
);
const collaborationMigration = readFileSync(
  new URL(
    '../../../../../prisma/migrations/20260728000600_business_event_collaboration_foundation/migration.sql',
    import.meta.url,
  ),
  'utf8',
);

describe('process and collaboration migration security invariants', () => {
  it('uses the canonical organization table name and PUBLIC restrictive tenant policies', () => {
    expect(processMigration).not.toContain('organization_units');
    expect(collaborationMigration).not.toContain('organization_units');
    expect(processMigration.match(/^BEGIN;$/gm)).toHaveLength(2);
    expect(processMigration.match(/^COMMIT;$/gm)).toHaveLength(2);
    expect(collaborationMigration.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(collaborationMigration.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(processMigration).toMatch(
      /CREATE POLICY tenant_isolation ON public\.%I[\s\S]*?AS RESTRICTIVE FOR ALL TO PUBLIC/,
    );
    expect(collaborationMigration).toMatch(
      /CREATE POLICY tenant_isolation ON public\.%I[\s\S]*?AS RESTRICTIVE FOR ALL TO PUBLIC/,
    );
  });

  it('makes graph publication and runtime transitions closed, revisioned command traces', () => {
    expect(processMigration).toContain('validate_process_graph_publication');
    expect(processMigration).toContain('process_graph_reachability_check');
    expect(processMigration).toContain('process_graph_end_reachable_check');
    expect(processMigration).toContain('process_commands_one_per_revision_idx');
    expect(processMigration).toContain('process_step_commands_one_per_revision_idx');
    expect(processMigration).toContain('validate_process_transition_command_coverage');
    expect(processMigration).toContain(
      "WHEN OLD.\"status\" = 'READY' AND NEW.\"status\" = 'TIMED_OUT' THEN 'TIMEOUT'",
    );
    expect(processMigration).toContain(
      "CONSTRAINT = 'process_step_instances_attempt_transition_check'",
    );
    expect(processMigration).toMatch(
      /OLD\."status" IN \('REJECTED', 'TIMED_OUT', 'FAILED'\)[\s\S]*?NEW\."status" = 'READY'[\s\S]*?THEN 1/,
    );
    expect(processMigration).toContain('process_step_commands_service_actor_required');
    expect(processMigration).toContain('human_approval_evidence_valid');
  });

  it('gives the process capability only governed RLS and column-level support', () => {
    expect(processMigration).toContain(
      'NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS',
    );
    expect(processMigration).toContain('CREATE POLICY enterprise_agent_process_read');
    expect(processMigration).toMatch(
      /GRANT SELECT \("tenant_id", "id", "display_name", "status"\)\s+ON TABLE public\."users"\s+TO enterprise_agent_process;/,
    );
    expect(processMigration).toMatch(
      /GRANT SELECT \(\s*"tenant_id", "objective_id", "objective_version", "role_assignment_id"\s*\)\s+ON TABLE public\."objective_role_assignments"\s+TO enterprise_agent_process;/,
    );
    expect(processMigration).toMatch(
      /FOREACH table_name IN ARRAY ARRAY\[[\s\S]*?'objective_role_assignments'[\s\S]*?CREATE POLICY enterprise_agent_process_read/,
    );
    expect(processMigration).toMatch(
      /CREATE POLICY enterprise_agent_process_tenant_isolation\s+ON public\."users"\s+AS RESTRICTIVE\s+FOR SELECT\s+TO enterprise_agent_process[\s\S]*?"tenant_id" = NULLIF\(current_setting\('app\.tenant_id', true\), ''\)::uuid/,
    );
    expect(processMigration).toMatch(
      /CREATE POLICY enterprise_agent_process_read\s+ON public\."users"\s+AS PERMISSIVE\s+FOR SELECT\s+TO enterprise_agent_process\s+USING \(true\);/,
    );
    expect(processMigration).toContain('CREATE POLICY enterprise_agent_process_task_link');
    expect(processMigration).toContain('GRANT UPDATE ("process_instance_id")');
    expect(processMigration).toMatch(
      /GRANT INSERT \([\s\S]*?"occurred_at"[\s\S]*?\) ON TABLE public\."audit_events" TO enterprise_agent_process;/,
    );
    expect(processMigration).toMatch(
      /GRANT INSERT \([\s\S]*?"payload"[\s\S]*?\) ON TABLE public\."outbox_events" TO enterprise_agent_process;/,
    );
    expect(processMigration).toContain('CREATE POLICY enterprise_agent_process_tenant_isolation');
  });

  it('binds event effects to deliveries and keeps ledgers append-only', () => {
    expect(collaborationMigration).toContain('business_event_deliveries_effect_identity_key');
    expect(collaborationMigration).toMatch(
      /business_event_effects_delivery_fkey[\s\S]*?FOREIGN KEY \([\s\S]*?"tenant_id", "delivery_id", "business_event_id", "consumer_name"[\s\S]*?\)[\s\S]*?REFERENCES public\."business_event_deliveries"\s*\([\s\S]*?"tenant_id", "id", "business_event_id", "consumer_name"/,
    );
    expect(collaborationMigration).toContain('business_event_deliveries_no_delete_trigger');
    expect(collaborationMigration).toContain('business_event_effects_no_delete_trigger');
    expect(collaborationMigration).not.toMatch(
      /FROM public\."business_events"[\s\S]*?AND "id" = NEW\."causation_id"\s+FOR SHARE;/,
    );
    expect(collaborationMigration).toContain('collaboration_participants_active_user_key');
    expect(collaborationMigration).toContain('collaboration_participants_active_agent_key');
    expect(collaborationMigration).not.toMatch(
      /FROM public\."collaboration_participants"[\s\S]*?AND "active"\s+FOR SHARE;/,
    );
    expect(collaborationMigration).toContain(
      `NEW."replayed_by_user_id" =\n        nullif(current_setting('app.user_id', true), '')::uuid`,
    );
    expect(collaborationMigration).toContain(`replay_actor."role" IN ('OWNER', 'ADMIN')`);
    expect(collaborationMigration).toContain(
      `GRANT SELECT ("role") ON TABLE public."users" TO enterprise_agent_process;`,
    );
    expect(collaborationMigration).toContain(`NEW."available_at" = NEW."replayed_at"`);
  });

  it('resolves trusted actors and replays collaboration/correction state at commit', () => {
    expect(collaborationMigration).toContain('build_trusted_assignment_snapshot');
    expect(collaborationMigration).toMatch(
      /CREATE OR REPLACE FUNCTION public\.build_trusted_assignment_snapshot\([\s\S]*?LANGUAGE plpgsql\s+SECURITY DEFINER\s+SET search_path = pg_catalog, public/,
    );
    expect(collaborationMigration).toMatch(
      /IF p_tenant_id IS DISTINCT FROM\s+NULLIF\(current_setting\('app\.tenant_id', true\), ''\)::uuid THEN[\s\S]*?USING ERRCODE = '42501'/,
    );
    expect(collaborationMigration).toMatch(
      /REVOKE ALL ON FUNCTION public\.build_trusted_assignment_snapshot\([\s\S]*?\) FROM PUBLIC, enterprise_agent_app, enterprise_agent_admin,\s+enterprise_agent_auth, enterprise_agent_provisioner;/,
    );
    expect(collaborationMigration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.build_trusted_assignment_snapshot\([\s\S]*?\) TO enterprise_agent_process;/,
    );
    expect(collaborationMigration).toContain('trusted_assignment_resolution_check');
    expect(collaborationMigration).toContain('trusted_assignment_operational_scope_check');
    expect(collaborationMigration).toContain(
      'assignment_record."permission_scope"->\'dataLabels\'',
    );
    expect(collaborationMigration).toContain('assignment_record."permission_scope"->\'taskIds\'');
    expect(collaborationMigration).toContain('assignment_record."permission_scope"->\'actions\'');
    expect(collaborationMigration).toContain(
      'assignment_record."organization_scope"->\'orgUnitIds\'',
    );
    expect(collaborationMigration).toContain('task."owner_org_unit_id"');
    expect(collaborationMigration).toContain(
      'FROM public."objective_role_assignments" objective_assignment',
    );
    expect(collaborationMigration).toContain('collaboration_acceptance_trace_check');
    expect(collaborationMigration).toContain('duplicate_count <> 0');
    expect(collaborationMigration).toContain(
      'A Correction case requires an independent human reviewer.',
    );
    expect(collaborationMigration).toContain('evidence."verified_at" IS NULL');
    expect(collaborationMigration).toContain('validate_collaboration_trace');
    expect(collaborationMigration).toContain('collaborations_trace_replay_check');
    expect(collaborationMigration).toContain('validate_correction_trace');
    expect(collaborationMigration).toContain('correction_cases_trace_replay_check');
    expect(collaborationMigration).toMatch(
      /CREATE CONSTRAINT TRIGGER "collaborations_trace_completeness_trigger"[\s\S]*?DEFERRABLE INITIALLY DEFERRED/,
    );
    expect(collaborationMigration).toMatch(
      /CREATE CONSTRAINT TRIGGER "correction_cases_trace_completeness_trigger"[\s\S]*?DEFERRABLE INITIALLY DEFERRED/,
    );
  });
});
