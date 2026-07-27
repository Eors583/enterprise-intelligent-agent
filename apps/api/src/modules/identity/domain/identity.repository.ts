import type { Tenant, User } from './identity.models.js';

export abstract class IdentityRepository {
  abstract findTenantById(tenantId: string): Promise<Tenant | null>;
  abstract findUserById(tenantId: string, userId: string): Promise<User | null>;
}
