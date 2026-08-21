import { Module } from '@nestjs/common';

import {
  EmployeeAiUsageController,
  EmployeeExperienceController,
  EmployeeExperienceSourceController,
} from './employee-insights.controller.js';
import { EmployeeInsightsRepository } from './employee-insights.repository.js';
import { EmployeeInsightsService } from './employee-insights.service.js';
import { PrismaEmployeeInsightsRepository } from './infrastructure/prisma-employee-insights.repository.js';
import { MemoryExperienceModule } from '../memory-experience/memory-experience.module.js';
import { RuntimeIdentityPort } from '../process-orchestration/application/runtime-identity.port.js';
import { TenantContextRuntimeIdentityAdapter } from '../process-orchestration/application/tenant-context-runtime-identity.adapter.js';

@Module({
  imports: [MemoryExperienceModule],
  controllers: [
    EmployeeExperienceController,
    EmployeeExperienceSourceController,
    EmployeeAiUsageController,
  ],
  providers: [
    EmployeeInsightsService,
    PrismaEmployeeInsightsRepository,
    {
      provide: EmployeeInsightsRepository,
      useExisting: PrismaEmployeeInsightsRepository,
    },
    {
      provide: RuntimeIdentityPort,
      useClass: TenantContextRuntimeIdentityAdapter,
    },
  ],
})
export class EmployeeInsightsModule {}
