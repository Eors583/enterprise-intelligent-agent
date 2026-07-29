import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL(
    '../../../../../prisma/migrations/20260728001900_agent_run_streaming/migration.sql',
    import.meta.url,
  ),
  'utf8',
);
const reconciliationMigration = readFileSync(
  new URL(
    '../../../../../prisma/migrations/20260729001100_agent_run_reconciliation_stream/migration.sql',
    import.meta.url,
  ),
  'utf8',
);
const hardeningMigration = readFileSync(
  new URL(
    '../../../../../prisma/migrations/20260729001200_agent_run_reconciliation_hardening/migration.sql',
    import.meta.url,
  ),
  'utf8',
);
const connectivityProbeRouteFallbackMigration = readFileSync(
  new URL(
    '../../../../../prisma/migrations/20260729001300_model_connectivity_probe_route_fallback/migration.sql',
    import.meta.url,
  ),
  'utf8',
);
const repository = readFileSync(
  new URL('./prisma-agent-run-stream.repository.ts', import.meta.url),
  'utf8',
);
const runRepository = readFileSync(
  new URL('./prisma-agent-run.repository.ts', import.meta.url),
  'utf8',
);

describe('Agent Run streaming database gate', () => {
  it('is append-only, force-RLS tenant scoped, and minimally granted', () => {
    expect(migration).toContain('CREATE TABLE public."agent_run_stream_events"');
    expect(migration).toContain(
      'ALTER TABLE public."agent_run_stream_events" FORCE ROW LEVEL SECURITY',
    );
    expect(migration).toContain('AS RESTRICTIVE');
    expect(migration).toContain("current_setting('app.tenant_id', true)");
    expect(migration).toContain('BEFORE UPDATE OR DELETE');
    expect(migration).toContain('BEFORE TRUNCATE');
    expect(migration).toContain(
      'GRANT SELECT, INSERT ON TABLE public."agent_run_stream_events" TO enterprise_agent_app',
    );
    expect(migration).not.toContain(
      'GRANT UPDATE ON TABLE public."agent_run_stream_events" TO enterprise_agent_app',
    );
    expect(migration).not.toContain(
      'GRANT DELETE ON TABLE public."agent_run_stream_events" TO enterprise_agent_app',
    );
  });

  it('enforces tenant parents, contiguous bounded events, hashes, and terminal Run state', () => {
    expect(migration).toContain('CONSTRAINT "agent_run_stream_events_tenant_id_run_id_fkey"');
    expect(migration).toContain('sequence must be contiguous');
    expect(migration).toContain('"sequence" BETWEEN 1 AND 10000');
    expect(migration).toContain('"sequence" < 10000');
    expect(migration).toContain('octet_length("delta") BETWEEN 1 AND 16384');
    expect(migration).toContain("digest(convert_to(NEW.\"delta\", 'UTF8'), 'sha256')");
    expect(migration).toContain('accumulated_output_bytes > 1000000');
    expect(migration).toContain('terminal stream event must match the durable Agent Run status');
    expect(migration).not.toMatch(/"(?:prompt|authorization|api_key|secret)"/i);
  });

  it('serializes idempotency before the insert statement receives its snapshot', () => {
    expect(repository).toContain('await lockStream(transaction, input.tenantId, input.runId)');
    expect(repository).toContain('SELECT pg_advisory_xact_lock(hashtextextended(');
    expect(migration).toContain('existing_event."delta" IS NOT DISTINCT FROM NEW."delta"');
    expect(migration).toContain('RETURN NULL');
  });

  it('preserves UNKNOWN history while allowing one validated reconciliation marker', () => {
    expect(reconciliationMigration).toContain("ADD VALUE IF NOT EXISTS 'TERMINAL_RECONCILED'");
    expect(reconciliationMigration).toContain(
      'CREATE UNIQUE INDEX "agent_run_stream_events_one_reconciled_terminal_idx"',
    );
    expect(reconciliationMigration).toContain(
      'reconciled terminal requires a prior UNKNOWN terminal marker',
    );
    expect(reconciliationMigration).toContain(
      'NEW."terminal_status" = \'UNKNOWN\'::public."AgentRunStatus"',
    );
    expect(repository).toContain("'TERMINAL_RECONCILED'");
    expect(repository).toContain('row.terminalStatus === run.status');
  });

  it('reserves a second terminal sequence and freezes Agent Run execution identity', () => {
    expect(hardeningMigration).toContain('CHECK ("sequence" BETWEEN 1 AND 10001)');
    expect(hardeningMigration).toContain('CREATE TRIGGER "agent_runs_execution_identity_guard"');
    for (const immutableField of [
      'idempotency_key',
      'policy_snapshot',
      'conversation_id',
      'input_message_id',
      'requester_user_id',
      'agent_id',
      'agent_version_id',
    ]) {
      expect(hardeningMigration).toContain(
        `OLD."${immutableField}" IS DISTINCT FROM NEW."${immutableField}"`,
      );
    }
    expect(hardeningMigration).toContain('Agent Run execution identity is immutable');
    expect(repository).toContain("if (input.status === 'UNKNOWN') return");
    expect(repository).toContain('sequence > 10_001');
  });

  it('admits connectivity probes only through the strictly shaped app capability', () => {
    expect(hardeningMigration).toContain('CREATE TABLE public."ai_model_connectivity_probes"');
    for (const constraint of [
      'ai_model_connectivity_probes_run_fkey',
      'ai_model_connectivity_probes_catalog_fkey',
      'ai_model_connectivity_probes_requester_fkey',
      'ai_model_connectivity_probes_conversation_fkey',
    ]) {
      expect(hardeningMigration).toContain(`CONSTRAINT "${constraint}"`);
    }
    expect(hardeningMigration).toContain(
      'ALTER TABLE public."ai_model_connectivity_probes" FORCE ROW LEVEL SECURITY',
    );
    expect(hardeningMigration).toContain(
      'CREATE TRIGGER "ai_model_connectivity_probes_append_only"',
    );
    expect(hardeningMigration).toContain(
      'BEFORE UPDATE OR DELETE ON public."ai_model_connectivity_probes"',
    );
    expect(hardeningMigration).toContain(
      'CREATE TRIGGER "ai_model_connectivity_probes_reject_truncate"',
    );
    expect(hardeningMigration).toContain(
      'BEFORE TRUNCATE ON public."ai_model_connectivity_probes"',
    );
    expect(hardeningMigration).toContain('TO PUBLIC');
    expect(hardeningMigration).toContain(
      'REVOKE ALL ON TABLE public."ai_model_connectivity_probes" FROM PUBLIC',
    );
    expect(hardeningMigration).toContain(
      'GRANT SELECT ON TABLE public."ai_model_connectivity_probes"',
    );
    expect(hardeningMigration).toContain(
      'REVOKE ALL ON FUNCTION public.register_ai_model_connectivity_probe(uuid, uuid, uuid, uuid)',
    );
    expect(hardeningMigration).toContain(
      'GRANT EXECUTE ON FUNCTION public.register_ai_model_connectivity_probe(uuid, uuid, uuid, uuid)',
    );
    expect(hardeningMigration).toContain('TO enterprise_agent_app;');
    expect(hardeningMigration).not.toMatch(
      /GRANT\s+(?:INSERT|UPDATE|DELETE|TRUNCATE)[^;]*ai_model_connectivity_probes/iu,
    );

    for (const provenanceCheck of [
      "current_setting('app.tenant_id', true)",
      "current_setting('app.user_id', true)",
      `stored_run."idempotency_key" NOT LIKE 'model-connectivity-probe:%'`,
      `'model-connectivity-probe:' || requested_user_id::text || ':' || stored_run."agent_id"::text`,
      `conversation."title" = '[SYSTEM] Model connectivity probe'`,
      `message."content" = jsonb_build_object(`,
      `participant."left_at" IS NULL`,
      `catalog."status" = 'PUBLISHED'::public."AiGovernanceStatus"`,
      `policy."status" = 'PUBLISHED'::public."AiGovernanceStatus"`,
    ]) {
      expect(hardeningMigration).toContain(provenanceCheck);
    }
    expect(hardeningMigration).toContain(') <> 2 OR (');
    expect(hardeningMigration).toContain(
      'model connectivity probe conversation provenance is invalid',
    );
    expect(runRepository).toContain('transaction.aiModelConnectivityProbe.findFirst');
  });

  it('keeps database probe routing aligned with the application GENERAL_QA fallback', () => {
    expect(connectivityProbeRouteFallbackMigration).toContain(
      'CREATE OR REPLACE FUNCTION public.register_ai_model_connectivity_probe',
    );
    expect(connectivityProbeRouteFallbackMigration).toContain(`~ '^[A-Z0-9][A-Z0-9._-]{0,119}$'`);
    expect(connectivityProbeRouteFallbackMigration).toContain(`ELSE 'GENERAL_QA'`);
    expect(connectivityProbeRouteFallbackMigration).toContain(
      'GRANT EXECUTE ON FUNCTION public.register_ai_model_connectivity_probe',
    );
  });
});
