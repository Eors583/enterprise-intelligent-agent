import { ConflictException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import type { AdminPrincipal } from '../admin/admin-access.service.js';
import { governedTransition } from './ai-safety-model-routing.service.js';

const TENANT_ID = '00000000-0000-7000-8000-000000000101';
const USER_ID = '00000000-0000-7000-8000-000000000201';

describe('AI model governance transition', () => {
  it('allows the enterprise owner to publish a version they submitted', () => {
    const transition = governedTransition(
      {
        status: 'IN_REVIEW',
        revision: 2,
        submittedByUserId: USER_ID,
      },
      {
        action: 'PUBLISH',
        expectedRevision: 2,
        reason: 'The enterprise owner approved the production model route.',
        idempotencyKey: 'owner-model-route-publish',
      },
      principal('OWNER'),
    );

    expect(transition).toEqual(
      expect.objectContaining({
        status: 'PUBLISHED',
        reviewedByUserId: USER_ID,
        publishedByUserId: USER_ID,
      }),
    );
  });

  it('keeps maker-checker for a delegated administrator', () => {
    expect(() =>
      governedTransition(
        {
          status: 'IN_REVIEW',
          revision: 2,
          submittedByUserId: USER_ID,
        },
        {
          action: 'PUBLISH',
          expectedRevision: 2,
          reason: 'A delegated administrator attempted self-publication.',
          idempotencyKey: 'admin-model-route-publish',
        },
        principal('ADMIN'),
      ),
    ).toThrow(ConflictException);
  });
});

function principal(role: AdminPrincipal['role']): AdminPrincipal {
  return {
    tenantId: TENANT_ID,
    userId: USER_ID,
    role,
    authenticationSource: 'session',
  };
}
