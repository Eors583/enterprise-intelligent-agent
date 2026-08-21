import { Module } from '@nestjs/common';

import { AgentRunWorker } from './application/agent-run.worker.js';
import { AgentRunControlService } from './application/agent-run-control.service.js';
import { AgentRunStreamService } from './application/agent-run-stream.service.js';
import { AuthorizationModule } from '../authorization/authorization.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { KnowledgeGatewayModule } from '../knowledge-gateway/knowledge-gateway.module.js';
import { PeopleOrganizationModule } from '../people-organization/people-organization.module.js';
import { AgentRunQueueRepository } from './domain/agent-run-queue.repository.js';
import { AgentRunRepository } from './domain/agent-run.repository.js';
import { AgentRunStreamRepository } from './domain/agent-run-stream.repository.js';
import { AgentRuntimeClient } from './domain/agent-runtime.client.js';
import { PrismaAgentRunQueueRepository } from './infrastructure/prisma/prisma-agent-run-queue.repository.js';
import { PrismaAgentRunRepository } from './infrastructure/prisma/prisma-agent-run.repository.js';
import { PrismaAgentRunStreamRepository } from './infrastructure/prisma/prisma-agent-run-stream.repository.js';
import { HttpAgentRuntimeClient } from './infrastructure/runtime/http-agent-runtime.client.js';

@Module({
  imports: [AuthorizationModule, IdentityModule, KnowledgeGatewayModule, PeopleOrganizationModule],
  providers: [
    AgentRunControlService,
    AgentRunStreamService,
    AgentRunWorker,
    PrismaAgentRunQueueRepository,
    PrismaAgentRunRepository,
    PrismaAgentRunStreamRepository,
    HttpAgentRuntimeClient,
    { provide: AgentRunQueueRepository, useExisting: PrismaAgentRunQueueRepository },
    { provide: AgentRunRepository, useExisting: PrismaAgentRunRepository },
    { provide: AgentRunStreamRepository, useExisting: PrismaAgentRunStreamRepository },
    { provide: AgentRuntimeClient, useExisting: HttpAgentRuntimeClient },
  ],
  exports: [
    AgentRunWorker,
    AgentRunControlService,
    AgentRunStreamService,
    AgentRunRepository,
    AgentRuntimeClient,
  ],
})
export class AgentRunModule {}
