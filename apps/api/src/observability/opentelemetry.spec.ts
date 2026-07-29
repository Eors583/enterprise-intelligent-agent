import { describe, expect, it } from 'vitest';

import {
  isApiOpenTelemetryStale,
  readApiOpenTelemetryConfig,
  resolveApiOpenTelemetryStatus,
} from './opentelemetry.js';

describe('API OpenTelemetry configuration', () => {
  it('keeps local test runs disabled when no collector is configured', () => {
    expect(readApiOpenTelemetryConfig({}, 'test')).toMatchObject({
      enabled: false,
      required: false,
      serviceName: 'enterprise-agent-api',
    });
  });

  it('marks production telemetry as required so readiness cannot claim success', () => {
    expect(readApiOpenTelemetryConfig({}, 'production')).toMatchObject({
      enabled: false,
      required: true,
      traceEndpoint: null,
      metricEndpoint: null,
    });
  });

  it('derives exact trace and metric endpoints from a trusted collector base', () => {
    expect(
      readApiOpenTelemetryConfig(
        {
          OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.example.test/otlp',
          OTEL_EXPORTER_OTLP_HEADERS: 'authorization=Bearer%20server-only-token',
          OTEL_TRACES_SAMPLER_ARG: '0.25',
        },
        'production',
      ),
    ).toMatchObject({
      enabled: true,
      required: true,
      traceEndpoint: 'https://otel.example.test/otlp/v1/traces',
      metricEndpoint: 'https://otel.example.test/otlp/v1/metrics',
      headers: { authorization: 'Bearer server-only-token' },
      samplingRatio: 0.25,
      staleAfterMs: 90_000,
    });
  });

  it('treats a required started SDK without recent export evidence as stale', () => {
    expect(
      isApiOpenTelemetryStale(
        {
          state: 'started',
          required: true,
          lastSuccessfulExportAt: null,
          staleAfterMs: 90_000,
        },
        Date.parse('2026-07-29T00:00:00.000Z'),
      ),
    ).toBe(true);
    expect(
      isApiOpenTelemetryStale(
        {
          state: 'started',
          required: true,
          lastSuccessfulExportAt: '2026-07-29T00:00:00.000Z',
          staleAfterMs: 90_000,
        },
        Date.parse('2026-07-29T00:01:00.000Z'),
      ),
    ).toBe(false);
    expect(
      isApiOpenTelemetryStale(
        {
          state: 'started',
          required: true,
          lastSuccessfulExportAt: '2026-07-29T00:00:00.000Z',
          staleAfterMs: 90_000,
        },
        Date.parse('2026-07-29T00:02:00.000Z'),
      ),
    ).toBe(true);
  });

  it('requires independent recent export evidence from both telemetry signals', () => {
    const status = resolveApiOpenTelemetryStatus(
      {
        state: 'started',
        required: true,
        serviceName: 'enterprise-agent-api',
        failureCode: null,
        staleAfterMs: 90_000,
        signals: {
          trace: {
            lastExportAttemptAt: '2026-07-29T00:00:10.000Z',
            lastSuccessfulExportAt: '2026-07-29T00:00:10.000Z',
            consecutiveExportFailures: 0,
            failureCode: null,
          },
          metric: {
            lastExportAttemptAt: '2026-07-29T00:00:20.000Z',
            lastSuccessfulExportAt: '2026-07-29T00:00:20.000Z',
            consecutiveExportFailures: 0,
            failureCode: null,
          },
        },
      },
      Date.parse('2026-07-29T00:01:00.000Z'),
    );

    expect(status).toMatchObject({
      stale: false,
      failureCode: null,
      lastExportAttemptAt: '2026-07-29T00:00:20.000Z',
      lastSuccessfulExportAt: '2026-07-29T00:00:10.000Z',
      signals: {
        trace: { stale: false },
        metric: { stale: false },
      },
    });
  });

  it('does not let a recent metric export hide stale trace exports', () => {
    const status = resolveApiOpenTelemetryStatus(
      {
        state: 'started',
        required: true,
        serviceName: 'enterprise-agent-api',
        failureCode: null,
        staleAfterMs: 90_000,
        signals: {
          trace: {
            lastExportAttemptAt: '2026-07-29T00:00:05.000Z',
            lastSuccessfulExportAt: '2026-07-29T00:00:05.000Z',
            consecutiveExportFailures: 2,
            failureCode: 'OTEL_EXPORT_FAILED',
          },
          metric: {
            lastExportAttemptAt: '2026-07-29T00:03:50.000Z',
            lastSuccessfulExportAt: '2026-07-29T00:03:50.000Z',
            consecutiveExportFailures: 0,
            failureCode: null,
          },
        },
      },
      Date.parse('2026-07-29T00:04:00.000Z'),
    );

    expect(status).toMatchObject({
      stale: true,
      failureCode: 'OTEL_EXPORT_STALE',
      lastSuccessfulExportAt: '2026-07-29T00:00:05.000Z',
      consecutiveExportFailures: 2,
      signals: {
        trace: {
          stale: true,
          failureCode: 'OTEL_EXPORT_FAILED',
          consecutiveExportFailures: 2,
        },
        metric: {
          stale: false,
          failureCode: null,
          consecutiveExportFailures: 0,
        },
      },
    });
  });

  it('does not treat collector connectivity as successful signal export evidence', () => {
    const status = resolveApiOpenTelemetryStatus(
      {
        state: 'started',
        required: true,
        serviceName: 'enterprise-agent-api',
        failureCode: null,
        staleAfterMs: 90_000,
        signals: {
          trace: {
            lastExportAttemptAt: null,
            lastSuccessfulExportAt: null,
            consecutiveExportFailures: 0,
            failureCode: null,
          },
          metric: {
            lastExportAttemptAt: null,
            lastSuccessfulExportAt: null,
            consecutiveExportFailures: 0,
            failureCode: null,
          },
        },
      },
      Date.parse('2026-07-29T00:00:00.000Z'),
    );

    expect(status).toMatchObject({
      stale: true,
      failureCode: 'OTEL_EXPORT_STALE',
      lastExportAttemptAt: null,
      lastSuccessfulExportAt: null,
      signals: {
        trace: { stale: true, lastSuccessfulExportAt: null },
        metric: { stale: true, lastSuccessfulExportAt: null },
      },
    });
  });

  it('preserves one signal failure when the other signal succeeds', () => {
    const status = resolveApiOpenTelemetryStatus(
      {
        state: 'started',
        required: true,
        serviceName: 'enterprise-agent-api',
        failureCode: null,
        staleAfterMs: 90_000,
        signals: {
          trace: {
            lastExportAttemptAt: '2026-07-29T00:00:30.000Z',
            lastSuccessfulExportAt: '2026-07-29T00:00:10.000Z',
            consecutiveExportFailures: 1,
            failureCode: 'OTEL_EXPORT_FAILED',
          },
          metric: {
            lastExportAttemptAt: '2026-07-29T00:00:40.000Z',
            lastSuccessfulExportAt: '2026-07-29T00:00:40.000Z',
            consecutiveExportFailures: 0,
            failureCode: null,
          },
        },
      },
      Date.parse('2026-07-29T00:01:00.000Z'),
    );

    expect(status).toMatchObject({
      stale: false,
      failureCode: 'OTEL_EXPORT_FAILED',
      consecutiveExportFailures: 1,
      signals: {
        trace: {
          failureCode: 'OTEL_EXPORT_FAILED',
          consecutiveExportFailures: 1,
        },
        metric: {
          failureCode: null,
          consecutiveExportFailures: 0,
        },
      },
    });
  });

  it('requires both signal-specific endpoints when no common base is supplied', () => {
    expect(() =>
      readApiOpenTelemetryConfig(
        {
          OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'https://otel.example.test/v1/traces',
        },
        'production',
      ),
    ).toThrow(/both signal-specific/);
  });

  it('rejects remote plaintext collectors and unsafe headers', () => {
    expect(() =>
      readApiOpenTelemetryConfig(
        { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel.example.test' },
        'production',
      ),
    ).toThrow(/must use HTTPS/);
    expect(() =>
      readApiOpenTelemetryConfig(
        {
          OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.example.test',
          OTEL_EXPORTER_OTLP_HEADERS: 'host=attacker.example',
        },
        'production',
      ),
    ).toThrow(/unsafe header/);
  });
});
