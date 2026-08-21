import { describe, expect, it } from 'vitest';

import { createExperienceCandidateRequestSchema } from './memory-experience.js';

const REQUEST = {
  title: '可复用交付经验',
  sourceTaskId: '00000000-0000-7000-8000-000000000001',
  sourceDeliverableIds: [],
  sourceEvidenceIds: ['00000000-0000-7000-8000-000000000002'],
  candidateSummary: '基于可信交付证据整理的经验。',
  permissionLabels: ['INTERNAL'],
  sensitivity: 'INTERNAL',
  idempotencyKey: 'experience-create-1',
} as const;

describe('createExperienceCandidateRequestSchema', () => {
  it('accepts the de-technicalized request without a client-provided content hash', () => {
    expect(createExperienceCandidateRequestSchema.parse(REQUEST)).not.toHaveProperty(
      'rawInputHash',
    );
  });

  it('keeps the legacy hash field wire-compatible for older clients', () => {
    expect(
      createExperienceCandidateRequestSchema.parse({
        ...REQUEST,
        rawInputHash: 'a'.repeat(64),
      }).rawInputHash,
    ).toBe('a'.repeat(64));
  });
});
