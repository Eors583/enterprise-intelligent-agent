from __future__ import annotations

import json

from enterprise_ai_runtime.observability import resolve_trace_context, structured_access_log


def test_trace_context_preserves_valid_w3c_identity_and_rejects_unsafe_input() -> None:
    correlation_id, trace_id, traceparent = resolve_trace_context(
        request_id="request-1",
        correlation_id="task:42",
        traceparent="00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01",
    )
    assert correlation_id == "task:42"
    assert trace_id == "4bf92f3577b34da6a3ce929d0e0e4736"
    assert traceparent == "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"

    fallback_correlation, fallback_trace_id, fallback_traceparent = resolve_trace_context(
        request_id="request-2",
        correlation_id="unsafe correlation",
        traceparent="00-00000000000000000000000000000000-0000000000000000-01",
    )
    assert fallback_correlation == "request-2"
    assert len(fallback_trace_id) == 32
    assert fallback_traceparent.startswith(f"00-{fallback_trace_id}-")


def test_structured_access_log_excludes_query_and_body_content() -> None:
    payload = structured_access_log(
        request_id="request-1",
        correlation_id="task-1",
        trace_id="4bf92f3577b34da6a3ce929d0e0e4736",
        method="POST",
        path="/internal/v1/runs",
        status_code=202,
        duration_ms=12.36,
        occurred_at_utc="2026-07-28T00:00:00+00:00",
    )

    assert json.loads(payload) == {
        "event": "http_request_completed",
        "occurredAtUtc": "2026-07-28T00:00:00+00:00",
        "requestId": "request-1",
        "correlationId": "task-1",
        "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
        "method": "POST",
        "path": "/internal/v1/runs",
        "statusCode": 202,
        "durationMs": 12.4,
    }
    assert "prompt" not in payload
