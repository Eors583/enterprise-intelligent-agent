import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { MarketingEvidenceService } from './marketing-evidence.service.js';
import { MarketingManagementController } from './marketing-management.controller.js';
import { MarketingMasterDataService } from './marketing-master-data.service.js';
import { MarketingPlanningService } from './marketing-planning.service.js';

const id = (suffix: number): string =>
  `00000000-0000-4000-8000-${suffix.toString().padStart(12, '0')}`;

describe('MarketingManagementController', () => {
  let app: INestApplication;
  const evidence = {
    listObservations: vi.fn(),
    createObservation: vi.fn(),
    listInsights: vi.fn(),
    createInsight: vi.fn(),
    transitionInsight: vi.fn(),
  };
  const masterData = { list: vi.fn(), create: vi.fn(), update: vi.fn() };
  const planning = {
    listTargets: vi.fn(),
    createTarget: vi.fn(),
    transitionTarget: vi.fn(),
    listPlans: vi.fn(),
    createPlan: vi.fn(),
    transitionPlan: vi.fn(),
    createItem: vi.fn(),
    transitionItem: vi.fn(),
    addContributor: vi.fn(),
    createDependency: vi.fn(),
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [MarketingManagementController],
      providers: [
        { provide: MarketingEvidenceService, useValue: evidence },
        { provide: MarketingMasterDataService, useValue: masterData },
        { provide: MarketingPlanningService, useValue: planning },
      ],
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
  });

  afterAll(async () => app.close());

  it('accepts a governed observation without request-controlled tenant or actor identity', async () => {
    const body = {
      code: 'OBS-CUSTOMER-001',
      dimension: 'CUSTOMER',
      assertionType: 'FACT',
      statement: 'Enterprise customers require a verifiable same-day response.',
      confidence: 0.9,
      origin: 'HUMAN',
      agentRunId: null,
      evidence: [
        {
          evidenceId: id(1),
          evidenceVersion: 1,
          linkType: 'SUPPORTS',
          expectedContentHash: 'a'.repeat(64),
        },
      ],
      idempotencyKey: 'marketing-observation-1',
    };
    evidence.createObservation.mockResolvedValueOnce({ id: id(2) });
    await request(app.getHttpServer())
      .post('/api/v1/admin/marketing/observations')
      .send(body)
      .expect(201);
    expect(evidence.createObservation).toHaveBeenCalledWith(body);

    await request(app.getHttpServer())
      .post('/api/v1/admin/marketing/observations')
      .send({ ...body, tenantId: id(99), createdByUserId: id(98) })
      .expect(400);
  });

  it('rejects an ambiguous target axis before the service boundary', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/admin/marketing/targets')
      .send({
        code: 'TARGET-001',
        productId: id(1),
        axis: 'REGION',
        regionId: id(2),
        customerSegmentId: id(3),
        strategyId: id(4),
        strategyVersion: 1,
        objectiveId: id(5),
        objectiveVersion: 1,
        valueDefinitionId: id(6),
        valueVersionId: id(7),
        valueVersionNumber: 1,
        responsibleRoleAssignmentId: id(8),
        metricDefinitionId: id(9),
        metricDefinitionVersion: 1,
        baselineValue: 10,
        targetValue: 20,
        unit: 'COUNT',
        periodStart: '2026-07-28T08:00:00.000+00:00',
        periodEnd: '2026-08-28T08:00:00.000+00:00',
        budgetAmount: 1000,
        budgetCurrency: 'CNY',
        idempotencyKey: 'marketing-target-1',
      })
      .expect(400);
    expect(planning.createTarget).not.toHaveBeenCalled();
  });
});
