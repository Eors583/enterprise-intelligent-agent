import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const apiRoot = process.cwd().endsWith(path.join('apps', 'api'))
  ? process.cwd()
  : path.resolve(process.cwd(), 'apps/api');
const migration = readFileSync(
  path.join(apiRoot, 'prisma/migrations/20260728000800_memory_experience_foundation/migration.sql'),
  'utf8',
);

describe('Memory and Experience database foundation', () => {
  it('creates five-scope Memory and normalized Experience governance tables', () => {
    for (const table of [
      'memory_records',
      'memory_source_evidence',
      'memory_commands',
      'experience_candidates',
      'experience_source_deliverables',
      'experience_source_evidence',
      'experience_commands',
      'experience_review_evidence',
      'experience_validations',
      'experience_publications',
      'experience_publication_role_targets',
      'experience_publication_org_targets',
    ]) {
      expect(migration).toContain(`CREATE TABLE public."${table}"`);
    }
    for (const scope of ['ENTERPRISE', 'ROLE', 'EMPLOYEE_PRIVATE', 'TASK', 'CONVERSATION']) {
      expect(migration).toContain(`'${scope}'`);
    }
  });

  it('enforces exact private-memory consent and dynamic Role Assignment validity', () => {
    expect(migration).toContain('memory_records_scope_identity_check');
    expect(migration).toContain('memory_records_consent_check');
    expect(migration).toContain('memory_records_private_assignment_check');
    expect(migration).toContain('memory_assignment_active');
    expect(migration).toContain(`assignment."status" = 'ACTIVE'`);
    expect(migration).toContain(`employment."status" = 'ACTIVE'`);
    expect(migration).toContain(`unit."status" = 'ACTIVE'`);
    expect(migration).toContain('normalized_purpose');
    expect(migration).not.toContain('organization_units');
  });

  it('prevents Memory and Experience state shortcuts with append-only commands', () => {
    expect(migration).toContain('memory_records_command_coverage');
    expect(migration).toContain('memory_records_command_trace_complete');
    expect(migration).toContain('experience_candidates_command_coverage');
    expect(migration).toContain('experience_candidates_trace_complete');
    expect(migration).toContain('memory_commands_append_only_trigger');
    expect(migration).toContain('experience_commands_append_only_trigger');
    expect(migration).not.toContain(
      `candidate_record."status" = 'VALIDATED' AND NEW."action" = 'RETIRE'`,
    );
  });

  it('requires verified provenance, independent review, validation, and governed publication', () => {
    expect(migration).toContain('memory_records_source_evidence_completeness');
    expect(migration).toContain('experience_candidates_source_completeness');
    expect(migration).toContain('experience_commands_review_proof');
    expect(migration).toContain('experience_validations_evidence_integrity');
    expect(migration).toContain('experience_commands_validation_proof');
    expect(migration).toContain('experience_publications_knowledge_integrity');
    expect(migration).toContain('experience_commands_publication_proof');
    expect(migration).toContain(`run_record."total_tokens" <= 0`);
    expect(migration).toContain(`dataset_record."status" <> 'PUBLISHED'`);
  });

  it('uses composite tenant foreign keys for every governed relationship', () => {
    for (const constraint of [
      'memory_records_role_version_fkey',
      'memory_records_role_assignment_fkey',
      'memory_source_evidence_evidence_fkey',
      'experience_candidates_contributor_assignment_fkey',
      'experience_source_deliverables_deliverable_fkey',
      'experience_source_evidence_evidence_fkey',
      'experience_validations_run_fkey',
      'experience_validations_dataset_version_fkey',
      'experience_publications_document_version_fkey',
      'experience_publication_role_targets_role_fkey',
      'experience_publication_org_targets_org_unit_fkey',
    ]) {
      expect(migration).toContain(`CONSTRAINT "${constraint}"`);
    }
  });

  it('forces tenant RLS, least-privilege ACLs, and transactional audit/outbox coverage', () => {
    expect(migration).toContain('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY');
    expect(migration).toContain('AS RESTRICTIVE FOR ALL TO PUBLIC');
    expect(migration).toContain('memory_records_app_select');
    expect(migration).toContain('memory_records_app_insert');
    expect(migration).toContain('memory_commands_app_insert');
    expect(migration).toContain('REVOKE ALL ON TABLE public.%I FROM enterprise_agent_app');
    expect(migration).toContain('memory_records_audit_outbox_coverage');
    expect(migration).toContain('experience_candidates_audit_outbox_coverage');
    expect(migration.match(/DEFERRABLE INITIALLY DEFERRED/gu)).toHaveLength(4);
  });
});
