import { Module } from '@nestjs/common';

import { AdminAccessModule } from './admin-access.module.js';
import { RoleAssignmentAdminController } from './role-assignment-admin.controller.js';
import { RoleAssignmentAdminService } from './role-assignment-admin.service.js';
import { RoleAssignmentLifecycleService } from './role-assignment-lifecycle.service.js';

@Module({
  imports: [AdminAccessModule],
  controllers: [RoleAssignmentAdminController],
  providers: [RoleAssignmentAdminService, RoleAssignmentLifecycleService],
  exports: [RoleAssignmentLifecycleService],
})
export class RoleAssignmentAdminModule {}
