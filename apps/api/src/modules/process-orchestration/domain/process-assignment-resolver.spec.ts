import { describe, expect, it } from 'vitest';

import {
  resolveProcessStepParticipants,
  type ProcessAssignmentCandidate,
  type ProcessStepRoutingContext,
} from './process-assignment-resolver.js';

const NOW = new Date('2026-07-28T06:00:00.000Z');
const CONTEXT: ProcessStepRoutingContext = {
  tenantId: 'tenant-a',
  responsibleRoleBlueprintId: 'role-solution-owner',
  organizationId: 'org-project-alpha',
  organizationAncestorIds: ['org-headquarters'],
  projectId: 'project-alpha',
  taskId: 'task-alpha',
  permissionLabels: ['internal.project-alpha'],
  requiredPermissionAction: 'process.step.execute',
};

const CANDIDATE: ProcessAssignmentCandidate = {
  id: 'assignment-b',
  tenantId: 'tenant-a',
  userId: 'user-b',
  employmentId: 'employment-b',
  employmentStatus: 'ACTIVE',
  orgUnitStatus: 'ACTIVE',
  roleBlueprintId: 'role-solution-owner',
  roleVersionStatus: 'PUBLISHED',
  status: 'ACTIVE',
  agentId: 'agent-b',
  effectiveFrom: '2026-07-01T00:00:00.000Z',
  effectiveTo: null,
  organizationIds: ['org-headquarters'],
  includeOrganizationDescendants: true,
  projectIds: ['project-alpha'],
  taskIds: ['task-alpha'],
  permissionLabels: ['internal.project-alpha', 'internal.shared'],
  permissionActions: ['process.step.execute'],
};

describe('resolveProcessStepParticipants', () => {
  it('derives users and Agents from every current eligible Role Assignment deterministically', () => {
    const result = resolveProcessStepParticipants(
      CONTEXT,
      [
        CANDIDATE,
        {
          ...CANDIDATE,
          id: 'assignment-a',
          userId: 'user-a',
          employmentId: 'employment-a',
          agentId: 'agent-a',
        },
      ],
      NOW,
    );

    expect(result).toEqual({
      eligible: true,
      participants: [
        {
          roleAssignmentId: 'assignment-a',
          userId: 'user-a',
          employmentId: 'employment-a',
          agentId: 'agent-a',
        },
        {
          roleAssignmentId: 'assignment-b',
          userId: 'user-b',
          employmentId: 'employment-b',
          agentId: 'agent-b',
        },
      ],
      evaluatedAt: NOW.toISOString(),
    });
  });

  it('keeps an existing active appointment usable when its immutable version is retired', () => {
    expect(
      resolveProcessStepParticipants(
        CONTEXT,
        [{ ...CANDIDATE, roleVersionStatus: 'RETIRED' }],
        NOW,
      ),
    ).toMatchObject({
      eligible: true,
      participants: [{ roleAssignmentId: CANDIDATE.id }],
    });
  });

  it.each([
    [{ status: 'REVOKED' as const }, 'NO_ACTIVE_ASSIGNMENT'],
    [{ employmentStatus: 'TERMINATED' as const }, 'NO_ACTIVE_ASSIGNMENT'],
    [{ roleVersionStatus: 'DRAFT' as const }, 'NO_ACTIVE_ASSIGNMENT'],
    [{ effectiveTo: '2026-07-28T05:59:59.000Z' }, 'NO_ACTIVE_ASSIGNMENT'],
    [{ orgUnitStatus: 'ARCHIVED' as const }, 'ORG_UNIT_NOT_ACTIVE'],
    [{ permissionActions: [] }, 'ACTION_SCOPE_DENIED'],
    [
      { organizationIds: ['org-finance'], includeOrganizationDescendants: false },
      'ORGANIZATION_SCOPE_DENIED',
    ],
    [{ projectIds: ['project-beta'] }, 'PROJECT_SCOPE_DENIED'],
    [{ taskIds: ['task-beta'] }, 'TASK_SCOPE_DENIED'],
    [{ permissionLabels: ['internal.shared'] }, 'PERMISSION_LABEL_SCOPE_DENIED'],
  ])('fails closed for an ineligible appointment %#', (override, reason) => {
    expect(resolveProcessStepParticipants(CONTEXT, [{ ...CANDIDATE, ...override }], NOW)).toEqual({
      eligible: false,
      reason,
      evaluatedAt: NOW.toISOString(),
    });
  });

  it('treats empty project and task scopes as deny, never as a wildcard', () => {
    expect(
      resolveProcessStepParticipants(CONTEXT, [{ ...CANDIDATE, projectIds: [] }], NOW),
    ).toMatchObject({
      eligible: false,
      reason: 'PROJECT_SCOPE_DENIED',
    });
    expect(
      resolveProcessStepParticipants(CONTEXT, [{ ...CANDIDATE, taskIds: [] }], NOW),
    ).toMatchObject({
      eligible: false,
      reason: 'TASK_SCOPE_DENIED',
    });
  });

  it('does not combine organization, project, task, and label grants from different assignments', () => {
    const result = resolveProcessStepParticipants(
      CONTEXT,
      [
        {
          ...CANDIDATE,
          id: 'relation-only',
          projectIds: ['project-beta'],
        },
        {
          ...CANDIDATE,
          id: 'scope-only',
          organizationIds: ['org-finance'],
          includeOrganizationDescendants: false,
        },
      ],
      NOW,
    );
    expect(result).toMatchObject({
      eligible: false,
      reason: 'PROJECT_SCOPE_DENIED',
    });
  });
});
