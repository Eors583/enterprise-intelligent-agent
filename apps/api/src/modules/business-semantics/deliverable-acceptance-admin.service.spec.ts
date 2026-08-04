import type { Deliverable as DbDeliverable, Evidence as DbEvidence, Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { submitDeliverableWithinTransaction } from './deliverable-acceptance-admin.service.js';

const tenantId = '00000000-0000-7000-8000-000000000001';
const taskId = '00000000-0000-7000-8000-000000000002';
const deliverableId = '00000000-0000-7000-8000-000000000003';
const evidenceId = '00000000-0000-7000-8000-000000000004';

describe('submitDeliverableWithinTransaction', () => {
  it('persists server-derived effective permission labels with the submission', async () => {
    const submittedAt = '2026-07-29T10:00:00.000Z';
    const transaction = {
      evidence: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: evidenceId,
            version: 1,
            effectiveFrom: new Date('2026-07-01T00:00:00.000Z'),
            effectiveTo: null,
          } as DbEvidence,
        ]),
      },
      deliverableEvidence: {
        createMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      deliverable: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };

    await submitDeliverableWithinTransaction(
      transaction as unknown as Prisma.TransactionClient,
      tenantId,
      taskId,
      {
        id: deliverableId,
        tenantId,
        taskId,
        version: 1,
        status: 'DRAFT',
        revision: 3,
      } as unknown as DbDeliverable,
      {
        action: 'SUBMIT',
        expectedRevision: 3,
        submittedAt,
        artifactUri: 'https://documents.example.test/result',
        contentHash: 'a'.repeat(64),
        evidenceIds: [evidenceId],
        effectivePermissionLabels: ['classification:internal', 'department:sales'],
      },
    );

    expect(transaction.deliverable.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId,
          id: deliverableId,
          taskId,
          revision: 3,
        }),
        data: expect.objectContaining({
          permissionLabels: ['classification:internal', 'department:sales'],
          contentHash: 'a'.repeat(64),
        }),
      }),
    );
  });
});
