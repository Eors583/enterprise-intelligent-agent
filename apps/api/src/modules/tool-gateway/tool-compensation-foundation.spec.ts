import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const apiRoot = process.cwd().endsWith(path.join('apps', 'api'))
  ? process.cwd()
  : path.resolve(process.cwd(), 'apps/api');
const migration = readFileSync(
  path.join(apiRoot, 'prisma/migrations/20260728001300_tool_compensation_execution/migration.sql'),
  'utf8',
);

describe('Tool compensation database boundary', () => {
  it('persists an immutable tenant-scoped binding between original and child invocation', () => {
    expect(migration).toContain('CREATE TABLE public."tool_compensation_bindings"');
    expect(migration).toContain('tool_compensation_bindings_child_key');
    expect(migration).toContain('tool_compensation_bindings_append_only_trigger');
    expect(migration).toContain('tool_compensation_bindings_original_invocation_fkey');
    expect(migration).toContain('tool_compensation_bindings_compensation_invocation_fkey');
    expect(migration).toContain(
      'ALTER TABLE public."tool_compensation_bindings" FORCE ROW LEVEL SECURITY',
    );
    expect(migration).toContain('tool_compensation_requester_read');
  });

  it('rejects caller-controlled or mismatched original provider identities', () => {
    for (const immutableBinding of [
      'original_invocation_id',
      'original_tool_version_id',
      'original_input_hash',
      'original_provider_request_id',
      'original_output_hash',
      'compensation_tool_version_id',
      'compensation_input_hash',
    ]) {
      expect(migration).toContain(`"${immutableBinding}"`);
    }
    expect(migration).toContain('tool_invocations_compensation_binding');
    expect(migration).toContain(`NEW."input"->>'operation' IS DISTINCT FROM 'COMPENSATE'`);
    expect(migration).toContain(
      `NEW."input"->'payload'->'input'\n       IS DISTINCT FROM original_record."input"`,
    );
    expect(migration).toContain(
      `NEW."input"->'payload'->'output'\n       IS DISTINCT FROM original_record."output"`,
    );
  });

  it('requires a current published compensator and one live compensation', () => {
    expect(migration).toContain('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    expect(migration).toContain('tool_versions_compensator_published');
    expect(migration).toContain('tool_invocations_one_live_compensation_idx');
    expect(migration).toContain(`compensation_version."status" <> 'PUBLISHED'`);
    expect(migration).toContain('compensation_definition."current_version_id"');
    expect(migration).toContain(`compensation_version."effective_from" > CURRENT_TIMESTAMP`);
    expect(migration).toContain(`'READ_ONLY', 'DRAFT_ONLY', 'FORBIDDEN'`);
  });

  it('does not claim that a compensation still runs inside a completed process step', () => {
    expect(migration).toContain(`OR NEW."process_step_instance_id" IS NOT NULL`);
  });

  it('binds start and final transitions to the compensation receipt', () => {
    expect(migration).toContain('tool_invocation_commands_compensation_binding_trigger');
    expect(migration).toContain('compensationInvocationId');
    expect(migration).toContain('compensationToolVersionId');
    expect(migration).toContain('compensationInputHash');
    expect(migration).toContain('originalProviderRequestId');
    expect(migration).toContain('originalOutputHash');
    expect(migration).toContain('compensationReceiptHash');
    expect(migration).toContain('tool_execution_receipts');
    expect(migration).toContain('tool_reconciliation_receipts');
    expect(migration).toContain('finalize_tool_compensation_after_reconciliation');
    expect(migration).toContain('tool_invocations_compensation_reconciliation_trigger');
    expect(migration).toContain('without replaying the original operation');
  });

  it('keeps mutation privileges on the dedicated gateway role only', () => {
    expect(migration).toContain(
      'GRANT SELECT, INSERT ON TABLE public."tool_compensation_bindings"',
    );
    expect(migration).toContain('TO enterprise_agent_tool_gateway');
    expect(migration).toContain('FROM PUBLIC, enterprise_agent_app, enterprise_agent_admin,');
  });
});
