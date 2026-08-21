import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { roleAssignmentListResponseSchema } from '@enterprise/contracts';
import request from 'supertest';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';

import { MyRoleAssignmentController } from './my-role-assignment.controller.js';
import { MyRoleAssignmentService } from './my-role-assignment.service.js';

describe('MyRoleAssignmentController', () => {
  let app: INestApplication;
  const listMine = vi.fn();

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [MyRoleAssignmentController],
      providers: [{ provide: MyRoleAssignmentService, useValue: { listMine } }],
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
  });

  afterAll(async () => app.close());

  it('exposes the current employee read-only assignment endpoint', async () => {
    listMine.mockResolvedValueOnce({ items: [] });

    const response = await request(app.getHttpServer())
      .get('/api/v1/role-assignments/me')
      .expect(200);

    expect(roleAssignmentListResponseSchema.parse(response.body)).toEqual({ items: [] });
    expect(listMine).toHaveBeenCalledOnce();
  });

  it('does not expose a write route on the employee controller', async () => {
    await request(app.getHttpServer()).post('/api/v1/role-assignments/me').send({}).expect(404);
  });
});
