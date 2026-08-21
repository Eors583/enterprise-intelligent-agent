import { Module } from '@nestjs/common';

import { AgentAdminModule } from './agent-admin.module.js';
import { FeishuDirectoryAdminModule } from './feishu-directory-admin.module.js';
import { KnowledgeAdminModule } from './knowledge-admin.module.js';
import { OrganizationAdminModule } from './organization-admin.module.js';
import { RoleAssignmentAdminModule } from './role-assignment-admin.module.js';
import { RoleBlueprintAdminModule } from './role-blueprint-admin.module.js';

@Module({
  imports: [
    OrganizationAdminModule,
    KnowledgeAdminModule,
    AgentAdminModule,
    FeishuDirectoryAdminModule,
    RoleBlueprintAdminModule,
    RoleAssignmentAdminModule,
  ],
})
export class AdminModule {}
