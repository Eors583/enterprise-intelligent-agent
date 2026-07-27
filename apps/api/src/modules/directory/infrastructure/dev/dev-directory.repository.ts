import { Injectable } from '@nestjs/common';

import type { Department, DirectoryMember } from '../../domain/directory.models.js';
import { DirectoryRepository } from '../../domain/directory.repository.js';

const TENANT_ID = '00000000-0000-7000-8000-000000000001';
const PRODUCT_DEPARTMENT_ID = '00000000-0000-7000-8000-000000000201';
const ENGINEERING_DEPARTMENT_ID = '00000000-0000-7000-8000-000000000202';
const PEOPLE_DEPARTMENT_ID = '00000000-0000-7000-8000-000000000203';

/** Development seed adapter. It is never the production system of record. */
@Injectable()
export class DevDirectoryRepository extends DirectoryRepository {
  private readonly departments: readonly Department[] = [
    {
      id: PRODUCT_DEPARTMENT_ID,
      tenantId: TENANT_ID,
      name: '产品中心',
      parentId: null,
      memberCount: 1,
    },
    {
      id: ENGINEERING_DEPARTMENT_ID,
      tenantId: TENANT_ID,
      name: '研发中心',
      parentId: null,
      memberCount: 1,
    },
    {
      id: PEOPLE_DEPARTMENT_ID,
      tenantId: TENANT_ID,
      name: '组织与人才',
      parentId: null,
      memberCount: 1,
    },
  ];

  private readonly members: readonly DirectoryMember[] = [
    {
      id: '00000000-0000-7000-8000-000000000101',
      tenantId: TENANT_ID,
      name: '林晓',
      title: '产品负责人',
      departmentIds: [PRODUCT_DEPARTMENT_ID],
      avatarUrl: 'https://api.dicebear.com/9.x/initials/svg?seed=LX',
      status: 'active',
    },
    {
      id: '00000000-0000-7000-8000-000000000102',
      tenantId: TENANT_ID,
      name: '周睿',
      title: '后端工程师',
      departmentIds: [ENGINEERING_DEPARTMENT_ID],
      avatarUrl: 'https://api.dicebear.com/9.x/initials/svg?seed=ZR',
      status: 'active',
    },
    {
      id: '00000000-0000-7000-8000-000000000103',
      tenantId: TENANT_ID,
      name: '陈瑶',
      title: '人力资源伙伴',
      departmentIds: [PEOPLE_DEPARTMENT_ID],
      status: 'active',
    },
  ];

  async listDepartments(tenantId: string): Promise<readonly Department[]> {
    return this.departments.filter((department) => department.tenantId === tenantId);
  }

  async listMembers(tenantId: string): Promise<readonly DirectoryMember[]> {
    return this.members.filter((member) => member.tenantId === tenantId);
  }
}
