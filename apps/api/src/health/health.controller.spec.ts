import { ServiceUnavailableException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as openTelemetry from '../observability/opentelemetry.js';
import type { ApiOpenTelemetryStatus } from '../observability/opentelemetry.js';
import { HealthController } from './health.controller.js';

function controller(input?: {
  workerEnabled?: boolean;
  ping?: () => Promise<void>;
  knowledgeReadiness?: () => 'up' | 'disabled' | 'not_required';
}): HealthController {
  const values = {
    REPOSITORY_DRIVER: 'prisma',
    AGENT_RUN_WORKER_ENABLED: input?.workerEnabled ?? true,
    TOOL_EXECUTION_WORKER_ENABLED: true,
    FEISHU_SYNC_WORKER_ENABLED: true,
    AI_RUNTIME_URL: 'http://127.0.0.1:8100',
    AI_RUNTIME_HTTP_TIMEOUT_MS: 90_000,
  } as const;
  const config = {
    get: (key: keyof typeof values): (typeof values)[keyof typeof values] => values[key],
  };
  const prisma = { ping: input?.ping ?? (async () => undefined) };
  const knowledgeIngestion = {
    readinessStatus: input?.knowledgeReadiness ?? (() => 'up' as const),
  };
  return new HealthController(config as never, prisma as never, knowledgeIngestion as never);
}

describe('HealthController readiness', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('does not claim readiness when the enabled AI Runtime is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection refused')));

    await expect(controller().ready()).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('requires a valid ready response from the enabled AI Runtime', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ status: 'not_ready' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    await expect(controller().ready()).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('reports both dependencies when the AI Runtime is ready', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: 'ready' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(controller().ready()).resolves.toMatchObject({
      status: 'ready',
      checks: {
        repository: 'up',
        adapter: 'prisma',
        aiRuntime: 'up',
        knowledgeIngestion: 'up',
        toolExecution: 'enabled',
        feishuDirectorySync: 'enabled',
        openTelemetry: 'disabled',
      },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      new URL('http://127.0.0.1:8100/health/ready'),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('makes the AI dependency explicit when the worker is disabled', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(controller({ workerEnabled: false }).ready()).resolves.toMatchObject({
      checks: {
        repository: 'up',
        adapter: 'prisma',
        aiRuntime: 'disabled',
        knowledgeIngestion: 'up',
        toolExecution: 'enabled',
        feishuDirectorySync: 'enabled',
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails readiness when production knowledge writes have no healthy consumer', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      controller({
        workerEnabled: false,
        knowledgeReadiness: () => {
          throw new ServiceUnavailableException('Knowledge ingestion consumer unavailable.');
        },
      }).ready(),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails before checking the runtime when the repository is unavailable', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      controller({ ping: async () => Promise.reject(new Error('database unavailable')) }).ready(),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails closed when required telemetry could not start against its collector', async () => {
    vi.spyOn(openTelemetry, 'apiOpenTelemetryStatus').mockReturnValue(
      telemetryStatus({
        state: 'failed',
        required: true,
        failureCode: 'OTEL_SDK_START_FAILED',
      }),
    );

    await expect(controller({ workerEnabled: false }).ready()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('does not let a healthy metric signal hide a required trace export failure', async () => {
    vi.spyOn(openTelemetry, 'apiOpenTelemetryStatus').mockReturnValue(
      telemetryStatus({
        required: true,
        signals: {
          trace: {
            lastExportAttemptAt: '2026-07-29T00:01:00.000Z',
            lastSuccessfulExportAt: '2026-07-29T00:00:30.000Z',
            consecutiveExportFailures: 1,
            failureCode: 'OTEL_EXPORT_FAILED',
            stale: false,
          },
          metric: healthySignal(),
        },
      }),
    );

    await expect(controller({ workerEnabled: false }).ready()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('does not let a healthy trace signal hide a required stale metric signal', async () => {
    vi.spyOn(openTelemetry, 'apiOpenTelemetryStatus').mockReturnValue(
      telemetryStatus({
        required: true,
        signals: {
          trace: healthySignal(),
          metric: {
            lastExportAttemptAt: '2026-07-29T00:00:00.000Z',
            lastSuccessfulExportAt: '2026-07-29T00:00:00.000Z',
            consecutiveExportFailures: 0,
            failureCode: null,
            stale: true,
          },
        },
      }),
    );

    await expect(controller({ workerEnabled: false }).ready()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('reports telemetry up only when both independent signals are healthy', async () => {
    vi.spyOn(openTelemetry, 'apiOpenTelemetryStatus').mockReturnValue(
      telemetryStatus({
        required: true,
        signals: {
          trace: healthySignal(),
          metric: healthySignal(),
        },
      }),
    );

    await expect(controller({ workerEnabled: false }).ready()).resolves.toMatchObject({
      status: 'ready',
      checks: {
        openTelemetry: 'up',
      },
    });
  });
});

function healthySignal(): ApiOpenTelemetryStatus['signals']['trace'] {
  return {
    lastExportAttemptAt: '2026-07-29T00:01:00.000Z',
    lastSuccessfulExportAt: '2026-07-29T00:01:00.000Z',
    consecutiveExportFailures: 0,
    failureCode: null,
    stale: false,
  };
}

function telemetryStatus(overrides: Partial<ApiOpenTelemetryStatus>): ApiOpenTelemetryStatus {
  return {
    state: 'started',
    required: false,
    serviceName: 'enterprise-agent-api',
    failureCode: null,
    lastExportAttemptAt: '2026-07-29T00:01:00.000Z',
    lastSuccessfulExportAt: '2026-07-29T00:01:00.000Z',
    consecutiveExportFailures: 0,
    staleAfterMs: 90_000,
    stale: false,
    signals: {
      trace: healthySignal(),
      metric: healthySignal(),
    },
    ...overrides,
  };
}
