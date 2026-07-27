import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { AdminAccessModule } from './admin-access.module.js';
import { OrganizationAdminController } from './organization-admin.controller.js';
import { OrganizationAdminService } from './organization-admin.service.js';
import { MemberInvitationService } from './member-invitation.service.js';

@Module({
  imports: [AuthModule, AdminAccessModule],
  controllers: [OrganizationAdminController],
  providers: [OrganizationAdminService, MemberInvitationService],
})
export class OrganizationAdminModule {}
