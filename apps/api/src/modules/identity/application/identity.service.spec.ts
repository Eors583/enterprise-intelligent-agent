import { ForbiddenException } from '@nestjs/common';

import type { TenantContext } from '../../../common/context/tenant-context.js';
import type { Tenant, User } from '../domain/identity.models.js';
import { IdentityRepository } from '../domain/identity.repository.js';
import { IdentityService } from './identity.service.js';

const TENANT_ID = '00000000-0000-7000-8000-000000000001';
const USER_ID = '00000000-0000-7000-8000-000000000101';

class StubIdentityRepository extends IdentityRepository {
  constructor(private readonly tenant: Tenant) {
    super();
  }

  async findTenantById(): Promise<Tenant> {
    return this.tenant;
  }

  async findUserById(): Promise<User> {
    return {
      id: USER_ID,
      tenantId: TENANT_ID,
      name: '测试成员',
      status: 'active',
    };
  }
}

function serviceFor(status: Tenant['status']): IdentityService {
  const context = {
    current: {
      tenantId: TENANT_ID,
      userId: USER_ID,
      authenticationSource: 'development-header',
    },
  } as TenantContext;
  return new IdentityService(
    context,
    new StubIdentityRepository({ id: TENANT_ID, name: '测试租户', status }),
  );
}

describe('IdentityService tenant lifecycle', () => {
  it('allows an active tenant', async () => {
    await expect(serviceFor('active').getCurrentIdentity()).resolves.toMatchObject({
      tenant: { status: 'active' },
      user: { id: USER_ID },
    });
  });

  it.each(['suspended', 'archived'] as const)('rejects a %s tenant', async (status) => {
    await expect(serviceFor(status).getCurrentIdentity()).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});
