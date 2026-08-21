import { Prisma, PrismaClient } from '@prisma/client';

import { cleanupDisposableTenants } from './database-test-harness.js';

const enabled = process.env.RUN_DATABASE_TESTS === 'true';
const tenantA = '00000000-0000-7000-8000-00000000fb01';
const tenantB = '00000000-0000-7000-8000-00000000fb02';
const recorderA = '00000000-0000-7000-8000-00000000fb11';
const reviewerA = '00000000-0000-7000-8000-00000000fb12';
const secondReviewerA = '00000000-0000-7000-8000-00000000fb13';
const reviewerB = '00000000-0000-7000-8000-00000000fb14';
const evidenceA = '00000000-0000-7000-8000-00000000fb21';
const evidenceB = '00000000-0000-7000-8000-00000000fb22';
const priceA = '00000000-0000-7000-8000-00000000fb31';
const costA = '00000000-0000-7000-8000-00000000fb41';
const now = new Date();
const beforeNow = new Date(now.getTime() - 60_000);

describe.runIf(enabled)('PostgreSQL independent FinOps cost verification', () => {
  const administrator = new PrismaClient();

  beforeAll(async () => {
    await cleanup();
    await seed();
  });

  afterAll(async () => {
    await cleanup();
    await administrator.$disconnect();
  });

  it('enforces maker-checker and active same-tenant verified Evidence', async () => {
    await expect(
      createReview(recorderA, {
        decision: 'VERIFIED',
        basis: 'TRUSTED_EVIDENCE',
        evidenceId: evidenceA,
        evidenceVersion: 1,
        comment: 'The recorder must not verify their own cost.',
        idempotencyKey: 'finops-cost-review-self-0001',
      }),
    ).rejects.toThrow(/independent maker-checker/i);

    await expect(
      createReview(reviewerA, {
        decision: 'VERIFIED',
        basis: 'TRUSTED_EVIDENCE',
        evidenceId: evidenceB,
        evidenceVersion: 1,
        comment: 'Cross-tenant Evidence must be rejected.',
        idempotencyKey: 'finops-cost-review-cross-tenant-0001',
      }),
    ).rejects.toThrow();

    const review = await createReview(reviewerA, {
      decision: 'VERIFIED',
      basis: 'TRUSTED_EVIDENCE',
      evidenceId: evidenceA,
      evidenceVersion: 1,
      comment: 'Independent reviewer confirmed active verified Evidence.',
      idempotencyKey: 'finops-cost-review-valid-0001',
    });
    expect(review).toMatchObject({
      revision: 1,
      reviewerUserId: reviewerA,
      evidenceContentHash: 'e'.repeat(64),
    });

    const [state] = await administrator.$queryRaw<
      Array<{
        originalStatus: string;
        effectiveStatus: string;
        reviewId: string;
      }>
    >`
      SELECT
        "original_verification_status"::text AS "originalStatus",
        "effective_verification_status"::text AS "effectiveStatus",
        "review_id" AS "reviewId"
      FROM public."finops_effective_cost_verifications"
      WHERE "tenant_id" = ${tenantA}::uuid
        AND "cost_entry_id" = ${costA}::uuid
    `;
    expect(state).toEqual({
      originalStatus: 'PENDING',
      effectiveStatus: 'VERIFIED',
      reviewId: review.id,
    });
  });

  it('serializes concurrent immutable attestations and lets the latest dispute remove trusted cost', async () => {
    const [left, right] = await Promise.all([
      createReview(reviewerA, {
        decision: 'VERIFIED',
        basis: 'TRUSTED_EVIDENCE',
        evidenceId: evidenceA,
        evidenceVersion: 1,
        comment: 'A second evidence-backed verification exercises serialized revisions.',
        idempotencyKey: 'finops-cost-review-concurrent-0001',
      }),
      createReview(secondReviewerA, {
        decision: 'DISPUTED',
        basis: 'REVIEWER_JUDGMENT',
        evidenceId: null,
        evidenceVersion: null,
        comment: 'A concurrent independent dispute must not collide on revision.',
        idempotencyKey: 'finops-cost-review-concurrent-0002',
      }),
    ]);
    expect([left.revision, right.revision].sort()).toEqual([2, 3]);

    const latest = left.revision > right.revision ? left : right;
    if (latest.decision !== 'DISPUTED') {
      await createReview(secondReviewerA, {
        decision: 'DISPUTED',
        basis: 'REVIEWER_JUDGMENT',
        evidenceId: null,
        evidenceVersion: null,
        comment: 'A final independent dispute removes the cost from trusted totals.',
        idempotencyKey: 'finops-cost-review-final-dispute-0001',
      });
    }

    const [state] = await administrator.$queryRaw<Array<{ status: string }>>`
      SELECT "effective_verification_status"::text AS "status"
      FROM public."finops_effective_cost_verifications"
      WHERE "tenant_id" = ${tenantA}::uuid
        AND "cost_entry_id" = ${costA}::uuid
    `;
    expect(state?.status).toBe('DISPUTED');

    await expect(
      administrator.finopsCostVerificationReview.update({
        where: { id: left.id },
        data: { comment: 'Immutable review history cannot be rewritten.' },
      }),
    ).rejects.toThrow(/immutable/i);
    await expect(
      administrator.finopsCostVerificationReview.delete({ where: { id: left.id } }),
    ).rejects.toThrow(/immutable/i);
  });

  it('keeps tenant RLS and exact table ACL fail closed', async () => {
    const visible = await asAdminRows<{ count: bigint }>(
      tenantA,
      Prisma.sql`
        SELECT count(*)::bigint AS "count"
        FROM public."finops_cost_verification_reviews"
      `,
    );
    const hidden = await asAdminRows<{ count: bigint }>(
      tenantB,
      Prisma.sql`
        SELECT count(*)::bigint AS "count"
        FROM public."finops_cost_verification_reviews"
        WHERE "tenant_id" = ${tenantA}::uuid
      `,
    );
    expect(Number(visible[0]?.count)).toBeGreaterThan(0);
    expect(Number(hidden[0]?.count)).toBe(0);

    const [acl] = await administrator.$queryRaw<
      Array<{
        adminSelect: boolean;
        adminInsert: boolean;
        adminUpdate: boolean;
        adminDelete: boolean;
        appSelect: boolean;
        appInsert: boolean;
      }>
    >`
      SELECT
        has_table_privilege(
          'enterprise_agent_admin',
          'public.finops_cost_verification_reviews',
          'SELECT'
        ) AS "adminSelect",
        has_table_privilege(
          'enterprise_agent_admin',
          'public.finops_cost_verification_reviews',
          'INSERT'
        ) AS "adminInsert",
        has_table_privilege(
          'enterprise_agent_admin',
          'public.finops_cost_verification_reviews',
          'UPDATE'
        ) AS "adminUpdate",
        has_table_privilege(
          'enterprise_agent_admin',
          'public.finops_cost_verification_reviews',
          'DELETE'
        ) AS "adminDelete",
        has_table_privilege(
          'enterprise_agent_app',
          'public.finops_cost_verification_reviews',
          'SELECT'
        ) AS "appSelect",
        has_table_privilege(
          'enterprise_agent_app',
          'public.finops_cost_verification_reviews',
          'INSERT'
        ) AS "appInsert"
    `;
    expect(acl).toEqual({
      adminSelect: true,
      adminInsert: true,
      adminUpdate: false,
      adminDelete: false,
      appSelect: false,
      appInsert: false,
    });
  });

  async function createReview(
    reviewerUserId: string,
    input: {
      decision: 'VERIFIED' | 'DISPUTED' | 'REJECTED';
      basis: 'TRUSTED_EVIDENCE' | 'TRUSTED_SOURCE' | 'REVIEWER_JUDGMENT';
      evidenceId: string | null;
      evidenceVersion: number | null;
      comment: string;
      idempotencyKey: string;
    },
  ) {
    return administrator.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_admin');
      await transaction.$queryRaw`SELECT set_config('app.tenant_id', ${tenantA}, true)`;
      await transaction.$queryRaw`SELECT set_config('app.user_id', ${reviewerUserId}, true)`;
      return transaction.finopsCostVerificationReview.create({
        data: {
          tenantId: tenantA,
          costEntryId: costA,
          revision: 1,
          decision: input.decision,
          basis: input.basis,
          reviewerUserId,
          evidenceId: input.evidenceId,
          evidenceVersion: input.evidenceVersion,
          evidenceContentHash: null,
          comment: input.comment,
          idempotencyKey: input.idempotencyKey,
          requestHash: 'f'.repeat(64),
        },
      });
    });
  }

  async function asAdminRows<T>(tenantId: string, statement: Prisma.Sql): Promise<T[]> {
    return administrator.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_admin');
      await transaction.$queryRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      return transaction.$queryRaw<T[]>(statement);
    });
  }

  async function seed(): Promise<void> {
    await administrator.tenant.createMany({
      data: [
        { id: tenantA, slug: 'finops-cost-review-a', name: 'FinOps Cost Review A' },
        { id: tenantB, slug: 'finops-cost-review-b', name: 'FinOps Cost Review B' },
      ],
    });
    await administrator.user.createMany({
      data: [
        user(tenantA, recorderA, 'finops-review-recorder-a@test.invalid'),
        user(tenantA, reviewerA, 'finops-review-checker-a@test.invalid'),
        user(tenantA, secondReviewerA, 'finops-review-checker-b@test.invalid'),
        user(tenantB, reviewerB, 'finops-review-checker-c@test.invalid'),
      ],
    });
    await administrator.evidence.createMany({
      data: [
        evidence(tenantA, evidenceA, reviewerA, 'FINOPS.COST.EVIDENCE.A', 'e'.repeat(64)),
        evidence(tenantB, evidenceB, reviewerB, 'FINOPS.COST.EVIDENCE.B', 'd'.repeat(64)),
      ],
    });
    await administrator.finopsPriceSnapshot.create({
      data: {
        id: priceA,
        tenantId: tenantA,
        code: 'PRICE.API.REVIEW',
        version: 1,
        revision: 2,
        resourceKind: 'API',
        provider: 'internal',
        sku: 'api.review',
        currency: 'CNY',
        billingUnit: 'REQUEST',
        unitSize: new Prisma.Decimal(1),
        unitPrice: new Prisma.Decimal(2),
        effectiveFrom: beforeNow,
        status: 'APPROVED',
        sourceAuthority: 'TRUSTED_SYSTEM',
        sourceSystem: 'pricing-catalog',
        sourceRecordId: 'api.review',
        sourceRecordVersion: '1',
        sourceContentHash: 'a'.repeat(64),
        createdByUserId: recorderA,
        approvedByUserId: reviewerA,
        approvalComment: 'Independent price approval fixture.',
        approvedAt: now,
        idempotencyKey: 'finops-cost-review-price-0001',
        requestHash: 'b'.repeat(64),
      },
    });
    await administrator.finopsCostEntry.create({
      data: {
        id: costA,
        tenantId: tenantA,
        subjectType: 'API',
        subjectId: 'manual-api-cost-review',
        priceSnapshotId: priceA,
        priceSnapshotVersion: 1,
        resourceKind: 'API',
        quantity: new Prisma.Decimal(3),
        rawUsage: { requests: 3 },
        formulaCode: 'LINEAR_UNIT_RATE',
        formulaVersion: 1,
        formulaExpression: '(quantity / unitSize) * unitPrice',
        currency: 'CNY',
        calculatedAmount: new Prisma.Decimal(0),
        verificationStatus: 'PENDING',
        sourceAuthority: 'HUMAN_ATTESTED',
        sourceSystem: 'manual-finops',
        sourceRecordId: 'manual-api-cost-review',
        sourceRecordVersion: '1',
        sourceContentHash: 'c'.repeat(64),
        incurredAt: now,
        recordedByUserId: recorderA,
        idempotencyKey: 'finops-cost-review-entry-0001',
        requestHash: 'd'.repeat(64),
      },
    });
  }

  async function cleanup(): Promise<void> {
    await cleanupDisposableTenants(administrator, [tenantA, tenantB]);
  }
});

function user(tenantId: string, id: string, email: string) {
  return {
    id,
    tenantId,
    email,
    emailNormalized: email,
    displayName: email,
    role: 'MEMBER' as const,
    status: 'ACTIVE' as const,
  };
}

function evidence(
  tenantId: string,
  id: string,
  verifierUserId: string,
  code: string,
  contentHash: string,
) {
  return {
    id,
    tenantId,
    code,
    version: 1,
    revision: 1,
    status: 'ACTIVE' as const,
    sourceType: 'BUSINESS_SYSTEM' as const,
    sourceSystem: 'finops-proof',
    sourceRecordId: code,
    sourceVersion: '1',
    observedAt: beforeNow,
    contentHashAlgorithm: 'SHA256',
    contentHash,
    trustLevel: 'VERIFIED' as const,
    confidence: new Prisma.Decimal(1),
    summary: 'Verified immutable evidence for FinOps cost review.',
    verifiedByUserId: verifierUserId,
    verifiedAt: now,
    ownerUserId: verifierUserId,
    permissionLabels: [],
    effectiveFrom: beforeNow,
    activatedAt: beforeNow,
    idempotencyKey: `${code}-idempotency`,
    requestHash: '9'.repeat(64),
  };
}
