import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { AdminAccessModule } from './admin-access.module.js';
import { OrganizationAdminController } from './organization-admin.controller.js';
import { OrganizationAdminService } from './organization-admin.service.js';
import { MemberInvitationService } from './member-invitation.service.js';
import { KnowledgeGatewayModule } from '../knowledge-gateway/knowledge-gateway.module.js';

@Module({
  imports: [AuthModule, AdminAccessModule, KnowledgeGatewayModule],
  controllers: [OrganizationAdminController],
  providers: [OrganizationAdminService, MemberInvitationService],
})
export class OrganizationAdminModule {}
