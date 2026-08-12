import { Module } from '@nestjs/common';

import { PrismaMemoryExperienceAuthorizationAdapter } from './infrastructure/prisma/prisma-memory-experience-authorization.adapter.js';
import { PrismaExperienceKnowledgeProjectionAdapter } from './infrastructure/prisma/prisma-experience-knowledge-projection.adapter.js';
import { PrismaMemoryExperienceRepository } from './infrastructure/prisma/prisma-memory-experience.repository.js';
import {
  ExperienceAdminController,
  MemoryWorkbenchController,
} from './memory-experience.controller.js';
import { MemoryExperienceAuthorizationPort } from './memory-experience-authorization.port.js';
import { ExperienceKnowledgeProjectionPort } from './experience-knowledge-projection.port.js';
import { MemoryExperienceRepository } from './memory-experience.repository.js';
import { MemoryExperienceService } from './memory-experience.service.js';
import { KnowledgeGatewayModule } from '../knowledge-gateway/knowledge-gateway.module.js';
import { RuntimeIdentityPort } from '../process-orchestration/application/runtime-identity.port.js';
import { TenantContextRuntimeIdentityAdapter } from '../process-orchestration/application/tenant-context-runtime-identity.adapter.js';

@Module({
  imports: [KnowledgeGatewayModule],
  controllers: [ExperienceAdminController, MemoryWorkbenchController],
  providers: [
    MemoryExperienceService,
    PrismaExperienceKnowledgeProjectionAdapter,
    PrismaMemoryExperienceRepository,
    PrismaMemoryExperienceAuthorizationAdapter,
    {
      provide: MemoryExperienceRepository,
      useExisting: PrismaMemoryExperienceRepository,
    },
    {
      provide: MemoryExperienceAuthorizationPort,
      useExisting: PrismaMemoryExperienceAuthorizationAdapter,
    },
    {
      provide: ExperienceKnowledgeProjectionPort,
      useExisting: PrismaExperienceKnowledgeProjectionAdapter,
    },
    {
      provide: RuntimeIdentityPort,
      useClass: TenantContextRuntimeIdentityAdapter,
    },
  ],
  exports: [
    MemoryExperienceService,
    MemoryExperienceRepository,
    MemoryExperienceAuthorizationPort,
    ExperienceKnowledgeProjectionPort,
  ],
})
export class MemoryExperienceModule {}
