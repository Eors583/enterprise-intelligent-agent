import type { EmployeeAiUsageSummary, EmployeeExperienceCandidate } from '@enterprise/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createEmployeeExperience, getEmployeeAiUsage, listEmployeeExperiences } from './api';

const TASK = '00000000-0000-7000-8000-000000000501';
const EXPERIENCE = '00000000-0000-7000-8000-000000000502';
const EVIDENCE = '00000000-0000-7000-8000-000000000503';
const NOW = '2026-07-28T08:00:00.000Z';

afterEach(() => vi.unstubAllGlobals());

describe('employee experience and usage API', () => {
  it('uses status/cursor pagination and validates the privacy-preserving read model', async () => {
    const candidate = candidateFixture();
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        items: [candidate],
        nextCursor: EXPERIENCE,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      listEmployeeExperiences(
        { status: 'CANDIDATE', cursor: EXPERIENCE },
        undefined,
        'http://127.0.0.1:3000',
      ),
    ).resolves.toMatchObject({ items: [candidate] });
    expect(fetchMock).toHaveBeenCalledWith(
      `http://127.0.0.1:3000/api/v1/workbench/experiences?limit=25&status=CANDIDATE&cursor=${EXPERIENCE}`,
      expect.objectContaining({ method: 'GET', credentials: 'include' }),
    );

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          items: [{ ...candidate, candidateSummary: 'raw private content' }],
          nextCursor: null,
        }),
      ),
    );
    await expect(listEmployeeExperiences({}, undefined, 'http://127.0.0.1:3000')).rejects.toThrow(
      '契约',
    );
  });

  it('submits an actor-free candidate without a client-supplied raw hash', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(candidateFixture()));
    vi.stubGlobal('fetch', fetchMock);
    const input = {
      title: 'Repeatable customer handoff',
      sourceTaskId: TASK,
      sourceDeliverableIds: [],
      sourceEvidenceIds: [EVIDENCE],
      candidateSummary: 'Raw employee contribution for controlled sanitization.',
      permissionLabels: [],
      sensitivity: 'INTERNAL' as const,
      idempotencyKey: 'employee-experience-0501',
    };

    await createEmployeeExperience(input, 'http://127.0.0.1:3000');

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://127.0.0.1:3000/api/v1/workbench/experiences');
    expect(JSON.parse(String(request.body))).toEqual(input);
    expect(JSON.parse(String(request.body))).not.toHaveProperty('rawInputHash');
    expect(JSON.parse(String(request.body))).not.toHaveProperty('contributorUserId');
  });

  it('requests a bounded usage window and accepts only trusted/unreported split totals', async () => {
    const usage = usageFixture();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(usage));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      getEmployeeAiUsage(
        {
          from: '2026-07-01T00:00:00.000Z',
          to: NOW,
        },
        undefined,
        'http://127.0.0.1:3000',
      ),
    ).resolves.toEqual(usage);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:3000/api/v1/workbench/ai-usage?groupLimit=25&from=2026-07-01T00%3A00%3A00.000Z&to=2026-07-28T08%3A00%3A00.000Z',
      expect.objectContaining({ method: 'GET', credentials: 'include' }),
    );
  });
});

function candidateFixture(): EmployeeExperienceCandidate {
  return {
    id: EXPERIENCE,
    status: 'CANDIDATE',
    revision: 1,
    title: 'Repeatable customer handoff',
    source: { taskId: TASK, deliverableIds: [], evidenceIds: [EVIDENCE] },
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
}

function usageFixture(): EmployeeAiUsageSummary {
  return {
    period: {
      from: '2026-07-01T00:00:00.000Z',
      to: NOW,
      defaultedToCurrentMonth: false,
    },
    generatedAt: NOW,
    runs: {
      total: 2,
      succeeded: 1,
      failed: 0,
      unknown: 1,
      cancelled: 0,
      inProgress: 0,
      tokenReported: 1,
      tokenUnreported: 1,
      costReported: 1,
      costUnreported: 1,
    },
    trustedUsage: {
      inputTokens: '20',
      outputTokens: '5',
      totalTokens: '25',
      costMicros: '800',
    },
    latency: { sampleCount: 2, averageMs: 250, p50Ms: 200, p95Ms: 300 },
    byAgent: [],
    byTask: [],
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
