import { describe, expect, it, vi } from 'vitest';

import { AdminOverviewService, buildAlerts } from './admin-overview.service.js';

const TENANT_ID = '00000000-0000-7000-8000-000000000001';
const USER_ID = '00000000-0000-7000-8000-000000000101';
const AGENT_ID = '00000000-0000-7000-8000-000000000201';

function inputFixture() {
  return {
    people: {
      total: 2,
      active: 2,
      inactive: 0,
      locked: 0,
      pending_invitations: 0,
      active_users_7d: 2,
    },
    agents: { notReady: 0, degraded: 0, unknown: 0 },
    today: {
      total: 0,
      succeeded: 0,
      failed: 0,
      unknown: 0,
      cancelled: 0,
      in_progress: 0,
      trusted_usage_runs: 0,
      unreported_usage_runs: 0,
      quota_upper_bound_runs: 0,
      input_tokens: '0',
      output_tokens: '0',
      total_tokens: '0',
      quota_charged_tokens: '0',
      cost_micros: '0',
      latency_sample_count: 0,
      average_latency_ms: null,
      p95_latency_ms: null,
      grounded_succeeded_runs: 0,
      ungrounded_succeeded_runs: 0,
      helpful_feedback: 0,
      not_helpful_feedback: 0,
    },
    knowledge: {
      failedDocuments: 0,
      pendingParseReviews: 0,
      rejectedParseReviews: 0,
      failedIngestionJobs: 0,
      chunksMissingEmbeddings: 0,
    },
    directory: { failedRuns24h: 0, pendingPreviewItems: 0 },
    operations: {
      pendingOutboxEvents: 0,
      failedOutboxEvents: 0,
      unknownOutboxEvents: 0,
      quarantinedOutboxEvents: 0,
      unknownAgentRuns24h: 0,
    },
  };
}

describe('buildAlerts', () => {
  it('keeps a healthy empty workload free from synthetic alerts', () => {
    expect(buildAlerts(inputFixture())).toEqual([]);
  });

  it('separates unavailable Agents, unreported usage and UNKNOWN side effects', () => {
    const fixture = inputFixture();
    const alerts = buildAlerts({
      ...fixture,
      agents: { notReady: 2, degraded: 1, unknown: 1 },
      today: {
        ...fixture.today,
        failed: 1,
        unknown: 2,
        unreported_usage_runs: 3,
      },
      operations: {
        ...fixture.operations,
        unknownOutboxEvents: 1,
        unknownAgentRuns24h: 2,
      },
    });

    expect(alerts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'AGENTS_NOT_OPERATIONALLY_AVAILABLE',
          severity: 'CRITICAL',
          count: 4,
        }),
        expect.objectContaining({ code: 'AI_USAGE_UNREPORTED_TODAY', count: 3 }),
        expect.objectContaining({ code: 'OUTBOX_DELIVERY_FAILURES', count: 1 }),
        expect.objectContaining({ code: 'UNKNOWN_AGENT_RUNS_24H', count: 2 }),
      ]),
    );
  });
});

describe('AdminOverviewService', () => {
  it('maps persisted tenant state and dynamic operational availability without sample data', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([
        {
          total: 3,
          active: 2,
          inactive: 1,
          locked: 0,
          pending_invitations: 1,
          active_users_7d: 2,
        },
      ])
      .mockResolvedValueOnce([{ id: AGENT_ID, status: 'ONLINE' }])
      .mockResolvedValueOnce([{ ...inputFixture().today, total: 2, succeeded: 2 }])
      .mockResolvedValueOnce([{ ...inputFixture().today, total: 4, succeeded: 4 }])
      .mockResolvedValueOnce([
        {
          latest_run_status: 'SUCCEEDED',
          latest_run_finished_at: new Date('2026-07-28T00:30:00.000Z'),
          failed_runs_24h: 0,
          pending_preview_items: 0,
        },
      ])
      .mockResolvedValueOnce([
        {
          pending_outbox_events: 0,
          failed_outbox_events: 0,
          unknown_outbox_events: 0,
          quarantined_outbox_events: 0,
          unknown_agent_runs_24h: 0,
        },
      ]);
    const service = new AdminOverviewService(
      {
        withTenant: vi.fn(
          (_tenantId: string, operation: (transaction: unknown) => Promise<unknown>) =>
            operation({ $queryRaw: query }),
        ),
      } as never,
      {
        requireDirectoryWrite: vi.fn().mockReturnValue({
          tenantId: TENANT_ID,
          userId: USER_ID,
          role: 'ADMIN',
        }),
      } as never,
      {
        inspectAgents: vi.fn().mockResolvedValue(
          new Map([
            [
              AGENT_ID,
              {
                status: 'AVAILABLE',
                evidenceStatus: 'VERIFIED',
                reasonCodes: [],
                checkedAt: '2026-07-28T00:30:00.000Z',
              },
            ],
          ]),
        ),
      } as never,
      {
        readOperationalSummary: vi.fn().mockResolvedValue({
          activeBases: 1,
          totalDocuments: 2,
          readyDocuments: 2,
          failedDocuments: 0,
          pendingParseReviews: 0,
          rejectedParseReviews: 0,
          failedIngestionJobs: 0,
          totalChunks: 8,
          chunksWithEmbeddings: 8,
        }),
      } as never,
    );

    const result = await service.read();

    expect(result.people).toEqual({
      total: 3,
      active: 2,
      inactive: 1,
      locked: 0,
      pendingInvitations: 1,
      activeUsers7d: 2,
    });
    expect(result.agents).toMatchObject({ total: 1, configuredOnline: 1, available: 1 });
    expect(result.knowledge).toMatchObject({
      totalChunks: 8,
      chunksWithEmbeddings: 8,
      chunksMissingEmbeddings: 0,
    });
    expect(result.directory.latestRunStatus).toBe('SUCCEEDED');
    expect(query).toHaveBeenCalledTimes(6);
    const todayQuery = query.mock.calls[2]?.[0] as { readonly sql?: string } | undefined;
    expect(todayQuery?.sql).toContain('run."grounded_citation_count" > 0');
    expect(todayQuery?.sql).not.toContain('public."messages"');
  });
});
