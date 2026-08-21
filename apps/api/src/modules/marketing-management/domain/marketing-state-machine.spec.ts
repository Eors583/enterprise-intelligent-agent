import { describe, expect, it } from 'vitest';

import {
  InvalidMarketingTransitionError,
  transitionMarketingActionItem,
  transitionMarketingInsight,
  transitionMarketingTarget,
} from './marketing-state-machine.js';

const maker = '00000000-0000-4000-8000-000000000001';
const reviewer = '00000000-0000-4000-8000-000000000002';

describe('marketing governance state machines', () => {
  it('enforces maker-checker before an insight can be approved', () => {
    expect(() =>
      transitionMarketingInsight(
        {
          status: 'UNDER_REVIEW',
          revision: 2,
          createdByUserId: maker,
          reviewedByUserId: null,
        },
        { action: 'APPROVE', expectedRevision: 2, comment: 'Looks valid.' },
        { userId: maker },
      ),
    ).toThrow(InvalidMarketingTransitionError);

    expect(
      transitionMarketingInsight(
        {
          status: 'UNDER_REVIEW',
          revision: 2,
          createdByUserId: maker,
          reviewedByUserId: null,
        },
        { action: 'APPROVE', expectedRevision: 2, comment: 'Evidence verified.' },
        { userId: reviewer },
      ).status,
    ).toBe('APPROVED');
  });

  it('does not let a candidate bypass independent review into publication', () => {
    expect(() =>
      transitionMarketingInsight(
        {
          status: 'CANDIDATE',
          revision: 1,
          createdByUserId: maker,
          reviewedByUserId: null,
        },
        { action: 'PUBLISH', expectedRevision: 1, comment: 'Publish directly.' },
        { userId: reviewer },
      ),
    ).toThrow('cannot PUBLISH');
  });

  it('uses expected revision as the CAS boundary', () => {
    expect(() =>
      transitionMarketingTarget(
        { status: 'DRAFT', revision: 3 },
        { action: 'ACTIVATE', expectedRevision: 2, comment: 'Activate.' },
      ),
    ).toThrow('changed');
  });

  it('requires governed acceptance evidence before completing an action item', () => {
    expect(() =>
      transitionMarketingActionItem(
        { status: 'ACTIVE', revision: 3 },
        {
          action: 'COMPLETE',
          expectedRevision: 3,
          comment: 'Done.',
          acceptanceEvidenceId: null,
          acceptanceEvidenceVersion: null,
        },
      ),
    ).toThrow('requires acceptance Evidence');
  });
});
