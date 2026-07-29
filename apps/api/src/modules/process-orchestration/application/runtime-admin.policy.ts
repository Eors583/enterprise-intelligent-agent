import { ForbiddenException } from '@nestjs/common';

import type { TrustedRuntimePrincipal } from './runtime-identity.port.js';

export function requireRuntimeAdministrator(principal: TrustedRuntimePrincipal): void {
  if (principal.tenantRole !== 'OWNER' && principal.tenantRole !== 'ADMIN') {
    throw new ForbiddenException('Runtime governance requires an owner or administrator account.');
  }
}
