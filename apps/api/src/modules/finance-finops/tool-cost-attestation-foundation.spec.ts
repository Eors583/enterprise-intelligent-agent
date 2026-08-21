import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(
    process.cwd(),
    'prisma/migrations/20260729000800_tool_cost_attestation_invitation_hardening/migration.sql',
  ),
  'utf8',
);

describe('Tool cost attestation database foundation', () => {
  it('keeps unreported cost nullable and distinct from attested zero', () => {
    expect(migration.trimStart().startsWith('--')).toBe(true);
    expect(migration).toContain('BEGIN;');
    expect(migration.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(migration).toContain('CREATE TYPE public."ToolCostAttestation"');
    expect(migration).toContain('"cost_attestation" = \'UNATTESTED\'');
    expect(migration).toContain('AND "cost_micros" IS NULL');
    expect(migration).toContain('"cost_attestation" = \'PROVIDER_ATTESTED\'');
    expect(migration).toContain('AND "cost_micros" IS NOT NULL');
    expect(migration).toContain('"cost_attestation" = \'GATEWAY_ATTESTED\'');
    expect(migration).toContain('AND "cost_micros" = 0');
  });

  it('does not grant public access to the attestation type', () => {
    expect(migration).toContain('REVOKE ALL ON TYPE public."ToolCostAttestation" FROM PUBLIC');
    expect(migration).toContain('enterprise_agent_finops_projector');
    expect(migration).toContain('enterprise_agent_tool_gateway');
    expect(migration).toContain('enterprise_agent_app');
    expect(migration).toContain('enterprise_agent_admin');
  });
});
