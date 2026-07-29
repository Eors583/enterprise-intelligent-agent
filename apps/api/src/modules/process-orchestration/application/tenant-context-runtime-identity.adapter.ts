import { Inject, Injectable } from '@nestjs/common';

import { TenantContext } from '../../../common/context/tenant-context.js';
import { RuntimeIdentityPort, type TrustedRuntimePrincipal } from './runtime-identity.port.js';

@Injectable()
export class TenantContextRuntimeIdentityAdapter extends RuntimeIdentityPort {
  constructor(@Inject(TenantContext) private readonly context: TenantContext) {
    super();
  }

  current(): TrustedRuntimePrincipal {
    const principal = this.context.current;
    return {
      tenantId: principal.tenantId,
      userId: principal.userId,
      tenantRole: principal.role,
      authenticationSource: principal.authenticationSource,
    };
  }
}
