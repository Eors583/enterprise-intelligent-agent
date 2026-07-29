import { Module } from '@nestjs/common';

import { AiEvaluationModule } from '../ai-evaluation/ai-evaluation.module.js';
import { AdminAccessModule } from './admin-access.module.js';
import { RoleBlueprintAdminController } from './role-blueprint-admin.controller.js';
import { RoleBlueprintAdminService } from './role-blueprint-admin.service.js';

@Module({
  imports: [AdminAccessModule, AiEvaluationModule],
  controllers: [RoleBlueprintAdminController],
  providers: [RoleBlueprintAdminService],
})
export class RoleBlueprintAdminModule {}
