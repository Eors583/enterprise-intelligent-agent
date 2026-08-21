import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import {
  type CreateRoleAssignmentRequest,
  type RevokeRoleAssignmentRequest,
  type RoleAssignment,
  type RoleAssignmentListResponse,
  type RoleAssignmentReconcileResponse,
  createRoleAssignmentRequestSchema,
  revokeRoleAssignmentRequestSchema,
} from '@enterprise/contracts';

import { SchemaValidationPipe } from '../../common/pipes/schema-validation.pipe.js';
import { AdminAccessService } from './admin-access.service.js';
import { RoleAssignmentAdminService } from './role-assignment-admin.service.js';
import { RoleAssignmentLifecycleService } from './role-assignment-lifecycle.service.js';

@Controller('admin/role-assignments')
export class RoleAssignmentAdminController {
  constructor(
    @Inject(RoleAssignmentAdminService)
    private readonly assignments: RoleAssignmentAdminService,
    @Inject(RoleAssignmentLifecycleService)
    private readonly lifecycle: RoleAssignmentLifecycleService,
    @Inject(AdminAccessService)
    private readonly access: AdminAccessService,
  ) {}

  @Get()
  list(): Promise<RoleAssignmentListResponse> {
    return this.assignments.list();
  }

  @Post()
  create(
    @Body(new SchemaValidationPipe(createRoleAssignmentRequestSchema))
    request: CreateRoleAssignmentRequest,
  ): Promise<RoleAssignment> {
    return this.assignments.create(request);
  }

  @Post('reconcile')
  reconcile(): Promise<RoleAssignmentReconcileResponse> {
    const principal = this.access.requireDirectoryWrite();
    return this.lifecycle.reconcileTenant(principal.tenantId);
  }

  @Post(':id/revoke')
  revoke(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new SchemaValidationPipe(revokeRoleAssignmentRequestSchema))
    request: RevokeRoleAssignmentRequest,
  ): Promise<RoleAssignment> {
    return this.assignments.revoke(id, request);
  }
}
