import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  join(
    process.cwd(),
    'prisma',
    'migrations',
    '20260728002100_ai_safety_model_routing',
    'migration.sql',
  ),
  'utf8',
);

const ownerSelfPublishMigration = readFileSync(
  join(
    process.cwd(),
    'prisma',
    'migrations',
    '20260817000100_owner_self_publish_ai_model_governance',
    'migration.sql',
  ),
  'utf8',
);

describe('AI safety and model routing database foundation', () => {
  it('creates governed model routing, immutable evidence and Run snapshot tables', () => {
    for (const table of [
      'ai_model_catalog_versions',
      'ai_model_route_policy_versions',
      'ai_model_route_candidates',
      'ai_model_circuit_states',
      'ai_model_attempt_receipts',
      'ai_safety_decisions',
      'ai_governance_commands',
    ]) {
      expect(migration).toContain(`public."${table}"`);
    }
    expect(migration).toContain('"model_route_snapshot" JSONB');
    expect(migration).toContain('agent_run_model_route_snapshot_immutable');
    expect(migration).toContain('ai_evidence_append_only');
  });

  it('preserves workflow evidence, CAS, RLS, ACL, audit and Outbox side effects', () => {
    expect(migration).toContain('"reviewed_by_user_id" <> "submitted_by_user_id"');
    expect(ownerSelfPublishMigration).toContain(
      'DROP CONSTRAINT "ai_model_catalog_versions_workflow_check"',
    );
    expect(ownerSelfPublishMigration).toContain(
      'ADD CONSTRAINT "ai_model_catalog_versions_workflow_check"',
    );
    expect(ownerSelfPublishMigration).not.toContain(
      '"reviewed_by_user_id" <> "submitted_by_user_id"',
    );
    expect(migration).toContain('ai_governance_revision_cas');
    expect(migration).toContain('ai_governance_commands_tenant_idempotency_key');
    expect(migration).toContain('ENABLE ROW LEVEL SECURITY');
    expect(migration).toContain('FORCE ROW LEVEL SECURITY');
    expect(migration).toContain('REVOKE ALL ON TABLE');
    expect(migration).toContain('INSERT INTO public."audit_events"');
    expect(migration).toContain('INSERT INTO public."outbox_events"');
  });

  it('stores credential references and excludes provider secret columns', () => {
    expect(migration).toContain('"credential_reference" VARCHAR(300) NOT NULL');
    expect(migration).not.toMatch(/"api_key"\s+/u);
    expect(migration).not.toMatch(/"provider_secret"\s+/u);
  });
});
