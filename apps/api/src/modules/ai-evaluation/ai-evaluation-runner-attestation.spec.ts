import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(
    process.cwd(),
    'prisma/migrations/20260728003000_ai_evaluation_runner_attestation/migration.sql',
  ),
  'utf8',
);

describe('AI evaluation runner attestation boundary', () => {
  it('persists a one-time proof bound to the sealed run, runner and nonce', () => {
    expect(migration).toContain('CREATE TABLE public."ai_evaluation_runner_attestations"');
    expect(migration).toContain('"ai_evaluation_runner_attestations_run_key"');
    expect(migration).toContain('"ai_evaluation_runner_attestations_nonce_key"');
    expect(migration).toContain('ai_evaluation_runner_attestation_binding');
    expect(migration).toContain('app.evaluation_attestation_result_hash');
    expect(migration).toContain('ai_evaluation_runs_attested_runner_required');
  });

  it('keeps proof tenant-isolated, append-only and origin constrained', () => {
    expect(migration).toContain(
      'ALTER TABLE public."ai_evaluation_runner_attestations" FORCE ROW LEVEL SECURITY',
    );
    expect(migration).toContain('ai_evaluation_runner_attestations_append_only');
    expect(migration).toContain('jsonb_array_elements_text');
    expect(migration).toContain('starts_with(NEW."evidence_bundle_uri", allowed.origin)');
    expect(migration).not.toContain(
      'GRANT DELETE ON TABLE public."ai_evaluation_runner_attestations"',
    );
  });

  it('requires proof before result insertion and emits audit and outbox evidence', () => {
    expect(migration).toContain('ai_evaluation_results_attestation_required');
    expect(migration).toContain('ai_evaluation_runner_attestations_side_effects');
    expect(migration).toContain('ai.evaluation.runner_attestation.verified');
    expect(migration).toContain('AiEvaluationRunnerAttestationVerified');
  });
});
