import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { EnvironmentVariables } from '../../config/environment.js';
import { RuntimeIdentityPort } from '../process-orchestration/application/runtime-identity.port.js';
import { TenantContextRuntimeIdentityAdapter } from '../process-orchestration/application/tenant-context-runtime-identity.adapter.js';
import { ToolExecutionCircuitBreaker } from './application/tool-execution-circuit-breaker.js';
import { ToolExecutionWorker } from './application/tool-execution.worker.js';
import { ToolReconciliationStatusService } from './application/tool-reconciliation-status.service.js';
import { ToolReconciliationWorker } from './application/tool-reconciliation.worker.js';
import { ToolExecutionQueueRepository } from './domain/tool-execution-queue.repository.js';
import { ToolExecutionRepository } from './domain/tool-execution.repository.js';
import { ToolReconciliationQueueRepository } from './domain/tool-reconciliation-queue.repository.js';
import { ToolReconciliationRepository } from './domain/tool-reconciliation.repository.js';
import { ConfigToolEndpointResolver } from './infrastructure/config/config-tool-endpoint.resolver.js';
import { ConfiguredToolDnsResolver } from './infrastructure/dns/configured-tool-dns.resolver.js';
import { PinnedHttpToolProviderDispatcher } from './infrastructure/http/pinned-http-tool-provider.dispatcher.js';
import { PrismaToolExecutionQueueRepository } from './infrastructure/prisma/prisma-tool-execution-queue.repository.js';
import { PrismaToolExecutionRepository } from './infrastructure/prisma/prisma-tool-execution.repository.js';
import { PrismaToolGatewayRepository } from './infrastructure/prisma/prisma-tool-gateway.repository.js';
import { PrismaToolReconciliationQueueRepository } from './infrastructure/prisma/prisma-tool-reconciliation-queue.repository.js';
import { PrismaToolReconciliationRepository } from './infrastructure/prisma/prisma-tool-reconciliation.repository.js';
import {
  ToolDnsResolverPort,
  ToolEndpointResolverPort,
  ToolProviderDispatcherPort,
} from './tool-execution.port.js';
import {
  AdminToolGatewayController,
  WorkbenchAvailableToolsController,
  WorkbenchToolApprovalsController,
  WorkbenchToolGatewayController,
  WorkbenchToolReconciliationController,
} from './tool-gateway.controller.js';
import { ToolGatewayRepository } from './tool-gateway.repository.js';
import { ToolGatewayService } from './tool-gateway.service.js';

@Module({
  controllers: [
    AdminToolGatewayController,
    WorkbenchAvailableToolsController,
    WorkbenchToolApprovalsController,
    WorkbenchToolGatewayController,
    WorkbenchToolReconciliationController,
  ],
  providers: [
    ToolGatewayService,
    ToolReconciliationStatusService,
    ToolExecutionWorker,
    ToolReconciliationWorker,
    PrismaToolGatewayRepository,
    PrismaToolExecutionRepository,
    PrismaToolExecutionQueueRepository,
    PrismaToolReconciliationRepository,
    PrismaToolReconciliationQueueRepository,
    ConfigToolEndpointResolver,
    ConfiguredToolDnsResolver,
    PinnedHttpToolProviderDispatcher,
    {
      provide: ToolGatewayRepository,
      useExisting: PrismaToolGatewayRepository,
    },
    {
      provide: ToolExecutionRepository,
      useExisting: PrismaToolExecutionRepository,
    },
    {
      provide: ToolExecutionQueueRepository,
      useExisting: PrismaToolExecutionQueueRepository,
    },
    {
      provide: ToolReconciliationRepository,
      useExisting: PrismaToolReconciliationRepository,
    },
    {
      provide: ToolReconciliationQueueRepository,
      useExisting: PrismaToolReconciliationQueueRepository,
    },
    {
      provide: ToolEndpointResolverPort,
      useExisting: ConfigToolEndpointResolver,
    },
    {
      provide: ToolDnsResolverPort,
      useExisting: ConfiguredToolDnsResolver,
    },
    {
      provide: ToolProviderDispatcherPort,
      useExisting: PinnedHttpToolProviderDispatcher,
    },
    {
      provide: ToolExecutionCircuitBreaker,
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvironmentVariables, true>) =>
        new ToolExecutionCircuitBreaker(
          config.get('TOOL_CIRCUIT_FAILURE_THRESHOLD', { infer: true }),
          config.get('TOOL_CIRCUIT_OPEN_MS', { infer: true }),
        ),
    },
    {
      provide: RuntimeIdentityPort,
      useClass: TenantContextRuntimeIdentityAdapter,
    },
  ],
  exports: [ToolGatewayService],
})
export class ToolGatewayModule {}
