from __future__ import annotations

from datetime import UTC, datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread

import pytest
from fastapi.testclient import TestClient
from opentelemetry import metrics

import enterprise_ai_runtime.telemetry as telemetry_module
from enterprise_ai_runtime.config import RuntimeEnvironment
from enterprise_ai_runtime.domain.errors import RuntimeConfigurationError
from enterprise_ai_runtime.main import create_app
from enterprise_ai_runtime.telemetry import (
    AGENT_RUN_SLO_BUCKETS_SECONDS,
    TelemetryState,
    TelemetryStatus,
    read_telemetry_config,
    record_stream_completion,
    record_stream_delta,
    start_telemetry,
)


def test_agent_run_histogram_buckets_resolve_documented_slo_boundaries() -> None:
    assert 3.0 in AGENT_RUN_SLO_BUCKETS_SECONDS
    assert 8.0 in AGENT_RUN_SLO_BUCKETS_SECONDS
    assert AGENT_RUN_SLO_BUCKETS_SECONDS == tuple(sorted(set(AGENT_RUN_SLO_BUCKETS_SECONDS)))


def test_local_telemetry_is_optional_without_a_collector() -> None:
    config = read_telemetry_config({}, RuntimeEnvironment.TEST)

    assert config.enabled is False
    assert config.required is False
    assert config.service_name == "enterprise-ai-runtime"
    assert config.sampling_ratio == 1


def test_production_telemetry_is_required_and_blocks_readiness_when_missing() -> None:
    config = read_telemetry_config({}, RuntimeEnvironment.PRODUCTION)
    telemetry = start_telemetry(config, RuntimeEnvironment.PRODUCTION)

    assert telemetry.status.state == TelemetryState.DISABLED
    assert telemetry.status.required is True
    with TestClient(create_app(telemetry=telemetry)) as client:
        response = client.get("/health/ready")
        dependencies = client.get("/health/dependencies")

    assert response.status_code == 503
    assert response.json()["components"]["telemetry"] == "not_ready"
    assert dependencies.json()["status"] == "degraded"
    assert dependencies.json()["components"]["telemetry"] == {
        "status": "degraded",
        "configured": False,
        "evidence": "otlp_export_probe",
        "external_connectivity_verified": False,
        "fallback_mode": "readiness_blocked_until_telemetry_recovers",
        "stale": False,
    }


def test_started_required_telemetry_becomes_not_ready_when_export_evidence_is_stale() -> None:
    status = TelemetryStatus(
        state=TelemetryState.STARTED,
        required=True,
        configured=True,
        service_name="enterprise-ai-runtime",
        last_successful_export_at=datetime.now(UTC) - timedelta(seconds=120),
        stale_after_seconds=90,
    )

    assert status.stale is True
    assert status.ready is False


def test_required_telemetry_rejects_an_unreachable_collector_at_startup() -> None:
    config = read_telemetry_config(
        {
            "AI_RUNTIME_OTEL_REQUIRED": "true",
            "AI_RUNTIME_OTEL_EXPORTER_OTLP_ENDPOINT": "http://127.0.0.1:1",
            "AI_RUNTIME_OTEL_EXPORTER_OTLP_TIMEOUT": "0.1",
        },
        RuntimeEnvironment.TEST,
    )

    with pytest.raises(RuntimeConfigurationError, match="failed to start"):
        start_telemetry(config, RuntimeEnvironment.TEST)


def test_collector_base_derives_both_signal_endpoints_without_exposing_headers() -> None:
    config = read_telemetry_config(
        {
            "OTEL_EXPORTER_OTLP_ENDPOINT": "https://otel.example.test/otlp",
            "OTEL_EXPORTER_OTLP_HEADERS": "authorization=Bearer%20server-only-token",
            "OTEL_TRACES_SAMPLER_ARG": "0.25",
        },
        RuntimeEnvironment.PRODUCTION,
    )

    assert config.enabled is True
    assert config.trace_endpoint == "https://otel.example.test/otlp/v1/traces"
    assert config.metric_endpoint == "https://otel.example.test/otlp/v1/metrics"
    assert config.headers == {"authorization": "Bearer server-only-token"}
    assert config.sampling_ratio == 0.25
    assert "server-only-token" not in repr(config)


def test_signal_specific_configuration_requires_both_endpoints() -> None:
    with pytest.raises(RuntimeConfigurationError, match="both signal-specific"):
        read_telemetry_config(
            {"OTEL_EXPORTER_OTLP_TRACES_ENDPOINT": ("https://otel.example.test/v1/traces")},
            RuntimeEnvironment.PRODUCTION,
        )


@pytest.mark.parametrize(
    ("environment", "overrides", "message"),
    [
        (
            RuntimeEnvironment.PRODUCTION,
            {"OTEL_EXPORTER_OTLP_ENDPOINT": "http://otel.example.test"},
            "must use HTTPS",
        ),
        (
            RuntimeEnvironment.PRODUCTION,
            {
                "OTEL_EXPORTER_OTLP_ENDPOINT": "https://otel.example.test",
                "OTEL_EXPORTER_OTLP_HEADERS": "host=attacker.example",
            },
            "unsafe header",
        ),
        (
            RuntimeEnvironment.PRODUCTION,
            {
                "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT": ("https://otel.example.test/not-traces"),
                "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT": ("https://otel.example.test/v1/metrics"),
            },
            "exact OTLP signal path",
        ),
        (
            RuntimeEnvironment.TEST,
            {"OTEL_REQUIRED": "yes"},
            "boolean environment values",
        ),
    ],
)
def test_telemetry_rejects_unsafe_or_ambiguous_configuration(
    environment: RuntimeEnvironment,
    overrides: dict[str, str],
    message: str,
) -> None:
    with pytest.raises(RuntimeConfigurationError, match=message):
        read_telemetry_config(overrides, environment)


def test_otlp_runtime_exports_trace_and_metric_batches_without_host_proxy() -> None:
    paths: list[str] = []

    class CollectorHandler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:  # noqa: N802 - stdlib HTTP handler protocol
            paths.append(self.path)
            content_length = int(self.headers.get("content-length", "0"))
            self.rfile.read(content_length)
            self.send_response(200)
            self.send_header("content-type", "application/x-protobuf")
            self.send_header("content-length", "0")
            self.end_headers()

        def log_message(self, *_: object) -> None:
            return

    collector = ThreadingHTTPServer(("127.0.0.1", 0), CollectorHandler)
    thread = Thread(target=collector.serve_forever, daemon=True)
    thread.start()
    try:
        endpoint = f"http://127.0.0.1:{collector.server_port}"
        config = read_telemetry_config(
            {
                "AI_RUNTIME_OTEL_EXPORTER_OTLP_ENDPOINT": endpoint,
                "AI_RUNTIME_OTEL_EXPORTER_OTLP_TIMEOUT": "1",
                "AI_RUNTIME_OTEL_METRIC_EXPORT_INTERVAL": "1000",
            },
            RuntimeEnvironment.TEST,
        )
        telemetry = start_telemetry(config, RuntimeEnvironment.TEST)
        app = create_app(telemetry=telemetry)
        telemetry.instrument_app(app)
        with TestClient(app) as client:
            response = client.get("/health/ready")
            assert response.status_code == 200
            assert response.json()["components"]["telemetry"] == "ready"
    finally:
        collector.shutdown()
        collector.server_close()
        thread.join(timeout=2)

    assert "/v1/traces" in paths
    assert "/v1/metrics" in paths


def test_stream_slo_histograms_record_first_delta_and_terminal_once(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class Instrument:
        def __init__(self, name: str, unit: str) -> None:
            self.name = name
            self.unit = unit
            self.measurements: list[tuple[float, dict[str, str]]] = []

        def add(self, value: float, attributes: dict[str, str] | None = None) -> None:
            self.measurements.append((value, attributes or {}))

        def record(self, value: float, attributes: dict[str, str] | None = None) -> None:
            self.measurements.append((value, attributes or {}))

    class Meter:
        def __init__(self) -> None:
            self.instruments: dict[str, Instrument] = {}

        def create_counter(self, name: str, *, unit: str, description: str) -> Instrument:
            del description
            instrument = Instrument(name, unit)
            self.instruments[name] = instrument
            return instrument

        def create_histogram(self, name: str, *, unit: str, description: str) -> Instrument:
            del description
            instrument = Instrument(name, unit)
            self.instruments[name] = instrument
            return instrument

    meter = Meter()
    monkeypatch.setattr(metrics, "get_meter", lambda *_args: meter)
    for name in (
        "_stream_delta_counter",
        "_stream_first_token_counter",
        "_stream_completion_counter",
        "_run_duration_histogram",
        "_time_to_first_token_histogram",
    ):
        monkeypatch.setattr(telemetry_module, name, None)

    record_stream_delta(first=True, elapsed_seconds=0.25)
    record_stream_delta(first=False, elapsed_seconds=None)
    record_stream_completion(status="succeeded", mode="live", elapsed_seconds=1.5)

    first_token = meter.instruments["enterprise.agent_run.time_to_first_token"]
    duration = meter.instruments["enterprise.agent_run.duration"]
    assert first_token.unit == "s"
    assert duration.unit == "s"
    assert first_token.measurements == [
        (
            0.25,
            {
                "enterprise.result.status": "running",
                "agent.stream.mode": "live",
            },
        )
    ]
    assert duration.measurements == [
        (
            1.5,
            {
                "enterprise.result.status": "succeeded",
                "agent.stream.mode": "live",
            },
        )
    ]
    assert len(meter.instruments["enterprise.agent_run.stream.delta"].measurements) == 2
    assert len(meter.instruments["enterprise.agent_run.stream.first_token"].measurements) == 1
    assert len(meter.instruments["enterprise.agent_run.stream.completion"].measurements) == 1
    assert "provider" not in str(first_token.measurements + duration.measurements).lower()
    assert "model" not in str(first_token.measurements + duration.measurements).lower()
