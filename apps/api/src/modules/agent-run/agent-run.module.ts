import { Module } from '@nestjs/common';

import { AgentRunWorker } from './application/agent-run.worker.js';
import { AgentRunControlService } from './application/agent-run-control.service.js';
import { IdentityModule } from '../identity/identity.module.js';
import { KnowledgeRetrievalModule } from '../knowledge-retrieval/knowledge-retrieval.module.js';
import { AgentRunQueueRepository } from './domain/agent-run-queue.repository.js';
import { AgentRunRepository } from './domain/agent-run.repository.js';
import { AgentRuntimeClient } from './domain/agent-runtime.client.js';
import { PrismaAgentRunQueueRepository } from './infrastructure/prisma/prisma-agent-run-queue.repository.js';
import { PrismaAgentRunRepository } from './infrastructure/prisma/prisma-agent-run.repository.js';
import { HttpAgentRuntimeClient } from './infrastructure/runtime/http-agent-runtime.client.js';

@Module({
  imports: [IdentityModule, KnowledgeRetrievalModule],
  providers: [
    AgentRunControlService,
    AgentRunWorker,
    PrismaAgentRunQueueRepository,
    PrismaAgentRunRepository,
    HttpAgentRuntimeClient,
    { provide: AgentRunQueueRepository, useExisting: PrismaAgentRunQueueRepository },
    { provide: AgentRunRepository, useExisting: PrismaAgentRunRepository },
    { provide: AgentRuntimeClient, useExisting: HttpAgentRuntimeClient },
  ],
  exports: [AgentRunWorker, AgentRunControlService],
})
export class AgentRunModule {}
