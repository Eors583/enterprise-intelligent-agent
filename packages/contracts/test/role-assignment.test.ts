import { describe, expect, it } from 'vitest';

import {
  createRoleAssignmentRequestSchema,
  revokeRoleAssignmentRequestSchema,
} from '../src/role-assignment.js';

const USER_ID = '00000000-0000-7000-8000-000000000101';
const EMPLOYMENT_ID = '00000000-0000-7000-8000-000000000201';
const VERSION_ID = '00000000-0000-7000-8000-000000000501';
const ASSIGNMENT_ID = '00000000-0000-7000-8000-000000000601';

describe('Role Assignment contracts', () => {
  it('normalizes an explicit key and applies safe policy defaults', () => {
    expect(
      createRoleAssignmentRequestSchema.parse({
        key: ' ASG:AI-ENGINEER:LIN ',
        userId: USER_ID,
        employmentId: EMPLOYMENT_ID,
        agentVersionId: VERSION_ID,
        effectiveFrom: '2026-07-28T00:00:00.000Z',
      }),
    ).toMatchObject({
      key: 'asg:ai-engineer:lin',
      employmentId: EMPLOYMENT_ID,
      source: 'LOCAL',
      organizationScope: {},
      permissionScope: {},
      memoryPolicy: {},
    });
  });

  it('rejects an invalid effective period and accepts directory provisioning', () => {
    expect(() =>
      createRoleAssignmentRequestSchema.parse({
        userId: USER_ID,
        employmentId: EMPLOYMENT_ID,
        agentVersionId: VERSION_ID,
        effectiveFrom: '2026-08-01T00:00:00.000Z',
        effectiveTo: '2026-07-31T00:00:00.000Z',
      }),
    ).toThrow();
    expect(
      createRoleAssignmentRequestSchema.parse({
        userId: USER_ID,
        employmentId: EMPLOYMENT_ID,
        agentVersionId: VERSION_ID,
        effectiveFrom: '2026-08-01T00:00:00.000Z',
        source: 'DIRECTORY',
      }),
    ).toMatchObject({ source: 'DIRECTORY' });
  });

  it('requires exact delegation lineage for delegation and handover sources', () => {
    const request = {
      userId: USER_ID,
      employmentId: EMPLOYMENT_ID,
      agentVersionId: VERSION_ID,
      effectiveFrom: '2026-08-01T00:00:00.000Z',
    };
    for (const source of ['DELEGATION', 'HANDOVER'] as const) {
      expect(() => createRoleAssignmentRequestSchema.parse({ ...request, source })).toThrow();
      expect(
        createRoleAssignmentRequestSchema.parse({
          ...request,
          source,
          delegatedFromAssignmentId: ASSIGNMENT_ID,
        }),
      ).toMatchObject({ source, delegatedFromAssignmentId: ASSIGNMENT_ID });
    }
    expect(() =>
      createRoleAssignmentRequestSchema.parse({
        ...request,
        source: 'LOCAL',
        delegatedFromAssignmentId: ASSIGNMENT_ID,
      }),
    ).toThrow();
  });

  it('requires a non-null employment identity for every new assignment', () => {
    const request = {
      userId: USER_ID,
      agentVersionId: VERSION_ID,
      effectiveFrom: '2026-08-01T00:00:00.000Z',
    };

    expect(() => createRoleAssignmentRequestSchema.parse(request)).toThrow();
    expect(() =>
      createRoleAssignmentRequestSchema.parse({ ...request, employmentId: null }),
    ).toThrow();
  });

  it('requires optimistic concurrency and an auditable revocation reason', () => {
    expect(() =>
      revokeRoleAssignmentRequestSchema.parse({
        reason: ' ',
        expectedUpdatedAt: '2026-07-28T00:00:00.000Z',
      }),
    ).toThrow();
    expect(
      revokeRoleAssignmentRequestSchema.parse({
        reason: '岗位任命已结束',
        expectedVersion: 3,
      }),
    ).toEqual({
      reason: '岗位任命已结束',
      expectedVersion: 3,
    });
    expect(() => revokeRoleAssignmentRequestSchema.parse({ reason: '岗位任命已结束' })).toThrow();
  });
});
