from __future__ import annotations

import asyncio
from uuid import UUID

import pytest
from fastapi.testclient import TestClient

from enterprise_ai_runtime.adapters.memory_run_store import InMemoryRunStore
from enterprise_ai_runtime.adapters.provider_runtime import ProviderRuntime
from enterprise_ai_runtime.adapters.routed_provider_runtime import RoutedProviderRuntime
from enterprise_ai_runtime.config import ModelRouteCatalogEntry
from enterprise_ai_runtime.domain.errors import ProviderRateLimitError
from enterprise_ai_runtime.domain.models import (
    RunCreateRequest,
    RunExecutionResult,
    RunOutput,
    RunRecord,
    RunStreamDeltaEvent,
    RunStreamTerminalEvent,
    RunUsage,
)
from enterprise_ai_runtime.main import create_app
from enterprise_ai_runtime.ports.provider import (
    ProviderCompletionRequest,
    ProviderStreamDelta,
    ProviderStreamTerminal,
)
from enterprise_ai_runtime.ports.runtime import RuntimeStreamDelta, RuntimeStreamTerminal
from enterprise_ai_runtime.services.run_service import RunService


class StaticRuntime:
    def __init__(self, result: RunExecutionResult, *, cancel_confirmed: bool = True) -> None:
        self.result = result
        self.cancel_confirmed = cancel_confirmed
        self.execute_calls = 0
        self.cancel_calls = 0
        self.request_ids: list[str] = []

    async def execute(self, run: RunRecord, request_id: str) -> RunExecutionResult:
        self.execute_calls += 1
        self.request_ids.append(request_id)
        return self.result

    async def cancel(self, run: RunRecord) -> bool:
        self.cancel_calls += 1
        return self.cancel_confirmed

    async def is_ready(self) -> bool:
        return True

    async def aclose(self) -> None:
        return None


class FailingRuntime(StaticRuntime):
    async def execute(self, run: RunRecord, request_id: str) -> RunExecutionResult:
        self.execute_calls += 1
        self.request_ids.append(request_id)
        raise ProviderRateLimitError()


class StreamingRuntime(StaticRuntime):
    def __init__(self, result: RunExecutionResult) -> None:
        super().__init__(result)
        self.stream_calls = 0
        self.first_delta_emitted = asyncio.Event()
        self.release_terminal = asyncio.Event()

    async def stream(self, run: RunRecord, request_id: str):  # type: ignore[no-untyped-def]
        self.stream_calls += 1
        self.request_ids.append(request_id)
        yield RuntimeStreamDelta(content="Project ")
        self.first_delta_emitted.set()
        await self.release_terminal.wait()
        yield RuntimeStreamDelta(content="summary")
        yield RuntimeStreamTerminal(result=self.result, mode="live")


class BlockingProvider:
    def __init__(self) -> None:
        self.started = asyncio.Event()
        self.calls = 0
        self.closed = False
        self.requests: list[ProviderCompletionRequest] = []

    async def complete(self, request: ProviderCompletionRequest) -> RunExecutionResult:
        self.calls += 1
        self.requests.append(request)
        self.started.set()
        await asyncio.Event().wait()
        raise AssertionError("the blocking provider should be cancelled")

    async def is_ready(self) -> bool:
        return True

    async def cancel(self, _run_id: UUID) -> bool:
        return True

    async def aclose(self) -> None:
        self.closed = True


class RoutedStreamingProvider:
    def __init__(self, content: str) -> None:
        self.content = content
        self.calls = 0

    async def complete(self, _request: ProviderCompletionRequest) -> RunExecutionResult:
        raise AssertionError("the routed API path must preserve provider streaming")

    async def stream(self, request: ProviderCompletionRequest):  # type: ignore[no-untyped-def]
        self.calls += 1
        first = self.content[:560]
        yield ProviderStreamDelta(content=first)
        yield ProviderStreamDelta(content=self.content[560:])
        yield ProviderStreamTerminal(
            result=result_with_usage(content=self.content),
            mode="live",
        )

    async def is_ready(self) -> bool:
        return True

    async def cancel(self, _run_id: UUID) -> bool:
        return False

    async def aclose(self) -> None:
        return None


def result_with_usage(
    *,
    content: str = "Project summary",
    input_tokens: int = 100,
    output_tokens: int = 20,
    cost_micros: int = 50,
    tool_calls: int = 0,
) -> RunExecutionResult:
    return RunExecutionResult(
        output=RunOutput(
            content=content,
            finish_reason="stop",
            model="model-a",
            provider="mock",
            response_id="response-1",
        ),
        usage=RunUsage(
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            total_tokens=input_tokens + output_tokens,
            tool_calls=tool_calls,
            cost_micros=cost_micros,
        ),
    )


def create_run(client: TestClient, payload: dict[str, object]) -> str:
    response = client.post(
        "/internal/v1/runs",
        headers={"X-Tenant-ID": "tenant-a"},
        json=payload,
    )
    assert response.status_code == 202
    return response.json()["run_id"]


def test_execute_saves_result_usage_timestamps_and_is_idempotent(
    run_payload: dict[str, object],
) -> None:
    runtime = StaticRuntime(result_with_usage())
    with TestClient(create_app(runtime=runtime)) as client:
        run_id = create_run(client, run_payload)
        executed = client.post(
            f"/internal/v1/runs/{run_id}/execute",
            headers={"X-Tenant-ID": "tenant-a", "X-Request-ID": "req-execute-1"},
        )
        repeated = client.post(
            f"/internal/v1/runs/{run_id}/execute",
            headers={"X-Tenant-ID": "tenant-a", "X-Request-ID": "req-execute-2"},
        )

    assert executed.status_code == 200
    assert executed.headers["X-Request-ID"] == "req-execute-1"
    body = executed.json()
    assert body["status"] == "succeeded"
    assert body["output"]["content"] == "Project summary"
    assert body["usage"]["total_tokens"] == 120
    assert body["started_at"] is not None
    assert body["finished_at"] is not None
    assert body["execution_request_id"] == "req-execute-1"
    assert body["version"] == 3
    assert repeated.json() == body
    assert runtime.execute_calls == 1
    assert runtime.request_ids == ["req-execute-1"]


def test_provider_error_is_sanitized_and_persisted(
    run_payload: dict[str, object],
) -> None:
    runtime = FailingRuntime(result_with_usage())
    with TestClient(create_app(runtime=runtime)) as client:
        run_id = create_run(client, run_payload)
        response = client.post(
            f"/internal/v1/runs/{run_id}/execute",
            headers={"X-Tenant-ID": "tenant-a"},
        )

    assert response.status_code == 200
    assert response.json()["status"] == "failed"
    assert response.json()["error"] == {
        "code": "PROVIDER_RATE_LIMITED",
        "message": "model provider rate limit was reached",
        "retryable": True,
        "model_attempts": [],
        "safety_decision": None,
    }
    assert response.json()["output"] is None
    assert response.json()["finished_at"] is not None


@pytest.mark.parametrize(
    ("usage_overrides", "expected_code"),
    [
        ({"input_tokens": 16_001}, "INPUT_TOKEN_BUDGET_EXCEEDED"),
        ({"output_tokens": 2_001}, "OUTPUT_TOKEN_BUDGET_EXCEEDED"),
        ({"tool_calls": 6}, "TOOL_CALL_BUDGET_EXCEEDED"),
        ({"cost_micros": 1_000_001}, "COST_BUDGET_EXCEEDED"),
    ],
)
def test_usage_over_budget_fails_and_keeps_auditable_usage(
    run_payload: dict[str, object],
    usage_overrides: dict[str, int],
    expected_code: str,
) -> None:
    runtime = StaticRuntime(result_with_usage(**usage_overrides))
    with TestClient(create_app(runtime=runtime)) as client:
        run_id = create_run(client, run_payload)
        response = client.post(
            f"/internal/v1/runs/{run_id}/execute",
            headers={"X-Tenant-ID": "tenant-a"},
        )

    body = response.json()
    assert body["status"] == "failed"
    assert body["error"]["code"] == expected_code
    assert body["usage"] is not None
    assert body["output"]["content"] == "Project summary"
    assert body["version"] == 3


def test_execute_is_tenant_scoped_and_terminal_cancel_is_idempotent(
    run_payload: dict[str, object],
) -> None:
    runtime = StaticRuntime(result_with_usage())
    with TestClient(create_app(runtime=runtime)) as client:
        run_id = create_run(client, run_payload)
        hidden = client.post(
            f"/internal/v1/runs/{run_id}/execute",
            headers={"X-Tenant-ID": "tenant-b"},
        )
        cancelled = client.post(
            f"/internal/v1/runs/{run_id}/cancel",
            headers={"X-Tenant-ID": "tenant-a"},
        )
        executed_after_cancel = client.post(
            f"/internal/v1/runs/{run_id}/execute",
            headers={"X-Tenant-ID": "tenant-a"},
        )

    assert hidden.status_code == 404
    assert cancelled.json()["status"] == "cancelled"
    assert executed_after_cancel.json() == cancelled.json()
    assert runtime.execute_calls == 0
    assert runtime.cancel_calls == 1


def test_unconfirmed_cancel_does_not_claim_that_the_run_stopped(
    run_payload: dict[str, object],
) -> None:
    runtime = StaticRuntime(result_with_usage(), cancel_confirmed=False)
    with TestClient(create_app(runtime=runtime)) as client:
        run_id = create_run(client, run_payload)
        cancellation = client.post(
            f"/internal/v1/runs/{run_id}/cancel",
            headers={"X-Tenant-ID": "tenant-a"},
        )
        executed = client.post(
            f"/internal/v1/runs/{run_id}/execute",
            headers={"X-Tenant-ID": "tenant-a"},
        )

    assert cancellation.status_code == 200
    assert cancellation.json()["status"] == "queued"
    assert executed.json()["status"] == "succeeded"
    assert runtime.cancel_calls == 1


def test_default_noop_fails_explicitly_without_external_usage(
    run_payload: dict[str, object],
) -> None:
    with TestClient(create_app()) as client:
        run_id = create_run(client, run_payload)
        response = client.post(
            f"/internal/v1/runs/{run_id}/execute",
            headers={"X-Tenant-ID": "tenant-a"},
        )

    body = response.json()
    assert body["status"] == "failed"
    assert body["error"] == {
        "code": "RUNTIME_NOT_CONFIGURED",
        "message": "no model runtime is configured",
        "retryable": False,
        "model_attempts": [],
        "safety_decision": None,
    }
    assert body["output"] is None
    assert body["usage"] is None


def test_provider_runtime_rejects_oversized_input_before_a_paid_call(
    run_payload: dict[str, object],
) -> None:
    provider = BlockingProvider()
    runtime = ProviderRuntime(provider, model="model-a")
    oversized = {
        **run_payload,
        "input": {
            "messages": [{"role": "user", "content": "问" * 6_000}],
            "attachments": [],
            "variables": {},
        },
    }
    with TestClient(create_app(runtime=runtime)) as client:
        run_id = create_run(client, oversized)
        response = client.post(
            f"/internal/v1/runs/{run_id}/execute",
            headers={"X-Tenant-ID": "tenant-a"},
        )

    assert response.status_code == 200
    assert response.json()["status"] == "failed"
    assert response.json()["error"]["code"] == "INPUT_TOKEN_BUDGET_PREFLIGHT_EXCEEDED"
    assert provider.calls == 0


def test_cancel_wins_safely_against_in_flight_execute(
    run_payload: dict[str, object],
) -> None:
    async def scenario() -> None:
        provider = BlockingProvider()
        runtime = ProviderRuntime(provider, model="model-a")
        store = InMemoryRunStore()
        service = RunService(store, runtime)
        run = await service.create(
            RunCreateRequest.model_validate(run_payload),
            "req-create-race",
        )

        execution = asyncio.create_task(
            service.execute(run.tenant_id, run.run_id, "req-execute-race")
        )
        await asyncio.wait_for(provider.started.wait(), timeout=1)
        cancelled = await service.cancel(run.tenant_id, run.run_id)
        execute_result = await asyncio.wait_for(execution, timeout=1)
        final = await store.get(run.tenant_id, run.run_id)
        await runtime.aclose()

        assert cancelled.status.value == "cancelled"
        assert execute_result.status.value == "cancelled"
        assert final.status.value == "cancelled"
        assert final.version == 3
        assert provider.calls == 1
        assert provider.requests[0].model == "model-a"
        assert provider.requests[0].timeout_ms == 60_000
        assert provider.requests[0].max_input_tokens == 16_000
        assert provider.requests[0].max_output_tokens == 2_000
        assert provider.requests[0].run_id == run.run_id
        assert provider.closed is True

    asyncio.run(scenario())


def test_stream_disconnect_replays_durable_session_without_second_execution(
    run_payload: dict[str, object],
) -> None:
    async def scenario() -> None:
        runtime = StreamingRuntime(result_with_usage())
        store = InMemoryRunStore()
        service = RunService(store, runtime)
        run = await service.create(
            RunCreateRequest.model_validate(run_payload),
            "req-create-stream",
        )

        first_subscription = service.stream(
            run.tenant_id,
            run.run_id,
            "req-stream-first",
            cursor=0,
        )
        first = await anext(first_subscription)
        assert isinstance(first, RunStreamDeltaEvent)
        assert first.sequence == 1
        assert first.delta == "Project "
        await first_subscription.aclose()

        # Closing the HTTP/subscriber iterator must not cancel the paid provider
        # execution owned by the RunService background session.
        assert runtime.stream_calls == 1
        runtime.release_terminal.set()
        for _ in range(100):
            final = await store.get(run.tenant_id, run.run_id)
            if final.status.is_terminal:
                break
            await asyncio.sleep(0)
        assert final.status.value == "succeeded"

        replay = [
            event
            async for event in service.stream(
                run.tenant_id,
                run.run_id,
                "req-stream-reconnect",
                cursor=0,
            )
        ]
        resumed = [
            event
            async for event in service.stream(
                run.tenant_id,
                run.run_id,
                "req-stream-resume-cursor",
                cursor=1,
            )
        ]

        assert runtime.stream_calls == 1
        assert [event.sequence for event in replay] == [1, 2, 3]
        assert [event.delta for event in replay if isinstance(event, RunStreamDeltaEvent)] == [
            "Project ",
            "summary",
        ]
        assert isinstance(replay[-1], RunStreamTerminalEvent)
        assert replay[-1].type == "terminal"
        assert [event.sequence for event in resumed] == [2, 3]

    asyncio.run(scenario())


def test_api_preserves_governed_live_stream_and_persists_terminal_evidence(
    run_payload: dict[str, object],
) -> None:
    catalog_id = UUID("00000000-0000-7000-8000-000000000901")
    content = "governed-safe-output " * 40
    provider = RoutedStreamingProvider(content)
    runtime = RoutedProviderRuntime(
        provider,
        catalog=(
            ModelRouteCatalogEntry(
                route_key="GENERAL.PRIMARY",
                catalog_version_id=catalog_id,
                provider="OPENAI_COMPATIBLE",
                model="model-a",
                credential_reference="vault://ai/general-primary",
            ),
        ),
        require_route=True,
    )
    governed_payload = {
        **run_payload,
        "model_route": {
            "schema_version": 1,
            "policy_version_id": "00000000-0000-7000-8000-000000000902",
            "policy_version": 1,
            "policy_hash": "a" * 64,
            "task_class": "GENERAL_QA",
            "maximum_classification": "INTERNAL",
            "required_capabilities": ["chat"],
            "maximum_attempts": 1,
            "circuit_failure_threshold": 3,
            "circuit_open_seconds": 60,
            "candidates": [
                {
                    "ordinal": 1,
                    "catalog_version_id": str(catalog_id),
                    "route_key": "GENERAL.PRIMARY",
                    "provider": "OPENAI_COMPATIBLE",
                    "model": "model-a",
                    "credential_reference": "vault://ai/general-primary",
                }
            ],
        },
        "safety_context": {
            "input_decision": {
                "direction": "INPUT",
                "classification": "INTERNAL",
                "action": "ALLOW",
                "reason_codes": ["NO_SENSITIVE_PATTERN_DETECTED"],
                "content_sha256": "b" * 64,
                "redacted_content_sha256": None,
                "detector_version": "test-v1",
                "decision_hash": "c" * 64,
            },
            "knowledge_is_untrusted_data": True,
        },
    }

    with TestClient(create_app(runtime=runtime)) as client:
        run_id = create_run(client, governed_payload)
        streamed = client.post(
            f"/internal/v1/runs/{run_id}/execute/stream",
            headers={
                "X-Tenant-ID": "tenant-a",
                "Accept": "text/event-stream",
            },
        )
        persisted = client.get(
            f"/internal/v1/runs/{run_id}",
            headers={"X-Tenant-ID": "tenant-a"},
        )

    assert streamed.status_code == 200
    assert "event: delta" in streamed.text
    assert "event: terminal\n" in streamed.text
    assert "event: terminal_only" not in streamed.text
    assert persisted.json()["status"] == "succeeded"
    assert persisted.json()["output"]["content"] == content
    assert persisted.json()["output"]["model_attempts"][0]["outcome"] == "SUCCEEDED"
    assert persisted.json()["output"]["safety_decision"]["action"] == "ALLOW"
    assert provider.calls == 1


def test_provider_runtime_labels_non_stream_provider_terminal_only(
    run_payload: dict[str, object],
) -> None:
    class TerminalOnlyProvider:
        def __init__(self) -> None:
            self.calls = 0

        async def complete(self, request: ProviderCompletionRequest) -> RunExecutionResult:
            self.calls += 1
            return result_with_usage()

        async def cancel(self, _run_id: UUID) -> bool:
            return False

        async def is_ready(self) -> bool:
            return True

        async def aclose(self) -> None:
            return None

    async def scenario() -> None:
        provider = TerminalOnlyProvider()
        runtime = ProviderRuntime(provider, model="manus-1.6-lite")  # type: ignore[arg-type]
        service = RunService(InMemoryRunStore(), runtime)
        run = await service.create(
            RunCreateRequest.model_validate(run_payload),
            "req-create-terminal-only",
        )
        events = [
            event
            async for event in service.stream(
                run.tenant_id,
                run.run_id,
                "req-stream-terminal-only",
            )
        ]

        assert provider.calls == 1
        assert len(events) == 1
        assert isinstance(events[0], RunStreamTerminalEvent)
        assert events[0].type == "terminal_only"
        assert events[0].run.status.value == "succeeded"

    asyncio.run(scenario())
