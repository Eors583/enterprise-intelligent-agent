import { Module } from '@nestjs/common';

import { RuntimeIdentityPort } from '../process-orchestration/application/runtime-identity.port.js';
import { TenantContextRuntimeIdentityAdapter } from '../process-orchestration/application/tenant-context-runtime-identity.adapter.js';
import { BusinessEventController } from './business-event.controller.js';
import { BusinessEventRepository } from './business-event.repository.js';
import { BusinessEventService } from './business-event.service.js';
import { PrismaBusinessEventRepository } from './infrastructure/prisma/prisma-business-event.repository.js';

@Module({
  controllers: [BusinessEventController],
  providers: [
    BusinessEventService,
    PrismaBusinessEventRepository,
    {
      provide: BusinessEventRepository,
      useExisting: PrismaBusinessEventRepository,
    },
    {
      provide: RuntimeIdentityPort,
      useClass: TenantContextRuntimeIdentityAdapter,
    },
  ],
  exports: [BusinessEventService],
})
export class BusinessEventModule {}
