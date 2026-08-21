import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(
    process.cwd(),
    'prisma/migrations/20260729000600_scim_capability_cancellation_hardening/migration.sql',
  ),
  'utf8',
);
const persistence = readFileSync(
  resolve(process.cwd(), 'src/database/scim-prisma.service.ts'),
  'utf8',
);

describe('SCIM capability and Agent Run cancellation hardening', () => {
  it('resolves an opaque bearer through one bounded definer capability', () => {
    expect(migration).toMatch(
      /CREATE OR REPLACE FUNCTION public\.resolve_scim_capability\([\s\S]*?SECURITY DEFINER[\s\S]*?SET search_path = pg_catalog, public[\s\S]*?SET row_security = off/,
    );
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.resolve_scim_capability(text, text) FROM PUBLIC',
    );
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION public.resolve_scim_capability(text, text)',
    );
    expect(migration).toContain('DROP POLICY IF EXISTS "identity_scim_token_lookup"');
    expect(migration).toContain('DROP POLICY IF EXISTS "identity_scim_token_telemetry"');
    expect(migration).toContain('DROP POLICY IF EXISTS "identity_scim_tenant_access"');
    expect(migration).toMatch(
      /REVOKE ALL PRIVILEGES ON TABLE\s+public\."scim_service_tokens",\s+public\."scim_connectors"\s+FROM enterprise_agent_scim/,
    );
    expect(migration).toMatch(
      /UPDATE public\."scim_service_tokens" AS token[\s\S]*?FROM public\."scim_connectors" AS connector[\s\S]*?RETURNING/,
    );
    expect(migration).not.toContain('FOR UPDATE OF token');
    expect(persistence).toContain('FROM public.resolve_scim_capability');
    expect(persistence).not.toContain('FROM public."scim_service_tokens"');
    expect(persistence).toContain('const capability = await this.$transaction');
    expect(persistence).toContain('return this.$transaction');
  });

  it('persists cancellation intent separately from Runtime confirmation', () => {
    expect(migration).toContain('ADD COLUMN "cancellation_requested_at" timestamptz(6)');
    expect(migration).toContain('ADD COLUMN "cancellation_confirmed_at" timestamptz(6)');
    expect(migration).toContain('CONSTRAINT "agent_runs_cancellation_evidence_check"');
    expect(migration).toContain('CREATE INDEX "agent_runs_pending_cancellation_idx"');
    expect(migration).toContain(`AND run."status" = 'QUEUED'`);
    expect(migration).toContain(`run."status" IN ('DISPATCHING', 'RUNNING', 'UNKNOWN')`);
    expect(migration).toContain(
      `OR (run."status" = 'QUEUED' AND run."external_run_id" IS NOT NULL)`,
    );
    expect(migration).toContain(`'agent.run_cancel_requested.v1'`);

    const providerBackedUpdate = migration.match(
      /WITH cancellation_requested AS \(([\s\S]*?)RETURNING run\."id", run\."external_run_id"/,
    )?.[1];
    expect(providerBackedUpdate).toBeDefined();
    expect(providerBackedUpdate).toContain('"cancellation_requested_at" = CURRENT_TIMESTAMP');
    expect(providerBackedUpdate).not.toContain(`"status" = 'CANCELLED'`);
    expect(providerBackedUpdate).not.toContain('"reserved_tokens" = 0');

    const trigger = migration.match(
      /CREATE OR REPLACE FUNCTION public\.apply_scim_user_deprovisioning\(\)([\s\S]*?)\$function\$;/,
    )?.[1];
    expect(trigger).toBeDefined();
    expect(trigger).not.toContain('FROM public."role_assignments"');
    expect(trigger).not.toContain('run."agent_id"');
    expect(trigger).toContain(`hashtextextended(NEW."tenant_id"::text || ':agent-run-quota', 0)`);
    expect(trigger).toContain('SECURITY DEFINER');
    expect(trigger).toContain('SET row_security = off');
    expect(trigger).toContain('connector."deactivate_user_on_scim_disable"');
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.apply_scim_user_deprovisioning() FROM PUBLIC',
    );
  });

  it('keeps cancellation writes behind reviewed lifecycle and trigger capabilities', () => {
    expect(migration).toMatch(
      /GRANT UPDATE \(\s+"cancellation_requested_at",\s+"cancellation_reason"\s+\) ON TABLE public\."agent_runs" TO enterprise_agent_admin/,
    );
    expect(migration).toMatch(
      /GRANT SELECT \(\s+"cancellation_requested_at"\s+\) ON TABLE public\."agent_runs" TO enterprise_agent_lifecycle/,
    );
    expect(migration).toMatch(
      /GRANT UPDATE \(\s+"cancellation_requested_at",\s+"cancellation_reason"\s+\) ON TABLE public\."agent_runs" TO enterprise_agent_lifecycle/,
    );
    expect(migration).toMatch(
      /REVOKE ALL PRIVILEGES ON TABLE\s+public\."auth_sessions",\s+public\."identity_devices",\s+public\."role_assignments",\s+public\."agent_runs",\s+public\."outbox_events",\s+public\."audit_events",\s+public\."identity_deprovisioning_actions"\s+FROM enterprise_agent_scim/,
    );
    expect(migration).toContain(
      'REVOKE UPDATE ("status") ON TABLE public."users" FROM enterprise_agent_scim',
    );
    expect(migration).not.toMatch(
      /GRANT (?:SELECT|UPDATE) \([\s\S]*?\) ON TABLE public\.(?:"auth_sessions"|"agent_runs") TO enterprise_agent_scim/,
    );
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION public.guard_untrusted_agent_run_cancellation()',
    );
    expect(migration).toContain(
      `current_user = ANY (ARRAY[
      'enterprise_agent_admin',
      'enterprise_agent_lifecycle',
      'enterprise_agent_scim'`,
    );
    expect(migration).toContain(
      `NEW."cancellation_confirmed_at" IS DISTINCT FROM OLD."cancellation_confirmed_at"`,
    );
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.guard_untrusted_agent_run_cancellation()',
    );
    expect(migration).not.toContain(
      'GRANT EXECUTE ON FUNCTION public.guard_untrusted_agent_run_cancellation()',
    );
    expect(migration).toContain(`OLD."status" IN ('SUCCEEDED', 'FAILED', 'CANCELLED')`);
    expect(migration).toContain('CREATE TRIGGER "agent_runs_untrusted_cancellation_guard"');
  });
});
