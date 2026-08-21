import { Prisma, type FinopsCostEntry as DbCostEntry } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { type EffectiveCostVerificationRow, mapCostEntry } from './finance-finops.mappers.js';

const tenantId = '00000000-0000-4000-8000-000000000001';
const costEntryId = '00000000-0000-4000-8000-000000000002';
const recorderUserId = '00000000-0000-4000-8000-000000000003';
const reviewerUserId = '00000000-0000-4000-8000-000000000004';
const reviewId = '00000000-0000-4000-8000-000000000005';
const evidenceId = '00000000-0000-4000-8000-000000000006';
const priceId = '00000000-0000-4000-8000-000000000007';
const occurredAt = new Date('2026-07-29T00:00:00.000Z');

describe('FinOps cost entry mapping', () => {
  it('keeps immutable original status separate from effective independent verification', () => {
    expect(mapCostEntry(costRow(), effectiveRow())).toMatchObject({
      id: costEntryId,
      verificationStatus: 'PENDING',
      originalVerificationStatus: 'PENDING',
      effectiveVerificationStatus: 'VERIFIED',
      calculatedAmount: '6',
      latestVerificationReview: {
        id: reviewId,
        costEntryId,
        decision: 'VERIFIED',
        basis: 'TRUSTED_EVIDENCE',
        reviewerUserId,
        evidenceId,
        evidenceVersion: 3,
        evidenceContentHash: 'e'.repeat(64),
      },
    });
  });

  it('uses the immutable original status when no independent review exists', () => {
    expect(mapCostEntry(costRow())).toMatchObject({
      verificationStatus: 'PENDING',
      originalVerificationStatus: 'PENDING',
      effectiveVerificationStatus: 'PENDING',
      latestVerificationReview: null,
    });
  });
});

function costRow(): DbCostEntry {
  return {
    id: costEntryId,
    tenantId,
    subjectType: 'API',
    subjectId: 'admin-api-cost',
    agentRunId: null,
    toolInvocationId: null,
    knowledgeDocumentVersionId: null,
    humanUserId: null,
    priceSnapshotId: priceId,
    priceSnapshotVersion: 2,
    resourceKind: 'API',
    quantity: new Prisma.Decimal(3),
    rawUsage: { requests: 3 },
    formulaCode: 'LINEAR_UNIT_RATE',
    formulaVersion: 1,
    formulaExpression: '(quantity / unitSize) * unitPrice',
    currency: 'CNY',
    calculatedAmount: new Prisma.Decimal(6),
    verificationStatus: 'PENDING',
    sourceAuthority: 'HUMAN_ATTESTED',
    sourceSystem: 'admin-finops',
    sourceRecordId: 'admin-api-cost',
    sourceRecordVersion: '1',
    sourceContentHash: 'c'.repeat(64),
    sourceEvidenceId: null,
    sourceEvidenceVersion: null,
    incurredAt: occurredAt,
    recordedByUserId: recorderUserId,
    idempotencyKey: 'cost-create-00000001',
    requestHash: 'd'.repeat(64),
    createdAt: occurredAt,
  };
}

function effectiveRow(): EffectiveCostVerificationRow {
  return {
    tenantId,
    costEntryId,
    originalVerificationStatus: 'PENDING',
    effectiveVerificationStatus: 'VERIFIED',
    reviewId,
    reviewRevision: 1,
    reviewDecision: 'VERIFIED',
    reviewBasis: 'TRUSTED_EVIDENCE',
    reviewerUserId,
    evidenceId,
    evidenceVersion: 3,
    evidenceContentHash: 'e'.repeat(64),
    reviewComment: 'Independent Evidence verified the immutable source usage.',
    reviewedAt: occurredAt,
  };
}
