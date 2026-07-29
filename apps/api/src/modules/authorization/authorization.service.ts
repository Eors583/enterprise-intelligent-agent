import { Inject, Injectable } from '@nestjs/common';

import { TenantContext } from '../../common/context/tenant-context.js';
import { AuthorizationDecisionService } from './authorization-decision.service.js';
import type { AuthorizationDecision, CurrentAuthorizationInput } from './authorization.types.js';

/** Request-principal adapter over the explicit, auditable decision contract. */
@Injectable()
export class AuthorizationService {
  constructor(
    @Inject(TenantContext) private readonly context: TenantContext,
    @Inject(AuthorizationDecisionService)
    private readonly decisions: AuthorizationDecisionService,
  ) {}

  assertTenantAccess(resourceTenantId: string): void {
    this.requireCurrent({
      action: 'tenant.read',
      resourceTenantId,
      risk: 'LOW',
    });
  }

  decideCurrent(input: CurrentAuthorizationInput): AuthorizationDecision {
    const principal = this.context.current;
    return this.decisions.decide({
      ...input,
      tenantId: principal.tenantId,
      userId: principal.userId,
      tenantRole: principal.role ?? 'MEMBER',
    });
  }

  requireCurrent(input: CurrentAuthorizationInput): AuthorizationDecision {
    const principal = this.context.current;
    return this.decisions.require({
      ...input,
      tenantId: principal.tenantId,
      userId: principal.userId,
      tenantRole: principal.role ?? 'MEMBER',
    });
  }
}
