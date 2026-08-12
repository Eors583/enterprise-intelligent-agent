import {
  personalManualSelfProfileSchema,
  updatePersonalManualRequestSchema,
  type PersonalManualSelfProfile,
  type UpdatePersonalManualRequest,
} from '@enterprise/contracts';

import { apiRequest } from '../../shared/api/client';

const PERSONAL_MANUAL_PATH = '/api/v1/workbench/people/me/personal-manual';

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
