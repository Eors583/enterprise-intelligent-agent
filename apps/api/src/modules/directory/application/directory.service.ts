import { Inject, Injectable } from '@nestjs/common';

import { TenantContext } from '../../../common/context/tenant-context.js';
import type { Department, DirectoryMember } from '../domain/directory.models.js';
import { DirectoryRepository } from '../domain/directory.repository.js';

@Injectable()
export class DirectoryService {
  constructor(
    @Inject(TenantContext) private readonly context: TenantContext,
    @Inject(DirectoryRepository)
    private readonly repository: DirectoryRepository,
  ) {}

  async getDirectory(): Promise<{
    departments: readonly Department[];
    members: readonly DirectoryMember[];
  }> {
    const { tenantId } = this.context.current;
    const [departments, members] = await Promise.all([
      this.repository.listDepartments(tenantId),
      this.repository.listMembers(tenantId),
    ]);
    return { departments, members };
  }
}
