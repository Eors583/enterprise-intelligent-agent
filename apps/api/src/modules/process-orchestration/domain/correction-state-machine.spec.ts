import {
  correctionCaseSchema,
  correctionFeedbackRequestSchema,
  type CorrectionFeedbackRequest,
} from '@enterprise/contracts';
import { describe, expect, it } from 'vitest';

import { evaluateCorrectionFeedback } from './correction-state-machine.js';

const SUBJECT_ROLE = '00000000-0000-7000-8000-000000000001';
const REVIEW_ROLE = '00000000-0000-7000-8000-000000000002';
const SUBJECT_USER = '00000000-0000-7000-8000-000000000009';
const REVIEW_USER = '00000000-0000-7000-8000-000000000010';
const EVIDENCE_ID = '00000000-0000-7000-8000-000000000008';
const NOW = new Date('2026-07-28T06:10:00.000Z');
const CORRECTION = correctionCaseSchema.parse({
  id: '00000000-0000-7000-8000-000000000003',
  tenantId: '00000000-0000-7000-8000-000000000004',
  correlationId: '00000000-0000-7000-8000-000000000005',
  subject: {
    type: 'TASK',
    id: '00000000-0000-7000-8000-000000000006',
    version: 1,
  },
  roleAssignmentId: SUBJECT_ROLE,
  objectiveId: '00000000-0000-7000-8000-000000000007',
  taskId: '00000000-0000-7000-8000-000000000006',
  processInstanceId: null,
  trigger: 'Repeated quality failures remain after resource causes were excluded.',
  category: 'CAPABILITY_RISK',
  severity: 'HIGH',
  confidence: 0.88,
  ruleFindings: ['Three verified rework events occurred under the same criterion.'],
  modelFinding: 'A capability gap may exist and requires manager review.',
  evidenceRefs: [
    {
      evidenceId: EVIDENCE_ID,
      version: 1,
      contentHash: null,
    },
  ],
  impact: 'Delivery quality remains below the accepted threshold.',
  suggestedActions: ['Assign a reviewer and verify the evidence before any people decision.'],
  requiredRoleAssignmentIds: [REVIEW_ROLE],
  status: 'ACKNOWLEDGED',
  revision: 2,
  permissionLabels: ['confidential.hr'],
  createdAt: '2026-07-28T06:00:00.000Z',
  updatedAt: '2026-07-28T06:05:00.000Z',
});

function feedback(
  action: CorrectionFeedbackRequest['action'],
  evidenceIds: string[] = [EVIDENCE_ID],
): CorrectionFeedbackRequest {
  return correctionFeedbackRequestSchema.parse({
    expectedRevision: 2,
    action,
    comment: 'The evidence has been independently reviewed.',
    evidenceIds,
    effectiveAt: '2026-07-28T06:10:00.000Z',
    idempotencyKey: `correction:${action.toLowerCase()}:2`,
  });
}

function context(
  overrides: {
    readonly actorType?: 'USER' | 'AGENT' | 'SYSTEM';
    readonly actorUserId?: string;
    readonly actorAssignmentId?: string;
    readonly actorAssignmentUserId?: string;
    readonly subjectUserId?: string;
    readonly evidence?: readonly {
      id: string;
      tenantId: string;
      active: boolean;
      sealed: boolean;
      visibleToActor: boolean;
      linkedToCorrection: boolean;
    }[];
  } = {},
) {
  const actorUserId = overrides.actorUserId ?? REVIEW_USER;
  return {
    actor: {
      type: overrides.actorType ?? ('USER' as const),
      tenantId: CORRECTION.tenantId,
      userId: actorUserId,
      roleAssignment: {
        id: overrides.actorAssignmentId ?? REVIEW_ROLE,
        tenantId: CORRECTION.tenantId,
        userId: overrides.actorAssignmentUserId ?? actorUserId,
        status: 'ACTIVE' as const,
        employmentStatus: 'ACTIVE' as const,
        orgUnitStatus: 'ACTIVE' as const,
        roleVersionStatus: 'PUBLISHED' as const,
        effectiveFrom: '2026-01-01T00:00:00.000Z',
        effectiveTo: null,
      },
    },
    subjectRoleAssignment: {
      id: SUBJECT_ROLE,
      tenantId: CORRECTION.tenantId,
      userId: overrides.subjectUserId ?? SUBJECT_USER,
    },
    evidence: overrides.evidence ?? [
      {
        id: EVIDENCE_ID,
        tenantId: CORRECTION.tenantId,
        active: true,
        sealed: true,
        visibleToActor: true,
        linkedToCorrection: true,
      },
    ],
    now: NOW,
  };
}

describe('evaluateCorrectionFeedback', () => {
  it('allows the subject to explain but not resolve a high-impact case', () => {
    expect(
      evaluateCorrectionFeedback(CORRECTION, feedback('EXPLAIN'), {
        ...context({
          actorUserId: SUBJECT_USER,
          actorAssignmentId: SUBJECT_ROLE,
          actorAssignmentUserId: SUBJECT_USER,
        }),
      }),
    ).toEqual({
      allowed: true,
      nextStatus: 'EXPLAINED',
      reason: 'ALLOW',
    });
    expect(
      evaluateCorrectionFeedback(CORRECTION, feedback('RESOLVE'), {
        ...context({
          actorUserId: SUBJECT_USER,
          actorAssignmentId: SUBJECT_ROLE,
          actorAssignmentUserId: SUBJECT_USER,
        }),
      }),
    ).toMatchObject({
      allowed: false,
      nextStatus: null,
      reason: 'REVIEW_ROLE_REQUIRED',
    });
  });

  it('requires an independent human reviewer with evidence to accept people-impacting findings', () => {
    expect(
      evaluateCorrectionFeedback(CORRECTION, feedback('ACCEPT'), {
        ...context({ actorType: 'AGENT' }),
      }),
    ).toMatchObject({ allowed: false, reason: 'HUMAN_REVIEW_REQUIRED' });

    expect(
      evaluateCorrectionFeedback(CORRECTION, feedback('ACCEPT', []), {
        ...context(),
      }),
    ).toMatchObject({ allowed: false, reason: 'EVIDENCE_REQUIRED' });

    expect(
      evaluateCorrectionFeedback(CORRECTION, feedback('ACCEPT'), {
        ...context(),
      }),
    ).toEqual({
      allowed: true,
      nextStatus: 'ACCEPTED',
      reason: 'ALLOW',
    });
  });

  it('denies stale and illegal transitions before actor evaluation', () => {
    expect(
      evaluateCorrectionFeedback(
        CORRECTION,
        { ...feedback('ACCEPT'), expectedRevision: 1 },
        context(),
      ),
    ).toMatchObject({ allowed: false, reason: 'STALE_REVISION' });

    expect(
      evaluateCorrectionFeedback(
        { ...CORRECTION, status: 'RESOLVED' },
        feedback('ACCEPT'),
        context(),
      ),
    ).toMatchObject({ allowed: false, reason: 'ILLEGAL_TRANSITION' });
  });

  it('requires an independent human for high-impact cancellation', () => {
    expect(
      evaluateCorrectionFeedback(CORRECTION, feedback('CANCEL'), context({ actorType: 'AGENT' })),
    ).toMatchObject({ allowed: false, reason: 'HUMAN_REVIEW_REQUIRED' });
    expect(
      evaluateCorrectionFeedback(
        CORRECTION,
        feedback('CANCEL'),
        context({ actorUserId: SUBJECT_USER, subjectUserId: SUBJECT_USER }),
      ),
    ).toMatchObject({ allowed: false, reason: 'INDEPENDENT_REVIEW_REQUIRED' });
  });

  it('does not treat unsealed, invisible, or unrelated evidence IDs as review evidence', () => {
    expect(
      evaluateCorrectionFeedback(
        CORRECTION,
        feedback('ACCEPT'),
        context({
          evidence: [
            {
              id: EVIDENCE_ID,
              tenantId: CORRECTION.tenantId,
              active: true,
              sealed: false,
              visibleToActor: true,
              linkedToCorrection: true,
            },
          ],
        }),
      ),
    ).toMatchObject({ allowed: false, reason: 'EVIDENCE_INVALID' });
  });

  it('rejects inaccessible evidence even for a non-high-impact feedback action', () => {
    expect(
      evaluateCorrectionFeedback(
        {
          ...CORRECTION,
          severity: 'LOW',
          category: 'OBJECTIVE_DEVIATION',
        },
        feedback('EXPLAIN'),
        context({
          evidence: [
            {
              id: EVIDENCE_ID,
              tenantId: CORRECTION.tenantId,
              active: true,
              sealed: true,
              visibleToActor: false,
              linkedToCorrection: true,
            },
          ],
        }),
      ),
    ).toMatchObject({ allowed: false, reason: 'EVIDENCE_INVALID' });
  });
});
