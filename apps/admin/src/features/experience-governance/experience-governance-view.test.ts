import { describe, expect, it } from 'vitest';

import {
  availableExperienceActions,
  experienceProgress,
  splitIdentifiers,
  transitionPayloadTemplate,
} from './experience-governance-view';

describe('experience governance view', () => {
  it('only exposes legal next actions', () => {
    expect(availableExperienceActions('CANDIDATE')).toEqual(['SANITIZE']);
    expect(availableExperienceActions('STRUCTURED')).toEqual(['APPROVE', 'REJECT']);
    expect(availableExperienceActions('REJECTED')).toEqual([]);
    expect(availableExperienceActions('MONITORED')).toEqual(['MONITOR', 'RETIRE']);
  });

  it('does not treat a rejected candidate as published progress', () => {
    expect(experienceProgress(candidate({ status: 'REJECTED' }))).toBe(3);
  });

  it('builds a sanitization template with all mandatory gates visible', () => {
    expect(transitionPayloadTemplate('SANITIZE', candidate())).toMatchObject({
      piiRemoved: true,
      secretsRemoved: true,
      customerIdentifiersRemoved: true,
    });
  });

  it('normalizes identifier lists without duplicates', () => {
    expect(splitIdentifiers('a, b；a\nc')).toEqual(['a', 'b', 'c']);
  });
});

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    id: '00000000-0000-7000-8000-000000000001',
    tenantId: '00000000-0000-7000-8000-000000000002',
    status: 'CANDIDATE',
    revision: 1,
    title: 'Delivery practice',
    contributorUserId: '00000000-0000-7000-8000-000000000003',
    contributorRoleAssignmentId: '00000000-0000-7000-8000-000000000004',
    sourceTaskId: '00000000-0000-7000-8000-000000000005',
    sourceDeliverableIds: [],
    sourceEvidenceIds: ['00000000-0000-7000-8000-000000000006'],
    rawInputHash: 'a'.repeat(64),
    candidateSummary: 'A reusable delivery practice.',
    sanitization: null,
    structuredContent: null,
    structuredHash: null,
    review: null,
    validation: null,
    publication: null,
    permissionLabels: [],
    sensitivity: 'INTERNAL',
    monitoredUseCount: 0,
    monitoredAdoptionCount: 0,
    monitoredComplaintCount: 0,
    expiresAt: null,
    retiredAt: null,
    createdAt: '2026-07-28T00:00:00.000Z',
    updatedAt: '2026-07-28T00:00:00.000Z',
    ...overrides,
  } as never;
}
