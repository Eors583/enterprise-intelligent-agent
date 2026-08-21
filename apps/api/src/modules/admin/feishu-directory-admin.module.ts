import { Module } from '@nestjs/common';

import { AgentControlModule } from '../agent-control/agent-control.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { AdminAccessModule } from './admin-access.module.js';
import { FeishuDirectorySyncController } from './feishu-directory-sync.controller.js';
import { FeishuDirectorySyncService } from './feishu-directory-sync.service.js';
import { FeishuDirectorySyncWorker } from './feishu-directory-sync.worker.js';
import { FeishuDirectoryClient } from './feishu/feishu-directory.client.js';
import { FeishuCredentialVault } from './feishu/feishu-credential-vault.js';
import { KnowledgeGatewayModule } from '../knowledge-gateway/knowledge-gateway.module.js';

@Module({
  imports: [AuthModule, AgentControlModule, AdminAccessModule, KnowledgeGatewayModule],
  controllers: [FeishuDirectorySyncController],
  providers: [
    FeishuDirectoryClient,
    FeishuCredentialVault,
    FeishuDirectorySyncService,
    FeishuDirectorySyncWorker,
  ],
})
export class FeishuDirectoryAdminModule {}
