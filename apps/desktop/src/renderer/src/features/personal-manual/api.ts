import {
  personalManualSelfProfileSchema,
  updateWorkAvailabilityRequestSchema,
  updatePersonalManualRequestSchema,
  workAvailabilitySelfResponseSchema,
  type PersonalManualSelfProfile,
  type UpdatePersonalManualRequest,
  type UpdateWorkAvailabilityRequest,
  type WorkAvailabilitySelfResponse,
} from '@enterprise/contracts';

import { apiRequest } from '../../shared/api/client';

const PERSONAL_MANUAL_PATH = '/api/v1/workbench/people/me/personal-manual';
const WORK_AVAILABILITY_PATH = '/api/v1/workbench/people/me/work-availability';

export function getMyPersonalManual(
  signal?: AbortSignal,
  apiBaseUrl?: string,
): Promise<PersonalManualSelfProfile> {
  return apiRequest(PERSONAL_MANUAL_PATH, {
    schema: personalManualSelfProfileSchema,
    ...(signal ? { signal } : {}),
    ...(apiBaseUrl ? { apiBaseUrl } : {}),
  });
}

export function getMyWorkAvailability(
  signal?: AbortSignal,
  apiBaseUrl?: string,
): Promise<WorkAvailabilitySelfResponse> {
  return apiRequest(WORK_AVAILABILITY_PATH, {
    schema: workAvailabilitySelfResponseSchema,
    ...(signal ? { signal } : {}),
    ...(apiBaseUrl ? { apiBaseUrl } : {}),
  });
}

export function updateMyWorkAvailability(
  input: UpdateWorkAvailabilityRequest,
  apiBaseUrl?: string,
): Promise<WorkAvailabilitySelfResponse> {
  return apiRequest(WORK_AVAILABILITY_PATH, {
    method: 'PUT',
    schema: workAvailabilitySelfResponseSchema,
    body: updateWorkAvailabilityRequestSchema.parse(input),
    ...(apiBaseUrl ? { apiBaseUrl } : {}),
  });
}

export function updateMyPersonalManual(
  input: UpdatePersonalManualRequest,
  apiBaseUrl?: string,
): Promise<PersonalManualSelfProfile> {
  return apiRequest(PERSONAL_MANUAL_PATH, {
    method: 'PUT',
    schema: personalManualSelfProfileSchema,
    body: updatePersonalManualRequestSchema.parse(input),
    ...(apiBaseUrl ? { apiBaseUrl } : {}),
  });
}
