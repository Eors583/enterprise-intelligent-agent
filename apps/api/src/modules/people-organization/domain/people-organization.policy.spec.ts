import { describe, expect, it } from 'vitest';

import {
  PeopleOrganizationPolicyError,
  assertOrganizationChangeCanApply,
  calculateTriangleHealth,
  confirmOrganizationChange,
  decideAssessmentConfirmation,
} from './people-organization.policy.js';

const id = (suffix: string): string => `00000000-0000-4000-8000-${suffix.padStart(12, '0')}`;
const observations = {
  TASK_RESPONSE_LATENCY: 4,
  INPUT_OUTPUT_COMPLETENESS: 0.9,
  PROCESS_RETURN_RATE: 0.1,
  COMMITMENT_FULFILLMENT: 0.9,
  CUSTOMER_CLOSURE: 0.8,
  SHARED_OBJECTIVE_RESULT: 0.85,
} as const;

describe('people and organization governance policy', () => {
  it('never makes an AI candidate effective before all configured humans confirm', () => {
    const first = decideAssessmentConfirmation(
      {
        status: 'CANDIDATE',
        revision: 1,
        subjectUserId: id('1'),
        createdByUserId: id('9'),
        requiredConfirmationRoles: ['EMPLOYEE', 'MANAGER', 'HR'],
        confirmations: [],
      },
      {
        role: 'EMPLOYEE',
        decision: 'CONFIRM',
        expectedRevision: 1,
        comment: 'I reviewed the evidence.',
        idempotencyKey: 'employee-confirm-1',
      },
      { userId: id('1'), isHrAdministrator: false, managesSubject: false },
    );
    expect(first).toEqual({ nextStatus: 'UNDER_REVIEW', effective: false });
  });

  it('prevents a manager confirmation from an untrusted actor', () => {
    expect(() =>
      decideAssessmentConfirmation(
        {
          status: 'UNDER_REVIEW',
          revision: 2,
          subjectUserId: id('1'),
          createdByUserId: id('9'),
          requiredConfirmationRoles: ['MANAGER'],
          confirmations: [],
        },
        {
          role: 'MANAGER',
          decision: 'CONFIRM',
          expectedRevision: 2,
          comment: 'I reviewed it.',
          idempotencyKey: 'manager-confirm-1',
        },
        { userId: id('2'), isHrAdministrator: false, managesSubject: false },
      ),
    ).toThrow(PeopleOrganizationPolicyError);
  });

  it('calculates health from governed business outcomes and not interaction counts', () => {
    const health = calculateTriangleHealth(
      id('1'),
      1,
      {
        expectedTeamRevision: 1,
        policyVersion: 1,
        periodStart: '2026-07-01T00:00:00.000+00:00',
        periodEnd: '2026-07-02T00:00:00.000+00:00',
        observations,
        sourceEvidenceIds: [id('2')],
        idempotencyKey: 'health-snapshot-1',
      },
      observations,
      {
        TASK_RESPONSE_LATENCY: 0.15,
        INPUT_OUTPUT_COMPLETENESS: 0.2,
        PROCESS_RETURN_RATE: 0.15,
        COMMITMENT_FULFILLMENT: 0.2,
        CUSTOMER_CLOSURE: 0.15,
        SHARED_OBJECTIVE_RESULT: 0.15,
      },
      new Date('2026-07-02T01:00:00.000Z'),
    );
    expect(health.score).toBe(100);
    expect(health.components).toHaveLength(6);
    expect(health.components.map((item) => item.dimension)).not.toContain('MESSAGE_COUNT');
  });

  it('requires complete impact coverage and independent maker-checker confirmation', () => {
    const state = {
      status: 'ANALYZED' as const,
      revision: 2,
      proposedByUserId: id('1'),
      confirmedByUserId: null,
      coveredImpactAreas: new Set([
        'OBJECTIVE',
        'PROCESS',
        'PERMISSION',
        'TASK',
        'AGENT_ASSIGNMENT',
      ]),
      hasCriticalImpact: true,
    };
    expect(() => confirmOrganizationChange(state, id('1'), 2)).toThrow(
      PeopleOrganizationPolicyError,
    );
    expect(() => confirmOrganizationChange(state, id('2'), 2)).not.toThrow();
  });

  it('requires an additional human for applying a critical organization change', () => {
    const state = {
      status: 'CONFIRMED' as const,
      revision: 3,
      proposedByUserId: id('1'),
      confirmedByUserId: id('2'),
      coveredImpactAreas: new Set<string>(),
      hasCriticalImpact: true,
    };
    expect(() => assertOrganizationChangeCanApply(state, id('2'), 3)).toThrow(
      PeopleOrganizationPolicyError,
    );
    expect(() => assertOrganizationChangeCanApply(state, id('3'), 3)).not.toThrow();
  });
});
