import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(
    process.cwd(),
    'prisma/migrations/20260728002900_answer_feedback_bad_case_projection/migration.sql',
  ),
  'utf8',
);
const projectionFixMigration = readFileSync(
  resolve(
    process.cwd(),
    'prisma/migrations/20260729000100_answer_feedback_bad_case_projection_fix/migration.sql',
  ),
  'utf8',
);
const projectionLockFixMigration = readFileSync(
  resolve(
    process.cwd(),
    'prisma/migrations/20260729000200_answer_feedback_bad_case_projection_lock_fix/migration.sql',
  ),
  'utf8',
);
const trustBoundaryMigration = readFileSync(
  resolve(
    process.cwd(),
    'prisma/migrations/20260729000300_answer_feedback_bad_case_projection_trust_boundary/migration.sql',
  ),
  'utf8',
);

describe('answer-feedback Evaluation Bad Case database projection', () => {
  it('persists immutable feedback, message, Run, Agent Version and citation lineage', () => {
    expect(migration).toContain('CREATE TABLE public."ai_evaluation_answer_feedback_sources"');
    for (const column of [
      '"feedback_id"',
      '"message_id"',
      '"input_message_id"',
      '"agent_run_id"',
      '"agent_id"',
      '"agent_version_id"',
      '"reported_by_user_id"',
      '"feedback_recorded_at"',
      '"citations"',
    ]) {
      expect(migration).toContain(column);
    }
    expect(migration).toContain('ai_evaluation_answer_feedback_sources_append_only');
    expect(migration).toContain('ai_evaluation_answer_feedback_pair_required');
  });

  it('uses a default-deny table and one narrow security-definer projection entrypoint', () => {
    expect(migration).toContain('FORCE ROW LEVEL SECURITY');
    expect(migration).toContain('CREATE POLICY "ai_evaluation_tenant_isolation"');
    expect(migration).toContain('CREATE POLICY "ai_evaluation_admin_access"');
    expect(migration).toContain('SECURITY DEFINER');
    expect(migration).toContain('CREATE ROLE enterprise_agent_feedback_projector');
    expect(migration).toContain('INHERIT NOREPLICATION NOBYPASSRLS');
    expect(migration).toContain('OWNER TO enterprise_agent_feedback_projector');
    expect(migration).toContain('FROM PUBLIC, enterprise_agent_app');
    expect(migration).toContain('public.project_not_helpful_answer_feedback_bad_case(uuid)');
    expect(migration).not.toContain(
      'GRANT INSERT ON TABLE public."ai_evaluation_answer_feedback_sources" TO enterprise_agent_app',
    );
  });

  it('revalidates authenticated ownership, succeeded Run binding and tenant-owned citations', () => {
    expect(migration).toContain("current_setting('app.user_id', true)");
    expect(migration).toContain('feedback."user_id" = actor_user_id');
    expect(migration).toContain('run."requester_user_id" = actor_user_id');
    expect(migration).toContain('run."status" = \'SUCCEEDED\'');
    expect(migration).toContain('public."knowledge_chunks"');
    expect(migration).toContain('ai_evaluation_answer_feedback_citations_tenant');
  });

  it('deduplicates per feedback and retains only sanitized input plus snapshot hashes', () => {
    expect(migration).toContain('UNIQUE ("tenant_id", "feedback_id")');
    expect(migration).toContain(
      'ON CONFLICT ("tenant_id", "source_type", "source_id", "source_version")',
    );
    expect(migration).toContain('ai_evaluation_sanitize_feedback_input');
    expect(migration).toContain('"prompt_snapshot_hash"');
    expect(migration).toContain('"answer_snapshot_hash"');
    expect(migration).toContain('"citations_snapshot_hash"');
  });

  it('uses unambiguous context variables and only locks mutable lineage records', () => {
    expect(projectionFixMigration).toContain('context_tenant_id uuid');
    expect(projectionFixMigration).toContain('context_actor_user_id uuid');
    expect(projectionFixMigration).toContain('target_feedback_id uuid');
    expect(projectionLockFixMigration).toContain(
      'FOR SHARE OF feedback, output_message, run, input_message',
    );
    expect(projectionLockFixMigration).toContain("'FOR SHARE OF feedback, run'");
    expect(projectionLockFixMigration).toContain('EXECUTE function_definition');
    expect(projectionLockFixMigration).toContain('OWNER TO enterprise_agent_feedback_projector');
  });

  it('recomputes every source snapshot inside the database before accepting a ledger row', () => {
    expect(trustBoundaryMigration).toContain(
      'CREATE OR REPLACE FUNCTION public.ai_evaluation_derive_answer_feedback_source(',
    );
    expect(trustBoundaryMigration).toContain('SECURITY DEFINER');
    expect(trustBoundaryMigration).toContain('SET search_path = pg_catalog, public');
    expect(trustBoundaryMigration).toContain(
      'expected_source := public.ai_evaluation_derive_answer_feedback_source(',
    );
    expect(trustBoundaryMigration).toContain("digest(convert_to(prompt_text, 'UTF8'), 'sha256')");
    expect(trustBoundaryMigration).toContain("digest(convert_to(answer_text, 'UTF8'), 'sha256')");
    expect(trustBoundaryMigration).toContain(
      "digest(convert_to(citation_snapshot::text, 'UTF8'), 'sha256')",
    );
    expect(trustBoundaryMigration).toContain(
      "CONSTRAINT = 'ai_evaluation_answer_feedback_hash_binding'",
    );
    expect(trustBoundaryMigration).toContain(
      "CONSTRAINT = 'ai_evaluation_answer_feedback_bad_case_binding'",
    );
  });

  it('fails closed while upgrading legacy feedback Bad Cases', () => {
    expect(trustBoundaryMigration).toContain('WHERE bad_case."source_type" = \'ANSWER_FEEDBACK\'');
    expect(trustBoundaryMigration).toContain(
      'INSERT INTO public."ai_evaluation_answer_feedback_sources"',
    );
    expect(trustBoundaryMigration).toContain(
      "CONSTRAINT = 'ai_evaluation_answer_feedback_legacy_mismatch'",
    );
    expect(trustBoundaryMigration).toContain(
      "CONSTRAINT = 'ai_evaluation_answer_feedback_existing_source_mismatch'",
    );
    expect(trustBoundaryMigration).toContain(
      "CONSTRAINT = 'ai_evaluation_answer_feedback_upgrade_incomplete'",
    );
  });

  it('keeps the source ledger append-only and closes helper function execution', () => {
    const normalizedMigration = trustBoundaryMigration.replace(/\s+/gu, ' ');
    expect(normalizedMigration).toContain(
      'GRANT SELECT ON TABLE public."ai_evaluation_answer_feedback_sources"',
    );
    expect(normalizedMigration).toContain('TO enterprise_agent_admin;');
    expect(normalizedMigration).toContain(
      'GRANT SELECT, INSERT ON TABLE public."ai_evaluation_answer_feedback_sources"',
    );
    expect(normalizedMigration).toContain('TO enterprise_agent_feedback_projector;');
    expect(normalizedMigration).toContain(
      'REVOKE UPDATE, DELETE ON TABLE public."ai_evaluation_answer_feedback_sources"',
    );
    for (const signature of [
      'public.ai_evaluation_sanitize_feedback_input(text)',
      'public.ai_evaluation_derive_answer_feedback_source(uuid, uuid, uuid)',
      'public.ai_evaluation_answer_feedback_source_guard()',
      'public.ai_evaluation_answer_feedback_pair_guard()',
      'public.project_not_helpful_answer_feedback_bad_case(uuid)',
    ]) {
      expect(normalizedMigration).toContain(`ALTER FUNCTION ${signature}`);
      expect(normalizedMigration).toContain(`REVOKE ALL ON FUNCTION ${signature}`);
    }
    expect(normalizedMigration).toContain('OWNER TO enterprise_agent_feedback_projector');
    expect(normalizedMigration).toContain(
      'public.project_not_helpful_answer_feedback_bad_case(uuid) TO enterprise_agent_app, enterprise_agent_admin;',
    );
  });
});
