import {
  createCompetencyDefinitionRequestSchema,
  createOrganizationChangeRequestSchema,
  createTriangleTeamRequestSchema,
  competencyDefinitionSchema,
  organizationChangeSchema,
  peopleOrganizationOverviewSchema,
  triangleTeamSchema,
  type CreateCompetencyDefinitionRequest,
  type CreateOrganizationChangeRequest,
  type CreateTriangleTeamRequest,
  type CompetencyDefinition,
  type OrganizationChange,
  type PeopleOrganizationOverview,
  type TriangleTeam,
} from '@enterprise/contracts';

import { request } from '@/api/client';

export function getPeopleOrganizationOverview(
  signal?: AbortSignal,
): Promise<PeopleOrganizationOverview> {
  return request('/admin/people-organization/overview', {
    schema: peopleOrganizationOverviewSchema,
    ...(signal ? { signal } : {}),
  });
}

export function createCompetencyDefinition(
  input: CreateCompetencyDefinitionRequest,
): Promise<CompetencyDefinition> {
  return request('/admin/people-organization/competencies', {
    method: 'POST',
    schema: competencyDefinitionSchema,
    body: createCompetencyDefinitionRequestSchema.parse(input),
  });
}

export function createTriangleTeam(input: CreateTriangleTeamRequest): Promise<TriangleTeam> {
  return request('/admin/people-organization/triangle-teams', {
    method: 'POST',
    schema: triangleTeamSchema,
    body: createTriangleTeamRequestSchema.parse(input),
  });
}

export function proposeOrganizationChange(
  input: CreateOrganizationChangeRequest,
): Promise<OrganizationChange> {
  return request('/admin/people-organization/organization-changes', {
    method: 'POST',
    schema: organizationChangeSchema,
    body: createOrganizationChangeRequestSchema.parse(input),
  });
}
