import { Module } from '@nestjs/common';

import { RuntimeIdentityPort } from '../process-orchestration/application/runtime-identity.port.js';
import { TenantContextRuntimeIdentityAdapter } from '../process-orchestration/application/tenant-context-runtime-identity.adapter.js';
import { CollaborationCorrectionController } from './collaboration-correction.controller.js';
import { CollaborationCorrectionAuthorizationPort } from './collaboration-correction-authorization.port.js';
import { CollaborationCorrectionRepository } from './collaboration-correction.repository.js';
import { CollaborationCorrectionService } from './collaboration-correction.service.js';
import { PrismaCollaborationCorrectionAuthorizationAdapter } from './infrastructure/prisma/prisma-collaboration-correction-authorization.adapter.js';
import { PrismaCollaborationCorrectionRepository } from './infrastructure/prisma/prisma-collaboration-correction.repository.js';

@Module({
  controllers: [CollaborationCorrectionController],
  providers: [
    CollaborationCorrectionService,
    PrismaCollaborationCorrectionRepository,
    PrismaCollaborationCorrectionAuthorizationAdapter,
    {
      provide: CollaborationCorrectionRepository,
      useExisting: PrismaCollaborationCorrectionRepository,
    },
    {
      provide: CollaborationCorrectionAuthorizationPort,
      useExisting: PrismaCollaborationCorrectionAuthorizationAdapter,
    },
    {
      provide: RuntimeIdentityPort,
      useClass: TenantContextRuntimeIdentityAdapter,
    },
  ],
  exports: [CollaborationCorrectionService],
})
export class CollaborationCorrectionModule {}
