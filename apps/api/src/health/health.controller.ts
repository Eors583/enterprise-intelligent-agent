import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { EnvironmentVariables } from '../config/environment.js';
import { PrismaService } from '../database/prisma.service.js';
import {
  apiOpenTelemetryStatus,
  type ApiOpenTelemetryStatus,
} from '../observability/opentelemetry.js';
import {
  KnowledgeIngestionAvailabilityService,
  type KnowledgeIngestionReadinessStatus,
} from '../modules/knowledge-ingestion/application/knowledge-ingestion-availability.service.js';

@Controller('health')
export class HealthController {
  constructor(
    @Inject(ConfigService)
    private readonly config: ConfigService<EnvironmentVariables, true>,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(KnowledgeIngestionAvailabilityService)
    private readonly knowledgeIngestion: KnowledgeIngestionAvailabilityService,
  ) {}

  @Get('live')
  live(): { status: 'ok'; timestamp: string } {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }

  @Get('ready')
  async ready(): Promise<{
    status: 'ready';
    checks: {
      repository: 'up';
      adapter: 'memory' | 'prisma';
      aiRuntime: 'up' | 'disabled';
      knowledgeIngestion: KnowledgeIngestionReadinessStatus;
      toolExecution: 'enabled' | 'disabled';
      feishuDirectorySync: 'enabled' | 'disabled';
      openTelemetry: 'up' | 'disabled';
    };
    timestamp: string;
  }> {
    const adapter = this.config.get('REPOSITORY_DRIVER', { infer: true });
    try {
      await this.prisma.ping();
    } catch {
      throw new ServiceUnavailableException('Database readiness check failed.');
    }
    const agentWorkerEnabled = this.config.get('AGENT_RUN_WORKER_ENABLED', { infer: true });
    const toolExecutionWorkerEnabled = this.config.get('TOOL_EXECUTION_WORKER_ENABLED', {
      infer: true,
    });
    const feishuDirectorySyncWorkerEnabled = this.config.get('FEISHU_SYNC_WORKER_ENABLED', {
      infer: true,
    });
    if (agentWorkerEnabled) await this.assertAiRuntimeReady();
    const knowledgeIngestion = this.knowledgeIngestion.readinessStatus();
    const telemetry = apiOpenTelemetryStatus();
    const telemetryReady = isOpenTelemetryReady(telemetry);
    if (telemetry.required && !telemetryReady) {
      throw new ServiceUnavailableException('OpenTelemetry readiness check failed.');
    }
    return {
      status: 'ready',
      checks: {
        repository: 'up',
        adapter,
        aiRuntime: agentWorkerEnabled ? 'up' : 'disabled',
        knowledgeIngestion,
        toolExecution: toolExecutionWorkerEnabled ? 'enabled' : 'disabled',
        feishuDirectorySync: feishuDirectorySyncWorkerEnabled ? 'enabled' : 'disabled',
        openTelemetry: telemetryReady ? 'up' : 'disabled',
      },
      timestamp: new Date().toISOString(),
    };
  }

  private async assertAiRuntimeReady(): Promise<void> {
    const runtimeUrl = this.config.get('AI_RUNTIME_URL', { infer: true });
    const configuredTimeout = this.config.get('AI_RUNTIME_HTTP_TIMEOUT_MS', { infer: true });
    const readinessTimeout = Math.min(configuredTimeout, 3_000);
    try {
      const response = await fetch(new URL('/health/ready', runtimeUrl), {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(readinessTimeout),
      });
      if (!response.ok) throw new Error('AI Runtime readiness endpoint is not ready.');
      const body: unknown = await response.json();
      if (!isReadyRuntimeResponse(body)) {
        throw new Error('AI Runtime returned an invalid readiness response.');
      }
    } catch {
      // The public health response deliberately does not expose upstream URLs,
      // response bodies, or provider diagnostics.
      throw new ServiceUnavailableException('AI Runtime readiness check failed.');
    }
  }
}

function isOpenTelemetryReady(telemetry: ApiOpenTelemetryStatus): boolean {
  return (
    telemetry.state === 'started' &&
    !telemetry.signals.trace.stale &&
    telemetry.signals.trace.failureCode === null &&
    !telemetry.signals.metric.stale &&
    telemetry.signals.metric.failureCode === null
  );
}

function isReadyRuntimeResponse(value: unknown): boolean {
  return (
    typeof value === 'object' && value !== null && 'status' in value && value.status === 'ready'
  );
}
