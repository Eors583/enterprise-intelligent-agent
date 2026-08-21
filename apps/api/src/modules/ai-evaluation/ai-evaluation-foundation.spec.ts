import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(process.cwd(), 'prisma/migrations/20260728000900_ai_evaluation_governance/migration.sql'),
  'utf8',
);

describe('AI evaluation governance database foundation', () => {
  it('persists versioned datasets, annotations, bad cases, runs, metrics and release checks', () => {
    for (const table of [
      'ai_evaluation_datasets',
      'ai_evaluation_dataset_versions',
      'ai_evaluation_cases',
      'ai_evaluation_annotations',
      'ai_evaluation_bad_cases',
      'ai_evaluation_runners',
      'ai_evaluation_runs',
      'ai_evaluation_case_results',
      'ai_evaluation_metric_results',
      'ai_evaluation_release_checks',
    ]) {
      expect(migration).toContain(`CREATE TABLE public."${table}"`);
    }
  });

  it('enforces CAS, immutable snapshots, exact case coverage and sealed thresholds', () => {
    expect(migration).toContain('ai_evaluation_dataset_versions_cas');
    expect(migration).toContain('ai_evaluation_runs_cas');
    expect(migration).toContain('ai_evaluation_bad_cases_cas');
    expect(migration).toContain('ai_evaluation_runs_case_coverage');
    expect(migration).toContain('ai_evaluation_metric_results_threshold_match');
    expect(migration).toContain('ai_evaluation_evidence_append_only');
    expect(migration).toContain('ai_evaluation_runs_submission_immutable');
    expect(migration).toContain('ai_evaluation_runs_verification_immutable');
    expect(migration).toContain('runner_attestation_key_fingerprint');
    expect(migration).toContain('ai_evaluation_runners_immutable');
  });

  it('requires authenticated runner submission, verified evidence and independent reviewers', () => {
    expect(migration).toContain('"result_submitted_by_runner_id" = "runner_id"');
    expect(migration).toContain('app.evaluation_runner_id');
    expect(migration).toContain('ai_evaluation_runs_runner_submitter_binding');
    expect(migration).toContain('ai_evaluation_runs_user_submitter_binding');
    expect(migration).toContain('ai_evaluation_runs_verifier_binding');
    expect(migration).toContain('ai_evaluation_runs_evidence_origin');
    expect(migration).toContain('"reviewed_by_user_id" <> "submitted_by_user_id"');
    expect(migration).toContain('"verified_by_user_id" <> "result_submitted_by_user_id"');
    expect(migration).toContain('"triaged_by_user_id" <> "reported_by_user_id"');
    expect(migration).toContain('"trust_level" = \'VERIFIED\'');
    expect(migration).toContain('"verified_at" IS NOT NULL');
  });

  it('uses a dedicated no-bypass runner role with tenant RLS and narrow ACLs', () => {
    expect(migration).toContain('CREATE ROLE enterprise_agent_evaluation_runner');
    expect(migration).toContain('NOINHERIT NOBYPASSRLS');
    expect(migration).toContain('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY');
    expect(migration).toContain('CREATE POLICY ai_evaluation_tenant_isolation');
    expect(migration).not.toContain(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public."ai_evaluation_runs"',
    );
  });

  it('records audit and outbox evidence for governance and readiness mutations', () => {
    expect(migration).toContain('ai_evaluation_append_side_effects');
    expect(migration).toContain('INSERT INTO public."audit_events"');
    expect(migration).toContain('INSERT INTO public."outbox_events"');
    expect(migration).toContain('ai_evaluation_release_checks_side_effects');
  });

  it('binds Agent and Knowledge publication transitions to the exact passing run', () => {
    expect(migration).toContain('assert_ai_evaluation_publication_gate');
    expect(migration).toContain('agent_versions_evaluation_publication_guard');
    expect(migration).toContain('knowledge_document_versions_evaluation_publication_guard');
    expect(migration).toContain('ai_evaluation_publication_run_not_ready');
    expect(migration).toContain('ai_evaluation_publication_readiness_missing');
    expect(migration).toContain('"checked_at" >= run."verified_at"');
    expect(migration).toContain('agent_versions_evaluation_run_fkey');
    expect(migration).toContain('knowledge_document_versions_evaluation_run_fkey');
  });
});
