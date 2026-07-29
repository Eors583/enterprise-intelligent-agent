import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const REPOSITORY_SOURCE = readFileSync(
  new URL('./prisma-tool-gateway.repository.ts', import.meta.url),
  'utf8',
);
const SUPPORT_SOURCE = readFileSync(
  new URL('./tool-gateway-prisma.support.ts', import.meta.url),
  'utf8',
);
const MIGRATION_SOURCE = readFileSync(
  new URL(
    '../../../../../prisma/migrations/20260728000700_tool_gateway_foundation/migration.sql',
    import.meta.url,
  ),
  'utf8',
);

describe('Prisma Tool Gateway hardening', () => {
  it('always demotes raw SQL to a dedicated no-bypass capability role with tenant and user context', () => {
    expect(SUPPORT_SOURCE).toContain(
      "role: 'enterprise_agent_admin' | 'enterprise_agent_tool_gateway'",
    );
    expect(SUPPORT_SOURCE).toContain('SET LOCAL ROLE ${role}');
    expect(SUPPORT_SOURCE).toContain("set_config('app.tenant_id'");
    expect(SUPPORT_SOURCE).toContain("set_config('app.user_id'");
    expect(REPOSITORY_SOURCE).toContain("'enterprise_agent_tool_gateway'");
  });

  it('resolves the requester from the Task owner and never reads an actor identity from the request', () => {
    expect(REPOSITORY_SOURCE).toContain('task.owner_role_assignment_id');
    expect(REPOSITORY_SOURCE).toContain('assignment.userId !== requesterUserId');
    expect(REPOSITORY_SOURCE).not.toMatch(
      /request\.(requesterUserId|roleAssignmentId|approverUserId)/u,
    );
  });

  it('discovers only the exact current published Tool Version through the same task policy gate', () => {
    expect(REPOSITORY_SOURCE).toContain('async listAvailableTools(');
    expect(REPOSITORY_SOURCE).toContain('definition."current_version_id" = version."id"');
    expect(REPOSITORY_SOURCE).toContain('definition."current_version" = version."version"');
    expect(REPOSITORY_SOURCE).toContain('definition."status" = \'PUBLISHED\'');
    expect(REPOSITORY_SOURCE).toContain('version."status" = \'PUBLISHED\'');
    expect(REPOSITORY_SOURCE).toContain('assignment.userId !== principal.userId');
    expect(REPOSITORY_SOURCE).toContain('const policy = decideToolInvocationPolicy(');
    expect(REPOSITORY_SOURCE).toContain("if (policy.kind === 'deny') continue;");
  });

  it('builds a reviewer queue from pending approvals without allowing requester self-approval', () => {
    expect(REPOSITORY_SOURCE).toContain('async listReviewableInvocations(');
    expect(REPOSITORY_SOURCE).toContain('AND "status" = \'PENDING_APPROVAL\'');
    expect(REPOSITORY_SOURCE).toContain('AND "requester_user_id" <> ${principal.userId}::uuid');
    expect(REPOSITORY_SOURCE).toContain(
      'const assignment = await loadReviewerAssignment(transaction, row, principal.userId);',
    );
    expect(REPOSITORY_SOURCE).toContain(
      "hasToolAction(assignment.permissionActions, 'tool.approve', toolKey)",
    );
    expect(MIGRATION_SOURCE).toContain(
      'assignment."permission_scope"->\'actions\' ? (\'tool.approve:\' || version."key")',
    );
  });

  it('completes VALIDATE_ONLY with one validator receipt and no provider dispatch', () => {
    expect(REPOSITORY_SOURCE).toContain("approved.dry_run_mode !== 'VALIDATE_ONLY'");
    expect(REPOSITORY_SOURCE).toContain('approved.provider_dispatch_allowed');
    expect(REPOSITORY_SOURCE).toContain(
      '\'GATEWAY_VALIDATOR\'::public."ToolExecutionReceiptSource"',
    );
    expect(REPOSITORY_SOURCE).toContain('\'GATEWAY_ATTESTED\'::public."ToolCostAttestation"');
    expect(REPOSITORY_SOURCE).not.toContain('\'PROVIDER\'::public."ToolExecutionReceiptSource"');
    expect(REPOSITORY_SOURCE.match(/INSERT INTO public\."tool_execution_receipts"/gu)).toHaveLength(
      1,
    );
    expect(MIGRATION_SOURCE).toContain('A provider receipt cannot exist for VALIDATE_ONLY.');
    expect(MIGRATION_SOURCE).toContain(
      '"tenant_id", "tool_invocation_id", "execution_attempt", "source"',
    );
    expect(MIGRATION_SOURCE).toContain(
      'Its single validator\n    -- receipt is appended for the terminal transition below.',
    );
    expect(MIGRATION_SOURCE).not.toContain(
      'VALIDATE_ONLY cannot dispatch a provider and requires a validator receipt.',
    );
  });

  it('persists every transition through CAS, an immutable command, audit and outbox', () => {
    expect(REPOSITORY_SOURCE).toContain('decideToolInvocationTransition');
    expect(REPOSITORY_SOURCE).toContain("current.status !== 'FAILED'");
    expect(REPOSITORY_SOURCE).toContain('UNKNOWN requires reconciliation');
    expect(REPOSITORY_SOURCE).toContain('WITH RECURSIVE retry_lineage AS');
    expect(REPOSITORY_SOURCE).toContain('version."max_attempts"');
    expect(REPOSITORY_SOURCE).toContain('INSERT INTO public."tool_invocation_commands"');
    expect(REPOSITORY_SOURCE).toContain('AND "revision" = ${current.revision}');
    expect(MIGRATION_SOURCE).toContain('tool_invocations_command_coverage_trigger');
    expect(MIGRATION_SOURCE).toContain('tool_invocation_commands_side_effects_trigger');
    expect(MIGRATION_SOURCE).toContain('ToolInvocationCommandRecorded');
  });

  it('advances the Tool Definition revision for every version lifecycle mutation', () => {
    expect(REPOSITORY_SOURCE.match(/updateDefinition: true/gu)).toHaveLength(3);
    expect(REPOSITORY_SOURCE).not.toContain('updateDefinition: current');
    expect(REPOSITORY_SOURCE).toContain('"revision" = "revision" + 1');
  });
});
