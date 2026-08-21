import { Controller, Get, Inject } from '@nestjs/common';
import type { RoleAssignmentListResponse } from '@enterprise/contracts';

import { MyRoleAssignmentService } from './my-role-assignment.service.js';

@Controller('role-assignments')
export class MyRoleAssignmentController {
  constructor(
    @Inject(MyRoleAssignmentService)
    private readonly assignments: MyRoleAssignmentService,
  ) {}

  @Get('me')
  listMine(): Promise<RoleAssignmentListResponse> {
    return this.assignments.listMine();
  }
}
