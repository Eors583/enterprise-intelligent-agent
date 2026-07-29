import { describe, expect, it } from 'vitest';

import {
  analyzeOrganizationChangeRequestSchema,
  createCompetencyAssessmentRequestSchema,
  createCompetencyEvidenceRequestSchema,
  createCompetencyVersionRequestSchema,
  createTriangleTeamRequestSchema,
  triangleHealthSnapshotRequestSchema,
} from '../src/people-organization.js';

const id = (suffix: string): string => `00000000-0000-4000-8000-${suffix.padStart(12, '0')}`;
const at = (day: number): string => `2026-07-${String(day).padStart(2, '0')}T00:00:00.000+00:00`;
const weights = {
  TASK_RESPONSE_LATENCY: 0.15,
  INPUT_OUTPUT_COMPLETENESS: 0.2,
  PROCESS_RETURN_RATE: 0.15,
  COMMITMENT_FULFILLMENT: 0.2,
  CUSTOMER_CLOSURE: 0.15,
  SHARED_OBJECTIVE_RESULT: 0.15,
} as const;

describe('people and organization contracts', () => {
  it('requires behavior anchors and a role/version requirement that targets a defined level', () => {
    const result = createCompetencyVersionRequestSchema.safeParse({
      expectedDefinitionRevision: 1,
      changeSummary: 'New engineering blueprint',
      levels: [
        {
          level: 2,
          name: 'Independent',
          taskComplexity: 'Completes medium complexity tasks independently.',
          evidenceRequirements: ['Two accepted deliverables'],
          behaviorAnchors: ['Explains trade-offs and raises risks before the due date.'],
        },
      ],
      roleRequirements: [
        {
          roleTemplateId: id('1'),
          roleVersionId: id('2'),
          requiredLevel: 3,
          context: '',
        },
      ],
      idempotencyKey: 'competency-version-1',
    });
    expect(result.success).toBe(false);
  });

  it('rejects competency evidence that is not traceable to governed work or review', () => {
    const result = createCompetencyEvidenceRequestSchema.safeParse({
      subjectUserId: id('1'),
      competencyVersionId: id('2'),
      demonstratedLevel: 2,
      evidenceId: id('3'),
      evidenceVersion: 1,
      validFrom: at(1),
      idempotencyKey: 'evidence-key-1',
    });
    expect(result.success).toBe(false);
  });

  it('requires AI attribution to separate capability from contextual causes', () => {
    const result = createCompetencyAssessmentRequestSchema.safeParse({
      subjectUserId: id('1'),
      competencyVersionId: id('2'),
      proposedLevel: 2,
      confidence: 0.7,
      agentRunId: id('3'),
      summary: 'Candidate only, pending human review.',
      attribution: [
        {
          factor: 'CAPABILITY',
          contribution: 0.8,
          statement: 'Capability candidate',
          evidenceIds: [id('4')],
        },
      ],
      requiredConfirmationRoles: ['EMPLOYEE', 'MANAGER', 'HR'],
      idempotencyKey: 'assessment-key-1',
    });
    expect(result.success).toBe(false);
  });

  it('requires distinct customer, solution and delivery assignments', () => {
    const result = createTriangleTeamRequestSchema.safeParse({
      code: 'TEAM.BLUE',
      name: 'Blue account triangle',
      objectiveId: id('1'),
      objectiveVersion: 1,
      customerRoleAssignmentId: id('2'),
      solutionRoleAssignmentId: id('2'),
      deliveryRoleAssignmentId: id('4'),
      arbiterRoleAssignmentId: id('5'),
      metricDefinitionIds: [id('6')],
      healthPolicy: {
        thresholds: Object.fromEntries(Object.keys(weights).map((key) => [key, 1])),
        weights,
      },
      idempotencyKey: 'triangle-key-1',
    });
    expect(result.success).toBe(false);
  });

  it('accepts exactly the six governed health dimensions and excludes message counts', () => {
    const result = triangleHealthSnapshotRequestSchema.safeParse({
      expectedTeamRevision: 1,
      policyVersion: 1,
      periodStart: at(1),
      periodEnd: at(2),
      observations: {
        TASK_RESPONSE_LATENCY: 4,
        INPUT_OUTPUT_COMPLETENESS: 0.9,
        PROCESS_RETURN_RATE: 0.1,
        COMMITMENT_FULFILLMENT: 0.85,
        CUSTOMER_CLOSURE: 0.8,
        SHARED_OBJECTIVE_RESULT: 0.75,
        MESSAGE_COUNT: 999,
      },
      sourceEvidenceIds: [id('7')],
      idempotencyKey: 'health-key-1',
    });
    expect(result.success).toBe(false);
  });

  it('requires an organization impact report to cover all five governed areas', () => {
    const result = analyzeOrganizationChangeRequestSchema.safeParse({
      expectedRevision: 1,
      impacts: [
        {
          area: 'OBJECTIVE',
          resourceType: 'objective',
          resourceId: id('1'),
          risk: 'HIGH',
          currentState: {},
          proposedState: {},
          mitigation: 'Reassign the owner after approval.',
        },
      ],
    });
    expect(result.success).toBe(false);
  });
});
