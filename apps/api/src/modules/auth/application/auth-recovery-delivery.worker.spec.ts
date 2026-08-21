import type { Prisma } from '@prisma/client';

import type { AuthPrismaService } from '../../../database/auth-prisma.service.js';
import type { IdentitySecretVault } from '../../identity-governance/identity-secret-vault.js';
import type { AuthRecoveryNotificationService } from './auth-recovery-notification.service.js';
import { AuthRecoveryDeliveryWorker } from './auth-recovery-delivery.worker.js';

const TENANT_ID = '00000000-0000-7000-8000-000000000001';
const DELIVERY_ID = '00000000-0000-7000-8000-000000000002';
const ACTION_ID = '00000000-0000-7000-8000-000000000003';

describe('AuthRecoveryDeliveryWorker', () => {
  it('claims an encrypted delivery and records a terminal provider receipt without exposing the token', async () => {
    const executeRaw = vi.fn().mockResolvedValue(1);
    const queryRaw = vi.fn().mockResolvedValue([
      {
        id: DELIVERY_ID,
        tenantId: TENANT_ID,
        actionTokenId: ACTION_ID,
        payloadCiphertext: Buffer.from('ciphertext'),
        attempts: 1,
        expiresAt: new Date(Date.now() + 60_000),
      },
    ]);
    const transaction = { $executeRaw: executeRaw, $queryRaw: queryRaw };
    const prisma = {
      enabled: true,
      withAuth: <T>(operation: (value: typeof transaction) => Promise<T>) => operation(transaction),
    } as unknown as AuthPrismaService;
    const vault = {
      decrypt: vi.fn().mockReturnValue(
        JSON.stringify({
          schemaVersion: 1,
          email: 'member@example.test',
          displayName: 'Member',
          tenantName: 'Tenant',
          token: 'ea_reset_private-capability',
        }),
      ),
    } as unknown as IdentitySecretVault;
    const notifications = {
      sendPasswordReset: vi.fn().mockResolvedValue('SENT'),
    } as unknown as AuthRecoveryNotificationService;

    await expect(
      new AuthRecoveryDeliveryWorker(prisma, vault, notifications).runOnce(),
    ).resolves.toBe(1);

    expect(vault.decrypt).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      expect.objectContaining({
        tenantId: TENANT_ID,
        resourceId: DELIVERY_ID,
        purpose: 'AUTH_RECOVERY_DELIVERY',
      }),
    );
    expect(notifications.sendPasswordReset).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'member@example.test',
        displayName: 'Member',
        tenantName: 'Tenant',
        token: 'ea_reset_private-capability',
      }),
    );
    const sql = executeRaw.mock.calls.map(([statement]) => prismaSqlText(statement)).join('\n');
    const values = executeRaw.mock.calls.flatMap(([statement]) => (statement as Prisma.Sql).values);
    expect(sql).toContain('"auth_recovery_deliveries"');
    expect(values).toContain('SENT');
    expect(sql).not.toContain('ea_reset_private-capability');
  });
});

function prismaSqlText(value: unknown): string {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('strings' in value) ||
    !Array.isArray(value.strings)
  ) {
    return '';
  }
  return value.strings.join('?');
}
