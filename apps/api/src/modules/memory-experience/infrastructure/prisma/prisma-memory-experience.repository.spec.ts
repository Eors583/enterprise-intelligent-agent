import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../../../database/prisma.service.js';
import type { TransitionExperienceInput } from '../../memory-experience.repository.js';
import {
  enrichExperiencePayload,
  PrismaMemoryExperienceRepository,
} from './prisma-memory-experience.repository.js';

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const USER_ID = '00000000-0000-4000-8000-000000000002';
const ROLE_ASSIGNMENT_ID = '00000000-0000-4000-8000-000000000003';
const EXPERIENCE_ID = '00000000-0000-4000-8000-000000000004';
const EVIDENCE_ID = '00000000-0000-4000-8000-000000000005';

describe('PrismaMemoryExperienceRepository database clock', () => {
  it('sources authorization time from the tenant transaction instead of the app host', async () => {
    const now = new Date('2026-07-29T04:32:00.123Z');
    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ now }]);
    const transaction = {
      $executeRawUnsafe: vi.fn().mockResolvedValue(0),
      $queryRaw: queryRaw,
    };
    const prisma = {
      enabled: true,
      $transaction: vi.fn((operation: (client: typeof transaction) => Promise<unknown>) =>
        operation(transaction),
      ),
    } as unknown as PrismaService;
    const repository = new PrismaMemoryExperienceRepository(prisma);

    await expect(
      repository.currentTime({
        tenantId: TENANT_ID,
        userId: USER_ID,
        tenantRole: 'OWNER',
        authenticationSource: 'session',
      }),
    ).resolves.toEqual(now);
    expect(queryRaw).toHaveBeenCalledTimes(4);
    expect((queryRaw.mock.calls[3]?.[0] as readonly string[]).join(' ')).toContain(
      'CURRENT_TIMESTAMP',
    );
  });
});

describe('PrismaMemoryExperienceRepository experience payload enrichment', () => {
  it.each(['APPROVE', 'REJECT'] as const)(
    'persists the review reason and trusted actor for %s',
    (action) => {
      const now = new Date('2026-07-28T08:00:00.000Z');
      const input = {
        principal: {
          tenantId: TENANT_ID,
          userId: USER_ID,
          tenantRole: 'OWNER',
          authenticationSource: 'session',
        },
        actor: {
          tenantId: TENANT_ID,
          userId: USER_ID,
          roleAssignmentId: ROLE_ASSIGNMENT_ID,
          assignmentStatus: 'ACTIVE',
          employmentStatus: 'ACTIVE',
          permissions: ['EXPERIENCE_REVIEW'],
          effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
          effectiveTo: null,
        },
        experienceId: EXPERIENCE_ID,
        nextStatus: action === 'APPROVE' ? 'APPROVED' : 'REJECTED',
        request: {
          action,
          reason: 'Evidence was reviewed against the reusable-practice criteria.',
          expectedRevision: 2,
          idempotencyKey: `experience-review-${action.toLowerCase()}`,
          payload: {
            evidenceIds: [EVIDENCE_ID],
          },
        },
        now,
      } satisfies TransitionExperienceInput;

      expect(enrichExperiencePayload(input)).toEqual({
        evidenceIds: [EVIDENCE_ID],
        reviewerUserId: USER_ID,
        reviewerRoleAssignmentId: ROLE_ASSIGNMENT_ID,
        decision: action === 'APPROVE' ? 'APPROVED' : 'REJECTED',
        reason: input.request.reason,
        decidedAt: now,
      });
    },
  );
});
