import type {
  PersonalManualSelfProfile,
  WorkAvailabilitySelfResponse,
} from '@enterprise/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getMyPersonalManual,
  getMyWorkAvailability,
  updateMyPersonalManual,
  updateMyWorkAvailability,
} from './api';

afterEach(() => vi.unstubAllGlobals());

describe('personal manual self-service API', () => {
  it('loads and validates the current member manual', async () => {
    const profile = profileFixture();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(profile));
    vi.stubGlobal('fetch', fetchMock);

    await expect(getMyPersonalManual(undefined, 'http://127.0.0.1:3000')).resolves.toEqual(profile);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:3000/api/v1/workbench/people/me/personal-manual',
      expect.objectContaining({ method: 'GET', credentials: 'include' }),
    );
  });

  it('sends a versioned full replacement and returns the saved snapshot', async () => {
    const profile = profileFixture();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(profile));
    vi.stubGlobal('fetch', fetchMock);

    await updateMyPersonalManual(
      {
        expectedUpdatedAt: profile.updatedAt,
        manual: profile.manual,
        disclosurePolicy: profile.disclosurePolicy,
        collaborationSettings: profile.collaborationSettings,
      },
      'http://127.0.0.1:3000',
    );

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(request.method).toBe('PUT');
    expect(JSON.parse(String(request.body))).toEqual({
      expectedUpdatedAt: profile.updatedAt,
      manual: profile.manual,
      disclosurePolicy: profile.disclosurePolicy,
      collaborationSettings: profile.collaborationSettings,
    });
  });

  it('loads and updates the current member work availability', async () => {
    const availability = availabilityFixture();
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(availability)));
    vi.stubGlobal('fetch', fetchMock);

    await expect(getMyWorkAvailability(undefined, 'http://127.0.0.1:3000')).resolves.toEqual(
      availability,
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'http://127.0.0.1:3000/api/v1/workbench/people/me/work-availability',
      expect.objectContaining({ method: 'GET', credentials: 'include' }),
    );

    await updateMyWorkAvailability(
      {
        status: 'FOCUSING',
        startsAt: availability.availability!.startsAt,
        endsAt: availability.availability!.endsAt,
        summary: '集中处理方案，紧急事项请联系代理人。',
        expectedResponse: '今天 17:00 前',
        emergencyContactUserId: availability.availability!.emergencyContact!.id,
        disclosureScope: 'SHARED_WORK',
        expectedRevision: availability.availability!.revision,
      },
      'http://127.0.0.1:3000',
    );

    const request = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(request.method).toBe('PUT');
    expect(JSON.parse(String(request.body))).toMatchObject({
      status: 'FOCUSING',
      disclosureScope: 'SHARED_WORK',
      expectedRevision: 1,
    });
  });
});

function profileFixture(): PersonalManualSelfProfile {
  return {
    user: {
      id: '00000000-0000-4000-8000-000000000001',
      displayName: '林晓',
      email: 'lin.xiao@example.com',
      phone: null,
      avatarUrl: null,
    },
    employment: {
      departmentName: '产品中心',
      title: '产品负责人',
      employeeNumber: 'P-001',
      employmentType: 'REGULAR',
    },
    manual: {
      personalSummary: '负责企业协作产品。',
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
    },
    disclosurePolicy: privatePolicy(),
    collaborationSettings: {
      manualSharingEnabled: false,
      availabilitySharingEnabled: false,
      privateRiskRemindersEnabled: true,
    },
    policyRevision: 1,
    updatedAt: '2026-08-11T01:00:00.000Z',
  };
}

function privatePolicy(): PersonalManualSelfProfile['disclosurePolicy'] {
  return {
    IDENTITY: 'SELF_ONLY',
    RESPONSIBILITIES: 'SELF_ONLY',
    COLLABORATION: 'SELF_ONLY',
    RESOURCES: 'SELF_ONLY',
    INTERESTS: 'SELF_ONLY',
    FAQ: 'SELF_ONLY',
  };
}

function availabilityFixture(): WorkAvailabilitySelfResponse {
  return {
    availability: {
      id: '00000000-0000-4000-8000-000000000010',
      status: 'FOCUSING',
      startsAt: '2026-08-13T01:00:00.000Z',
      endsAt: '2026-08-13T09:00:00.000Z',
      summary: '集中处理产品方案。',
      expectedResponse: '今天 17:00 前',
      emergencyContact: {
        id: '00000000-0000-4000-8000-000000000011',
        displayName: '陈晨',
      },
      disclosureScope: 'SHARED_WORK',
      revision: 1,
      updatedAt: '2026-08-13T01:00:00.000Z',
      expired: false,
    },
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
