import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  createMemberRequestSchema,
  createOrgUnitRequestSchema,
  inviteMemberRequestSchema,
  resetMemberPasswordRequestSchema,
  type AdminMember,
  type AdminOrganizationResponse,
  type AdminOrgUnit,
  type CreateMemberRequest,
  type CreateOrgUnitRequest,
  type InviteMemberRequest,
  type IssueMemberInvitationResponse,
  type MemberInvitation,
  type ResetMemberPasswordRequest,
  type ResetMemberPasswordResponse,
  type UpdateMemberRequest,
  type UpdateOrganizationRequest,
  type UpdateOrgUnitRequest,
  updateMemberRequestSchema,
  updateOrganizationRequestSchema,
  updateOrgUnitRequestSchema,
} from '@enterprise/contracts';

import { SchemaValidationPipe } from '../../common/pipes/schema-validation.pipe.js';
import { OrganizationAdminService } from './organization-admin.service.js';
import { MemberInvitationService } from './member-invitation.service.js';

@Controller('admin')
export class OrganizationAdminController {
  constructor(
    @Inject(OrganizationAdminService)
    private readonly organization: OrganizationAdminService,
    @Inject(MemberInvitationService)
    private readonly invitations: MemberInvitationService,
  ) {}

  @Get('organization')
  getOrganization(): Promise<AdminOrganizationResponse> {
    return this.organization.getOrganization();
  }

  @Patch('organization')
  updateOrganization(
    @Body(new SchemaValidationPipe(updateOrganizationRequestSchema))
    request: UpdateOrganizationRequest,
  ): Promise<AdminOrganizationResponse['organization']> {
    return this.organization.updateOrganization(request);
  }

  @Post('org-units')
  createOrgUnit(
    @Body(new SchemaValidationPipe(createOrgUnitRequestSchema)) request: CreateOrgUnitRequest,
  ): Promise<AdminOrgUnit> {
    return this.organization.createOrgUnit(request);
  }

  @Patch('org-units/:id')
  updateOrgUnit(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new SchemaValidationPipe(updateOrgUnitRequestSchema)) request: UpdateOrgUnitRequest,
  ): Promise<AdminOrgUnit> {
    return this.organization.updateOrgUnit(id, request);
  }

  @Delete('org-units/:id')
  archiveOrgUnit(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query('expectedVersion', new ParseIntPipe()) expectedVersion: number,
  ): Promise<AdminOrgUnit> {
    return this.organization.archiveOrgUnit(id, expectedVersion);
  }

  @Post('members')
  createMember(
    @Body(new SchemaValidationPipe(createMemberRequestSchema)) request: CreateMemberRequest,
  ): Promise<AdminMember> {
    return this.organization.createMember(request);
  }

  @Get('member-invitations')
  listMemberInvitations(): Promise<ReadonlyArray<MemberInvitation>> {
    return this.invitations.list();
  }

  @Post('member-invitations')
  inviteMember(
    @Body(new SchemaValidationPipe(inviteMemberRequestSchema)) request: InviteMemberRequest,
  ): Promise<IssueMemberInvitationResponse> {
    return this.invitations.invite(request);
  }

  @Post('members/:id/invitation')
  @HttpCode(HttpStatus.OK)
  issueDirectoryMemberInvitation(
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<IssueMemberInvitationResponse> {
    return this.invitations.issueForDirectoryMember(id);
  }

  @Post('members/:id/invitation/resend')
  @HttpCode(HttpStatus.OK)
  resendMemberInvitation(
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<IssueMemberInvitationResponse> {
    return this.invitations.resend(id);
  }

  @Patch('members/:id')
  updateMember(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new SchemaValidationPipe(updateMemberRequestSchema)) request: UpdateMemberRequest,
  ): Promise<AdminMember> {
    return this.organization.updateMember(id, request);
  }

  @Post('members/:id/reset-password')
  @HttpCode(HttpStatus.OK)
  resetMemberPassword(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new SchemaValidationPipe(resetMemberPasswordRequestSchema))
    request: ResetMemberPasswordRequest,
  ): Promise<ResetMemberPasswordResponse> {
    return this.organization.resetMemberPassword(id, request);
  }
}
