import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { ScimController } from './scim.controller.js';
import { ScimService } from './scim.service.js';

const bearer = `ea_scim_${'a'.repeat(40)}`;

describe('ScimController HTTP protocol', () => {
  let app: INestApplication;
  const service = {
    bulk: vi.fn(),
    listUsers: vi.fn(),
  };

  beforeEach(async () => {
    service.bulk.mockReset().mockResolvedValue({
      schemas: ['urn:ietf:params:scim:api:messages:2.0:BulkResponse'],
      Operations: [{ method: 'POST', bulkId: 'employee-1', status: '201' }],
    });
    service.listUsers.mockReset().mockResolvedValue({
      schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
      totalResults: 0,
      startIndex: 1,
      itemsPerPage: 0,
      Resources: [],
    });
    const module = await Test.createTestingModule({
      controllers: [ScimController],
      providers: [{ provide: ScimService, useValue: service }],
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('advertises bounded Bulk and allowlisted sorting with the SCIM media type', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/scim/v2/corporate/ServiceProviderConfig')
      .expect(200)
      .expect('content-type', /application\/scim\+json/);

    expect(response.body).toMatchObject({
      bulk: { supported: true, maxOperations: 100, maxPayloadSize: 98_304 },
      sort: { supported: true },
      changePassword: { supported: false },
    });
  });

  it('returns standard SCIM errors and never reflects request or credential material', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/scim/v2/corporate/Users')
      .set('x-request-id', 'must-not-be-reflected')
      .expect(401)
      .expect('content-type', /application\/scim\+json/);

    expect(response.body).toEqual({
      schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
      status: '401',
      detail: 'SCIM bearer capability is required.',
    });
    expect(JSON.stringify(response.body)).not.toContain('must-not-be-reflected');
  });

  it('accepts an idempotent Bulk document and preserves opaque authorization', async () => {
    const body = {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:BulkRequest'],
      Operations: [
        {
          method: 'POST',
          bulkId: 'employee-1',
          path: '/Users',
          data: {
            schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
            userName: 'person@example.test',
            displayName: 'Example Person',
          },
        },
      ],
    };
    await request(app.getHttpServer())
      .post('/api/v1/scim/v2/corporate/Bulk')
      .set('authorization', `bearer ${bearer}`)
      .set('idempotency-key', 'bulk-controller-request-0001')
      .send(body)
      .expect(200)
      .expect('content-type', /application\/scim\+json/);

    expect(service.bulk).toHaveBeenCalledWith(
      'corporate',
      {
        bearer,
        requestId: 'scim-request',
        idempotencyKey: 'bulk-controller-request-0001',
      },
      body,
    );
  });

  it('rejects overlong idempotency headers instead of silently truncating them', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/scim/v2/corporate/Bulk')
      .set('authorization', `Bearer ${bearer}`)
      .set('idempotency-key', 'x'.repeat(201))
      .send({
        schemas: ['urn:ietf:params:scim:api:messages:2.0:BulkRequest'],
        Operations: [],
      })
      .expect(400)
      .expect('content-type', /application\/scim\+json/);

    expect(response.body).toMatchObject({
      status: '400',
      scimType: 'invalidValue',
    });
    expect(service.bulk).not.toHaveBeenCalled();
  });
});
