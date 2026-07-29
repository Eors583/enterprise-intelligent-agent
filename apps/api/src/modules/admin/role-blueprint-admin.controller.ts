import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import {
  type CreateRoleBlueprintRequest,
  type CreateRoleVersionDraftRequest,
  type PublishRoleVersionRequest,
  type ReviewRoleVersionRequest,
  type RoleAssignmentCandidateListResponse,
  type RoleBlueprint,
  type RoleBlueprintListResponse,
  type RoleVersion,
  type RoleVersionTransitionRequest,
  type RollbackRoleVersionRequest,
  type UpdateRoleBlueprintRequest,
  type UpdateRoleVersionDraftRequest,
  createRoleBlueprintRequestSchema,
  createRoleVersionDraftRequestSchema,
  publishRoleVersionRequestSchema,
  reviewRoleVersionRequestSchema,
  roleVersionTransitionRequestSchema,
  rollbackRoleVersionRequestSchema,
  updateRoleBlueprintRequestSchema,
  updateRoleVersionDraftRequestSchema,
} from '@enterprise/contracts';

import { SchemaValidationPipe } from '../../common/pipes/schema-validation.pipe.js';
import { RoleBlueprintAdminService } from './role-blueprint-admin.service.js';

@Controller('admin/role-blueprints')
export class RoleBlueprintAdminController {
  constructor(
    @Inject(RoleBlueprintAdminService)
    private readonly blueprints: RoleBlueprintAdminService,
  ) {}

  @Get()
  list(): Promise<RoleBlueprintListResponse> {
    return this.blueprints.list();
  }

  @Get('assignment-candidates')
  listAssignmentCandidates(): Promise<RoleAssignmentCandidateListResponse> {
    return this.blueprints.listAssignmentCandidates();
  }

  @Post()
  create(
    @Body(new SchemaValidationPipe(createRoleBlueprintRequestSchema))
    request: CreateRoleBlueprintRequest,
  ): Promise<RoleBlueprint> {
    return this.blueprints.create(request);
  }

  @Patch(':blueprintId')
  update(
    @Param('blueprintId', new ParseUUIDPipe()) blueprintId: string,
    @Body(new SchemaValidationPipe(updateRoleBlueprintRequestSchema))
    request: UpdateRoleBlueprintRequest,
  ): Promise<RoleBlueprint> {
    return this.blueprints.update(blueprintId, request);
  }

  @Post(':blueprintId/versions')
  createDraft(
    @Param('blueprintId', new ParseUUIDPipe()) blueprintId: string,
    @Body(new SchemaValidationPipe(createRoleVersionDraftRequestSchema))
    request: CreateRoleVersionDraftRequest,
  ): Promise<RoleVersion> {
    return this.blueprints.createDraft(blueprintId, request);
  }

  @Patch(':blueprintId/versions/:versionId')
  updateDraft(
    @Param('blueprintId', new ParseUUIDPipe()) blueprintId: string,
    @Param('versionId', new ParseUUIDPipe()) versionId: string,
    @Body(new SchemaValidationPipe(updateRoleVersionDraftRequestSchema))
    request: UpdateRoleVersionDraftRequest,
  ): Promise<RoleVersion> {
    return this.blueprints.updateDraft(blueprintId, versionId, request);
  }

  @Post(':blueprintId/versions/:versionId/submit')
  submit(
    @Param('blueprintId', new ParseUUIDPipe()) blueprintId: string,
    @Param('versionId', new ParseUUIDPipe()) versionId: string,
    @Body(new SchemaValidationPipe(roleVersionTransitionRequestSchema))
    request: RoleVersionTransitionRequest,
  ): Promise<RoleVersion> {
    return this.blueprints.submit(blueprintId, versionId, request);
  }

  @Post(':blueprintId/versions/:versionId/review')
  review(
    @Param('blueprintId', new ParseUUIDPipe()) blueprintId: string,
    @Param('versionId', new ParseUUIDPipe()) versionId: string,
    @Body(new SchemaValidationPipe(reviewRoleVersionRequestSchema))
    request: ReviewRoleVersionRequest,
  ): Promise<RoleVersion> {
    return this.blueprints.review(blueprintId, versionId, request);
  }

  @Post(':blueprintId/versions/:versionId/publish')
  publish(
    @Param('blueprintId', new ParseUUIDPipe()) blueprintId: string,
    @Param('versionId', new ParseUUIDPipe()) versionId: string,
    @Body(new SchemaValidationPipe(publishRoleVersionRequestSchema))
    request: PublishRoleVersionRequest,
  ): Promise<RoleVersion> {
    return this.blueprints.publish(blueprintId, versionId, request);
  }

  @Post(':blueprintId/versions/:versionId/retire')
  retire(
    @Param('blueprintId', new ParseUUIDPipe()) blueprintId: string,
    @Param('versionId', new ParseUUIDPipe()) versionId: string,
    @Body(new SchemaValidationPipe(roleVersionTransitionRequestSchema))
    request: RoleVersionTransitionRequest,
  ): Promise<RoleVersion> {
    return this.blueprints.retire(blueprintId, versionId, request);
  }

  @Post(':blueprintId/versions/:versionId/rollback')
  rollback(
    @Param('blueprintId', new ParseUUIDPipe()) blueprintId: string,
    @Param('versionId', new ParseUUIDPipe()) versionId: string,
    @Body(new SchemaValidationPipe(rollbackRoleVersionRequestSchema))
    request: RollbackRoleVersionRequest,
  ): Promise<RoleVersion> {
    return this.blueprints.rollback(blueprintId, versionId, request);
  }
}
