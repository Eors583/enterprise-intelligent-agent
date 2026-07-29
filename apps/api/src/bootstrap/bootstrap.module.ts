import { Module } from '@nestjs/common';

import { AgentControlModule } from '../modules/agent-control/agent-control.module.js';
import { AgentOperationalReadinessModule } from '../modules/ai-safety-model-routing/agent-operational-readiness.module.js';
import { AuthorizationModule } from '../modules/authorization/authorization.module.js';
import { DirectoryModule } from '../modules/directory/directory.module.js';
import { IdentityModule } from '../modules/identity/identity.module.js';
import { BootstrapController } from './bootstrap.controller.js';
import { BootstrapService } from './bootstrap.service.js';

@Module({
  imports: [
    IdentityModule,
    DirectoryModule,
    AuthorizationModule,
    AgentControlModule,
    AgentOperationalReadinessModule,
  ],
  controllers: [BootstrapController],
  providers: [BootstrapService],
})
export class BootstrapModule {}
