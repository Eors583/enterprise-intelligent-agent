import type { PersonalManualSelfProfile } from '@enterprise/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { getMyPersonalManual, updateMyPersonalManual } from './api';

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
      { expectedUpdatedAt: profile.updatedAt, manual: profile.manual },
      'http://127.0.0.1:3000',
    );

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(request.method).toBe('PUT');
    expect(JSON.parse(String(request.body))).toEqual({
      expectedUpdatedAt: profile.updatedAt,
      manual: profile.manual,
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
    updatedAt: '2026-08-11T01:00:00.000Z',
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
