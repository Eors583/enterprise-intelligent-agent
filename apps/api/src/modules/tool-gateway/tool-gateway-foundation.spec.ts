import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const apiRoot = process.cwd().endsWith(path.join('apps', 'api'))
  ? process.cwd()
  : path.resolve(process.cwd(), 'apps/api');
const migration = readFileSync(
  path.join(apiRoot, 'prisma/migrations/20260728000700_tool_gateway_foundation/migration.sql'),
  'utf8',
);

describe('Tool Gateway database foundation', () => {
  it('creates a versioned registry and immutable invocation ledgers', () => {
    for (const table of [
      'tool_definitions',
      'tool_versions',
      'tool_invocations',
      'tool_invocation_commands',
      'tool_execution_receipts',
      'tool_dns_resolution_proofs',
    ]) {
      expect(migration).toContain(`CREATE TABLE public."${table}"`);
    }
    expect(migration).toContain('tool_versions_configuration_immutable');
    expect(migration).toContain('tool_invocation_commands_append_only_trigger');
    expect(migration).toContain('tool_execution_receipts_append_only_trigger');
    expect(migration).toContain('tool_dns_resolution_proofs_append_only_trigger');
    expect(migration).toContain('tool_invocations_no_delete_trigger');
  });

  it('requires one exact command for each revision and status transition', () => {
    expect(migration).toContain('tool_invocation_commands_revision_key');
    expect(migration).toContain('"result_revision" = "expected_revision" + 1');
    expect(migration).toContain('validate_tool_command_transition');
    expect(migration).toContain('validate_tool_transition_command');
    expect(migration).toContain('tool_invocation_commands_status_coverage');
    expect(migration).toContain('tool_invocations_command_coverage');
    expect(migration.match(/DEFERRABLE INITIALLY DEFERRED/g)).toHaveLength(2);
  });

  it('persists bound confirmation, approval, provider, and compensation proofs', () => {
    for (const binding of [
      'tenantId',
      'invocationId',
      'toolVersionId',
      'taskId',
      'inputHash',
      'policyDecisionId',
      'requesterRoleAssignmentId',
      'approverRoleAssignmentId',
      'providerRequestId',
      'authorizedCommand',
      'expiresAt',
    ]) {
      expect(migration).toContain(`'${binding}'`);
    }
    expect(migration).toContain('tool_invocation_commands_independent_approval');
    expect(migration).toContain('tool_invocations_approval_actor');
    expect(migration).toContain('tool_invocations_confirmation_actor');
    expect(migration).toContain('tool_invocations_high_risk_gate');
  });

  it('makes validate-only, native dry-run, and draft-only obligations enforceable', () => {
    expect(migration).toContain('tool_invocations_dry_run_dispatch_check');
    expect(migration).not.toContain('tool_invocations_validate_only_no_dispatch');
    expect(migration).toContain(
      'Its single validator\n    -- receipt is appended for the terminal transition below.',
    );
    expect(migration).toContain('"tenant_id", "tool_invocation_id", "execution_attempt", "source"');
    expect(migration).toContain('tool_execution_receipts_no_provider_dispatch');
    expect(migration).toContain('tool_execution_receipts_dry_run_binding');
    expect(migration).toContain('tool_execution_receipts_draft_only');
    expect(migration).toContain(`"output"->>'artifactMode' = 'DRAFT'`);
  });

  it('requires a fresh allowlisted public-IP pin for every HTTP dispatch', () => {
    expect(migration).toContain('tool_dns_resolution_proofs_host_allowlist');
    expect(migration).toContain('tool_dns_resolution_proofs_pin_membership');
    expect(migration).toContain('tool_dns_resolution_proofs_public_pin_check');
    expect(migration).toContain('tool_dns_resolution_proofs_redirect_check');
    expect(migration).toContain('tool_invocations_http_dns_proof');
    expect(migration).toContain('tool_execution_receipts_dns_binding');
    for (const deniedRange of [
      '10.0.0.0/8',
      '100.64.0.0/10',
      '127.0.0.0/8',
      '169.254.0.0/16',
      '192.168.0.0/16',
      '::1/128',
      'fc00::/7',
      'fe80::/10',
    ]) {
      expect(migration).toContain(`inet '${deniedRange}'`);
    }
  });

  it('uses a non-bypass capability role with tenant RLS and transactional audit/outbox', () => {
    expect(migration).toContain('CREATE ROLE enterprise_agent_tool_gateway');
    expect(migration).toContain('NOINHERIT NOBYPASSRLS');
    expect(migration).toContain('tool_tenant_isolation');
    expect(migration).toContain('tool_gateway_parent_tenant');
    expect(migration).toContain('tool_app_invocation_read');
    expect(migration).toContain('record_tool_command_side_effects');
    expect(migration).toContain('ToolInvocationCommandRecorded');
    expect(migration).toContain('tool_gateway_audit_tenant');
    expect(migration).toContain('tool_gateway_outbox_tenant');
  });
});
