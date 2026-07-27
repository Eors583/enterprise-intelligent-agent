import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { knowledgeCitationDetailSchema } from '@enterprise/contracts';
import request from 'supertest';

import { KnowledgeCitationController } from './knowledge-citation.controller.js';
import { KnowledgeCitationService } from './knowledge-citation.service.js';

const VERSION_ID = '00000000-0000-7000-8000-000000000501';
const CHUNK_ID = '00000000-0000-7000-8000-000000000601';

describe('KnowledgeCitationController', () => {
  let app: INestApplication;
  const getOriginal = vi.fn();

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [KnowledgeCitationController],
      providers: [{ provide: KnowledgeCitationService, useValue: { getOriginal } }],
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('exposes the employee citation-original endpoint with a contract-valid response', async () => {
    getOriginal.mockResolvedValueOnce({
      knowledgeBaseId: '00000000-0000-7000-8000-000000000301',
      knowledgeBaseName: '企业制度库',
      documentId: '00000000-0000-7000-8000-000000000401',
      documentTitle: '请假制度',
      documentVersionId: VERSION_ID,
      documentVersion: 3,
      chunkId: CHUNK_ID,
      headingPath: ['人事制度', '年假'],
      sourceType: 'MARKDOWN',
      content: '年假申请需至少提前一天发起。',
      updatedAt: '2026-07-20T02:00:00.000Z',
    });

    const response = await request(app.getHttpServer())
      .get(`/api/v1/knowledge-citations/${VERSION_ID}/chunks/${CHUNK_ID}`)
      .expect(200);

    expect(knowledgeCitationDetailSchema.safeParse(response.body).success).toBe(true);
    expect(getOriginal).toHaveBeenCalledWith(VERSION_ID, CHUNK_ID);
  });

  it('rejects malformed resource identifiers before invoking the service', async () => {
    await request(app.getHttpServer())
      .get(`/api/v1/knowledge-citations/not-a-uuid/chunks/${CHUNK_ID}`)
      .expect(400);
  });
});
