import { ConflictException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { FinopsLedgerService } from './finops-ledger.service.js';
import type { AdminPrismaService } from '../../database/admin-prisma.service.js';
import type { AdminAccessService } from '../admin/admin-access.service.js';

const tenantId = '00000000-0000-4000-8000-000000000001';
const reviewerUserId = '00000000-0000-4000-8000-000000000002';
const recorderUserId = '00000000-0000-4000-8000-000000000003';
const costEntryId = '00000000-0000-4000-8000-000000000004';
const reviewId = '00000000-0000-4000-8000-000000000005';
const evidenceId = '00000000-0000-4000-8000-000000000006';

describe('FinopsLedgerService cost verification', () => {
  it('binds the authenticated reviewer and records command, audit, and outbox atomically', async () => {
    const transaction = transactionFixture(recorderUserId);
    const service = serviceWith(transaction);

    await expect(
      service.reviewCost(costEntryId, {
        decision: 'VERIFIED',
        basis: 'TRUSTED_EVIDENCE',
        evidenceId,
        evidenceVersion: 2,
        comment: 'Independent verified Evidence matches the immutable usage source.',
        idempotencyKey: 'cost-review-service-0001',
      }),
    ).resolves.toMatchObject({
      id: reviewId,
      costEntryId,
      reviewerUserId,
      decision: 'VERIFIED',
      evidenceContentHash: 'e'.repeat(64),
    });

    expect(transaction.$queryRaw).toHaveBeenCalled();
    expect(transaction.finopsCostVerificationReview.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId,
        costEntryId,
        reviewerUserId,
        evidenceContentHash: null,
      }),
    });
    expect(transaction.finopsCommand.create).toHaveBeenCalledTimes(1);
    expect(transaction.auditEvent.create).toHaveBeenCalledTimes(1);
    expect(transaction.outboxEvent.create).toHaveBeenCalledTimes(1);
  });

  it('rejects the recorder before writing an independent review', async () => {
    const transaction = transactionFixture(reviewerUserId);
    const service = serviceWith(transaction);
    await expect(
      service.reviewCost(costEntryId, {
        decision: 'REJECTED',
        basis: 'REVIEWER_JUDGMENT',
        evidenceId: null,
        evidenceVersion: null,
        comment: 'Self-review must be rejected.',
        idempotencyKey: 'cost-review-service-self-0001',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(transaction.finopsCostVerificationReview.create).not.toHaveBeenCalled();
  });
});

function serviceWith(transaction: ReturnType<typeof transactionFixture>): FinopsLedgerService {
  const prisma = {
    withTenant: vi.fn(
      async (_tenantId: string, operation: (client: typeof transaction) => Promise<unknown>) =>
        operation(transaction),
    ),
  } as unknown as AdminPrismaService;
  const access = {
    requireDirectoryWrite: vi.fn(() => ({
      tenantId,
      userId: reviewerUserId,
      role: 'ADMIN',
    })),
  } as unknown as AdminAccessService;
  return new FinopsLedgerService(prisma, access);
}

function transactionFixture(recordedByUserId: string) {
  return {
    $executeRaw: vi.fn(async () => 1),
    $queryRaw: vi.fn(async () => [{ set_config: reviewerUserId }]),
    finopsCommand: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async () => ({})),
    },
    finopsCostEntry: {
      findFirst: vi.fn(async () => ({
        id: costEntryId,
        recordedByUserId,
        sourceAuthority: 'HUMAN_ATTESTED',
      })),
    },
    finopsCostVerificationReview: {
      findFirstOrThrow: vi.fn(),
      create: vi.fn(async () => ({
        id: reviewId,
        tenantId,
        costEntryId,
        revision: 1,
        decision: 'VERIFIED',
        basis: 'TRUSTED_EVIDENCE',
        reviewerUserId,
        evidenceId,
        evidenceVersion: 2,
        evidenceContentHash: 'e'.repeat(64),
        comment: 'Independent verified Evidence matches the immutable usage source.',
        idempotencyKey: 'cost-review-service-0001',
        requestHash: 'f'.repeat(64),
        createdAt: new Date('2026-07-29T00:00:00.000Z'),
      })),
    },
    auditEvent: { create: vi.fn(async () => ({})) },
    outboxEvent: { create: vi.fn(async () => ({})) },
  };
}
