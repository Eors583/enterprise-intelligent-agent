import { Inject, Injectable } from '@nestjs/common';

import { PrismaService } from '../../../../database/prisma.service.js';
import type { Department, DirectoryMember } from '../../domain/directory.models.js';
import { DirectoryRepository } from '../../domain/directory.repository.js';

@Injectable()
export class PrismaDirectoryRepository extends DirectoryRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {
    super();
  }

  listDepartments(tenantId: string): Promise<readonly Department[]> {
    return this.prisma.withTenant(tenantId, async (transaction) => {
      const departments = await transaction.orgUnit.findMany({
        where: { tenantId, status: 'ACTIVE' },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        include: {
          _count: {
            select: { employments: { where: { tenantId, status: 'ACTIVE' } } },
          },
        },
      });
      return departments.map((department) => ({
        id: department.id,
        tenantId: department.tenantId,
        name: department.name,
        parentId: department.parentId,
        memberCount: department._count.employments,
      }));
    });
  }

  listMembers(tenantId: string): Promise<readonly DirectoryMember[]> {
    return this.prisma.withTenant(tenantId, async (transaction) => {
      const users = await transaction.user.findMany({
        where: { tenantId },
        orderBy: { displayName: 'asc' },
        include: {
          employments: {
            where: { tenantId, status: 'ACTIVE' },
            include: { position: true },
            orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
          },
        },
      });

      return users.map((user) => {
        const title = user.employments.find((employment) => employment.position !== null)?.position
          ?.name;
        return {
          id: user.id,
          tenantId: user.tenantId,
          name: user.displayName,
          title: title ?? '成员',
          departmentIds: [...new Set(user.employments.map((employment) => employment.orgUnitId))],
          ...(user.avatarUrl === null ? {} : { avatarUrl: user.avatarUrl }),
          status: user.status === 'ACTIVE' ? 'active' : 'inactive',
        };
      });
    });
  }
}
