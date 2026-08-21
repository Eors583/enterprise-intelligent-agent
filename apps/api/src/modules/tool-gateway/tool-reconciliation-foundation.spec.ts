import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const apiRoot = process.cwd().endsWith(path.join('apps', 'api'))
  ? process.cwd()
  : path.resolve(process.cwd(), 'apps/api');
const migration = readFileSync(
  path.join(apiRoot, 'prisma/migrations/20260728001100_tool_unknown_reconciliation/migration.sql'),
  'utf8',
);

describe('Tool UNKNOWN reconciliation database boundary', () => {
  it('creates append-only attempts and receipts with tenant RLS and least privilege', () => {
    expect(migration).toContain('CREATE TABLE public."tool_reconciliation_attempts"');
    expect(migration).toContain('CREATE TABLE public."tool_reconciliation_receipts"');
    expect(migration).toContain('tool_reconciliation_attempts_append_only_trigger');
    expect(migration).toContain('tool_reconciliation_receipts_append_only_trigger');
    expect(migration).toContain('FORCE ROW LEVEL SECURITY');
    expect(migration).toContain('tool_reconciliation_attempts_requester_read');
    expect(migration).toContain('tool_reconciliation_receipts_requester_read');
    expect(migration).toContain(
      'TO enterprise_agent_app, enterprise_agent_admin, enterprise_agent_tool_gateway',
    );
    expect(migration).not.toMatch(/GRANT\s+(?:ALL|UPDATE|DELETE)[\s\S]*tool_reconciliation_/u);
  });

  it('binds attempts to the claimed event and receipts to the original provider id', () => {
    expect(migration).toContain('ToolInvocation.ReconciliationRequested');
    expect(migration).toContain('tool_reconciliation_attempts_binding');
    expect(migration).toContain('tool_reconciliation_receipts_binding');
    expect(migration).toContain('"provider_request_id"');
    expect(migration).toContain('"requested_revision"');
    expect(migration).toContain('"outbox_event_id"');
    expect(migration).toContain('invocation_record."tool_version_id" <> NEW."tool_version_id"');
    expect(migration).toContain('invocation_record."input_hash" <> NEW."input_hash"');
  });

  it('only permits UNKNOWN terminal resolution with eligible immutable proof and CAS', () => {
    expect(migration).toContain(`attempt."eligibility" <> 'INELIGIBLE'`);
    expect(migration).toContain('tool_invocations_reconciliation_receipt');
    expect(migration).toContain('tool_invocations_reconciliation_command');
    expect(migration).toContain(`OLD."status" = 'UNKNOWN'`);
    expect(migration).toContain(`NEW."status" IN ('SUCCEEDED', 'FAILED')`);
    expect(migration).toContain(`receipt."proof_type" IS NOT NULL`);
    expect(migration).toContain(`receipt."proof_hash" IS NOT NULL`);
    expect(migration).not.toContain('BEGIN_COMPENSATION');
    expect(migration).not.toContain('COMPLETE_COMPENSATION');
  });

  it('grants the gateway only the requested-event outbox read boundary', () => {
    expect(migration).toContain('tool_gateway_reconciliation_outbox_tenant');
    expect(migration).toContain('tool_gateway_reconciliation_outbox_read');
    expect(migration).toContain(`"event_type" = 'ToolInvocation.ReconciliationRequested'`);
  });
});
