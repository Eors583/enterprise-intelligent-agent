import {
  createRoleAssignmentRequestSchema,
  revokeRoleAssignmentRequestSchema,
  roleAssignmentCandidateListResponseSchema,
  roleAssignmentListResponseSchema,
  roleAssignmentSchema,
  type CreateRoleAssignmentRequest,
} from '@enterprise/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { requestMock } = vi.hoisted(() => ({ requestMock: vi.fn() }));

vi.mock('./client', () => ({ request: requestMock }));

import {
  createRoleAssignment,
  listRoleAssignmentCandidates,
  listRoleAssignments,
  revokeRoleAssignment,
} from './admin-api';

describe('role assignment admin API', () => {
  beforeEach(() => {
    requestMock.mockReset();
    requestMock.mockResolvedValue({});
  });

  it('loads the typed assignment list with cancellation support', async () => {
    const controller = new AbortController();

    await listRoleAssignments(controller.signal);

    expect(requestMock).toHaveBeenCalledWith('/admin/role-assignments', {
      schema: roleAssignmentListResponseSchema,
      signal: controller.signal,
    });
  });

  it('loads server-governed assignment candidates from the dedicated route', async () => {
    const controller = new AbortController();

    await listRoleAssignmentCandidates(controller.signal);

    expect(requestMock).toHaveBeenCalledWith('/admin/role-blueprints/assignment-candidates', {
      schema: roleAssignmentCandidateListResponseSchema,
      signal: controller.signal,
    });
  });

  it('validates and normalizes creation input before sending it', async () => {
    const input = {
      key: ' Project:Alpha:Reviewer ',
      userId: '00000000-0000-7000-8000-000000000011',
      employmentId: '00000000-0000-7000-8000-000000000012',
      agentVersionId: '00000000-0000-7000-8000-000000000013',
      agentName: '  Alpha Reviewer  ',
      effectiveFrom: '2026-07-28T02:00:00.000Z',
      effectiveTo: '2026-08-28T02:00:00.000Z',
      source: 'PROJECT' as const,
      organizationScope: { orgUnitIds: ['product'] },
      permissionScope: {},
      memoryPolicy: {},
    };

    await createRoleAssignment(input);

    expect(requestMock).toHaveBeenCalledWith('/admin/role-assignments', {
      method: 'POST',
      body: createRoleAssignmentRequestSchema.parse(input),
      schema: roleAssignmentSchema,
    });
  });

  it('does not issue a create request when employment is null', () => {
    const invalid = {
      userId: '00000000-0000-7000-8000-000000000011',
      employmentId: null,
      agentVersionId: '00000000-0000-7000-8000-000000000013',
      effectiveFrom: '2026-07-28T02:00:00.000Z',
      source: 'LOCAL',
      organizationScope: {},
      permissionScope: {},
      memoryPolicy: {},
    } as unknown as CreateRoleAssignmentRequest;

    expect(() => createRoleAssignment(invalid)).toThrow();
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('submits the selected row revision as the revoke concurrency guard', async () => {
    const input = {
      reason: '  项目已经结束  ',
      expectedUpdatedAt: '2026-07-28T03:00:00.000Z',
    };

    await revokeRoleAssignment('assignment/id', input);

    expect(requestMock).toHaveBeenCalledWith('/admin/role-assignments/assignment%2Fid/revoke', {
      method: 'POST',
      body: revokeRoleAssignmentRequestSchema.parse(input),
      schema: roleAssignmentSchema,
    });
  });
});
