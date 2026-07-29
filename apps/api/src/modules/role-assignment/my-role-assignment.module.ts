import { Module } from '@nestjs/common';

import { IdentityModule } from '../identity/identity.module.js';
import { MyRoleAssignmentController } from './my-role-assignment.controller.js';
import { MyRoleAssignmentService } from './my-role-assignment.service.js';

@Module({
  imports: [IdentityModule],
  controllers: [MyRoleAssignmentController],
  providers: [MyRoleAssignmentService],
  exports: [MyRoleAssignmentService],
})
export class MyRoleAssignmentModule {}
