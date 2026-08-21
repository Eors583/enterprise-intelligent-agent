import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../../../database/prisma.service.js';
import {
  ADMIN_PRINCIPAL,
  DELIVERY_ID,
} from '../../../process-orchestration/testing/runtime-test-fixtures.js';
import { PrismaBusinessEventRepository } from './prisma-business-event.repository.js';

describe('PrismaBusinessEventRepository replay rejection mapping', () => {
  it('maps the replay actor trigger rejection to a stable result without database details', async () => {
    const databaseError = Object.assign(
      new Error('Raw query failed with private SQL and credential detail'),
      {
        code: 'P2010',
        meta: {
          code: '42501',
          constraint: 'business_event_deliveries_replay_actor_v2_check',
          message:
            'Dead-letter replay attribution requires the active tenant administrator. private-detail',
        },
      },
    );
    const transaction = {
      $executeRawUnsafe: vi.fn().mockResolvedValue(0),
      $queryRaw: vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ status: 'DEAD_LETTERED', revision: 2 }])
        .mockRejectedValueOnce(databaseError),
    };
    const prisma = {
      enabled: true,
      $transaction: vi.fn((operation: (value: typeof transaction) => unknown) =>
        operation(transaction),
      ),
    };
    const repository = new PrismaBusinessEventRepository(prisma as unknown as PrismaService);

    const result = await repository.replayDelivery({
      principal: ADMIN_PRINCIPAL,
      deliveryId: DELIVERY_ID,
      request: {
        expectedStatus: 'DEAD_LETTERED',
        reason: 'Replay after operator review.',
        idempotencyKey: 'delivery:replay:stable-rejection',
      },
    });

    expect(result).toEqual({
      kind: 'REJECTED',
      reason: 'INVARIANT_VIOLATION',
      detail: 'Dead-letter replay requires an active tenant owner or administrator.',
    });
    expect(JSON.stringify(result)).not.toContain('private');
    expect(JSON.stringify(result)).not.toContain('42501');
    expect(JSON.stringify(result)).not.toContain('business_event_deliveries_replay_actor_v2_check');
  });
});
