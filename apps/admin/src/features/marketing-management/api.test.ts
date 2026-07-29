import { beforeEach, describe, expect, it, vi } from 'vitest';

const { requestMock } = vi.hoisted(() => ({ requestMock: vi.fn() }));
vi.mock('@/api/client', () => ({ request: requestMock }));

import {
  createMarketingInsight,
  createMarketingTarget,
  listMarketingActionPlans,
  listMarketingInsights,
  listMarketingMasterData,
  listMarketingObservations,
  listMarketingTargets,
  transitionMarketingInsight,
} from './api';

const id = (suffix: number): string =>
  `00000000-0000-4000-8000-${suffix.toString().padStart(12, '0')}`;

describe('marketing management admin API adapter', () => {
  beforeEach(() => {
    requestMock.mockReset();
    requestMock.mockResolvedValue({ items: [] });
  });

  it('uses the governed marketing list routes and response envelopes', async () => {
    const controller = new AbortController();
    await Promise.all([
      listMarketingObservations(controller.signal),
      listMarketingInsights(controller.signal),
      listMarketingTargets(controller.signal),
      listMarketingActionPlans(controller.signal),
      listMarketingMasterData('products', controller.signal),
      listMarketingMasterData('regions', controller.signal),
      listMarketingMasterData('customer-segments', controller.signal),
    ]);
    expect(requestMock.mock.calls.map(([path]) => path)).toEqual([
      '/admin/marketing/observations',
      '/admin/marketing/insights',
      '/admin/marketing/targets',
      '/admin/marketing/action-plans',
      '/admin/marketing/products',
      '/admin/marketing/regions',
      '/admin/marketing/customer-segments',
    ]);
    for (const [, options] of requestMock.mock.calls) {
      expect(options).toEqual(
        expect.objectContaining({ signal: controller.signal, schema: expect.anything() }),
      );
    }
  });

  it('keeps candidate creation, human review, and matrix creation on exact mutation routes', async () => {
    await createMarketingInsight({
      code: 'INSIGHT-001',
      title: 'Renewal insight',
      statement: 'Verified response time influences renewal.',
      origin: 'HUMAN',
      agentRunId: null,
      observationIds: [id(1)],
      idempotencyKey: 'marketing-insight-1',
    });
    expect(requestMock.mock.calls.at(-1)?.[0]).toBe('/admin/marketing/insights');

    await transitionMarketingInsight(id(2), {
      action: 'APPROVE',
      expectedRevision: 2,
      comment: 'Independent evidence review passed.',
    });
    expect(requestMock.mock.calls.at(-1)?.[0]).toBe(
      `/admin/marketing/insights/${id(2)}/transition`,
    );

    await createMarketingTarget({
      code: 'TARGET-001',
      productId: id(3),
      axis: 'REGION',
      regionId: id(4),
      customerSegmentId: null,
      strategyId: id(5),
      strategyVersion: 1,
      objectiveId: id(6),
      objectiveVersion: 1,
      valueDefinitionId: id(7),
      valueVersionId: id(8),
      valueVersionNumber: 1,
      responsibleRoleAssignmentId: id(9),
      metricDefinitionId: id(10),
      metricDefinitionVersion: 1,
      baselineValue: 10,
      targetValue: 20,
      unit: 'COUNT',
      periodStart: '2026-07-28T08:00:00.000+00:00',
      periodEnd: '2026-08-28T08:00:00.000+00:00',
      budgetAmount: 1000,
      budgetCurrency: 'CNY',
      idempotencyKey: 'marketing-target-1',
    });
    expect(requestMock.mock.calls.at(-1)?.[0]).toBe('/admin/marketing/targets');
    expect(requestMock.mock.calls.at(-1)?.[1]).toEqual(
      expect.objectContaining({
        method: 'POST',
        body: expect.objectContaining({ axis: 'REGION' }),
      }),
    );
  });
});
