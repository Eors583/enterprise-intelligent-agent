import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { defaultResource, resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK, metrics } from '@opentelemetry/sdk-node';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

import type { NodeEnvironment } from '../config/environment.js';

export interface ApiOpenTelemetryConfig {
  readonly enabled: boolean;
  readonly required: boolean;
  readonly serviceName: string;
  readonly traceEndpoint: string | null;
  readonly metricEndpoint: string | null;
  readonly headers: Readonly<Record<string, string>>;
  readonly metricIntervalMs: number;
  readonly staleAfterMs: number;
  readonly samplingRatio: number;
  readonly diagnostics: boolean;
}

export interface ApiOpenTelemetryStatus {
  readonly state: 'not_initialized' | 'disabled' | 'started' | 'failed' | 'stopped';
  readonly required: boolean;
  readonly serviceName: string;
  readonly failureCode: string | null;
  readonly lastExportAttemptAt: string | null;
  readonly lastSuccessfulExportAt: string | null;
  readonly consecutiveExportFailures: number;
  readonly staleAfterMs: number;
  readonly stale: boolean;
  readonly signals: {
    readonly trace: ApiOpenTelemetrySignalStatus;
    readonly metric: ApiOpenTelemetrySignalStatus;
  };
}

export interface ApiOpenTelemetrySignalStatus {
  readonly lastExportAttemptAt: string | null;
  readonly lastSuccessfulExportAt: string | null;
  readonly consecutiveExportFailures: number;
  readonly failureCode: 'OTEL_EXPORT_FAILED' | null;
  readonly stale: boolean;
}

interface MutableApiOpenTelemetrySignalStatus {
  readonly lastExportAttemptAt: string | null;
  readonly lastSuccessfulExportAt: string | null;
  readonly consecutiveExportFailures: number;
  readonly failureCode: 'OTEL_EXPORT_FAILED' | null;
}

interface ApiOpenTelemetryInternalStatus {
  readonly state: ApiOpenTelemetryStatus['state'];
  readonly required: boolean;
  readonly serviceName: string;
  readonly failureCode: string | null;
  readonly staleAfterMs: number;
  readonly signals: {
    readonly trace: MutableApiOpenTelemetrySignalStatus;
    readonly metric: MutableApiOpenTelemetrySignalStatus;
  };
}

let sdk: NodeSDK | null = null;
let shutdownPromise: Promise<void> | null = null;
let hooksInstalled = false;
let status: ApiOpenTelemetryInternalStatus = {
  state: 'not_initialized',
  required: false,
  serviceName: 'enterprise-agent-api',
  failureCode: null,
  staleAfterMs: 90_000,
  signals: emptySignalStatuses(),
};

export async function startApiOpenTelemetry(
  source: Readonly<Record<string, string | undefined>>,
  environment: NodeEnvironment,
): Promise<void> {
  const config = readApiOpenTelemetryConfig(source, environment);
  status = {
    state: config.enabled ? 'not_initialized' : 'disabled',
    required: config.required,
    serviceName: config.serviceName,
    failureCode: null,
    staleAfterMs: config.staleAfterMs,
    signals: emptySignalStatuses(),
  };
  if (!config.enabled) return;

  if (config.diagnostics) {
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.WARN);
  }

  process.env.OTEL_TRACES_SAMPLER = 'parentbased_traceidratio';
  process.env.OTEL_TRACES_SAMPLER_ARG = String(config.samplingRatio);
  const traceExporter = observeExporter(
    'trace',
    new OTLPTraceExporter({
      url: config.traceEndpoint!,
      headers: { ...config.headers },
    }),
  );
  const metricExporter = observeExporter(
    'metric',
    new OTLPMetricExporter({
      url: config.metricEndpoint!,
      headers: { ...config.headers },
    }),
  );
  const metricReader = new metrics.PeriodicExportingMetricReader({
    exporter: metricExporter,
    exportIntervalMillis: config.metricIntervalMs,
  });
  sdk = new NodeSDK({
    resource: defaultResource().merge(
      resourceFromAttributes({
        [ATTR_SERVICE_NAME]: config.serviceName,
        [ATTR_SERVICE_VERSION]: '0.1.0',
        'deployment.environment.name': environment,
      }),
    ),
    traceExporter,
    metricReaders: [metricReader],
    instrumentations: [
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-fs': { enabled: false },
        '@opentelemetry/instrumentation-dns': { enabled: false },
        '@opentelemetry/instrumentation-net': { enabled: false },
      }),
    ],
  });
  try {
    sdk.start();
    await Promise.all([
      probeOtlpHttpEndpoint(config.traceEndpoint!, config.headers),
      probeOtlpHttpEndpoint(config.metricEndpoint!, config.headers),
    ]);
    status = {
      ...status,
      state: 'started',
      failureCode: null,
    };
  } catch {
    status = { ...status, state: 'failed', failureCode: 'OTEL_SDK_START_FAILED' };
    const failedSdk = sdk;
    sdk = null;
    await failedSdk?.shutdown().catch(() => undefined);
    if (config.required) throw new Error('OpenTelemetry SDK failed to start.');
  }
}

async function probeOtlpHttpEndpoint(
  endpoint: string,
  headers: Readonly<Record<string, string>>,
): Promise<void> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      ...headers,
      'content-type': 'application/x-protobuf',
    },
    body: new Uint8Array(),
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    throw new Error('OpenTelemetry collector export probe failed.');
  }
}

export function installOpenTelemetryShutdownHooks(): void {
  if (hooksInstalled) return;
  hooksInstalled = true;
  process.once('beforeExit', () => {
    void stopApiOpenTelemetry();
  });
  process.once('SIGTERM', () => {
    void stopApiOpenTelemetry();
  });
  process.once('SIGINT', () => {
    void stopApiOpenTelemetry();
  });
}

export function stopApiOpenTelemetry(): Promise<void> {
  if (shutdownPromise !== null) return shutdownPromise;
  if (sdk === null) {
    if (status.state === 'started') status = { ...status, state: 'stopped' };
    return Promise.resolve();
  }
  const current = sdk;
  sdk = null;
  shutdownPromise = current
    .shutdown()
    .catch(() => {
      status = { ...status, state: 'failed', failureCode: 'OTEL_SDK_SHUTDOWN_FAILED' };
    })
    .then(() => {
      if (status.state !== 'failed') status = { ...status, state: 'stopped' };
    });
  return shutdownPromise;
}

export function apiOpenTelemetryStatus(): ApiOpenTelemetryStatus {
  return resolveApiOpenTelemetryStatus(status, Date.now());
}

export function resolveApiOpenTelemetryStatus(
  current: ApiOpenTelemetryInternalStatus,
  nowMs: number,
): ApiOpenTelemetryStatus {
  const trace = resolveSignalStatus(current, current.signals.trace, nowMs);
  const metric = resolveSignalStatus(current, current.signals.metric, nowMs);
  const stale = trace.stale || metric.stale;
  const exportFailed =
    trace.failureCode === 'OTEL_EXPORT_FAILED' || metric.failureCode === 'OTEL_EXPORT_FAILED';
  return {
    state: current.state,
    required: current.required,
    serviceName: current.serviceName,
    failureCode: stale
      ? 'OTEL_EXPORT_STALE'
      : exportFailed
        ? 'OTEL_EXPORT_FAILED'
        : current.failureCode,
    lastExportAttemptAt: latestTimestamp(trace.lastExportAttemptAt, metric.lastExportAttemptAt),
    lastSuccessfulExportAt: oldestCompleteTimestamp(
      trace.lastSuccessfulExportAt,
      metric.lastSuccessfulExportAt,
    ),
    consecutiveExportFailures: Math.max(
      trace.consecutiveExportFailures,
      metric.consecutiveExportFailures,
    ),
    staleAfterMs: current.staleAfterMs,
    stale,
    signals: { trace, metric },
  };
}

export function isApiOpenTelemetryStale(
  current: Pick<
    ApiOpenTelemetryStatus,
    'state' | 'required' | 'lastSuccessfulExportAt' | 'staleAfterMs'
  >,
  nowMs: number,
): boolean {
  if (!current.required || current.state !== 'started') return false;
  if (current.lastSuccessfulExportAt === null) return true;
  const exportedAt = Date.parse(current.lastSuccessfulExportAt);
  return !Number.isFinite(exportedAt) || nowMs - exportedAt > current.staleAfterMs;
}

export function readApiOpenTelemetryConfig(
  source: Readonly<Record<string, string | undefined>>,
  environment: NodeEnvironment,
): ApiOpenTelemetryConfig {
  const required = parseBoolean(source.OTEL_REQUIRED, environment === 'production');
  const explicitlyDisabled = parseBoolean(source.OTEL_SDK_DISABLED, false);
  const baseEndpoint = optional(source.OTEL_EXPORTER_OTLP_ENDPOINT);
  const traceEndpoint = optional(source.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT);
  const metricEndpoint = optional(source.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT);
  const enabled =
    !explicitlyDisabled &&
    (baseEndpoint !== undefined || traceEndpoint !== undefined || metricEndpoint !== undefined);
  if (required && !enabled) {
    return {
      enabled: false,
      required,
      serviceName: serviceName(source.OTEL_SERVICE_NAME),
      traceEndpoint: null,
      metricEndpoint: null,
      headers: {},
      metricIntervalMs: 30_000,
      staleAfterMs: 90_000,
      samplingRatio: 0.1,
      diagnostics: false,
    };
  }
  if (!enabled) {
    return {
      enabled: false,
      required,
      serviceName: serviceName(source.OTEL_SERVICE_NAME),
      traceEndpoint: null,
      metricEndpoint: null,
      headers: {},
      metricIntervalMs: 30_000,
      staleAfterMs: 90_000,
      samplingRatio: environment === 'production' ? 0.1 : 1,
      diagnostics: parseBoolean(source.OTEL_DIAGNOSTICS_ENABLED, false),
    };
  }

  const normalizedBase =
    baseEndpoint === undefined
      ? undefined
      : validateCollectorUrl(baseEndpoint, environment, 'OTEL_EXPORTER_OTLP_ENDPOINT', true);
  if (
    normalizedBase === undefined &&
    (traceEndpoint === undefined || metricEndpoint === undefined)
  ) {
    throw new Error(
      'Configure OTEL_EXPORTER_OTLP_ENDPOINT or both signal-specific OTLP endpoints.',
    );
  }
  const metricIntervalMs = parseInteger(
    source.OTEL_METRIC_EXPORT_INTERVAL,
    'OTEL_METRIC_EXPORT_INTERVAL',
    30_000,
    1_000,
    300_000,
  );
  return {
    enabled: true,
    required,
    serviceName: serviceName(source.OTEL_SERVICE_NAME),
    traceEndpoint:
      traceEndpoint === undefined
        ? appendSignalPath(normalizedBase as string, 'v1/traces')
        : validateCollectorUrl(
            traceEndpoint,
            environment,
            'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
            false,
          ),
    metricEndpoint:
      metricEndpoint === undefined
        ? appendSignalPath(normalizedBase as string, 'v1/metrics')
        : validateCollectorUrl(
            metricEndpoint,
            environment,
            'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT',
            false,
          ),
    headers: parseHeaders(source.OTEL_EXPORTER_OTLP_HEADERS),
    metricIntervalMs,
    staleAfterMs: parseInteger(
      source.OTEL_EXPORT_STALE_AFTER_MS,
      'OTEL_EXPORT_STALE_AFTER_MS',
      Math.max(60_000, metricIntervalMs * 3),
      metricIntervalMs * 2,
      3_600_000,
    ),
    samplingRatio: parseRatio(source.OTEL_TRACES_SAMPLER_ARG, environment),
    diagnostics: parseBoolean(source.OTEL_DIAGNOSTICS_ENABLED, false),
  };
}

interface ExportResult {
  readonly code: number;
  readonly error?: Error;
}

interface ObservableExporter {
  export(items: unknown, callback: (result: ExportResult) => void): void;
}

function observeExporter<T extends object>(signal: 'trace' | 'metric', exporter: T): T {
  const observed = exporter as unknown as ObservableExporter;
  const original = observed.export.bind(observed);
  observed.export = (items, callback) => {
    updateSignalStatus(signal, {
      ...status.signals[signal],
      lastExportAttemptAt: new Date().toISOString(),
    });
    original(items, (result) => {
      if (result.code === 0) {
        updateSignalStatus(signal, {
          ...status.signals[signal],
          lastSuccessfulExportAt: new Date().toISOString(),
          consecutiveExportFailures: 0,
          failureCode: null,
        });
      } else {
        updateSignalStatus(signal, {
          ...status.signals[signal],
          consecutiveExportFailures: status.signals[signal].consecutiveExportFailures + 1,
          failureCode: 'OTEL_EXPORT_FAILED',
        });
      }
      callback(result);
    });
  };
  return exporter;
}

function updateSignalStatus(
  signal: 'trace' | 'metric',
  next: MutableApiOpenTelemetrySignalStatus,
): void {
  status = {
    ...status,
    signals: {
      ...status.signals,
      [signal]: next,
    },
  };
}

function resolveSignalStatus(
  current: Pick<ApiOpenTelemetryInternalStatus, 'state' | 'required' | 'staleAfterMs'>,
  signal: MutableApiOpenTelemetrySignalStatus,
  nowMs: number,
): ApiOpenTelemetrySignalStatus {
  return {
    ...signal,
    stale: isApiOpenTelemetryStale(
      {
        state: current.state,
        required: current.required,
        lastSuccessfulExportAt: signal.lastSuccessfulExportAt,
        staleAfterMs: current.staleAfterMs,
      },
      nowMs,
    ),
  };
}

function emptySignalStatuses(): ApiOpenTelemetryInternalStatus['signals'] {
  return {
    trace: emptySignalStatus(),
    metric: emptySignalStatus(),
  };
}

function emptySignalStatus(): MutableApiOpenTelemetrySignalStatus {
  return {
    lastExportAttemptAt: null,
    lastSuccessfulExportAt: null,
    consecutiveExportFailures: 0,
    failureCode: null,
  };
}

function latestTimestamp(left: string | null, right: string | null): string | null {
  if (left === null) return right;
  if (right === null) return left;
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

function oldestCompleteTimestamp(left: string | null, right: string | null): string | null {
  if (left === null || right === null) return null;
  return Date.parse(left) <= Date.parse(right) ? left : right;
}

function validateCollectorUrl(
  value: string,
  environment: NodeEnvironment,
  key: string,
  allowBasePath: boolean,
): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${key} must be a valid HTTP(S) URL.`);
  }
  const local =
    parsed.hostname === 'localhost' ||
    parsed.hostname === '127.0.0.1' ||
    parsed.hostname === '[::1]';
  if (
    (parsed.protocol !== 'https:' &&
      !(parsed.protocol === 'http:' && environment !== 'production' && local)) ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    parsed.port === '0'
  ) {
    throw new Error(
      `${key} must use HTTPS without credentials, query, or fragment; local HTTP is allowed outside production.`,
    );
  }
  if (!allowBasePath && parsed.pathname.endsWith('/')) {
    throw new Error(`${key} must include the exact OTLP signal path.`);
  }
  return parsed.toString().replace(/\/$/, '');
}

function appendSignalPath(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path}`;
}

function parseHeaders(value: string | undefined): Readonly<Record<string, string>> {
  const raw = optional(value);
  if (raw === undefined) return {};
  if (Buffer.byteLength(raw, 'utf8') > 16_384) {
    throw new Error('OTEL_EXPORTER_OTLP_HEADERS exceeds 16 KiB.');
  }
  const result: Record<string, string> = {};
  for (const item of raw.split(',')) {
    const separator = item.indexOf('=');
    if (separator <= 0) throw new Error('OTEL_EXPORTER_OTLP_HEADERS must use key=value pairs.');
    const name = decodeURIComponent(item.slice(0, separator).trim()).toLowerCase();
    const headerValue = decodeURIComponent(item.slice(separator + 1).trim());
    if (
      !/^[!#$%&'*+.^_`|~0-9a-z-]{1,80}$/u.test(name) ||
      ['connection', 'content-length', 'host', 'transfer-encoding'].includes(name) ||
      headerValue.length < 1 ||
      headerValue.length > 4_096 ||
      /[\r\n\u0000]/u.test(headerValue)
    ) {
      throw new Error('OTEL_EXPORTER_OTLP_HEADERS contains an unsafe header.');
    }
    if (Object.hasOwn(result, name)) {
      throw new Error('OTEL_EXPORTER_OTLP_HEADERS contains a duplicate header.');
    }
    result[name] = headerValue;
  }
  if (Object.keys(result).length > 32) {
    throw new Error('OTEL_EXPORTER_OTLP_HEADERS may contain at most 32 headers.');
  }
  return result;
}

function serviceName(value: string | undefined): string {
  const parsed = optional(value) ?? 'enterprise-agent-api';
  if (parsed.length > 120 || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(parsed)) {
    throw new Error('OTEL_SERVICE_NAME is invalid.');
  }
  return parsed;
}

function parseRatio(value: string | undefined, environment: NodeEnvironment): number {
  const parsed = Number(optional(value) ?? (environment === 'production' ? 0.1 : 1));
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error('OTEL_TRACES_SAMPLER_ARG must be between 0 and 1.');
  }
  return parsed;
}

function parseInteger(
  value: string | undefined,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(optional(value) ?? fallback);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${key} must be an integer between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  const parsed = optional(value);
  if (parsed === undefined) return fallback;
  if (parsed === 'true') return true;
  if (parsed === 'false') return false;
  throw new Error('OpenTelemetry boolean environment values must be true or false.');
}

function optional(value: string | undefined): string | undefined {
  const parsed = value?.trim();
  return parsed === undefined || parsed.length === 0 ? undefined : parsed;
}
