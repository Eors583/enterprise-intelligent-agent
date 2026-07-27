from __future__ import annotations

import asyncio
from uuid import UUID

import pytest
from fastapi.testclient import TestClient

from enterprise_ai_runtime.adapters.memory_run_store import InMemoryRunStore
from enterprise_ai_runtime.adapters.provider_runtime import ProviderRuntime
from enterprise_ai_runtime.domain.errors import ProviderRateLimitError
from enterprise_ai_runtime.domain.models import (
    RunCreateRequest,
    RunExecutionResult,
    RunOutput,
    RunRecord,
    RunUsage,
)
from enterprise_ai_runtime.main import create_app
from enterprise_ai_runtime.ports.provider import ProviderCompletionRequest
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


def result_with_usage(
    *,
    input_tokens: int = 100,
    output_tokens: int = 20,
    cost_micros: int = 50,
    tool_calls: int = 0,
) -> RunExecutionResult:
    return RunExecutionResult(
        output=RunOutput(
            content="Project summary",
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
