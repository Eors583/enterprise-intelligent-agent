import {
  competencyAppealSchema,
  createCompetencyAppealRequestSchema,
  employeePeopleProfileSchema,
  type CompetencyAppeal,
  type CreateCompetencyAppealRequest,
  type EmployeePeopleProfile,
} from '@enterprise/contracts';

import { apiRequest } from '../../shared/api/client';

export function getMyPeopleProfile(
  signal?: AbortSignal,
  apiBaseUrl?: string,
): Promise<EmployeePeopleProfile> {
  return apiRequest('/api/v1/workbench/people/me', {
    schema: employeePeopleProfileSchema,
    ...(signal ? { signal } : {}),
    ...(apiBaseUrl ? { apiBaseUrl } : {}),
  });
}

export function appealMyAssessment(
  assessmentId: string,
  input: CreateCompetencyAppealRequest,
  apiBaseUrl?: string,
): Promise<CompetencyAppeal> {
  return apiRequest(
    `/api/v1/workbench/people/assessments/${encodeURIComponent(assessmentId)}/appeals`,
    {
      method: 'POST',
      schema: competencyAppealSchema,
      body: createCompetencyAppealRequestSchema.parse(input),
      ...(apiBaseUrl ? { apiBaseUrl } : {}),
    },
  );
}
