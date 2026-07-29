from __future__ import annotations

import asyncio
import re
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import StrEnum
from threading import Lock
from typing import Any
from urllib.parse import unquote, urlsplit, urlunsplit

from fastapi import FastAPI

from enterprise_ai_runtime.config import RuntimeEnvironment
from enterprise_ai_runtime.domain.errors import RuntimeConfigurationError

SERVICE_NAME_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$")
HEADER_NAME_PATTERN = re.compile(r"^[!#$%&'*+.^_`|~0-9a-z-]{1,80}$")
FORBIDDEN_EXPORT_HEADERS = frozenset({"connection", "content-length", "host", "transfer-encoding"})
_stream_delta_counter: Any = None
_stream_first_token_counter: Any = None
_stream_completion_counter: Any = None
_run_duration_histogram: Any = None
_time_to_first_token_histogram: Any = None
AGENT_RUN_SLO_BUCKETS_SECONDS = (
    0.05,
    0.1,
    0.25,
    0.5,
    1.0,
    2.0,
    3.0,
    5.0,
    8.0,
    10.0,
    15.0,
    30.0,
    60.0,
    90.0,
    120.0,
)


class TelemetryState(StrEnum):
    DISABLED = "disabled"
    STARTED = "started"
    FAILED = "failed"
    STOPPED = "stopped"


@dataclass(frozen=True, slots=True)
class TelemetryConfig:
    enabled: bool
    required: bool
    service_name: str
    trace_endpoint: str | None
    metric_endpoint: str | None
    headers: Mapping[str, str] = field(default_factory=dict, repr=False)
    metric_interval_ms: int = 30_000
    sampling_ratio: float = 1.0
    export_timeout_seconds: float = 5.0
    stale_after_seconds: float = 90.0


@dataclass(slots=True)
class TelemetryStatus:
    state: TelemetryState
    required: bool
    configured: bool
    service_name: str
    failure_code: str | None = None
    last_export_attempt_at: datetime | None = None
    last_successful_export_at: datetime | None = None
    consecutive_export_failures: int = 0
    stale_after_seconds: float = 90.0

    @property
    def ready(self) -> bool:
        return self.state == TelemetryState.STARTED and not self.stale

    @property
    def stale(self) -> bool:
        if not self.required or self.state != TelemetryState.STARTED:
            return False
        if self.last_successful_export_at is None:
            return True
        return (
            datetime.now(UTC) - self.last_successful_export_at
        ).total_seconds() > self.stale_after_seconds


class TelemetryRuntime:
    """Owns process-level OpenTelemetry instrumentation and provider shutdown.

    Exporter credentials live only in ``TelemetryConfig`` while initialization is in progress.
    They are deliberately absent from the public status object and all error messages.
    """

    def __init__(
        self,
        *,
        status: TelemetryStatus,
        tracer_provider: Any = None,
        meter_provider: Any = None,
        httpx_instrumentor: Any = None,
        asyncpg_instrumentor: Any = None,
        config: TelemetryConfig | None = None,
    ) -> None:
        self.status = status
        self._tracer_provider = tracer_provider
        self._meter_provider = meter_provider
        self._httpx_instrumentor = httpx_instrumentor
        self._asyncpg_instrumentor = asyncpg_instrumentor
        self._config = config
        self._instrumented_apps: list[tuple[FastAPI, Any]] = []
        self._shutdown_lock = Lock()
        self._closed = False

    async def refresh_export_health(self) -> None:
        if self.status.state != TelemetryState.STARTED or self._config is None:
            return
        now = datetime.now(UTC)
        if self.status.last_export_attempt_at is not None and (
            now - self.status.last_export_attempt_at
        ).total_seconds() < min(10.0, self.status.stale_after_seconds / 3):
            return
        self.status.last_export_attempt_at = now
        try:
            await asyncio.to_thread(_probe_collector, self._config)
        except Exception:
            self.status.consecutive_export_failures += 1
            self.status.failure_code = "OTEL_EXPORT_PROBE_FAILED"
            return
        self.status.last_successful_export_at = datetime.now(UTC)
        self.status.consecutive_export_failures = 0
        self.status.failure_code = None

    def instrument_app(self, app: FastAPI) -> None:
        if not self.status.ready or self._tracer_provider is None:
            return
        try:
            from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor

            instrumentor = FastAPIInstrumentor()
            instrumentor.instrument_app(
                app,
                tracer_provider=self._tracer_provider,
                meter_provider=self._meter_provider,
                excluded_urls="/health/live",
            )
            self._instrumented_apps.append((app, instrumentor))
        except Exception as error:
            self.status.state = TelemetryState.FAILED
            self.status.failure_code = "OTEL_FASTAPI_INSTRUMENTATION_FAILED"
            if self.status.required:
                raise RuntimeConfigurationError(
                    "OpenTelemetry FastAPI instrumentation failed"
                ) from error

    async def aclose(self) -> None:
        await asyncio.to_thread(self._shutdown)

    def _shutdown(self) -> None:
        with self._shutdown_lock:
            if self._closed:
                return
            self._closed = True
            initial_state = self.status.state
            failed = False
            for app, instrumentor in reversed(self._instrumented_apps):
                try:
                    instrumentor.uninstrument_app(app)
                except Exception:
                    failed = True
            for instrumentor in (self._httpx_instrumentor, self._asyncpg_instrumentor):
                if instrumentor is None:
                    continue
                try:
                    instrumentor.uninstrument()
                except Exception:
                    failed = True
            for provider in (self._meter_provider, self._tracer_provider):
                if provider is None:
                    continue
                try:
                    provider.shutdown()
                except Exception:
                    failed = True
            self.status.state = (
                TelemetryState.FAILED
                if failed or initial_state == TelemetryState.FAILED
                else TelemetryState.STOPPED
                if initial_state == TelemetryState.STARTED
                else initial_state
            )
            self.status.failure_code = (
                "OTEL_SDK_SHUTDOWN_FAILED" if failed else self.status.failure_code
            )


def read_telemetry_config(
    environ: Mapping[str, str],
    environment: RuntimeEnvironment,
) -> TelemetryConfig:
    required = _boolean(
        _setting(environ, "OTEL_REQUIRED"),
        environment == RuntimeEnvironment.PRODUCTION,
    )
    disabled = _boolean(_setting(environ, "OTEL_SDK_DISABLED"), False)
    service_name = _service_name(_setting(environ, "OTEL_SERVICE_NAME"))
    base = _optional(_setting(environ, "OTEL_EXPORTER_OTLP_ENDPOINT"))
    trace = _optional(_setting(environ, "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"))
    metric = _optional(_setting(environ, "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT"))
    enabled = not disabled and any(value is not None for value in (base, trace, metric))

    if not enabled:
        return TelemetryConfig(
            enabled=False,
            required=required,
            service_name=service_name,
            trace_endpoint=None,
            metric_endpoint=None,
            sampling_ratio=0.1 if environment == RuntimeEnvironment.PRODUCTION else 1.0,
        )

    normalized_base = (
        _collector_url(
            base,
            environment=environment,
            key="OTEL_EXPORTER_OTLP_ENDPOINT",
            exact_signal_path=False,
        )
        if base is not None
        else None
    )
    if normalized_base is None and (trace is None or metric is None):
        raise RuntimeConfigurationError(
            "configure OTEL_EXPORTER_OTLP_ENDPOINT or both signal-specific OTLP endpoints"
        )

    trace_endpoint = (
        _append_signal_path(normalized_base, "v1/traces")
        if trace is None
        else _collector_url(
            trace,
            environment=environment,
            key="OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
            exact_signal_path=True,
        )
    )
    metric_endpoint = (
        _append_signal_path(normalized_base, "v1/metrics")
        if metric is None
        else _collector_url(
            metric,
            environment=environment,
            key="OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
            exact_signal_path=True,
        )
    )
    metric_interval_ms = _integer(
        _setting(environ, "OTEL_METRIC_EXPORT_INTERVAL"),
        key="OTEL_METRIC_EXPORT_INTERVAL",
        fallback=30_000,
        minimum=1_000,
        maximum=300_000,
    )
    return TelemetryConfig(
        enabled=True,
        required=required,
        service_name=service_name,
        trace_endpoint=trace_endpoint,
        metric_endpoint=metric_endpoint,
        headers=_headers(_setting(environ, "OTEL_EXPORTER_OTLP_HEADERS")),
        metric_interval_ms=metric_interval_ms,
        sampling_ratio=_ratio(_setting(environ, "OTEL_TRACES_SAMPLER_ARG"), environment),
        export_timeout_seconds=_float(
            _setting(environ, "OTEL_EXPORTER_OTLP_TIMEOUT"),
            key="OTEL_EXPORTER_OTLP_TIMEOUT",
            fallback=5.0,
            minimum=0.1,
            maximum=30.0,
        ),
        stale_after_seconds=_float(
            _setting(environ, "OTEL_EXPORT_STALE_AFTER_SECONDS"),
            key="OTEL_EXPORT_STALE_AFTER_SECONDS",
            fallback=max(60.0, metric_interval_ms * 3 / 1_000),
            minimum=max(10.0, metric_interval_ms * 2 / 1_000),
            maximum=3_600.0,
        ),
    )


def start_telemetry(config: TelemetryConfig, environment: RuntimeEnvironment) -> TelemetryRuntime:
    status = TelemetryStatus(
        state=TelemetryState.DISABLED,
        required=config.required,
        configured=config.enabled,
        service_name=config.service_name,
        stale_after_seconds=config.stale_after_seconds,
    )
    if not config.enabled:
        return TelemetryRuntime(status=status)

    tracer_provider = None
    meter_provider = None
    httpx_instrumentor = None
    asyncpg_instrumentor = None
    try:
        from opentelemetry import metrics, trace
        from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
        from opentelemetry.instrumentation.asyncpg import AsyncPGInstrumentor
        from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor
        from opentelemetry.sdk.metrics import MeterProvider
        from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
        from opentelemetry.sdk.metrics.view import (
            ExplicitBucketHistogramAggregation,
            View,
        )
        from opentelemetry.sdk.resources import Resource
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor
        from opentelemetry.sdk.trace.sampling import ParentBased, TraceIdRatioBased
        from requests import Session

        status.last_export_attempt_at = datetime.now(UTC)
        _probe_collector(config)
        status.last_successful_export_at = datetime.now(UTC)
        status.consecutive_export_failures = 0

        resource = Resource.create(
            {
                "service.name": config.service_name,
                "service.version": "0.2.0",
                "deployment.environment.name": environment.value,
            }
        )
        tracer_provider = TracerProvider(
            resource=resource,
            sampler=ParentBased(TraceIdRatioBased(config.sampling_ratio)),
        )
        tracer_provider.add_span_processor(
            BatchSpanProcessor(
                OTLPSpanExporter(
                    endpoint=config.trace_endpoint,
                    headers=dict(config.headers),
                    timeout=config.export_timeout_seconds,
                    session=_direct_export_session(Session),
                )
            )
        )
        metric_reader = PeriodicExportingMetricReader(
            OTLPMetricExporter(
                endpoint=config.metric_endpoint,
                headers=dict(config.headers),
                timeout=config.export_timeout_seconds,
                session=_direct_export_session(Session),
            ),
            export_interval_millis=config.metric_interval_ms,
        )
        meter_provider = MeterProvider(
            resource=resource,
            metric_readers=[metric_reader],
            views=[
                View(
                    instrument_name="enterprise.agent_run.duration",
                    aggregation=ExplicitBucketHistogramAggregation(
                        boundaries=AGENT_RUN_SLO_BUCKETS_SECONDS
                    ),
                ),
                View(
                    instrument_name="enterprise.agent_run.time_to_first_token",
                    aggregation=ExplicitBucketHistogramAggregation(
                        boundaries=AGENT_RUN_SLO_BUCKETS_SECONDS
                    ),
                ),
            ],
        )
        trace.set_tracer_provider(tracer_provider)
        metrics.set_meter_provider(meter_provider)

        httpx_instrumentor = HTTPXClientInstrumentor()
        httpx_instrumentor.instrument(tracer_provider=tracer_provider)
        asyncpg_instrumentor = AsyncPGInstrumentor()
        asyncpg_instrumentor.instrument(tracer_provider=tracer_provider)
        status.state = TelemetryState.STARTED
        return TelemetryRuntime(
            status=status,
            tracer_provider=tracer_provider,
            meter_provider=meter_provider,
            httpx_instrumentor=httpx_instrumentor,
            asyncpg_instrumentor=asyncpg_instrumentor,
            config=config,
        )
    except Exception as error:
        for instrumentor in (httpx_instrumentor, asyncpg_instrumentor):
            if instrumentor is not None:
                try:
                    instrumentor.uninstrument()
                except Exception:
                    pass
        for provider in (meter_provider, tracer_provider):
            if provider is not None:
                try:
                    provider.shutdown()
                except Exception:
                    pass
        status.state = TelemetryState.FAILED
        status.failure_code = "OTEL_SDK_START_FAILED"
        runtime = TelemetryRuntime(status=status)
        if config.required:
            raise RuntimeConfigurationError("OpenTelemetry SDK failed to start") from error
        return runtime


def _probe_collector(config: TelemetryConfig) -> None:
    from requests import Session

    session = _direct_export_session(Session)
    headers = {**config.headers, "content-type": "application/x-protobuf"}
    for endpoint in (config.trace_endpoint, config.metric_endpoint):
        if endpoint is None:
            raise RuntimeConfigurationError("OpenTelemetry collector endpoint is missing")
        response = session.post(
            endpoint,
            headers=headers,
            data=b"",
            timeout=config.export_timeout_seconds,
        )
        response.raise_for_status()


@contextmanager
def runtime_span(name: str, attributes: Mapping[str, Any]) -> Iterator[Any]:
    """Create a prompt-free business span even when the SDK is a no-op provider."""

    from opentelemetry import trace

    tracer = trace.get_tracer("enterprise_ai_runtime", "0.2.0")
    with tracer.start_as_current_span(name, attributes=dict(attributes)) as span:
        yield span


def mark_span_result(span: Any, *, status: str, error_code: str | None = None) -> None:
    from opentelemetry.trace import Status, StatusCode

    span.set_attribute("enterprise.result.status", status)
    if error_code is None:
        span.set_status(Status(StatusCode.OK))
        return
    span.set_attribute("error.type", error_code)
    span.set_status(Status(StatusCode.ERROR, error_code))


def record_stream_delta(*, first: bool, elapsed_seconds: float | None = None) -> None:
    """Record content-free streaming counters on the configured global meter."""

    global _stream_delta_counter, _stream_first_token_counter, _time_to_first_token_histogram
    from opentelemetry import metrics

    meter = metrics.get_meter("enterprise_ai_runtime", "0.2.0")
    if _stream_delta_counter is None:
        _stream_delta_counter = meter.create_counter(
            "enterprise.agent_run.stream.delta",
            unit="{event}",
            description="Validated Agent Run stream delta events.",
        )
    _stream_delta_counter.add(1)
    if first:
        if _stream_first_token_counter is None:
            _stream_first_token_counter = meter.create_counter(
                "enterprise.agent_run.stream.first_token",
                unit="{run}",
                description="Agent Runs that reached a first validated output delta.",
            )
        _stream_first_token_counter.add(1)
        if _time_to_first_token_histogram is None:
            _time_to_first_token_histogram = meter.create_histogram(
                "enterprise.agent_run.time_to_first_token",
                unit="s",
                description="Seconds from Runtime stream execution start to first validated delta.",
            )
        _time_to_first_token_histogram.record(
            max(0.0, elapsed_seconds or 0.0),
            attributes={
                "enterprise.result.status": "running",
                "agent.stream.mode": "live",
            },
        )


def record_stream_completion(*, status: str, mode: str, elapsed_seconds: float) -> None:
    global _run_duration_histogram, _stream_completion_counter
    from opentelemetry import metrics

    meter = metrics.get_meter("enterprise_ai_runtime", "0.2.0")
    safe_status = status if status in {"succeeded", "failed", "cancelled"} else "unknown"
    safe_mode = mode if mode in {"live", "terminal_only"} else "unknown"
    attributes = {
        "enterprise.result.status": safe_status,
        "agent.stream.mode": safe_mode,
    }
    if _stream_completion_counter is None:
        _stream_completion_counter = meter.create_counter(
            "enterprise.agent_run.stream.completion",
            unit="{run}",
            description="Agent Run stream terminal outcomes.",
        )
    _stream_completion_counter.add(
        1,
        attributes=attributes,
    )
    if _run_duration_histogram is None:
        _run_duration_histogram = meter.create_histogram(
            "enterprise.agent_run.duration",
            unit="s",
            description="Seconds from Runtime stream execution start to confirmed terminal state.",
        )
    _run_duration_histogram.record(max(0.0, elapsed_seconds), attributes=attributes)


def _collector_url(
    value: str,
    *,
    environment: RuntimeEnvironment,
    key: str,
    exact_signal_path: bool,
) -> str:
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError as error:
        raise RuntimeConfigurationError(f"{key} must be a valid HTTP(S) URL") from error
    local = parsed.hostname in {"localhost", "127.0.0.1", "::1"}
    safe_scheme = parsed.scheme == "https" or (
        parsed.scheme == "http" and environment != RuntimeEnvironment.PRODUCTION and local
    )
    if (
        not safe_scheme
        or not parsed.netloc
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or port == 0
    ):
        raise RuntimeConfigurationError(
            f"{key} must use HTTPS without credentials, query, or fragment; "
            "local HTTP is allowed outside production"
        )
    path = parsed.path.rstrip("/")
    expected_suffix = "/v1/traces" if key == "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT" else "/v1/metrics"
    if exact_signal_path and not path.endswith(expected_suffix):
        raise RuntimeConfigurationError(f"{key} must include the exact OTLP signal path")
    return urlunsplit((parsed.scheme, parsed.netloc, path, "", ""))


def _append_signal_path(base: str | None, signal_path: str) -> str:
    if base is None:
        raise RuntimeConfigurationError("OTLP collector base endpoint is missing")
    return f"{base.rstrip('/')}/{signal_path}"


def _headers(value: str | None) -> Mapping[str, str]:
    raw = _optional(value)
    if raw is None:
        return {}
    if len(raw.encode("utf-8")) > 16_384:
        raise RuntimeConfigurationError("OTEL_EXPORTER_OTLP_HEADERS exceeds 16 KiB")
    result: dict[str, str] = {}
    for item in raw.split(","):
        name, separator, encoded_value = item.partition("=")
        if not separator:
            raise RuntimeConfigurationError("OTEL_EXPORTER_OTLP_HEADERS must use key=value pairs")
        try:
            normalized_name = unquote(name.strip()).lower()
            normalized_value = unquote(encoded_value.strip())
        except UnicodeDecodeError as error:
            raise RuntimeConfigurationError(
                "OTEL_EXPORTER_OTLP_HEADERS contains invalid percent encoding"
            ) from error
        if (
            HEADER_NAME_PATTERN.fullmatch(normalized_name) is None
            or normalized_name in FORBIDDEN_EXPORT_HEADERS
            or not 1 <= len(normalized_value) <= 4_096
            or any(character in normalized_value for character in ("\r", "\n", "\0"))
        ):
            raise RuntimeConfigurationError("OTEL_EXPORTER_OTLP_HEADERS contains an unsafe header")
        if normalized_name in result:
            raise RuntimeConfigurationError(
                "OTEL_EXPORTER_OTLP_HEADERS contains a duplicate header"
            )
        result[normalized_name] = normalized_value
    if len(result) > 32:
        raise RuntimeConfigurationError("OTEL_EXPORTER_OTLP_HEADERS may contain at most 32 headers")
    return result


def _service_name(value: str | None) -> str:
    parsed = _optional(value) or "enterprise-ai-runtime"
    if SERVICE_NAME_PATTERN.fullmatch(parsed) is None:
        raise RuntimeConfigurationError("OTEL_SERVICE_NAME is invalid")
    return parsed


def _ratio(value: str | None, environment: RuntimeEnvironment) -> float:
    try:
        parsed = float(
            _optional(value) or ("0.1" if environment == RuntimeEnvironment.PRODUCTION else "1")
        )
    except ValueError as error:
        raise RuntimeConfigurationError(
            "OTEL_TRACES_SAMPLER_ARG must be between 0 and 1"
        ) from error
    if not 0 <= parsed <= 1:
        raise RuntimeConfigurationError("OTEL_TRACES_SAMPLER_ARG must be between 0 and 1")
    return parsed


def _integer(
    value: str | None,
    *,
    key: str,
    fallback: int,
    minimum: int,
    maximum: int,
) -> int:
    try:
        parsed = int(_optional(value) or str(fallback))
    except ValueError as error:
        raise RuntimeConfigurationError(
            f"{key} must be an integer between {minimum} and {maximum}"
        ) from error
    if not minimum <= parsed <= maximum:
        raise RuntimeConfigurationError(f"{key} must be an integer between {minimum} and {maximum}")
    return parsed


def _float(
    value: str | None,
    *,
    key: str,
    fallback: float,
    minimum: float,
    maximum: float,
) -> float:
    try:
        parsed = float(_optional(value) or str(fallback))
    except ValueError as error:
        raise RuntimeConfigurationError(
            f"{key} must be a number between {minimum} and {maximum}"
        ) from error
    if not minimum <= parsed <= maximum:
        raise RuntimeConfigurationError(f"{key} must be a number between {minimum} and {maximum}")
    return parsed


def _boolean(value: str | None, fallback: bool) -> bool:
    parsed = _optional(value)
    if parsed is None:
        return fallback
    if parsed == "true":
        return True
    if parsed == "false":
        return False
    raise RuntimeConfigurationError(
        "OpenTelemetry boolean environment values must be true or false"
    )


def _optional(value: str | None) -> str | None:
    if value is None:
        return None
    parsed = value.strip()
    return parsed or None


def _setting(environ: Mapping[str, str], standard_name: str) -> str | None:
    """Prefer the runtime-scoped alias in the repository's shared dotenv.

    A process-injected standard OTEL variable remains supported. The scoped alias prevents the
    API and AI Runtime from accidentally sharing one ``OTEL_SERVICE_NAME`` when both are launched
    from the same development dotenv.
    """

    return environ.get(f"AI_RUNTIME_{standard_name}") or environ.get(standard_name)


def _direct_export_session(session_type: type[Any]) -> Any:
    session = session_type()
    # Collector credentials and telemetry payloads must not be redirected through a workstation
    # or cloud egress proxy inherited from the host. Route collectors at the network layer.
    session.trust_env = False
    return session
