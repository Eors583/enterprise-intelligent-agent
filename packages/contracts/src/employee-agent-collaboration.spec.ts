import { describe, expect, it } from 'vitest';

import {
  DEFAULT_EMPLOYEE_AGENT_COLLABORATION_SETTINGS,
  DEFAULT_PERSONAL_MANUAL_DISCLOSURE_POLICY,
  personalManualSelfProfileSchema,
  updatePersonalManualRequestSchema,
  updateWorkAvailabilityRequestSchema,
} from './index.js';

describe('employee Agent collaboration contracts', () => {
  it('keeps historical personal manuals private when old clients omit sharing settings', () => {
    const request = updatePersonalManualRequestSchema.parse({
      expectedUpdatedAt: null,
      manual: emptyManual(),
    });

    expect(request.disclosurePolicy).toEqual(DEFAULT_PERSONAL_MANUAL_DISCLOSURE_POLICY);
    expect(request.collaborationSettings).toEqual(DEFAULT_EMPLOYEE_AGENT_COLLABORATION_SETTINGS);
  });

  it('requires all six business sections in a self-profile response', () => {
    const result = personalManualSelfProfileSchema.safeParse({
      user: {
        id: '00000000-0000-4000-8000-000000000001',
        displayName: '林晓',
        email: 'lin.xiao@example.com',
        phone: null,
        avatarUrl: null,
      },
      employment: null,
      manual: emptyManual(),
      disclosurePolicy: DEFAULT_PERSONAL_MANUAL_DISCLOSURE_POLICY,
      collaborationSettings: DEFAULT_EMPLOYEE_AGENT_COLLABORATION_SETTINGS,
      policyRevision: 1,
      updatedAt: null,
    });

    expect(result.success).toBe(true);
  });

  it('rejects an availability end time that is not after its start', () => {
    const result = updateWorkAvailabilityRequestSchema.safeParse({
      status: 'TRAVELING',
      startsAt: '2026-08-13T09:00:00+08:00',
      endsAt: '2026-08-13T08:00:00+08:00',
      summary: null,
      expectedResponse: '次日回复',
      emergencyContactUserId: null,
      disclosureScope: 'SHARED_WORK',
      expectedRevision: null,
    });

    expect(result.success).toBe(false);
  });
});

function emptyManual() {
  return {
    personalSummary: null,
    educationBackground: null,
    careerOverview: null,
    jobResponsibilities: null,
    communicationPreference: null,
    collaborationHabits: null,
    routineSchedule: null,
    contactInformation: null,
    coreSkills: null,
    availableResources: null,
    hobbies: null,
    clubs: null,
    faqs: [],
  };
}
