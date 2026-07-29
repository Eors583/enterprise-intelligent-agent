import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const apiRoot = process.cwd().endsWith(path.join('apps', 'api'))
  ? process.cwd()
  : path.resolve(process.cwd(), 'apps/api');
const repositorySource = readFileSync(
  path.join(
    apiRoot,
    'src/modules/tool-gateway/infrastructure/prisma/prisma-tool-execution.repository.ts',
  ),
  'utf8',
);
const migrationSource = readFileSync(
  path.join(
    apiRoot,
    'prisma/migrations/20260728001000_tool_gateway_predispatch_receipts/migration.sql',
  ),
  'utf8',
);
const compensationMigrationSource = readFileSync(
  path.join(apiRoot, 'prisma/migrations/20260728001300_tool_compensation_execution/migration.sql'),
  'utf8',
);

describe('Prisma Tool execution settlement invariants', () => {
  it('reserves a deterministic provider request id before provider dispatch', () => {
    expect(repositorySource).toContain(
      'const providerRequestId = `${PROVIDER_REQUEST_PREFIX}${current.id}`',
    );
    expect(repositorySource.indexOf('"provider_request_id" = ${providerRequestId}')).toBeLessThan(
      repositorySource.indexOf('recordDnsProof(input: ToolDnsProofInput)'),
    );
  });

  it('serializes and enforces cross-replica capacity before START', () => {
    expect(repositorySource).toContain('pg_advisory_xact_lock');
    expect(repositorySource).toContain('tool-capacity:');
    expect(repositorySource).toContain('TOOL_MAX_CONCURRENT_PER_VERSION');
    expect(repositorySource).toContain('TOOL_MAX_STARTS_PER_MINUTE_PER_VERSION');
    expect(repositorySource).toContain("reasonCode: 'TOOL_CONCURRENCY_LIMIT'");
    expect(repositorySource).toContain("reasonCode: 'TOOL_RATE_LIMIT'");
    expect(repositorySource.indexOf('pg_advisory_xact_lock')).toBeLessThan(
      repositorySource.indexOf('"status" = \'EXECUTING\''),
    );
  });

  it('persists a no-provider receipt for every failed pre-dispatch attempt', () => {
    expect(repositorySource).toContain("failureBoundary: 'PRE_DISPATCH'");
    expect(repositorySource).toContain(
      '\'GATEWAY_VALIDATOR\'::public."ToolExecutionReceiptSource"',
    );
    expect(repositorySource).toContain('\'FAILED\'::public."ToolExecutionReceiptOutcome"');
    expect(repositorySource).toContain('\'GATEWAY_ATTESTED\'::public."ToolCostAttestation"');
    expect(migrationSource).toContain('failed pre-dispatch attempts');
    expect(migrationSource).toContain('NEW."provider_request_id" IS NULL');
    expect(migrationSource).toContain('NEW."cost_micros" = 0');
  });

  it('persists provider cost attestation independently from the nullable amount', () => {
    expect(repositorySource).toContain('const costAttestation = settlement.cost.kind');
    expect(repositorySource).toContain('"cost_micros", "cost_attestation", "receipt_hash"');
    expect(repositorySource).toContain('${costAttestation}::public."ToolCostAttestation"');
  });

  it('keeps provider receipts bound to DNS proof and disallows provider claims for validate-only', () => {
    expect(migrationSource).toContain('tool_execution_receipts_no_provider_dispatch');
    expect(migrationSource).toContain('tool_execution_receipts_dns_binding');
    expect(migrationSource).toContain('proof."expires_at" > NEW."started_at"');
  });

  it('moves the original into COMPENSATING only inside the child execution start transaction', () => {
    expect(repositorySource).toContain('beginOriginalCompensation(transaction, current, now)');
    expect(
      repositorySource.indexOf('beginOriginalCompensation(transaction, current, now)'),
    ).toBeLessThan(
      repositorySource.indexOf(
        'const providerRequestId = `${PROVIDER_REQUEST_PREFIX}${current.id}`',
      ),
    );
    expect(repositorySource).toContain("command: 'BEGIN_COMPENSATION'");
    expect(repositorySource).toContain(`"status" = 'COMPENSATING'::public."ToolInvocationStatus"`);
    expect(compensationMigrationSource).toContain(
      'tool_invocation_commands_compensation_receipt_binding',
    );
  });

  it('settles original compensation from one immutable child receipt', () => {
    expect(repositorySource).toContain('finalizeOriginalCompensation(transaction, current');
    expect(repositorySource).toContain(`'COMPENSATOR'::public."ToolExecutionReceiptSource"`);
    expect(repositorySource).toContain('${nextStatus}::public."ToolExecutionReceiptOutcome"');
    expect(repositorySource).toContain('compensationReceiptHash');
    expect(repositorySource).toContain(
      "result.outcome === 'SUCCEEDED' ? 'COMPLETE_COMPENSATION' : 'FAIL_COMPENSATION'",
    );
  });
});
