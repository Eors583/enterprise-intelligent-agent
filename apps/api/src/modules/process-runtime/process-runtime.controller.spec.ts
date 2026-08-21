import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  processInstanceDetailResponseSchema,
  processInstanceListResponseSchema,
  processInstanceSchema,
  processStepInstanceSchema,
} from '@enterprise/contracts';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  CLAIM_STEP_COMMAND,
  INSTANCE_ID,
  START_PROCESS_COMMAND,
  STEP_ID,
  processDetail,
  processInstance,
  processStep,
} from '../process-orchestration/testing/runtime-test-fixtures.js';
import { ProcessRuntimeController } from './process-runtime.controller.js';
import { ProcessRuntimeService } from './process-runtime.service.js';

describe('ProcessRuntimeController', () => {
  let app: INestApplication;
  const listInstances = vi.fn();
  const getInstance = vi.fn();
  const executeProcessCommand = vi.fn();
  const executeStepCommand = vi.fn();

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [ProcessRuntimeController],
      providers: [
        {
          provide: ProcessRuntimeService,
          useValue: {
            listInstances,
            getInstance,
            executeProcessCommand,
            executeStepCommand,
          },
        },
      ],
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
  });

  afterAll(async () => app.close());

  it('exposes the bounded Process Instance list endpoint', async () => {
    listInstances.mockResolvedValueOnce({
      items: [processInstance()],
      pageInfo: { nextCursor: null, hasMore: false },
    });

    const response = await request(app.getHttpServer())
      .get('/api/v1/admin/process-runtime/instances?cursor=opaque')
      .expect(200);

    expect(processInstanceListResponseSchema.parse(response.body).items).toHaveLength(1);
    expect(listInstances).toHaveBeenCalledWith('opaque');
  });

  it('exposes Process Instance detail with its steps', async () => {
    getInstance.mockResolvedValueOnce(processDetail());

    const response = await request(app.getHttpServer())
      .get(`/api/v1/admin/process-runtime/instances/${INSTANCE_ID}`)
      .expect(200);

    expect(processInstanceDetailResponseSchema.parse(response.body).instance.id).toBe(INSTANCE_ID);
    expect(getInstance).toHaveBeenCalledWith(INSTANCE_ID);
  });

  it('validates and delegates Process Instance commands', async () => {
    executeProcessCommand.mockResolvedValueOnce(
      processInstance({
        status: 'RUNNING',
        revision: 2,
        startedAt: '2026-07-28T01:05:00.000Z',
        updatedAt: '2026-07-28T01:05:00.000Z',
      }),
    );

    const response = await request(app.getHttpServer())
      .post(`/api/v1/admin/process-runtime/instances/${INSTANCE_ID}/commands`)
      .send(START_PROCESS_COMMAND)
      .expect(201);

    expect(processInstanceSchema.parse(response.body).revision).toBe(2);
    expect(executeProcessCommand).toHaveBeenCalledWith(INSTANCE_ID, START_PROCESS_COMMAND);
  });

  it('validates and delegates Process Step commands', async () => {
    executeStepCommand.mockResolvedValueOnce(
      processStep({
        status: 'RUNNING',
        revision: 2,
        claimedAt: '2026-07-28T01:05:00.000Z',
        startedAt: '2026-07-28T01:05:00.000Z',
        updatedAt: '2026-07-28T01:05:00.000Z',
      }),
    );

    const response = await request(app.getHttpServer())
      .post(`/api/v1/admin/process-runtime/instances/${INSTANCE_ID}/steps/${STEP_ID}/commands`)
      .send(CLAIM_STEP_COMMAND)
      .expect(201);

    expect(processStepInstanceSchema.parse(response.body).revision).toBe(2);
    expect(executeStepCommand).toHaveBeenCalledWith(INSTANCE_ID, STEP_ID, CLAIM_STEP_COMMAND);
  });

  it('rejects a body outside the shared strict command contract', async () => {
    await request(app.getHttpServer())
      .post(`/api/v1/admin/process-runtime/instances/${INSTANCE_ID}/commands`)
      .send({ ...START_PROCESS_COMMAND, actorUserId: 'request-controlled' })
      .expect(400);
  });
});
