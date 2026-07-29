import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { IdentityGovernanceAdminController } from '../identity-governance/identity-governance-admin.controller.js';
import { IdentityGovernanceAdminService } from '../identity-governance/identity-governance-admin.service.js';
import { FeishuDirectorySyncController } from './feishu-directory-sync.controller.js';
import { FeishuDirectorySyncService } from './feishu-directory-sync.service.js';

describe('nullable admin response wire contract', () => {
  let app: INestApplication;
  const getCurrentPreview = vi.fn().mockResolvedValue(null);
  const getPolicy = vi.fn().mockResolvedValue(null);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [FeishuDirectorySyncController, IdentityGovernanceAdminController],
      providers: [
        {
          provide: FeishuDirectorySyncService,
          useValue: { getCurrentPreview },
        },
        {
          provide: IdentityGovernanceAdminService,
          useValue: { getPolicy },
        },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use((incomingRequest: Request, _response: Response, next: NextFunction) => {
      incomingRequest.authPrincipal = {
        sessionId: '00000000-0000-7000-8000-000000000003',
        tenantId: '00000000-0000-7000-8000-000000000001',
        tenantSlug: 'nullable-wire',
        tenantName: 'Nullable Wire',
        userId: '00000000-0000-7000-8000-000000000002',
        email: 'owner@nullable-wire.test',
        displayName: 'Nullable Owner',
        role: 'OWNER',
        passwordChangeRequired: false,
        accessExpiresAt: '2026-07-29T12:00:00.000Z',
        refreshExpiresAt: '2026-08-29T12:00:00.000Z',
        authenticationSource: 'session',
      };
      next();
    });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('serializes an absent Feishu preview as an explicit JSON null', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/admin/integrations/feishu/organization-sync/preview')
      .expect(200)
      .expect('Content-Type', /application\/json/);

    expect(response.text).toBe('null');
    expect(response.body).toBeNull();
  });

  it('serializes an absent identity policy as an explicit JSON null', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/admin/identity-governance/policy')
      .expect(200)
      .expect('Content-Type', /application\/json/);

    expect(response.text).toBe('null');
    expect(response.body).toBeNull();
  });
});
