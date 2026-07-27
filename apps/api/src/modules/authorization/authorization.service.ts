import { ForbiddenException, Inject, Injectable } from '@nestjs/common';

import { TenantContext } from '../../common/context/tenant-context.js';

/** Initial policy seam; replace checks with the OpenFGA-backed adapter. */
@Injectable()
export class AuthorizationService {
  constructor(@Inject(TenantContext) private readonly context: TenantContext) {}

  assertTenantAccess(resourceTenantId: string): void {
    if (this.context.current.tenantId !== resourceTenantId) {
      throw new ForbiddenException('Cross-tenant access is forbidden.');
    }
  }
}
