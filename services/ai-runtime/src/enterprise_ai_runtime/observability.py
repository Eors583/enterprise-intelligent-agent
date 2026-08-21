from __future__ import annotations

import json
import re
from secrets import token_hex
from typing import Any

CORRELATION_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
TRACEPARENT_PATTERN = re.compile(
    r"^(?P<version>[0-9a-f]{2})-(?P<trace_id>[0-9a-f]{32})-"
    r"(?P<parent_id>[0-9a-f]{16})-(?P<flags>[0-9a-f]{2})$"
)


def resolve_trace_context(
    *,
    request_id: str,
    correlation_id: str | None,
    traceparent: str | None,
) -> tuple[str, str, str]:
    resolved_correlation = (
        correlation_id
        if correlation_id is not None and CORRELATION_ID_PATTERN.fullmatch(correlation_id)
        else request_id
    )
    normalized_traceparent = traceparent.lower() if traceparent is not None else ""
    match = TRACEPARENT_PATTERN.fullmatch(normalized_traceparent)
    if (
        match is not None
        and match.group("version") != "ff"
        and set(match.group("trace_id")) != {"0"}
        and set(match.group("parent_id")) != {"0"}
    ):
        return resolved_correlation, match.group("trace_id"), normalized_traceparent

    trace_id = token_hex(16)
    return resolved_correlation, trace_id, f"00-{trace_id}-{token_hex(8)}-01"


def structured_access_log(
    *,
    request_id: str,
    correlation_id: str,
    trace_id: str,
    method: str,
    path: str,
    status_code: int,
    duration_ms: float,
    occurred_at_utc: str,
) -> str:
    value: dict[str, Any] = {
        "event": "http_request_completed",
        "occurredAtUtc": occurred_at_utc,
        "requestId": request_id,
        "correlationId": correlation_id,
        "traceId": trace_id,
        "method": method,
        # `path` is supplied from request.url.path and therefore excludes query
        # values, request bodies, credentials, and model prompts.
        "path": path,
        "statusCode": status_code,
        "durationMs": round(max(0.0, duration_ms), 1),
    }
    return json.dumps(value, ensure_ascii=True, separators=(",", ":"), sort_keys=True)
