import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  EmployeeAiUsageController,
  EmployeeExperienceController,
  EmployeeExperienceSourceController,
} from './employee-insights.controller.js';
import { EmployeeInsightsService } from './employee-insights.service.js';

const TASK = '00000000-0000-7000-8000-000000000401';
const EVIDENCE = '00000000-0000-7000-8000-000000000402';

describe('employee experience and AI usage controllers', () => {
  let app: INestApplication;
  const service = {
    listExperiences: vi.fn(),
    experienceSources: vi.fn(),
    createExperience: vi.fn(),
    aiUsage: vi.fn(),
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [
        EmployeeExperienceController,
        EmployeeExperienceSourceController,
        EmployeeAiUsageController,
      ],
      providers: [{ provide: EmployeeInsightsService, useValue: service }],
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
  });

  afterAll(async () => app.close());

  it('exposes paged status-filtered self experience reads', async () => {
    service.listExperiences.mockResolvedValueOnce({ items: [], nextCursor: null });
    await request(app.getHttpServer())
      .get('/api/v1/workbench/experiences?status=SANITIZED&limit=10')
      .expect(200, { items: [], nextCursor: null });
    expect(service.listExperiences).toHaveBeenCalledWith({
      status: 'SANITIZED',
      limit: 10,
    });
  });

  it('accepts actor-free contribution and rejects identity or raw-hash injection', async () => {
    const body = {
      title: 'Repeatable customer handoff',
      sourceTaskId: TASK,
      sourceDeliverableIds: [],
      sourceEvidenceIds: [EVIDENCE],
      candidateSummary: 'A raw contribution for the governed experience lifecycle.',
      permissionLabels: [],
      sensitivity: 'INTERNAL',
      idempotencyKey: 'employee-experience-0401',
    };
    service.createExperience.mockResolvedValueOnce({ id: 'created' });
    await request(app.getHttpServer()).post('/api/v1/workbench/experiences').send(body).expect(201);
    expect(service.createExperience).toHaveBeenCalledWith(body);

    await request(app.getHttpServer())
      .post('/api/v1/workbench/experiences')
      .send({ ...body, contributorUserId: EVIDENCE, rawInputHash: 'a'.repeat(64) })
      .expect(400);
  });

  it('requires an exact Task source selector and an exact usage window', async () => {
    service.experienceSources.mockResolvedValueOnce({
      task: { id: TASK, title: 'Task', permissionLabels: [] },
      deliverables: [],
      evidence: [],
    });
    await request(app.getHttpServer())
      .get(`/api/v1/workbench/experience-sources?taskId=${TASK}`)
      .expect(200);
    expect(service.experienceSources).toHaveBeenCalledWith(TASK);

    await request(app.getHttpServer())
      .get('/api/v1/workbench/ai-usage?from=2026-07-01T00%3A00%3A00.000Z')
      .expect(400);

    service.aiUsage.mockResolvedValueOnce({ period: {} });
    await request(app.getHttpServer()).get('/api/v1/workbench/ai-usage').expect(200);
    expect(service.aiUsage).toHaveBeenCalledWith({ groupLimit: 25 });
  });
});
