import { Module } from '@nestjs/common';

import { AiEvaluationModule } from '../ai-evaluation/ai-evaluation.module.js';
import { AdminAccessModule } from './admin-access.module.js';
import { RoleBlueprintAdminController } from './role-blueprint-admin.controller.js';
import { RoleBlueprintAdminService } from './role-blueprint-admin.service.js';
import { KnowledgeGatewayModule } from '../knowledge-gateway/knowledge-gateway.module.js';

@Module({
  imports: [AdminAccessModule, AiEvaluationModule, KnowledgeGatewayModule],
  controllers: [RoleBlueprintAdminController],
  providers: [RoleBlueprintAdminService],
})
export class RoleBlueprintAdminModule {}
