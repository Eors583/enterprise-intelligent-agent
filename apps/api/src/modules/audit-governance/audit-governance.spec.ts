import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { auditGovernanceTestSupport } from './audit-governance.service.js';

const migration = readFileSync(
  resolve(process.cwd(), 'prisma/migrations/20260728001500_audit_hash_chain/migration.sql'),
  'utf8',
);
const verifierAclMigration = readFileSync(
  resolve(
    process.cwd(),
    'prisma/migrations/20260729001400_audit_verifier_helper_acl/migration.sql',
  ),
  'utf8',
);

describe('audit governance foundation', () => {
  it('backfills and serializes a tenant-scoped SHA-256 chain', () => {
    expect(migration).toContain('audit_event_chain_payload');
    expect(migration).toContain('pg_advisory_xact_lock');
    expect(migration).toContain('\'audit-chain:\' || NEW."tenant_id"::text');
    expect(migration).toContain('"chain_sequence" = next_sequence');
    expect(migration).toContain('digest(');
    expect(migration).toContain("'sha256'");
    expect(migration).toContain('audit_events_tenant_chain_sequence_key');
    expect(migration).toContain('audit_events_tenant_event_hash_key');
  });

  it('rejects update, delete and truncate while exposing a tenant-bound verifier', () => {
    expect(migration).toContain('BEFORE UPDATE OR DELETE');
    expect(migration).toContain('BEFORE TRUNCATE');
    expect(migration).toContain("RAISE EXCEPTION 'audit_events is append-only'");
    expect(migration).toContain('verify_audit_event_chain');
    expect(migration).toContain("current_setting('app.tenant_id', true)::uuid <> p_tenant_id");
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.verify_audit_event_chain(uuid)');
    expect(migration).toContain('TO enterprise_agent_admin');
  });

  it('grants only the admin verifier role access to the immutable payload helper', () => {
    expect(verifierAclMigration).toContain(
      'REVOKE ALL ON FUNCTION public.audit_event_chain_payload(',
    );
    expect(verifierAclMigration).toContain('FROM PUBLIC');
    expect(verifierAclMigration).toContain(
      'GRANT EXECUTE ON FUNCTION public.audit_event_chain_payload(',
    );
    expect(verifierAclMigration).toContain('TO enterprise_agent_admin');
    expect(verifierAclMigration).not.toContain('TO enterprise_agent_app');
    expect(verifierAclMigration).not.toContain('TO enterprise_agent_auth');
  });

  it('uses opaque cursors and rejects malformed cursor input', () => {
    const cursor = auditGovernanceTestSupport.encodeCursor({
      occurredAt: '2026-07-28T10:00:00.000Z',
      id: '00000000-0000-7000-8000-000000000001',
    });
    expect(auditGovernanceTestSupport.decodeCursor(cursor)).toEqual({
      occurredAt: '2026-07-28T10:00:00.000Z',
      id: '00000000-0000-7000-8000-000000000001',
    });
    expect(() => auditGovernanceTestSupport.decodeCursor('not-a-cursor')).toThrow(
      BadRequestException,
    );
  });

  it('neutralizes spreadsheet formulas and includes chain evidence in CSV exports', () => {
    const csv = auditGovernanceTestSupport.renderAuditCsv([
      {
        id: '00000000-0000-7000-8000-000000000001',
        tenantId: '00000000-0000-7000-8000-000000000002',
        actorType: 'USER',
        actorId: '00000000-0000-7000-8000-000000000003',
        action: '=HYPERLINK("https://malicious.invalid")',
        resourceType: 'document',
        resourceId: '00000000-0000-7000-8000-000000000004',
        metadata: {},
        occurredAt: '2026-07-28T10:00:00.000Z',
        chainSequence: '1',
        previousHash: null,
        eventHash: 'a'.repeat(64),
      },
    ]);
    expect(csv).toContain('chainSequence,eventHash,previousHash');
    expect(csv).toContain(`"${'a'.repeat(64)}"`);
    expect(csv).toContain(`"'=HYPERLINK(""https://malicious.invalid"")"`);
  });
});
