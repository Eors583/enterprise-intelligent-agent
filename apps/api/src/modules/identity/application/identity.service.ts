import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';

import { TenantContext } from '../../../common/context/tenant-context.js';
import type { Tenant, User } from '../domain/identity.models.js';
import { IdentityRepository } from '../domain/identity.repository.js';

@Injectable()
export class IdentityService {
  constructor(
    @Inject(TenantContext) private readonly context: TenantContext,
    @Inject(IdentityRepository) private readonly repository: IdentityRepository,
  ) {}

  async getCurrentIdentity(): Promise<{ tenant: Tenant; user: User }> {
    const principal = this.context.current;
    const [tenant, user] = await Promise.all([
      this.repository.findTenantById(principal.tenantId),
      this.repository.findUserById(principal.tenantId, principal.userId),
    ]);

    if (tenant === null) throw new NotFoundException('Tenant was not found.');
    if (tenant.status !== 'active') {
      throw new ForbiddenException('Tenant is not active.');
    }
    if (user === null) throw new NotFoundException('Current user was not found.');
    if (user.status !== 'active') {
      throw new NotFoundException('Current user is inactive.');
    }
    return { tenant, user };
  }
}
