import { ForbiddenException } from '@nestjs/common';

import type { TenantContext } from '../../common/context/tenant-context.js';
import { AuthorizationService } from './authorization.service.js';

const TENANT_ID = '00000000-0000-7000-8000-000000000001';
const USER_ID = '00000000-0000-7000-8000-000000000101';

function service(): AuthorizationService {
  return new AuthorizationService({
    current: {
      tenantId: TENANT_ID,
      userId: USER_ID,
      authenticationSource: 'development-header',
    },
  } as TenantContext);
}

describe('AuthorizationService tenant boundary', () => {
  it('allows the current tenant and rejects a different tenant', () => {
    expect(() => service().assertTenantAccess(TENANT_ID)).not.toThrow();
    expect(() => service().assertTenantAccess('00000000-0000-7000-8000-000000000009')).toThrow(
      ForbiddenException,
    );
  });
});
