import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { EnvironmentVariables } from '../../config/environment.js';
import { AgentControlService } from './application/agent-control.service.js';
import { AgentRepository } from './domain/agent.repository.js';
import { DevAgentRepository } from './infrastructure/dev/dev-agent.repository.js';
import { PrismaAgentRepository } from './infrastructure/prisma/prisma-agent.repository.js';
import { DirectoryPersonalAgentProvisioner } from './infrastructure/prisma/directory-personal-agent.provisioner.js';

@Module({
  providers: [
    AgentControlService,
    DevAgentRepository,
    PrismaAgentRepository,
    DirectoryPersonalAgentProvisioner,
    {
      provide: AgentRepository,
      inject: [ConfigService, DevAgentRepository, PrismaAgentRepository],
      useFactory: (
        config: ConfigService<EnvironmentVariables, true>,
        memory: DevAgentRepository,
        prisma: PrismaAgentRepository,
      ): AgentRepository =>
        config.get('REPOSITORY_DRIVER', { infer: true }) === 'prisma' ? prisma : memory,
    },
  ],
  exports: [AgentControlService, AgentRepository, DirectoryPersonalAgentProvisioner],
})
export class AgentControlModule {}
