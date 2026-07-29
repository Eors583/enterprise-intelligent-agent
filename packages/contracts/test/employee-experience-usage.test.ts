import { describe, expect, it } from 'vitest';

import {
  employeeAiUsageQuerySchema,
  employeeAiUsageSummarySchema,
  employeeCreateExperienceRequestSchema,
  employeeExperienceCandidateSchema,
} from '../src/employee-experience-usage.js';

const ID = '00000000-0000-7000-8000-000000000001';
const OTHER_ID = '00000000-0000-7000-8000-000000000002';
const NOW = '2026-07-28T08:00:00.000Z';

describe('employee experience and AI usage contracts', () => {
  it('keeps employee submissions actor-free and strict', () => {
    const request = {
      title: 'Repeatable customer handoff',
      sourceTaskId: ID,
      sourceDeliverableIds: [],
      sourceEvidenceIds: [OTHER_ID],
      candidateSummary: 'A raw contribution that must be sanitized before wider reuse.',
      permissionLabels: ['delivery'],
      sensitivity: 'INTERNAL',
      idempotencyKey: 'employee-experience-0001',
    };
    expect(employeeCreateExperienceRequestSchema.parse(request)).toEqual(request);
    expect(
      employeeCreateExperienceRequestSchema.safeParse({
        ...request,
        contributorUserId: OTHER_ID,
      }).success,
    ).toBe(false);
  });

  it('never includes pre-sanitization content in the employee read model', () => {
    const response = {
      id: ID,
      status: 'CANDIDATE',
      revision: 1,
      title: 'Repeatable customer handoff',
      source: {
        taskId: OTHER_ID,
        deliverableIds: [],
        evidenceIds: [ID],
      },
      sanitized: null,
      review: null,
      validation: null,
      publication: null,
      permissionLabels: [],
      sensitivity: 'INTERNAL',
      metrics: { useCount: 0, adoptionCount: 0, complaintCount: 0 },
      retiredAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    expect(employeeExperienceCandidateSchema.parse(response)).toEqual(response);
    expect(
      employeeExperienceCandidateSchema.safeParse({
        ...response,
        candidateSummary: 'raw private content',
      }).success,
    ).toBe(false);
  });

  it('requires an exact bounded optional usage window', () => {
    expect(employeeAiUsageQuerySchema.parse({})).toEqual({ groupLimit: 25 });
    expect(employeeAiUsageQuerySchema.safeParse({ from: NOW }).success).toBe(false);
    expect(
      employeeAiUsageQuerySchema.safeParse({
        from: '2026-07-29T00:00:00.000Z',
        to: '2026-07-28T00:00:00.000Z',
      }).success,
    ).toBe(false);
  });

  it('rejects inconsistent status or unreported usage accounting', () => {
    const summary = {
      period: {
        from: '2026-07-01T00:00:00.000Z',
        to: NOW,
        defaultedToCurrentMonth: true,
      },
      generatedAt: NOW,
      runs: {
        total: 3,
        succeeded: 1,
        failed: 0,
        unknown: 1,
        cancelled: 0,
        inProgress: 1,
        tokenReported: 1,
        tokenUnreported: 1,
        costReported: 1,
        costUnreported: 1,
      },
      trustedUsage: {
        inputTokens: '12',
        outputTokens: '4',
        totalTokens: '16',
        costMicros: '230',
      },
      latency: { sampleCount: 2, averageMs: 120, p50Ms: 100, p95Ms: 140 },
      byAgent: [],
      byTask: [],
    };
    expect(employeeAiUsageSummarySchema.parse(summary)).toEqual(summary);
    expect(
      employeeAiUsageSummarySchema.safeParse({
        ...summary,
        runs: { ...summary.runs, tokenUnreported: 0 },
      }).success,
    ).toBe(false);
  });
});
