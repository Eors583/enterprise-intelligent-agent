import { Module } from '@nestjs/common';

import { AgentAdminModule } from './agent-admin.module.js';
import { FeishuDirectoryAdminModule } from './feishu-directory-admin.module.js';
import { KnowledgeAdminModule } from './knowledge-admin.module.js';
import { OrganizationAdminModule } from './organization-admin.module.js';

@Module({
  imports: [
    OrganizationAdminModule,
    KnowledgeAdminModule,
    AgentAdminModule,
    FeishuDirectoryAdminModule,
  ],
})
export class AdminModule {}
