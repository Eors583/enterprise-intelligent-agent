import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

describe('Feishu directory synchronization persistence boundary', () => {
  it('persists previews, leased runs, tenant RLS and the outbox capability grant', () => {
    const migration = readFileSync(
      new URL(
        '../../../prisma/migrations/20260728001200_feishu_directory_sync_runs/migration.sql',
        import.meta.url,
      ),
      'utf8',
    );
    expect(migration).toContain('CREATE TABLE public."directory_sync_previews"');
    expect(migration).toContain('CREATE TABLE public."directory_sync_preview_items"');
    expect(migration).toContain('CREATE TABLE public."directory_sync_runs"');
    expect(migration).toContain('"lease_owner" varchar(120)');
    expect(migration).toContain('FORCE ROW LEVEL SECURITY');
    expect(migration).toContain('TO enterprise_agent_outbox');
  });

  it('does not detach synchronization from the request lifecycle', () => {
    const service = readFileSync(
      new URL('./feishu-directory-sync.service.ts', import.meta.url),
      'utf8',
    );
    expect(service).not.toContain('void this.execute(claim)');
    expect(service).toContain('expectedSnapshotCursor');
    expect(service).toContain('SNAPSHOT_CHANGED');
    expect(service).toContain('DIRECTORY_ACCOUNT_REMOVED');
    expect(service).toContain('cancelAssignedAgentRuns');
    expect(service).toContain('cascadeAssignmentDescendants');
  });

  it('claims with skip-locked leases and renews the Outbox lock', () => {
    const worker = readFileSync(
      new URL('./feishu-directory-sync.worker.ts', import.meta.url),
      'utf8',
    );
    const service = readFileSync(
      new URL('./feishu-directory-sync.service.ts', import.meta.url),
      'utf8',
    );
    expect(worker).toContain('FOR UPDATE SKIP LOCKED');
    expect(worker).toContain('run.lease_expires_at <= CURRENT_TIMESTAMP');
    expect(worker).toContain('first_attempted_at = COALESCE');
    expect(worker).toContain('renewDirectoryDelivery');
    expect(worker).toContain('SET locked_until = ${leaseExpiresAt}');
    expect(service).toContain('renewWorkerLease');
    expect(service).toContain('data: { leaseExpiresAt }');
  });

  it('imports directory identities without manufacturing a shared password credential', () => {
    const service = readFileSync(
      new URL('./feishu-directory-sync.service.ts', import.meta.url),
      'utf8',
    );
    const environment = readFileSync(
      new URL('../../config/environment.ts', import.meta.url),
      'utf8',
    );
    expect(service).not.toContain('FEISHU_DIRECTORY_INITIAL_PASSWORD');
    expect(service).not.toContain('passwordCredential.create');
    expect(service).not.toContain('this.passwords.hash');
    expect(environment).not.toContain('FEISHU_DIRECTORY_INITIAL_PASSWORD');
  });
});
