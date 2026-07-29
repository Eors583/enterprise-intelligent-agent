import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  ExperienceAdminController,
  MemoryWorkbenchController,
} from './memory-experience.controller.js';
import { MemoryExperienceService } from './memory-experience.service.js';

const EXPERIENCE_ID = '00000000-0000-7000-8000-000000000101';
const MEMORY_ID = '00000000-0000-7000-8000-000000000102';
const TASK_ID = '00000000-0000-7000-8000-000000000103';
const EVIDENCE_ID = '00000000-0000-7000-8000-000000000104';
const KNOWLEDGE_BASE_ID = '00000000-0000-7000-8000-000000000105';
const ROLE_TEMPLATE_ID = '00000000-0000-7000-8000-000000000106';

describe('Memory and Experience controllers', () => {
  let app: INestApplication;
  const service = {
    listMemories: vi.fn(),
    getMemory: vi.fn(),
    createMemory: vi.fn(),
    transitionMemoryRecord: vi.fn(),
    listExperiences: vi.fn(),
    getExperience: vi.fn(),
    createExperience: vi.fn(),
    transitionExperienceCandidate: vi.fn(),
    getExperienceKnowledgeProjection: vi.fn(),
    prepareExperienceKnowledgeProjection: vi.fn(),
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [ExperienceAdminController, MemoryWorkbenchController],
      providers: [{ provide: MemoryExperienceService, useValue: service }],
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
  });

  afterAll(async () => app.close());

  it('exposes the admin Experience governance terminal routes', async () => {
    service.listExperiences.mockResolvedValueOnce({ items: [], nextCursor: null });
    await request(app.getHttpServer())
      .get('/api/v1/admin/experiences?status=CANDIDATE&limit=25')
      .expect(200, { items: [], nextCursor: null });
    expect(service.listExperiences).toHaveBeenCalledWith({
      status: 'CANDIDATE',
      limit: 25,
    });

    service.createExperience.mockResolvedValueOnce({ id: EXPERIENCE_ID });
    const candidate = {
      title: 'Proven delivery practice',
      sourceTaskId: TASK_ID,
      sourceDeliverableIds: [],
      sourceEvidenceIds: [EVIDENCE_ID],
      rawInputHash: 'a'.repeat(64),
      candidateSummary: 'A governed candidate extracted from a completed Task.',
      permissionLabels: [],
      sensitivity: 'INTERNAL',
      idempotencyKey: 'experience-create-1',
    };
    await request(app.getHttpServer())
      .post('/api/v1/admin/experiences')
      .send(candidate)
      .expect(201);
    expect(service.createExperience).toHaveBeenCalledWith(candidate);
  });

  it('accepts strict action-bound transition payloads and rejects actor injection', async () => {
    const transition = {
      expectedRevision: 1,
      action: 'SANITIZE',
      reason: 'Remove private and secret material before structuring.',
      payload: {
        sanitizedContent: 'A safe description of the repeatable operating practice.',
        sanitizedHash: 'b'.repeat(64),
        piiRemoved: true,
        secretsRemoved: true,
        customerIdentifiersRemoved: true,
        findings: [],
      },
      idempotencyKey: 'experience-sanitize-1',
    };
    service.transitionExperienceCandidate.mockResolvedValueOnce({ id: EXPERIENCE_ID });
    await request(app.getHttpServer())
      .post(`/api/v1/admin/experiences/${EXPERIENCE_ID}/transitions`)
      .send(transition)
      .expect(201);
    expect(service.transitionExperienceCandidate).toHaveBeenCalledWith(EXPERIENCE_ID, transition);

    await request(app.getHttpServer())
      .post(`/api/v1/admin/experiences/${EXPERIENCE_ID}/transitions`)
      .send({
        ...transition,
        actorUserId: '00000000-0000-7000-8000-000000000999',
      })
      .expect(400);
  });

  it('exposes strict Experience Knowledge projection read and preparation routes', async () => {
    service.getExperienceKnowledgeProjection.mockResolvedValueOnce({
      id: '00000000-0000-7000-8000-000000000107',
    });
    await request(app.getHttpServer())
      .get(`/api/v1/admin/experiences/${EXPERIENCE_ID}/knowledge-projection`)
      .expect(200);
    expect(service.getExperienceKnowledgeProjection).toHaveBeenCalledWith(EXPERIENCE_ID);

    const preparation = {
      expectedRevision: 4,
      knowledgeBaseId: KNOWLEDGE_BASE_ID,
      targetRoleTemplateIds: [ROLE_TEMPLATE_ID],
      targetOrgUnitIds: [],
      title: 'Governed delivery practice',
      idempotencyKey: 'experience-projection-1',
    };
    service.prepareExperienceKnowledgeProjection.mockResolvedValueOnce({
      id: '00000000-0000-7000-8000-000000000107',
    });
    await request(app.getHttpServer())
      .post(`/api/v1/admin/experiences/${EXPERIENCE_ID}/knowledge-projection`)
      .send(preparation)
      .expect(201);
    expect(service.prepareExperienceKnowledgeProjection).toHaveBeenCalledWith(
      EXPERIENCE_ID,
      preparation,
    );

    await request(app.getHttpServer())
      .post(`/api/v1/admin/experiences/${EXPERIENCE_ID}/knowledge-projection`)
      .send({ ...preparation, targetRoleTemplateIds: [], actorUserId: ROLE_TEMPLATE_ID })
      .expect(400);
  });

  it('exposes five-scope workbench Memory list, detail, create and transition routes', async () => {
    service.listMemories.mockResolvedValueOnce({ items: [], nextCursor: null });
    await request(app.getHttpServer())
      .get('/api/v1/workbench/memories?scope=EMPLOYEE_PRIVATE&purpose=Personal%20assistant')
      .expect(200);
    expect(service.listMemories).toHaveBeenCalledWith({
      scope: 'EMPLOYEE_PRIVATE',
      purpose: 'Personal assistant',
      limit: 50,
    });

    service.transitionMemoryRecord.mockResolvedValueOnce({ id: MEMORY_ID });
    const transition = {
      expectedRevision: 1,
      action: 'ACTIVATE',
      reason: 'The employee confirmed this memory candidate.',
      idempotencyKey: 'memory-activate-1',
    };
    await request(app.getHttpServer())
      .post(`/api/v1/workbench/memories/${MEMORY_ID}/transitions`)
      .send(transition)
      .expect(201);
    expect(service.transitionMemoryRecord).toHaveBeenCalledWith(MEMORY_ID, transition);
  });
});
