import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('durable account-recovery delivery hardening', () => {
  it('persists only an encrypted leased payload and keeps the raw capability out of Outbox', () => {
    const root = join(import.meta.dirname, '..', '..', '..');
    const service = readFileSync(
      join(root, 'src/modules/auth/application/auth-recovery.service.ts'),
      'utf8',
    );
    const worker = readFileSync(
      join(root, 'src/modules/auth/application/auth-recovery-delivery.worker.ts'),
      'utf8',
    );
    const migration = readFileSync(
      join(root, 'prisma/migrations/20260729003000_auth_recovery_durable_delivery/migration.sql'),
      'utf8',
    );

    expect(service).not.toContain('setImmediate(');
    expect(service).toContain('"payload_ciphertext"');
    expect(service).toContain("purpose: 'AUTH_RECOVERY_DELIVERY'");
    expect(worker).toContain('FOR UPDATE OF delivery SKIP LOCKED');
    expect(worker).toContain('action."consumed_at" IS NULL');
    expect(worker).toContain('action."revoked_at" IS NULL');
    expect(migration).toContain(
      'ALTER TABLE public."auth_recovery_deliveries" FORCE ROW LEVEL SECURITY',
    );
    expect(migration).toContain(
      'REVOKE ALL PRIVILEGES ON TABLE public."auth_recovery_deliveries" FROM PUBLIC',
    );
    expect(migration).not.toContain('"token"');
  });
});
