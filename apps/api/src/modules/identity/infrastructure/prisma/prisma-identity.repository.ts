import { Inject, Injectable } from '@nestjs/common';

import { PrismaService } from '../../../../database/prisma.service.js';
import type { Tenant, User } from '../../domain/identity.models.js';
import { IdentityRepository } from '../../domain/identity.repository.js';

@Injectable()
export class PrismaIdentityRepository extends IdentityRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {
    super();
  }

  findTenantById(tenantId: string): Promise<Tenant | null> {
    return this.prisma.withTenant(tenantId, async (transaction) => {
      const tenant = await transaction.tenant.findUnique({
        where: { id: tenantId },
        select: { id: true, name: true, status: true },
      });
      if (tenant === null) return null;
      return {
        id: tenant.id,
        name: tenant.name,
        status: {
          ACTIVE: 'active' as const,
          SUSPENDED: 'suspended' as const,
          ARCHIVED: 'archived' as const,
        }[tenant.status],
      };
    });
  }

  findUserById(tenantId: string, userId: string): Promise<User | null> {
    return this.prisma.withTenant(tenantId, async (transaction) => {
      const user = await transaction.user.findFirst({
        where: { id: userId, tenantId },
        include: {
          employments: {
            where: { tenantId, status: 'ACTIVE' },
            include: { position: true },
            orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
            take: 1,
          },
        },
      });
      if (user === null) return null;

      const title = user.employments[0]?.position?.name;
      return {
        id: user.id,
        tenantId: user.tenantId,
        name: user.displayName,
        ...(title === undefined ? {} : { title }),
        ...(user.avatarUrl === null ? {} : { avatarUrl: user.avatarUrl }),
        status: user.status === 'ACTIVE' ? 'active' : 'inactive',
      };
    });
  }
}
