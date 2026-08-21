import { describe, expect, it } from 'vitest';

import {
  employeeDeliverableSubmissionCommandSchema,
  employeeDeliverableSubmissionRequestSchema,
  employeeEvidenceContributionCommandSchema,
  employeeEvidenceContributionRequestSchema,
} from './employee-task-execution.js';

const roleAssignmentId = '00000000-0000-7000-8000-000000000001';
const evidenceId = '00000000-0000-7000-8000-000000000002';

describe('employee task execution command contracts', () => {
  it('accepts the simplified evidence command without governance-generated fields', () => {
    expect(
      employeeEvidenceContributionCommandSchema.parse({
        roleAssignmentId,
        businessDescription: '客户已通过验收清单中的全部检查项。',
        sourceType: 'HUMAN_ATTESTATION',
      }),
    ).toEqual({
      roleAssignmentId,
      businessDescription: '客户已通过验收清单中的全部检查项。',
      sourceType: 'HUMAN_ATTESTATION',
      sourceUri: null,
    });
  });

  it('accepts the simplified deliverable command and rejects duplicate evidence identities', () => {
    const base = {
      roleAssignmentId,
      businessDescription: '交付结果已整理，可进入验收。',
      sourceType: 'DOCUMENT' as const,
      sourceUri: 'https://documents.example.test/deliverable',
    };
    expect(
      employeeDeliverableSubmissionCommandSchema.parse({
        ...base,
        evidenceIds: [evidenceId],
      }),
    ).toMatchObject({ evidenceIds: [evidenceId] });
    expect(() =>
      employeeDeliverableSubmissionCommandSchema.parse({
        ...base,
        evidenceIds: [evidenceId, evidenceId],
      }),
    ).toThrow();
  });

  it('keeps both legacy employee command contracts compatible', () => {
    expect(
      employeeDeliverableSubmissionRequestSchema.safeParse({
        expectedRevision: 1,
        roleAssignmentId,
        submittedAt: '2026-07-29T08:00:00.000Z',
        artifactUri: 'https://artifacts.example.test/result',
        contentHash: 'a'.repeat(64),
        evidenceIds: [evidenceId],
      }).success,
    ).toBe(true);
    expect(
      employeeEvidenceContributionRequestSchema.safeParse({
        roleAssignmentId,
        code: 'EVD:LEGACY',
        sourceType: 'DOCUMENT',
        sourceSystem: 'LEGACY.SYSTEM',
        sourceRecordId: 'legacy-record',
        sourceVersion: '1',
        sourceUri: 'https://documents.example.test/legacy',
        observedAt: '2026-07-29T08:00:00.000Z',
        contentHash: 'b'.repeat(64),
        summary: 'Legacy contract remains accepted.',
        effectiveFrom: '2026-07-29T08:00:00.000Z',
        effectiveTo: null,
        permissionLabels: [],
      }).success,
    ).toBe(true);
  });
});
