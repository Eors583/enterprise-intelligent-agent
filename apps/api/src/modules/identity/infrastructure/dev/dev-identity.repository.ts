import { Injectable } from '@nestjs/common';

import type { Tenant, User } from '../../domain/identity.models.js';
import { IdentityRepository } from '../../domain/identity.repository.js';

/**
 * Development-only adapter used to exercise the first vertical slice without a
 * database. Replace this provider with a Prisma repository before shared use.
 */
@Injectable()
export class DevIdentityRepository extends IdentityRepository {
  private readonly tenants: readonly Tenant[] = [
    {
      id: '00000000-0000-7000-8000-000000000001',
      name: '未来协作科技',
      status: 'active',
    },
  ];

  private readonly users: readonly User[] = [
    {
      id: '00000000-0000-7000-8000-000000000101',
      tenantId: '00000000-0000-7000-8000-000000000001',
      name: '林晓',
      title: '产品负责人',
      avatarUrl: 'https://api.dicebear.com/9.x/initials/svg?seed=LX',
      status: 'active',
    },
    {
      id: '00000000-0000-7000-8000-000000000102',
      tenantId: '00000000-0000-7000-8000-000000000001',
      name: '周睿',
      title: '后端工程师',
      avatarUrl: 'https://api.dicebear.com/9.x/initials/svg?seed=ZR',
      status: 'active',
    },
    {
      id: '00000000-0000-7000-8000-000000000103',
      tenantId: '00000000-0000-7000-8000-000000000001',
      name: '陈瑶',
      title: '人力资源伙伴',
      status: 'active',
    },
  ];

  async findTenantById(tenantId: string): Promise<Tenant | null> {
    return this.tenants.find((tenant) => tenant.id === tenantId) ?? null;
  }

  async findUserById(tenantId: string, userId: string): Promise<User | null> {
    return this.users.find((user) => user.tenantId === tenantId && user.id === userId) ?? null;
  }
}
