import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import type { ScimUser } from '@enterprise/contracts';
import type { Request } from 'express';

import type { EnvironmentVariables } from '../../config/environment.js';
import {
  InvalidScimCapabilityError,
  type ScimCapability,
  type ScimPrismaService,
} from '../../database/scim-prisma.service.js';
import { ScimController } from './scim.controller.js';
import { ScimHttpException } from './scim.errors.js';
import { ScimService } from './scim.service.js';

const tenantId = '00000000-0000-7000-8000-00000000c001';
const connectorId = '00000000-0000-7000-8000-00000000c101';
const serviceTokenId = '00000000-0000-7000-8000-00000000c201';
const localUserId = '00000000-0000-7000-8000-00000000c301';
const scimRowId = '00000000-0000-7000-8000-00000000c401';
const bearer = `ea_scim_${'a'.repeat(40)}`;
const etag = 'b'.repeat(64);

describe('ScimService capability and tenant boundary', () => {
  it('maps an invalid bearer capability to 401 and missing scope to 403', async () => {
    const invalid = createService({
      withToken: vi.fn().mockRejectedValue(new InvalidScimCapabilityError()),
    });
    const invalidError = await captureScimError(invalid.listUsers('corporate', identity(), {}));
    expect(invalidError.getStatus()).toBe(401);

    const noScope = createService(
      scopedPrisma({ $queryRaw: vi.fn() }, { scopes: ['scim.groups.read'] }),
    );
    const scopeError = await captureScimError(noScope.listUsers('corporate', identity(), {}));
    expect(scopeError.getStatus()).toBe(403);
    expect(scopeError.message).toContain('required scope');
  });

  it('normalizes an exact filter and binds every list query to tenant and connector', async () => {
    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce([{ count: 1n }])
      .mockResolvedValueOnce([
        {
          ...userRow(),
          attributes: {
            title: 'Engineer',
            password: 'legacy-secret-must-not-be-returned',
            profile: { Password: 'legacy-nested-secret', locale: 'zh-CN' },
          },
        },
      ]);
    const withToken = scopedPrisma({ $queryRaw: queryRaw });
    const service = createService(withToken);

    const result = await service.listUsers('corporate', identity(), {
      filter: 'userName eq "PERSON@EXAMPLE.TEST"',
      startIndex: '1',
      count: '25',
      sortBy: 'displayName',
      sortOrder: 'descending',
    });

    expect(result).toMatchObject({
      totalResults: 1,
      startIndex: 1,
      itemsPerPage: 1,
      Resources: [
        {
          id: 'scim-user-1',
          userName: 'person@example.test',
          active: true,
          title: 'Engineer',
          profile: { locale: 'zh-CN' },
        },
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(/password|legacy-secret/i);
    const capabilityCall = withToken.withToken.mock.calls[0];
    expect(capabilityCall?.[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(capabilityCall?.[0]).not.toContain(bearer);
    expect(capabilityCall?.[1]).toBe('corporate');
    for (const [query] of queryRaw.mock.calls as Array<[Prisma.Sql]>) {
      expect(query.strings.join(' ')).toContain('"tenant_id" =');
      expect(query.strings.join(' ')).toContain('"connector_id" =');
      expect(query.values).toEqual(
        expect.arrayContaining([tenantId, connectorId, 'person@example.test']),
      );
      expect(query.values).not.toContain('00000000-0000-7000-8000-00000000ffff');
    }
    expect((queryRaw.mock.calls[1]?.[0] as Prisma.Sql).strings.join(' ')).toContain(
      'ORDER BY "display_name" DESC NULLS LAST',
    );
  });

  it('rejects unsupported filter grammar and sort injection before touching the database', () => {
    const prisma = { withToken: vi.fn() };
    const service = createService(prisma);
    expect(() =>
      service.listUsers('corporate', identity(), {
        filter: 'userName co "example"',
      }),
    ).toThrow(ScimHttpException);
    expect(() =>
      service.listUsers('corporate', identity(), {
        sortBy: 'displayName"; DROP TABLE users; --',
        sortOrder: 'ascending',
      }),
    ).toThrow(ScimHttpException);
    expect(() =>
      service.listUsers('corporate', identity(), {
        sortOrder: 'descending',
      }),
    ).toThrow(ScimHttpException);
    expect(prisma.withToken).not.toHaveBeenCalled();
  });

  it('fails closed on password provisioning without touching persistence', () => {
    const prisma = { withToken: vi.fn() };
    const service = createService(prisma);
    const userInput = {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
      userName: 'person@example.test',
      displayName: 'Example Person',
      password: 'must-never-be-stored',
    };

    for (const invoke of [
      () => service.createUser('corporate', identity(), userInput),
      () =>
        service.replaceUser('corporate', 'scim-user-1', identity({ ifMatch: `W/"${etag}"` }), {
          ...userInput,
          profile: { Password: 'nested-secret' },
        }),
      () =>
        service.patchUser('corporate', 'scim-user-1', identity(), {
          schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
          Operations: [{ op: 'replace', path: 'password', value: 'secret' }],
        }),
    ]) {
      expect(invoke).toThrowError(
        expect.objectContaining({
          scimType: 'mutability',
          message: expect.stringMatching(/invitation|SSO/i),
        }),
      );
    }
    expect(prisma.withToken).not.toHaveBeenCalled();
  });

  it('requires a matching weak ETag for mutation and drives active=false deprovisioning', async () => {
    const missingIfMatch = createService(
      scopedPrisma({ $queryRaw: vi.fn().mockResolvedValue([userRow()]) }),
    );
    const required = await captureScimError(
      missingIfMatch.patchUser('corporate', 'scim-user-1', identity(), deactivatePatch()),
    );
    expect(required.getStatus()).toBe(428);

    const wrongIfMatch = createService(
      scopedPrisma({ $queryRaw: vi.fn().mockResolvedValue([userRow()]) }),
    );
    const stale = await captureScimError(
      wrongIfMatch.patchUser(
        'corporate',
        'scim-user-1',
        identity({ ifMatch: `W/"${'c'.repeat(64)}"` }),
        deactivatePatch(),
      ),
    );
    expect(stale.getStatus()).toBe(412);

    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce([userRow()])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          ...userRow(),
          active: false,
          resource_version: 2n,
          etag: 'd'.repeat(64),
          last_modified_at: new Date('2026-07-28T09:00:00.000Z'),
        },
      ]);
    const executeRaw = vi.fn().mockResolvedValue(1);
    const service = createService(scopedPrisma({ $queryRaw: queryRaw, $executeRaw: executeRaw }));
    const deprovisioned = await service.patchUser(
      'corporate',
      'scim-user-1',
      identity({ ifMatch: `W/"${etag}"` }),
      deactivatePatch(),
    );

    expect(deprovisioned.active).toBe(false);
    expect(deprovisioned.meta.version).toBe(`W/"${'d'.repeat(64)}"`);
    const statements = executeRaw.mock.calls.map(([strings]) =>
      (strings as TemplateStringsArray).join(' '),
    );
    expect(statements.some((sql) => sql.includes('UPDATE public."users"'))).toBe(true);
    const scimUpdate = queryRaw.mock.calls[2]?.[0] as TemplateStringsArray;
    expect(scimUpdate.join(' ')).toContain('UPDATE public."scim_users"');
    expect(queryRaw.mock.calls[2]).toEqual(expect.arrayContaining([tenantId, connectorId, false]));
  });
});

describe('ScimService Bulk protocol', () => {
  it('authorizes all scopes up front and returns explicit per-operation results', async () => {
    const prisma = scopedPrisma({}, { scopes: ['scim.users.write', 'scim.groups.write'] });
    const service = createService(prisma);
    const createUser = vi.spyOn(service, 'createUser').mockResolvedValue(scimUserResource());
    const patchUser = vi
      .spyOn(service, 'patchUser')
      .mockRejectedValue(
        new ScimHttpException(412, 'SCIM resource ETag does not match.', 'mutability'),
      );

    const result = await service.bulk(
      'corporate',
      identity({ idempotencyKey: 'bulk-request-0001' }),
      {
        schemas: ['urn:ietf:params:scim:api:messages:2.0:BulkRequest'],
        Operations: [
          {
            method: 'POST',
            bulkId: 'employee-1',
            path: '/Users',
            data: scimUserInput(),
          },
          {
            method: 'PATCH',
            path: '/Users/scim-user-1',
            version: `W/"${etag}"`,
            data: deactivatePatch(),
          },
        ],
      },
    );

    expect(result).toMatchObject({
      schemas: ['urn:ietf:params:scim:api:messages:2.0:BulkResponse'],
      Operations: [
        {
          method: 'POST',
          bulkId: 'employee-1',
          status: '201',
          location: '/api/v1/scim/v2/corporate/Users/scim-user-1',
        },
        {
          method: 'PATCH',
          status: '412',
          response: {
            schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
            status: '412',
            scimType: 'mutability',
          },
        },
      ],
    });
    expect(prisma.withToken).toHaveBeenCalledWith(
      expect.stringMatching(/^[0-9a-f]{64}$/),
      'corporate',
      expect.any(Function),
    );
    const createIdentity = createUser.mock.calls[0]?.[1];
    const patchIdentity = patchUser.mock.calls[0]?.[2];
    expect(createIdentity?.idempotencyKey).toMatch(/^bulk:[0-9a-f]{64}$/);
    expect(patchIdentity?.idempotencyKey).toMatch(/^bulk:[0-9a-f]{64}$/);
    expect(createIdentity?.idempotencyKey).not.toBe(patchIdentity?.idempotencyKey);
    expect(createIdentity?.bearer).toBe(bearer);
  });

  it('marks every unprocessed operation after failOnErrors instead of hiding partial success', async () => {
    const service = createService(scopedPrisma({}, { scopes: ['scim.users.write'] }));
    const createUser = vi
      .spyOn(service, 'createUser')
      .mockRejectedValueOnce(new ScimHttpException(409, 'Duplicate user.', 'uniqueness'));

    const result = await service.bulk(
      'corporate',
      identity({ idempotencyKey: 'bulk-request-0002' }),
      {
        schemas: ['urn:ietf:params:scim:api:messages:2.0:BulkRequest'],
        failOnErrors: 1,
        Operations: [1, 2, 3].map((index) => ({
          method: 'POST',
          bulkId: `employee-${String(index)}`,
          path: '/Users',
          data: {
            ...scimUserInput(),
            userName: `person-${String(index)}@example.test`,
          },
        })),
      },
    );

    expect(result.Operations.map((operation) => operation.status)).toEqual(['409', '424', '424']);
    expect(createUser).toHaveBeenCalledTimes(1);
    expect(result.Operations[2]?.response).toMatchObject({
      status: '424',
      detail: expect.stringMatching(/failOnErrors/),
    });
  });

  it('rejects unsafe bulkId references, passwords, and missing idempotency before authorization', async () => {
    const prisma = { withToken: vi.fn() };
    const service = createService(prisma);
    const request = {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:BulkRequest'],
      Operations: [
        {
          method: 'POST',
          bulkId: 'group-1',
          path: '/Groups',
          data: {
            schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
            displayName: 'Example Group',
            members: [{ value: 'bulkId:employee-1' }],
          },
        },
      ],
    };

    expect(
      await captureScimError(
        service.bulk('corporate', identity({ idempotencyKey: 'bulk-request-0003' }), request),
      ),
    ).toMatchObject({ scimType: 'invalidValue' });
    expect(
      await captureScimError(
        service.bulk('corporate', identity({ idempotencyKey: 'bulk-request-0004' }), {
          ...request,
          Operations: [
            {
              method: 'POST',
              bulkId: 'employee-1',
              path: '/Users',
              data: { ...scimUserInput(), password: 'never-store-this' },
            },
          ],
        }),
      ),
    ).toMatchObject({ scimType: 'mutability' });
    expect(
      await captureScimError(
        service.bulk('corporate', identity(), {
          ...request,
          Operations: [
            {
              method: 'POST',
              bulkId: 'employee-1',
              path: '/Users',
              data: scimUserInput(),
            },
          ],
        }),
      ),
    ).toMatchObject({ scimType: 'invalidValue' });
    expect(prisma.withToken).not.toHaveBeenCalled();
  });

  it('fails the whole bulk preflight when a capability lacks any requested scope', async () => {
    const service = createService(scopedPrisma({}, { scopes: ['scim.users.write'] }));
    const createUser = vi.spyOn(service, 'createUser');
    const createGroup = vi.spyOn(service, 'createGroup');
    const error = await captureScimError(
      service.bulk('corporate', identity({ idempotencyKey: 'bulk-request-0005' }), {
        schemas: ['urn:ietf:params:scim:api:messages:2.0:BulkRequest'],
        Operations: [
          {
            method: 'POST',
            bulkId: 'employee-1',
            path: '/Users',
            data: scimUserInput(),
          },
          {
            method: 'POST',
            bulkId: 'group-1',
            path: '/Groups',
            data: {
              schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
              displayName: 'Example Group',
              members: [],
            },
          },
        ],
      }),
    );
    expect(error.getStatus()).toBe(403);
    expect(createUser).not.toHaveBeenCalled();
    expect(createGroup).not.toHaveBeenCalled();
  });
});

describe('ScimController bearer parsing', () => {
  it('rejects malformed Authorization and passes only the opaque token to the service', async () => {
    const listUsers = vi.fn().mockResolvedValue({ Resources: [] });
    const controller = new ScimController({ listUsers } as unknown as ScimService);

    expect(() =>
      controller.listUsers(
        'corporate',
        requestWithHeaders({ authorization: 'Bearer raw-token' }),
        {},
      ),
    ).toThrow(ScimHttpException);

    await controller.listUsers(
      'corporate',
      requestWithHeaders({
        authorization: `Bearer ${bearer}`,
        'idempotency-key': 'request-idempotency-key',
      }),
      {},
    );
    expect(listUsers).toHaveBeenCalledWith(
      'corporate',
      {
        bearer,
        requestId: 'request-123',
        idempotencyKey: 'request-idempotency-key',
      },
      {},
    );
  });
});

function createService(prisma: { withToken: ReturnType<typeof vi.fn> }): ScimService {
  return new ScimService(
    prisma as unknown as ScimPrismaService,
    new ConfigService<EnvironmentVariables, true>({
      AUTH_TOKEN_PEPPER: 'scim-unit-test-pepper',
    } as EnvironmentVariables),
  );
}

function scopedPrisma(
  transaction: object,
  overrides?: Partial<ScimCapability>,
): { withToken: ReturnType<typeof vi.fn> } {
  const capability: ScimCapability = {
    serviceTokenId,
    tenantId,
    connectorId,
    connectorKey: 'corporate',
    scopes: ['scim.users.read', 'scim.users.write'],
    allowUserCreate: true,
    allowGroupCreate: true,
    deactivateUserOnDisable: true,
    ...overrides,
  };
  return {
    withToken: vi.fn(
      async (
        _tokenHash: string,
        _connectorKey: string,
        operation: (value: object, scopedCapability: ScimCapability) => Promise<unknown>,
      ) => operation(transaction, capability),
    ),
  };
}

function identity(
  overrides?: Partial<{
    bearer: string;
    requestId: string;
    idempotencyKey: string;
    ifMatch: string;
  }>,
) {
  return {
    bearer,
    requestId: 'request-123',
    ...overrides,
  };
}

function userRow() {
  return {
    id: scimRowId,
    tenant_id: tenantId,
    connector_id: connectorId,
    scim_id: 'scim-user-1',
    external_id: 'employee-1',
    user_id: localUserId,
    user_name_normalized: 'person@example.test',
    display_name: 'Example Person',
    active: true,
    attributes: {},
    resource_version: 1n,
    etag,
    last_modified_at: new Date('2026-07-28T08:00:00.000Z'),
    created_at: new Date('2026-07-28T08:00:00.000Z'),
  };
}

function deactivatePatch() {
  return {
    schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
    Operations: [{ op: 'replace', path: 'active', value: false }],
  };
}

function scimUserInput() {
  return {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
    userName: 'person@example.test',
    displayName: 'Example Person',
    active: true,
  };
}

function scimUserResource(): ScimUser {
  return {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
    userName: 'person@example.test',
    displayName: 'Example Person',
    active: true,
    id: 'scim-user-1',
    meta: {
      resourceType: 'User',
      created: '2026-07-28T08:00:00.000Z',
      lastModified: '2026-07-28T08:00:00.000Z',
      version: `W/"${etag}"`,
      location: '/api/v1/scim/v2/corporate/Users/scim-user-1',
    },
  };
}

async function captureScimError(promise: Promise<unknown>): Promise<ScimHttpException> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ScimHttpException);
    return error as ScimHttpException;
  }
  throw new Error('Expected a SCIM error.');
}

function requestWithHeaders(headers: Readonly<Record<string, string>>): Request {
  return {
    requestId: 'request-123',
    header: (name: string) => headers[name.toLowerCase()],
  } as unknown as Request;
}
