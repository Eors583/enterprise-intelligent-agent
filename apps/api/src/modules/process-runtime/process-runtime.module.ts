import { Module } from '@nestjs/common';

import { RuntimeIdentityPort } from '../process-orchestration/application/runtime-identity.port.js';
import { TenantContextRuntimeIdentityAdapter } from '../process-orchestration/application/tenant-context-runtime-identity.adapter.js';
import { PrismaProcessRuntimeAuthorizationAdapter } from './infrastructure/prisma/prisma-process-runtime-authorization.adapter.js';
import { PrismaProcessRuntimeRepository } from './infrastructure/prisma/prisma-process-runtime.repository.js';
import { ProcessRuntimeController } from './process-runtime.controller.js';
import { ProcessRuntimeAuthorizationPort } from './process-runtime-authorization.port.js';
import { ProcessRuntimeRepository } from './process-runtime.repository.js';
import { ProcessRuntimeService } from './process-runtime.service.js';

@Module({
  controllers: [ProcessRuntimeController],
  providers: [
    ProcessRuntimeService,
    PrismaProcessRuntimeRepository,
    PrismaProcessRuntimeAuthorizationAdapter,
    {
      provide: ProcessRuntimeRepository,
      useExisting: PrismaProcessRuntimeRepository,
    },
    {
      provide: ProcessRuntimeAuthorizationPort,
      useExisting: PrismaProcessRuntimeAuthorizationAdapter,
    },
    {
      provide: RuntimeIdentityPort,
      useClass: TenantContextRuntimeIdentityAdapter,
    },
  ],
  exports: [ProcessRuntimeService],
})
export class ProcessRuntimeModule {}
