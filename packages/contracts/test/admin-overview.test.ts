import { describe, expect, it } from 'vitest';

import { adminOverviewResponseSchema } from '../src/admin-overview.js';

const EMPTY_WINDOW = {
  from: '2026-07-28T00:00:00.000Z',
  total: 0,
  succeeded: 0,
  failed: 0,
  unknown: 0,
  cancelled: 0,
  inProgress: 0,
  trustedUsageRuns: 0,
  unreportedUsageRuns: 0,
  quotaUpperBoundRuns: 0,
  inputTokens: '0',
  outputTokens: '0',
  totalTokens: '0',
  quotaChargedTokens: '0',
  costMicros: '0',
  latencySampleCount: 0,
  averageLatencyMs: null,
  p95LatencyMs: null,
  groundedSucceededRuns: 0,
  ungroundedSucceededRuns: 0,
  helpfulFeedback: 0,
  notHelpfulFeedback: 0,
  feedbackSampleCount: 0,
  helpfulRateBps: null,
};

function responseFixture() {
  return {
    generatedAt: '2026-07-28T01:00:00.000Z',
    people: {
      total: 0,
      active: 0,
      inactive: 0,
      locked: 0,
      pendingInvitations: 0,
      activeUsers7d: 0,
    },
    agents: {
      total: 0,
      configuredOnline: 0,
      available: 0,
      notReady: 0,
      degraded: 0,
      unknown: 0,
    },
    ai: { today: EMPTY_WINDOW, month: EMPTY_WINDOW },
    knowledge: {
      activeBases: 0,
      totalDocuments: 0,
      readyDocuments: 0,
      failedDocuments: 0,
      pendingParseReviews: 0,
      rejectedParseReviews: 0,
      failedIngestionJobs: 0,
      totalChunks: 0,
      chunksWithEmbeddings: 0,
      chunksMissingEmbeddings: 0,
    },
    directory: {
      latestRunStatus: null,
      latestRunFinishedAt: null,
      failedRuns24h: 0,
      pendingPreviewItems: 0,
    },
    operations: {
      pendingOutboxEvents: 0,
      failedOutboxEvents: 0,
      unknownOutboxEvents: 0,
      quarantinedOutboxEvents: 0,
      unknownAgentRuns24h: 0,
    },
    alerts: [],
  };
}

describe('adminOverviewResponseSchema', () => {
  it('accepts explicit empty-state observability without inventing samples', () => {
    expect(adminOverviewResponseSchema.parse(responseFixture())).toMatchObject({
      knowledge: { totalChunks: 0, chunksMissingEmbeddings: 0 },
      ai: { today: { latencySampleCount: 0, p95LatencyMs: null } },
    });
  });

  it('rejects negative counters and non-integral cost evidence', () => {
    expect(() =>
      adminOverviewResponseSchema.parse({
        ...responseFixture(),
        operations: {
          ...responseFixture().operations,
          failedOutboxEvents: -1,
        },
      }),
    ).toThrow();
    expect(() =>
      adminOverviewResponseSchema.parse({
        ...responseFixture(),
        ai: {
          ...responseFixture().ai,
          today: { ...EMPTY_WINDOW, costMicros: 'unknown' },
        },
      }),
    ).toThrow();
  });
});
