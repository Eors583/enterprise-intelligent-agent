import { describe, expect, it } from 'vitest';

import {
  createCompetencyDefinitionRequestSchema,
  createTriangleTeamRequestSchema,
} from './people-organization.js';

const IDEMPOTENCY_KEY = 'people-form-de-technicalization-1';

describe('people organization generated codes', () => {
  it('accepts competency creation without a client-generated code', () => {
    expect(
      createCompetencyDefinitionRequestSchema.parse({
        name: '方案设计',
        category: 'SKILL',
        description: '把客户问题转化为可交付方案。',
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
    ).not.toHaveProperty('code');
  });

  it('accepts triangle-team creation without a client-generated code', () => {
    const roleIds = Array.from(
      { length: 4 },
      (_, index) => `00000000-0000-7000-8000-00000000000${index + 1}`,
    );
    expect(
      createTriangleTeamRequestSchema.parse({
        name: '客户成功铁三角',
        objectiveId: '00000000-0000-7000-8000-000000000010',
        objectiveVersion: 1,
        customerRoleAssignmentId: roleIds[0],
        solutionRoleAssignmentId: roleIds[1],
        deliveryRoleAssignmentId: roleIds[2],
        arbiterRoleAssignmentId: roleIds[3],
        metricDefinitionIds: ['00000000-0000-7000-8000-000000000020'],
        healthPolicy: {
          thresholds: {
            TASK_RESPONSE_LATENCY: 24,
            INPUT_OUTPUT_COMPLETENESS: 0.9,
            PROCESS_RETURN_RATE: 0.1,
            COMMITMENT_FULFILLMENT: 0.9,
            CUSTOMER_CLOSURE: 0.9,
            SHARED_OBJECTIVE_RESULT: 0.9,
          },
          weights: {
            TASK_RESPONSE_LATENCY: 0.15,
            INPUT_OUTPUT_COMPLETENESS: 0.2,
            PROCESS_RETURN_RATE: 0.15,
            COMMITMENT_FULFILLMENT: 0.2,
            CUSTOMER_CLOSURE: 0.15,
            SHARED_OBJECTIVE_RESULT: 0.15,
          },
        },
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
    ).not.toHaveProperty('code');
  });
});
