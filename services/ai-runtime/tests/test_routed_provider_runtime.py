from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from uuid import UUID

import pytest
from pydantic import ValidationError

from enterprise_ai_runtime.adapters.routed_provider_runtime import (
    RoutedExecutionError,
    RoutedProviderRuntime,
    UntrustedModelRouteError,
)
from enterprise_ai_runtime.config import ModelRouteCatalogEntry
from enterprise_ai_runtime.domain.errors import (
    ProviderRateLimitError,
    ProviderTimeoutError,
    UnsupportedRuntimeInputError,
)
from enterprise_ai_runtime.domain.models import (
    PrincipalContext,
    PrincipalType,
    RunBudget,
    RunExecutionResult,
    RunInput,
    RunMessage,
    RunOutput,
    RunRecord,
    RunStatus,
    RunUsage,
    SafetyContext,
    SafetyDecision,
    TrustedModelRoute,
)
from enterprise_ai_runtime.ports.provider import ProviderStreamDelta, ProviderStreamTerminal
from enterprise_ai_runtime.ports.runtime import RuntimeStreamDelta, RuntimeStreamTerminal

CATALOG_A = UUID("00000000-0000-7000-8000-000000000101")
CATALOG_B = UUID("00000000-0000-7000-8000-000000000102")
POLICY_ID = UUID("00000000-0000-7000-8000-000000000103")
RUN_ID = UUID("00000000-0000-7000-8000-000000000104")


class StubProvider:
    def __init__(self, behavior: dict[str, RunExecutionResult | Exception]) -> None:
        self.behavior = behavior
        self.calls: list[str] = []

    async def complete(self, request):  # type: ignore[no-untyped-def]
        self.calls.append(request.model)
        result = self.behavior[request.model]
        if isinstance(result, Exception):
            raise result
        return result

    async def cancel(self, _run_id: UUID) -> bool:
        return True

    async def is_ready(self) -> bool:
        return True

    async def aclose(self) -> None:
        return None


class StreamingStubProvider(StubProvider):
    def __init__(self, behavior: dict[str, list[object]]) -> None:
        super().__init__({})
        self.stream_behavior = behavior

    async def stream(self, request):  # type: ignore[no-untyped-def]
        self.calls.append(request.model)
        for item in self.stream_behavior[request.model]:
            if isinstance(item, Exception):
                raise item
            yield item

    async def complete(self, request):  # type: ignore[no-untyped-def]
        raise AssertionError(f"stream-capable provider used complete for {request.model}")


def result(content: str = "Grounded answer [SOURCE:chunk-1]") -> RunExecutionResult:
    return RunExecutionResult(
        output=RunOutput(
            content=content,
            finish_reason="stop",
            model="provider-returned-model",
            provider="provider",
        ),
        usage=RunUsage(
            input_tokens=10,
            output_tokens=5,
            total_tokens=15,
            tool_calls=0,
            cost_micros=10,
        ),
    )


def catalog() -> tuple[ModelRouteCatalogEntry, ...]:
    return (
        ModelRouteCatalogEntry(
            route_key="GENERAL.PRIMARY",
            catalog_version_id=CATALOG_A,
            provider="OPENAI_COMPATIBLE",
            model="model-a",
            credential_reference="vault://ai/general-primary",
        ),
        ModelRouteCatalogEntry(
            route_key="GENERAL.FALLBACK",
            catalog_version_id=CATALOG_B,
            provider="OPENAI_COMPATIBLE",
            model="model-b",
            credential_reference="vault://ai/general-fallback",
        ),
    )


def route(*, tampered: bool = False) -> TrustedModelRoute:
    return TrustedModelRoute.model_validate(
        {
            "schema_version": 1,
            "policy_version_id": str(POLICY_ID),
            "policy_version": 2,
            "policy_hash": "a" * 64,
            "task_class": "GENERAL_QA",
            "maximum_classification": "INTERNAL",
            "required_capabilities": ["chat"],
            "maximum_attempts": 2,
            "circuit_failure_threshold": 2,
            "circuit_open_seconds": 60,
            "candidates": [
                {
                    "ordinal": 1,
                    "catalog_version_id": str(CATALOG_A),
                    "route_key": "GENERAL.PRIMARY",
                    "provider": "OPENAI_COMPATIBLE",
                    "model": "attacker-model" if tampered else "model-a",
                    "credential_reference": "vault://ai/general-primary",
                },
                {
                    "ordinal": 2,
                    "catalog_version_id": str(CATALOG_B),
                    "route_key": "GENERAL.FALLBACK",
                    "provider": "OPENAI_COMPATIBLE",
                    "model": "model-b",
                    "credential_reference": "vault://ai/general-fallback",
                },
            ],
        }
    )


def run(*, model_route: TrustedModelRoute | None = None) -> RunRecord:
    now = datetime.now(UTC)
    input_decision = SafetyDecision(
        direction="INPUT",
        classification="INTERNAL",
        action="ALLOW",
        reason_codes=["NO_SENSITIVE_PATTERN_DETECTED"],
        content_sha256="b" * 64,
        redacted_content_sha256=None,
        detector_version="test-v1",
        decision_hash="c" * 64,
    )
    return RunRecord(
        run_id=RUN_ID,
        tenant_id="tenant-a",
        principal=PrincipalContext(
            principal_id="user-1",
            principal_type=PrincipalType.USER,
        ),
        agent_id="agent-1",
        agent_version="1",
        model_route=model_route,
        safety_context=SafetyContext(
            input_decision=input_decision,
            knowledge_is_untrusted_data=True,
        ),
        input=RunInput(
            messages=[RunMessage(role="user", content="hello")],
        ),
        budget=RunBudget(
            max_input_tokens=16_000,
            max_output_tokens=4_000,
            max_steps=3,
            max_tool_calls=0,
            timeout_ms=60_000,
            max_cost_micros=1_000_000,
        ),
        metadata={},
        status=RunStatus.RUNNING,
        request_id="request-1",
        created_at=now,
        updated_at=now,
    )


def test_route_request_cannot_carry_an_endpoint_or_key() -> None:
    payload = route().model_dump(mode="json")
    payload["candidates"][0]["endpoint"] = "https://attacker.invalid/v1"
    payload["candidates"][0]["api_key"] = "plaintext"
    with pytest.raises(ValidationError):
        TrustedModelRoute.model_validate(payload)


def test_runtime_rejects_a_route_that_does_not_exactly_match_server_allowlist() -> None:
    provider = StubProvider({"model-a": result(), "model-b": result()})
    runtime = RoutedProviderRuntime(provider, catalog=catalog(), require_route=True)
    with pytest.raises(UntrustedModelRouteError):
        asyncio.run(runtime.execute(run(model_route=route(tampered=True)), "request-1"))
    assert provider.calls == []


def test_runtime_rejects_classification_above_route_before_provider_call() -> None:
    provider = StubProvider({"model-a": result(), "model-b": result()})
    runtime = RoutedProviderRuntime(provider, catalog=catalog(), require_route=True)
    unsafe = run(model_route=route()).model_copy(
        update={
            "safety_context": SafetyContext(
                input_decision=SafetyDecision(
                    direction="INPUT",
                    classification="CONFIDENTIAL",
                    action="ALLOW",
                    reason_codes=["CONTEXT_CLASSIFICATION_ENFORCED"],
                    content_sha256="b" * 64,
                    redacted_content_sha256=None,
                    detector_version="test-v1",
                    decision_hash="c" * 64,
                ),
                knowledge_is_untrusted_data=True,
            )
        }
    )

    with pytest.raises(UnsupportedRuntimeInputError):
        asyncio.run(runtime.execute(unsafe, "request-1"))
    assert provider.calls == []


def test_safe_rate_limit_falls_back_once_and_records_immutable_attempts() -> None:
    provider = StubProvider(
        {
            "model-a": ProviderRateLimitError(),
            "model-b": result(),
        }
    )
    runtime = RoutedProviderRuntime(provider, catalog=catalog(), require_route=True)
    executed = asyncio.run(runtime.execute(run(model_route=route()), "request-1"))
    assert provider.calls == ["model-a", "model-b"]
    assert [item.outcome for item in executed.output.model_attempts] == [
        "FAILED",
        "SUCCEEDED",
    ]
    assert executed.output.model_attempts[0].retry_safe is True
    assert executed.output.safety_decision is not None
    assert executed.output.safety_decision.action == "ALLOW"


def test_ambiguous_timeout_never_blindly_switches_to_fallback() -> None:
    provider = StubProvider(
        {
            "model-a": ProviderTimeoutError(),
            "model-b": result(),
        }
    )
    runtime = RoutedProviderRuntime(provider, catalog=catalog(), require_route=True)
    with pytest.raises(RoutedExecutionError) as raised:
        asyncio.run(runtime.execute(run(model_route=route()), "request-1"))
    assert provider.calls == ["model-a"]
    assert raised.value.model_attempts[0].outcome == "UNKNOWN"
    assert raised.value.model_attempts[0].retry_safe is False


def test_generated_secret_material_is_blocked_without_returning_raw_content() -> None:
    provider = StubProvider(
        {
            "model-a": result(
                "credential: -----BEGIN PRIVATE KEY-----\nprivate\n-----END PRIVATE KEY-----"
            ),
            "model-b": result(),
        }
    )
    runtime = RoutedProviderRuntime(provider, catalog=catalog(), require_route=True)
    with pytest.raises(RoutedExecutionError) as raised:
        asyncio.run(runtime.execute(run(model_route=route()), "request-1"))
    assert raised.value.code == "AI_SAFETY_OUTPUT_BLOCKED"
    assert raised.value.safety_decision.action == "BLOCK"
    assert "private" not in str(raised.value.safety_decision.model_dump())


def test_unauthorized_representative_commitment_is_blocked() -> None:
    provider = StubProvider(
        {
            "model-a": result("我代表员工承诺周五交付全部结果。"),
            "model-b": result(),
        }
    )
    runtime = RoutedProviderRuntime(provider, catalog=catalog(), require_route=True)

    with pytest.raises(RoutedExecutionError) as raised:
        asyncio.run(runtime.execute(run(model_route=route()), "request-1"))

    assert raised.value.code == "AI_SAFETY_OUTPUT_BLOCKED"
    assert raised.value.safety_decision.action == "BLOCK"
    assert raised.value.safety_decision.reason_codes == [
        "GENERATED_UNAUTHORIZED_REPRESENTATIVE_ACTION"
    ]


def test_trusted_route_stream_releases_safe_content_before_provider_terminal() -> None:
    prefix = "safe-" * 120
    provider = StreamingStubProvider(
        {
            "model-a": [
                ProviderStreamDelta(content=prefix),
                ProviderStreamDelta(content="answer"),
                ProviderStreamTerminal(result=result(prefix + "answer"), mode="live"),
            ],
            "model-b": [],
        }
    )
    runtime = RoutedProviderRuntime(provider, catalog=catalog(), require_route=True)

    async def exercise() -> tuple[object, list[object]]:
        stream = runtime.stream(run(model_route=route()), "request-1")
        first = await anext(stream)
        remaining = [event async for event in stream]
        return first, remaining

    first, remaining = asyncio.run(exercise())
    assert isinstance(first, RuntimeStreamDelta)
    assert first.content
    assert isinstance(remaining[-1], RuntimeStreamTerminal)
    emitted = first.content + "".join(
        event.content for event in remaining if isinstance(event, RuntimeStreamDelta)
    )
    assert emitted == prefix + "answer"
    assert remaining[-1].mode == "live"
    assert remaining[-1].result.output.content == emitted


def test_stream_releases_a_short_completed_sentence_without_waiting_for_terminal() -> None:
    first_sentence = "这是已经通过输出安全检查的第一句。"
    complete = first_sentence + "这是第二句。"
    provider = StreamingStubProvider(
        {
            "model-a": [
                ProviderStreamDelta(content=first_sentence),
                ProviderStreamDelta(content="这是第二句。"),
                ProviderStreamTerminal(result=result(complete), mode="live"),
            ],
            "model-b": [],
        }
    )
    runtime = RoutedProviderRuntime(provider, catalog=catalog(), require_route=True)

    async def exercise() -> tuple[object, list[object]]:
        stream = runtime.stream(run(model_route=route()), "request-1")
        first = await anext(stream)
        return first, [event async for event in stream]

    first, remaining = asyncio.run(exercise())
    assert isinstance(first, RuntimeStreamDelta)
    assert first.content == first_sentence
    assert isinstance(remaining[-1], RuntimeStreamTerminal)
    assert first.content + "".join(
        event.content for event in remaining if isinstance(event, RuntimeStreamDelta)
    ) == complete


def test_stream_blocks_cross_delta_secret_without_leaking_secret_prefix() -> None:
    safe_prefix = "public " * 100
    provider = StreamingStubProvider(
        {
            "model-a": [
                ProviderStreamDelta(content=safe_prefix + "Bearer abcdefghi"),
                ProviderStreamDelta(content="jklmnopqrstuvwxyz123456"),
                ProviderStreamTerminal(
                    result=result(safe_prefix + "Bearer abcdefghijklmnopqrstuvwxyz123456"),
                    mode="live",
                ),
            ],
            "model-b": [],
        }
    )
    runtime = RoutedProviderRuntime(provider, catalog=catalog(), require_route=True)

    async def exercise() -> tuple[list[str], RoutedExecutionError]:
        emitted: list[str] = []
        with pytest.raises(RoutedExecutionError) as raised:
            async for event in runtime.stream(run(model_route=route()), "request-1"):
                if isinstance(event, RuntimeStreamDelta):
                    emitted.append(event.content)
        return emitted, raised.value

    emitted, error = asyncio.run(exercise())
    released = "".join(emitted)
    assert "Bearer" not in released
    assert "abcdefghijklmnopqrstuvwxyz123456" not in released
    assert error.code == "AI_SAFETY_OUTPUT_BLOCKED"
    assert error.safety_decision.action == "BLOCK"
    assert error.model_attempts[0].outcome == "UNKNOWN"
    assert error.retryable is False


def test_stream_blocks_cross_delta_representative_action_before_it_is_released() -> None:
    safe_prefix = "以下是未发送的草稿。" * 80
    raw = safe_prefix + "我代表员工承诺周五交付。"
    provider = StreamingStubProvider(
        {
            "model-a": [
                ProviderStreamDelta(content=safe_prefix + "我代表员工承诺"),
                ProviderStreamDelta(content="周五交付。"),
                ProviderStreamTerminal(result=result(raw), mode="live"),
            ],
            "model-b": [],
        }
    )
    runtime = RoutedProviderRuntime(provider, catalog=catalog(), require_route=True)

    async def exercise() -> tuple[str, RoutedExecutionError]:
        emitted: list[str] = []
        with pytest.raises(RoutedExecutionError) as raised:
            async for event in runtime.stream(run(model_route=route()), "request-1"):
                if isinstance(event, RuntimeStreamDelta):
                    emitted.append(event.content)
        return "".join(emitted), raised.value

    emitted, error = asyncio.run(exercise())
    assert "我代表员工承诺周五交付" not in emitted
    assert error.code == "AI_SAFETY_OUTPUT_BLOCKED"
    assert error.safety_decision.reason_codes == [
        "GENERATED_UNAUTHORIZED_REPRESENTATIVE_ACTION"
    ]


def test_stream_redacts_cross_delta_pii_and_terminal_matches_emitted_content() -> None:
    prefix = "safe " * 120
    raw = prefix + "contact employee@example.com today"
    provider = StreamingStubProvider(
        {
            "model-a": [
                ProviderStreamDelta(content=prefix + "contact employee@"),
                ProviderStreamDelta(content="example.com today"),
                ProviderStreamTerminal(result=result(raw), mode="live"),
            ],
            "model-b": [],
        }
    )
    runtime = RoutedProviderRuntime(provider, catalog=catalog(), require_route=True)

    async def exercise() -> list[object]:
        return [event async for event in runtime.stream(run(model_route=route()), "request-1")]

    events = asyncio.run(exercise())
    terminal = events[-1]
    assert isinstance(terminal, RuntimeStreamTerminal)
    emitted = "".join(event.content for event in events if isinstance(event, RuntimeStreamDelta))
    assert "employee@example.com" not in emitted
    assert "[REDACTED_EMAIL]" in emitted
    assert terminal.result.output.content == emitted
    assert terminal.result.output.safety_decision.action == "REDACT"


def test_stream_fails_closed_on_unbounded_email_candidate_without_leaking_it() -> None:
    prefix = "safe " * 120
    candidate = ("a" * 64) + "@" + ("domain" * 60)
    provider = StreamingStubProvider(
        {
            "model-a": [
                ProviderStreamDelta(content=prefix + candidate[:120]),
                ProviderStreamDelta(content=candidate[120:]),
                ProviderStreamTerminal(result=result(prefix + candidate), mode="live"),
            ],
            "model-b": [],
        }
    )
    runtime = RoutedProviderRuntime(provider, catalog=catalog(), require_route=True)

    async def exercise() -> tuple[str, RoutedExecutionError]:
        emitted: list[str] = []
        with pytest.raises(RoutedExecutionError) as raised:
            async for event in runtime.stream(run(model_route=route()), "request-1"):
                if isinstance(event, RuntimeStreamDelta):
                    emitted.append(event.content)
        return "".join(emitted), raised.value

    emitted, error = asyncio.run(exercise())
    assert "@" not in emitted
    assert error.code == "AI_SAFETY_OUTPUT_BLOCKED"
    assert error.safety_decision.reason_codes == ["GENERATED_UNBOUNDED_PII_DETECTED"]
    assert error.model_attempts[0].outcome == "UNKNOWN"


def test_stream_rate_limit_before_any_delta_can_use_bounded_fallback() -> None:
    content = "safe " * 120
    provider = StreamingStubProvider(
        {
            "model-a": [ProviderRateLimitError()],
            "model-b": [
                ProviderStreamDelta(content=content),
                ProviderStreamTerminal(result=result(content), mode="live"),
            ],
        }
    )
    runtime = RoutedProviderRuntime(provider, catalog=catalog(), require_route=True)

    async def exercise() -> list[object]:
        return [event async for event in runtime.stream(run(model_route=route()), "request-1")]

    events = asyncio.run(exercise())
    terminal = events[-1]
    assert provider.calls == ["model-a", "model-b"]
    assert isinstance(terminal, RuntimeStreamTerminal)
    assert [attempt.outcome for attempt in terminal.result.output.model_attempts] == [
        "FAILED",
        "SUCCEEDED",
    ]


def test_stream_never_retries_an_error_after_receiving_even_a_buffered_delta() -> None:
    content = "short-safe-delta"
    provider = StreamingStubProvider(
        {
            "model-a": [
                ProviderStreamDelta(content=content),
                ProviderRateLimitError(),
            ],
            "model-b": [
                ProviderStreamDelta(content="fallback"),
                ProviderStreamTerminal(result=result("fallback"), mode="live"),
            ],
        }
    )
    runtime = RoutedProviderRuntime(provider, catalog=catalog(), require_route=True)

    async def exercise() -> RoutedExecutionError:
        with pytest.raises(RoutedExecutionError) as raised:
            async for _event in runtime.stream(run(model_route=route()), "request-1"):
                pass
        return raised.value

    error = asyncio.run(exercise())
    assert provider.calls == ["model-a"]
    assert error.model_attempts[0].outcome == "UNKNOWN"
    assert error.model_attempts[0].retry_safe is False
    assert error.retryable is False
