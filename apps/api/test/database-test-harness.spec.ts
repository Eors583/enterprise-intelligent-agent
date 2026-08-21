import type { PrismaClient } from '@prisma/client';

import { cleanupDisposableTenants } from './database-test-harness.js';

describe('database test cleanup safety gate', () => {
  it('refuses a destructive cleanup when the configured connection reaches a development database', async () => {
    const previous = process.env.RUN_DATABASE_TESTS;
    process.env.RUN_DATABASE_TESTS = 'true';
    const transaction = vi.fn();
    const client = {
      $queryRaw: vi.fn().mockResolvedValue([
        {
          databaseName: 'enterprise_agent',
          currentUser: 'postgres',
          isSuperuser: true,
        },
      ]),
      $transaction: transaction,
    } as unknown as PrismaClient;

    try {
      await expect(
        cleanupDisposableTenants(client, ['00000000-0000-7000-8000-000000000001']),
      ).rejects.toThrow(
        'Refusing destructive test cleanup for non-disposable database enterprise_agent.',
      );
      expect(transaction).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.RUN_DATABASE_TESTS;
      else process.env.RUN_DATABASE_TESTS = previous;
    }
  });
});
