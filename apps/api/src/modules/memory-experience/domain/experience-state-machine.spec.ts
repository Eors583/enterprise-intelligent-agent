import { describe, expect, it } from 'vitest';

import {
  InvalidExperienceTransitionError,
  transitionExperience,
  type ExperienceAction,
  type ExperienceTransitionContext,
  type TrustedExperienceActor,
} from './experience-state-machine.js';

const HASH = 'a'.repeat(64);
const NOW = new Date('2026-07-28T06:00:00.000Z');
const TENANT = '00000000-0000-7000-8000-000000000001';
const CONTRIBUTOR = '00000000-0000-7000-8000-000000000002';
const CONTRIBUTOR_ASSIGNMENT = '00000000-0000-7000-8000-000000000003';
const ACTOR = '00000000-0000-7000-8000-000000000004';
const ACTOR_ASSIGNMENT = '00000000-0000-7000-8000-000000000005';

describe('experience state machine', () => {
  it('enforces the complete governed happy path', () => {
    expect(
      transitionExperience('CANDIDATE', 'SANITIZE', {
        ...context('SANITIZE'),
        proof: {
          action: 'SANITIZE',
          sanitizedHash: HASH,
          piiRemoved: true,
          secretsRemoved: true,
          customerIdentifiersRemoved: true,
        },
      }),
    ).toBe('SANITIZED');
    expect(
      transitionExperience('SANITIZED', 'STRUCTURE', {
        ...context('STRUCTURE'),
        proof: {
          action: 'STRUCTURE',
          structuredHash: HASH,
          scenarioPresent: true,
          problemPresent: true,
          stepsPresent: true,
          outcomesPresent: true,
          applicabilityBoundariesPresent: true,
        },
      }),
    ).toBe('STRUCTURED');
    expect(transitionExperience('STRUCTURED', 'APPROVE', reviewContext('APPROVE'))).toBe(
      'APPROVED',
    );
    expect(
      transitionExperience('APPROVED', 'VALIDATE', {
        ...context('VALIDATE'),
        proof: {
          action: 'VALIDATE',
          validationRunId: 'run-v1',
          datasetVersionId: 'dataset-v1',
          passed: true,
          score: 0.92,
          threshold: 0.8,
        },
      }),
    ).toBe('VALIDATED');
    expect(
      transitionExperience('VALIDATED', 'PUBLISH', {
        ...context('PUBLISH'),
        proof: {
          action: 'PUBLISH',
          knowledgeBaseId: 'knowledge-base',
          documentId: 'document',
          documentVersionId: 'document-version',
          targetRoleTemplateIds: ['role'],
          targetOrgUnitIds: [],
        },
      }),
    ).toBe('PUBLISHED');
  });

  it('rejects incomplete sanitization and structural shortcuts', () => {
    expect(() =>
      transitionExperience('CANDIDATE', 'SANITIZE', {
        ...context('SANITIZE'),
        proof: {
          action: 'SANITIZE',
          sanitizedHash: HASH,
          piiRemoved: true,
          secretsRemoved: false,
          customerIdentifiersRemoved: true,
        },
      }),
    ).toThrow(InvalidExperienceTransitionError);
    expect(() =>
      transitionExperience('CANDIDATE', 'PUBLISH', {
        ...context('PUBLISH'),
        proof: {
          action: 'PUBLISH',
          knowledgeBaseId: 'knowledge-base',
          documentId: 'document',
          documentVersionId: 'document-version',
          targetRoleTemplateIds: ['role'],
          targetOrgUnitIds: [],
        },
      }),
    ).toThrow(/invalid state transition/u);
  });

  it('rejects contributor self-review and proof borrowed from another action', () => {
    const selfReview = reviewContext('APPROVE');
    expect(() =>
      transitionExperience('STRUCTURED', 'APPROVE', {
        ...selfReview,
        actor: {
          ...selfReview.actor,
          userId: CONTRIBUTOR,
          roleAssignmentId: CONTRIBUTOR_ASSIGNMENT,
        },
        proof: {
          action: 'APPROVE',
          reviewerUserId: CONTRIBUTOR,
          reviewerRoleAssignmentId: CONTRIBUTOR_ASSIGNMENT,
          evidenceIds: ['evidence'],
        },
      }),
    ).toThrow(/not independent/u);
    expect(() =>
      transitionExperience('STRUCTURED', 'APPROVE', {
        ...context('APPROVE'),
        proof: {
          action: 'REJECT',
          reviewerUserId: ACTOR,
          reviewerRoleAssignmentId: ACTOR_ASSIGNMENT,
          evidenceIds: ['evidence'],
        },
      }),
    ).toThrow(/another action/u);
  });

  it('rejects inactive actors and missing governed permissions', () => {
    const approval = reviewContext('APPROVE');
    expect(() =>
      transitionExperience('STRUCTURED', 'APPROVE', {
        ...approval,
        actor: { ...approval.actor, assignmentStatus: 'REVOKED' },
      }),
    ).toThrow(/not active/u);
    expect(() =>
      transitionExperience('STRUCTURED', 'APPROVE', {
        ...approval,
        actor: { ...approval.actor, permissions: [] },
      }),
    ).toThrow(/lacks/u);
  });

  it('requires a passing independent validation and consistent monitoring counters', () => {
    expect(() =>
      transitionExperience('APPROVED', 'VALIDATE', {
        ...context('VALIDATE'),
        proof: {
          action: 'VALIDATE',
          validationRunId: 'run-v1',
          datasetVersionId: 'dataset-v1',
          passed: false,
          score: 0.4,
          threshold: 0.8,
        },
      }),
    ).toThrow(/did not pass/u);
    expect(() =>
      transitionExperience('MONITORED', 'MONITOR', {
        ...context('MONITOR'),
        proof: {
          action: 'MONITOR',
          useCount: 1,
          adoptionCount: 2,
          complaintCount: 0,
        },
      }),
    ).toThrow(/inconsistent/u);
  });
});

function actor(action: ExperienceAction): TrustedExperienceActor {
  const permissions = {
    SANITIZE: 'EXPERIENCE_SANITIZE',
    STRUCTURE: 'EXPERIENCE_STRUCTURE',
    APPROVE: 'EXPERIENCE_REVIEW',
    REJECT: 'EXPERIENCE_REVIEW',
    VALIDATE: 'EXPERIENCE_VALIDATE',
    PUBLISH: 'EXPERIENCE_PUBLISH',
    MONITOR: 'EXPERIENCE_MONITOR',
    RETIRE: 'EXPERIENCE_RETIRE',
  } as const;
  return {
    tenantId: TENANT,
    userId: ACTOR,
    roleAssignmentId: ACTOR_ASSIGNMENT,
    assignmentStatus: 'ACTIVE',
    employmentStatus: 'ACTIVE',
    permissions: [permissions[action]],
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    effectiveTo: null,
  };
}

function context(action: ExperienceAction): Omit<ExperienceTransitionContext, 'proof'> {
  return {
    tenantId: TENANT,
    contributorUserId: CONTRIBUTOR,
    contributorRoleAssignmentId: CONTRIBUTOR_ASSIGNMENT,
    actor: actor(action),
    now: NOW,
  };
}

function reviewContext(action: 'APPROVE' | 'REJECT'): ExperienceTransitionContext {
  return {
    ...context(action),
    proof: {
      action,
      reviewerUserId: ACTOR,
      reviewerRoleAssignmentId: ACTOR_ASSIGNMENT,
      evidenceIds: ['evidence'],
    },
  };
}
