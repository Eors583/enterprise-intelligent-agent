import { describe, expect, it } from 'vitest';

import {
  SCIM_BULK_MAX_OPERATIONS,
  SCIM_BULK_MAX_PAYLOAD_BYTES,
  scimBulkRequestSchema,
  scimBulkResponseSchema,
} from '../src/index.js';

const user = {
  schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
  userName: 'person@example.test',
  displayName: 'Example Person',
  active: true,
};

describe('SCIM Bulk contracts', () => {
  it('models bounded RFC-style request and per-operation response documents', () => {
    expect(SCIM_BULK_MAX_OPERATIONS).toBe(100);
    expect(SCIM_BULK_MAX_PAYLOAD_BYTES).toBeGreaterThanOrEqual(64 * 1024);

    const request = scimBulkRequestSchema.parse({
      schemas: ['urn:ietf:params:scim:api:messages:2.0:BulkRequest'],
      failOnErrors: 1,
      Operations: [{ method: 'POST', bulkId: 'employee-1', path: '/Users', data: user }],
    });
    expect(request.Operations[0]).toMatchObject({
      method: 'POST',
      bulkId: 'employee-1',
      path: '/Users',
    });

    expect(
      scimBulkResponseSchema.parse({
        schemas: ['urn:ietf:params:scim:api:messages:2.0:BulkResponse'],
        Operations: [
          {
            method: 'POST',
            bulkId: 'employee-1',
            status: '409',
            response: {
              schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
              status: '409',
              scimType: 'uniqueness',
              detail: 'SCIM user already exists.',
            },
          },
        ],
      }).Operations[0]?.status,
    ).toBe('409');
  });

  it('rejects ambiguous POST operations and invalid DELETE payloads', () => {
    expect(() =>
      scimBulkRequestSchema.parse({
        schemas: ['urn:ietf:params:scim:api:messages:2.0:BulkRequest'],
        Operations: [{ method: 'POST', path: '/Users', data: user }],
      }),
    ).toThrow();
    expect(() =>
      scimBulkRequestSchema.parse({
        schemas: ['urn:ietf:params:scim:api:messages:2.0:BulkRequest'],
        Operations: [{ method: 'DELETE', path: '/Users/user-1', data: {} }],
      }),
    ).toThrow();
  });
});
