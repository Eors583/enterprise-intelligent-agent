from __future__ import annotations

import asyncio
import json
import traceback
from dataclasses import replace
from typing import Any
from uuid import UUID

import httpx
import pytest

from enterprise_ai_runtime.adapters.manus_provider import ManusProvider
from enterprise_ai_runtime.domain.errors import (
    ProviderAuthenticationError,
    ProviderInteractionRequiredError,
    ProviderRateLimitError,
    ProviderRequestError,
    ProviderResponseError,
    ProviderTaskError,
    ProviderTimeoutError,
    ProviderUnavailableError,
)
from enterprise_ai_runtime.domain.models import MessageRole, RunMessage
from enterprise_ai_runtime.ports.provider import ProviderCompletionRequest

RUN_ID = UUID("00000000-0000-4000-8000-000000000101")


def completion_request(*, run_id: UUID = RUN_ID) -> ProviderCompletionRequest:
    return ProviderCompletionRequest(
        messages=(
            RunMessage(role=MessageRole.SYSTEM, content="Be concise."),
            RunMessage(role=MessageRole.USER, content="Summarize this project."),
        ),
        model="manus-1.6-lite",
        timeout_ms=5_000,
        max_input_tokens=10_000,
        max_output_tokens=500,
        request_id="req-manus-1",
        run_id=run_id,
    )


def success_body(
    task_id: str,
    *,
    content: str = "Project summary",
) -> dict[str, Any]:
    return {
        "ok": True,
        "request_id": "manus-request-list",
        "task_id": task_id,
        "messages": [
            {
                "id": f"event-status-{task_id}",
                "type": "status_update",
                "timestamp": "1785259942341",
                "status_update": {"agent_status": "stopped"},
            },
            {
                "id": f"event-answer-{task_id}",
                "type": "assistant_message",
                "timestamp": "1785259942340",
                "assistant_message": {"content": content, "attachments": []},
            },
        ],
        "has_more": False,
    }


def test_manus_readiness_uses_cached_authenticated_task_list_probe() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        assert request.url.path == "/v2/task.list"
        return httpx.Response(
            200,
            json={
                "ok": True,
                "request_id": "readiness-list",
                "data": [
                    {
                        "id": "task-readiness",
                        "status": "stopped",
                        "created_at": 1,
                        "updated_at": 2,
                        "title": "redacted",
                        "credit_usage": 0,
                        "task_url": "https://manus.im/app/task-readiness",
                    }
                ],
                "has_more": False,
            },
        )

    async def scenario() -> None:
        provider = ManusProvider(
            base_url="https://api.manus.ai",
            api_key="dummy-manus-key",
            client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        )
        assert await provider.is_ready() is True
        assert await provider.is_ready() is True
        await provider.aclose()
        assert await provider.is_ready() is False

    asyncio.run(scenario())
    assert len(requests) == 1
    assert requests[0].url.params["limit"] == "1"
    assert requests[0].url.params["order"] == "desc"
    assert requests[0].headers["x-manus-api-key"] == "dummy-manus-key"


def test_manus_readiness_fails_closed_for_invalid_task_list_envelope() -> None:
    request_count = 0

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal request_count
        request_count += 1
        return httpx.Response(
            200,
            json={
                "ok": True,
                "request_id": "readiness-invalid",
                "data": [{"id": "task-without-status"}],
                "has_more": False,
            },
        )

    async def scenario() -> None:
        provider = ManusProvider(
            base_url="https://api.manus.ai",
            api_key="dummy-manus-key",
            client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        )
        assert await provider.is_ready() is False
        assert await provider.is_ready() is False
        await provider.aclose()

    asyncio.run(scenario())
    assert request_count == 1


def test_manus_creates_private_isolated_task_and_polls_until_stopped() -> None:
    captured: list[httpx.Request] = []
    list_calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal list_calls
        captured.append(request)
        if request.url.path == "/v2/task.create":
            return httpx.Response(
                200,
                json={
                    "ok": True,
                    "request_id": "manus-request-create",
                    "task_id": "task-isolated-1",
                    "task_title": "Enterprise run",
                    "task_url": "https://manus.im/app/task-isolated-1",
                    "share_visibility": "private",
                },
            )
        if request.url.path == "/v2/task.listMessages":
            list_calls += 1
            if list_calls == 1:
                return httpx.Response(
                    200,
                    json={
                        "ok": True,
                        "request_id": "manus-request-running",
                        "task_id": "task-isolated-1",
                        "messages": [
                            {
                                "id": "event-running",
                                "type": "status_update",
                                "timestamp": 1,
                                "status_update": {"agent_status": "running"},
                            }
                        ],
                        "has_more": False,
                    },
                )
            return httpx.Response(200, json=success_body("task-isolated-1"))
        raise AssertionError(f"unexpected Manus path {request.url.path}")

    async def scenario() -> tuple[Any, list[float]]:
        sleeps: list[float] = []

        async def no_wait(delay: float) -> None:
            sleeps.append(delay)

        provider = ManusProvider(
            base_url="https://api.manus.ai",
            api_key="dummy-manus-key",
            project_id="project-approved",
            poll_interval_seconds=2,
            max_wait_seconds=10,
            client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
            sleep=no_wait,
        )
        result = await provider.complete(completion_request())
        await provider.aclose()
        return result, sleeps

    result, sleeps = asyncio.run(scenario())

    assert [request.url.path for request in captured] == [
        "/v2/task.create",
        "/v2/task.listMessages",
        "/v2/task.listMessages",
    ]
    create_request = captured[0]
    assert create_request.headers["x-manus-api-key"] == "dummy-manus-key"
    payload = json.loads(create_request.content)
    assert payload["interactive_mode"] is False
    assert payload["hide_in_task_list"] is True
    assert payload["share_visibility"] == "private"
    assert payload["agent_profile"] == "manus-1.6-lite"
    assert payload["project_id"] == "project-approved"
    assert payload["title"] == f"enterprise-run-{RUN_ID}"
    assert payload["message"]["connectors"] == []
    assert payload["locale"] == "zh-CN"
    assert "structured_output_schema" not in payload
    assert "agent-default-main_task" not in create_request.content.decode()
    assert payload["message"]["content"][0]["type"] == "text"
    message_envelope = payload["message"]["content"][0]["text"]
    assert '"role":"system"' in message_envelope
    assert '"role":"user"' in message_envelope
    assert captured[1].url.params["task_id"] == "task-isolated-1"
    assert sleeps == [2]
    assert result.output.content == "Project summary"
    assert result.output.provider == "manus"
    assert result.output.model == "manus-1.6-lite"
    assert result.output.response_id == "event-answer-task-isolated-1"
    assert result.usage.model_dump() == {
        "input_tokens": 0,
        "output_tokens": 0,
        "total_tokens": 0,
        "tool_calls": 0,
        "cost_micros": 0,
        "tokens_reported": False,
        "cost_reported": False,
    }


def test_manus_retries_fresh_task_visibility_without_creating_again() -> None:
    create_calls = 0
    list_calls = 0
    delays: list[float] = []

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal create_calls, list_calls
        if request.url.path == "/v2/task.create":
            create_calls += 1
            return httpx.Response(
                200,
                json={"ok": True, "request_id": "create", "task_id": "task-eventual"},
            )
        if request.url.path == "/v2/task.listMessages":
            list_calls += 1
            if list_calls == 1:
                return httpx.Response(404, json={"ok": False, "error": {"code": "not_found"}})
            if list_calls == 2:
                return httpx.Response(
                    200,
                    json={
                        "ok": False,
                        "request_id": "not-visible-yet",
                        "error": {"code": "failed_precondition", "message": "private detail"},
                    },
                )
            return httpx.Response(200, json=success_body("task-eventual"))
        raise AssertionError(f"unexpected Manus path {request.url.path}")

    async def no_wait(delay: float) -> None:
        delays.append(delay)

    async def scenario() -> None:
        provider = ManusProvider(
            base_url="https://api.manus.ai",
            api_key="dummy-manus-key",
            client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
            sleep=no_wait,
        )
        result = await provider.complete(completion_request())
        assert result.output.content == "Project summary"
        await provider.aclose()

    asyncio.run(scenario())
    assert create_calls == 1
    assert list_calls == 3
    assert delays == [0.25, 0.5]


def test_manus_retries_transient_incomplete_task_reads_without_creating_again(
    caplog: pytest.LogCaptureFixture,
) -> None:
    create_calls = 0
    list_calls = 0
    stop_calls = 0
    delays: list[float] = []

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal create_calls, list_calls, stop_calls
        if request.url.path == "/v2/task.create":
            create_calls += 1
            return httpx.Response(
                200,
                json={"ok": True, "request_id": "create", "task_id": "task-incomplete"},
            )
        if request.url.path == "/v2/task.listMessages":
            list_calls += 1
            if list_calls == 1:
                return httpx.Response(
                    200,
                    content=b"dummy-manus-key and private invalid json",
                    headers={"Content-Type": "application/json"},
                )
            if list_calls == 2:
                return httpx.Response(
                    200,
                    json={
                        "ok": True,
                        "request_id": "private missing messages",
                        "task_id": "task-incomplete",
                    },
                )
            if list_calls == 3:
                return httpx.Response(
                    200,
                    json={
                        "ok": True,
                        "request_id": "private malformed status",
                        "task_id": "task-incomplete",
                        "messages": [
                            {
                                "id": "event-malformed-status",
                                "type": "status_update",
                                "timestamp": 1,
                                "status_update": {"private": "dummy-manus-key"},
                            }
                        ],
                    },
                )
            if list_calls == 4:
                return httpx.Response(
                    200,
                    json={
                        "ok": True,
                        "request_id": "private malformed answer",
                        "task_id": "task-incomplete",
                        "messages": [
                            {
                                "id": "event-stopped-with-malformed-answer",
                                "type": "status_update",
                                "timestamp": 2,
                                "status_update": {"agent_status": "stopped"},
                            },
                            {
                                "id": "event-malformed-answer",
                                "type": "assistant_message",
                                "timestamp": 1,
                                "assistant_message": {"content": {"private": "dummy-manus-key"}},
                            },
                        ],
                    },
                )
            return httpx.Response(200, json=success_body("task-incomplete"))
        if request.url.path == "/v2/task.stop":
            stop_calls += 1
            return httpx.Response(200, json={"ok": True, "request_id": "stop"})
        raise AssertionError(f"unexpected Manus path {request.url.path}")

    async def no_wait(delay: float) -> None:
        delays.append(delay)

    async def scenario() -> None:
        provider = ManusProvider(
            base_url="https://api.manus.ai",
            api_key="dummy-manus-key",
            client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
            sleep=no_wait,
        )
        result = await provider.complete(completion_request())
        assert result.output.content == "Project summary"
        await provider.aclose()

    asyncio.run(scenario())
    assert create_calls == 1
    assert list_calls == 5
    assert stop_calls == 0
    assert delays == [0.25, 0.5, 1.0, 2.0]
    assert "stage=response_envelope" in caplog.text
    assert "stage=messages" in caplog.text
    assert "stage=status" in caplog.text
    assert "stage=assistant_message" in caplog.text
    assert "dummy-manus-key" not in caplog.text
    assert "private" not in caplog.text


def test_manus_persistent_invalid_task_read_fails_and_stops_same_task(
    caplog: pytest.LogCaptureFixture,
) -> None:
    create_calls = 0
    list_calls = 0
    stopped: list[str] = []
    delays: list[float] = []

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal create_calls, list_calls
        if request.url.path == "/v2/task.create":
            create_calls += 1
            return httpx.Response(
                200,
                json={"ok": True, "request_id": "create", "task_id": "task-persistent"},
            )
        if request.url.path == "/v2/task.listMessages":
            list_calls += 1
            return httpx.Response(
                200,
                json={
                    "ok": True,
                    "request_id": "dummy-manus-key private malformed response",
                    "task_id": "task-persistent",
                },
            )
        if request.url.path == "/v2/task.stop":
            stopped.append(json.loads(request.content)["task_id"])
            return httpx.Response(200, json={"ok": True, "request_id": "stop"})
        raise AssertionError(f"unexpected Manus path {request.url.path}")

    async def no_wait(delay: float) -> None:
        delays.append(delay)

    async def scenario() -> None:
        provider = ManusProvider(
            base_url="https://api.manus.ai",
            api_key="dummy-manus-key",
            client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
            sleep=no_wait,
            max_incomplete_response_retries=2,
        )
        with pytest.raises(ProviderResponseError) as raised:
            await provider.complete(completion_request())
        assert raised.value.code == "PROVIDER_INVALID_RESPONSE"
        assert raised.value.__cause__ is None
        await provider.aclose()

    asyncio.run(scenario())
    assert create_calls == 1
    assert list_calls == 3
    assert stopped == ["task-persistent"]
    assert delays == [0.25, 0.5]
    assert "stage=messages outcome=exhausted attempts=3" in caplog.text
    assert "dummy-manus-key" not in caplog.text
    assert "private malformed response" not in caplog.text


def test_every_run_creates_a_distinct_task_and_never_uses_shared_agent_thread() -> None:
    create_payloads: list[dict[str, Any]] = []
    created_task_ids: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/v2/task.create":
            payload = json.loads(request.content)
            create_payloads.append(payload)
            task_id = f"task-{len(create_payloads)}"
            created_task_ids.append(task_id)
            return httpx.Response(
                200,
                json={"ok": True, "request_id": "created", "task_id": task_id},
            )
        if request.url.path == "/v2/task.listMessages":
            task_id = request.url.params["task_id"]
            return httpx.Response(
                200,
                json=success_body(task_id, content=f"answer-{task_id}"),
            )
        raise AssertionError(f"unexpected Manus path {request.url.path}")

    async def scenario() -> None:
        provider = ManusProvider(
            base_url="https://api.manus.ai",
            api_key="dummy-manus-key",
            client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
            max_incomplete_response_retries=0,
        )
        first = await provider.complete(completion_request())
        second = await provider.complete(
            completion_request(run_id=UUID("00000000-0000-4000-8000-000000000102"))
        )
        await provider.aclose()
        assert first.output.content == "answer-task-1"
        assert second.output.content == "answer-task-2"

    asyncio.run(scenario())

    assert created_task_ids == ["task-1", "task-2"]
    assert create_payloads[0]["title"] != create_payloads[1]["title"]
    assert all("task_id" not in payload for payload in create_payloads)


def test_manus_rejects_stopped_task_without_a_terminal_assistant_message() -> None:
    stopped: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/v2/task.create":
            return httpx.Response(
                200,
                json={
                    "ok": True,
                    "request_id": "create-empty",
                    "task_id": "task-empty",
                    "task_title": f"enterprise-run-{RUN_ID}",
                },
            )
        if request.url.path == "/v2/task.listMessages":
            body = success_body("task-empty")
            body["messages"] = body["messages"][:1]
            return httpx.Response(
                200,
                json=body,
            )
        if request.url.path == "/v2/task.stop":
            stopped.append(json.loads(request.content)["task_id"])
            return httpx.Response(200, json={"ok": True, "request_id": "stop-empty"})
        raise AssertionError(f"unexpected Manus path {request.url.path}")

    async def scenario() -> None:
        provider = ManusProvider(
            base_url="https://api.manus.ai",
            api_key="dummy-manus-key",
            client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
            max_incomplete_response_retries=0,
        )
        with pytest.raises(ProviderResponseError):
            await provider.complete(completion_request())
        await provider.aclose()

    asyncio.run(scenario())
    assert stopped == ["task-empty"]


def test_manus_rejects_list_messages_envelope_for_a_different_task() -> None:
    stopped: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/v2/task.create":
            return httpx.Response(
                200,
                json={
                    "ok": True,
                    "request_id": "create-correlated",
                    "task_id": "task-created-for-run",
                    "task_title": f"enterprise-run-{RUN_ID}",
                },
            )
        if request.url.path == "/v2/task.listMessages":
            return httpx.Response(200, json=success_body("agent-default-main_task"))
        if request.url.path == "/v2/task.stop":
            stopped.append(json.loads(request.content)["task_id"])
            return httpx.Response(200, json={"ok": True, "request_id": "stop-correlated"})
        raise AssertionError(f"unexpected Manus path {request.url.path}")

    async def scenario() -> None:
        provider = ManusProvider(
            base_url="https://api.manus.ai",
            api_key="dummy-manus-key",
            client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
            max_incomplete_response_retries=0,
        )
        with pytest.raises(ProviderResponseError):
            await provider.complete(completion_request())
        await provider.aclose()

    asyncio.run(scenario())
    assert stopped == ["task-created-for-run"]


def test_manus_rejects_messages_that_are_not_in_declared_descending_order() -> None:
    stopped: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/v2/task.create":
            return httpx.Response(
                200,
                json={
                    "ok": True,
                    "request_id": "create-order",
                    "task_id": "task-order",
                },
            )
        if request.url.path == "/v2/task.listMessages":
            body = success_body("task-order")
            body["messages"] = list(reversed(body["messages"]))
            return httpx.Response(200, json=body)
        if request.url.path == "/v2/task.stop":
            stopped.append(json.loads(request.content)["task_id"])
            return httpx.Response(200, json={"ok": True, "request_id": "stop-order"})
        raise AssertionError(f"unexpected Manus path {request.url.path}")

    async def scenario() -> None:
        provider = ManusProvider(
            base_url="https://api.manus.ai",
            api_key="dummy-manus-key",
            client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
            max_incomplete_response_retries=0,
        )
        with pytest.raises(ProviderResponseError):
            await provider.complete(completion_request())
        await provider.aclose()

    asyncio.run(scenario())
    assert stopped == ["task-order"]


def test_manus_rejects_event_timestamps_without_an_explicit_timezone() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/v2/task.create":
            return httpx.Response(
                200,
                json={
                    "ok": True,
                    "request_id": "create-timestamp",
                    "task_id": "task-timestamp",
                },
            )
        if request.url.path == "/v2/task.listMessages":
            body = success_body("task-timestamp")
            body["messages"][0]["timestamp"] = "2026-07-29T01:00:02"
            return httpx.Response(200, json=body)
        if request.url.path == "/v2/task.stop":
            return httpx.Response(200, json={"ok": True, "request_id": "stop-timestamp"})
        raise AssertionError(f"unexpected Manus path {request.url.path}")

    async def scenario() -> None:
        provider = ManusProvider(
            base_url="https://api.manus.ai",
            api_key="dummy-manus-key",
            client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
            max_incomplete_response_retries=0,
        )
        with pytest.raises(ProviderResponseError):
            await provider.complete(completion_request())
        await provider.aclose()

    asyncio.run(scenario())


@pytest.mark.parametrize(
    ("agent_status", "expected_error"),
    [
        ("waiting", ProviderInteractionRequiredError),
        ("error", ProviderTaskError),
    ],
)
def test_manus_maps_terminal_non_success_status_and_stops_task(
    agent_status: str,
    expected_error: type[Exception],
) -> None:
    stopped: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/v2/task.create":
            return httpx.Response(
                200,
                json={"ok": True, "request_id": "create", "task_id": "task-status"},
            )
        if request.url.path == "/v2/task.listMessages":
            return httpx.Response(
                200,
                json={
                    "ok": True,
                    "request_id": "list",
                    "task_id": "task-status",
                    "messages": [
                        {
                            "id": "event-status",
                            "type": "status_update",
                            "timestamp": 1,
                            "status_update": {"agent_status": agent_status},
                        }
                    ],
                    "has_more": False,
                },
            )
        if request.url.path == "/v2/task.stop":
            stopped.append(json.loads(request.content)["task_id"])
            return httpx.Response(200, json={"ok": True, "request_id": "stop"})
        raise AssertionError(f"unexpected Manus path {request.url.path}")

    async def scenario() -> None:
        provider = ManusProvider(
            base_url="https://api.manus.ai",
            api_key="dummy-manus-key",
            client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        )
        with pytest.raises(expected_error):
            await provider.complete(completion_request())
        await provider.aclose()

    asyncio.run(scenario())
    assert stopped == ["task-status"]


@pytest.mark.parametrize(
    ("code", "expected_error"),
    [
        ("permission_denied", ProviderAuthenticationError),
        ("rate_limited", ProviderRateLimitError),
        ("invalid_argument", ProviderRequestError),
        ("internal_error", ProviderUnavailableError),
        ("future_unknown_code", ProviderResponseError),
    ],
)
def test_manus_maps_ok_false_without_exposing_provider_message(
    code: str,
    expected_error: type[Exception],
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "ok": False,
                "request_id": "provider-request",
                "error": {
                    "code": code,
                    "message": "dummy-manus-key and private provider diagnostics",
                },
            },
        )

    async def scenario() -> None:
        provider = ManusProvider(
            base_url="https://api.manus.ai",
            api_key="dummy-manus-key",
            client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        )
        with pytest.raises(expected_error) as raised:
            await provider.complete(completion_request())
        assert "dummy-manus-key" not in str(raised.value)
        assert "private provider diagnostics" not in str(raised.value)
        assert "dummy-manus-key" not in repr(provider)
        await provider.aclose()

    asyncio.run(scenario())


@pytest.mark.parametrize(
    ("status_code", "expected_error"),
    [
        (401, ProviderAuthenticationError),
        (403, ProviderAuthenticationError),
        (400, ProviderRequestError),
        (500, ProviderUnavailableError),
    ],
)
def test_manus_maps_http_errors(status_code: int, expected_error: type[Exception]) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            status_code,
            json={"error": "dummy-manus-key and private provider diagnostics"},
        )

    provider = ManusProvider(
        base_url="https://api.manus.ai",
        api_key="dummy-manus-key",
        client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )
    with pytest.raises(expected_error) as raised:
        asyncio.run(provider.complete(completion_request()))
    assert "dummy-manus-key" not in str(raised.value)
    asyncio.run(provider.aclose())


def test_manus_never_logs_key_or_full_provider_response(
    caplog: pytest.LogCaptureFixture,
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            401,
            json={
                "ok": False,
                "error": {
                    "code": "permission_denied",
                    "message": "dummy-manus-key plus full private response",
                },
            },
        )

    async def scenario() -> None:
        provider = ManusProvider(
            base_url="https://api.manus.ai",
            api_key="dummy-manus-key",
            client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        )
        with pytest.raises(ProviderAuthenticationError):
            await provider.complete(completion_request())
        await provider.aclose()

    asyncio.run(scenario())
    assert "dummy-manus-key" not in caplog.text
    assert "full private response" not in caplog.text


@pytest.mark.parametrize(
    ("failure", "expected_error"),
    [
        ("timeout", ProviderTimeoutError),
        ("transport", ProviderUnavailableError),
    ],
)
def test_manus_suppresses_http_exception_with_secret_request_headers(
    failure: str,
    expected_error: type[Exception],
    caplog: pytest.LogCaptureFixture,
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if failure == "timeout":
            raise httpx.ReadTimeout(
                "Authorization: dummy-manus-key private timeout",
                request=request,
            )
        raise httpx.ConnectError(
            "Authorization: dummy-manus-key private transport",
            request=request,
        )

    provider = ManusProvider(
        base_url="https://api.manus.ai",
        api_key="dummy-manus-key",
        client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )
    with pytest.raises(expected_error) as raised:
        asyncio.run(provider.complete(completion_request()))
    rendered = "".join(traceback.format_exception(raised.type, raised.value, raised.tb))
    assert raised.value.__cause__ is None
    assert "Authorization" not in rendered
    assert "dummy-manus-key" not in str(raised.value)
    assert "dummy-manus-key" not in rendered
    assert "dummy-manus-key" not in caplog.text
    asyncio.run(provider.aclose())


def test_manus_owned_client_ignores_environment_proxy_but_accepts_explicit_proxy() -> None:
    async def scenario() -> None:
        provider = ManusProvider(
            base_url="https://api.manus.ai",
            api_key="dummy-manus-key",
            proxy_url="http://127.0.0.1:10837",
        )
        assert provider._client.trust_env is False
        await provider.aclose()

    asyncio.run(scenario())


def test_manus_retries_429_with_backoff_then_succeeds() -> None:
    create_attempts = 0
    delays: list[float] = []

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal create_attempts
        if request.url.path == "/v2/task.create":
            create_attempts += 1
            if create_attempts < 3:
                return httpx.Response(429, json={"error": "rate limited"})
            return httpx.Response(
                200,
                json={"ok": True, "request_id": "create", "task_id": "task-retried"},
            )
        if request.url.path == "/v2/task.listMessages":
            return httpx.Response(200, json=success_body("task-retried"))
        raise AssertionError(f"unexpected Manus path {request.url.path}")

    async def no_wait(delay: float) -> None:
        delays.append(delay)

    async def scenario() -> None:
        provider = ManusProvider(
            base_url="https://api.manus.ai",
            api_key="dummy-manus-key",
            client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
            sleep=no_wait,
            random_value=lambda: 0,
        )
        result = await provider.complete(completion_request())
        assert result.output.content == "Project summary"
        await provider.aclose()

    asyncio.run(scenario())
    assert create_attempts == 3
    assert delays == [1, 2]


def test_manus_exhausted_429_is_sanitized_rate_limit_error() -> None:
    attempts = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        return httpx.Response(429, json={"error": "private detail"})

    async def no_wait(delay: float) -> None:
        return None

    async def scenario() -> None:
        provider = ManusProvider(
            base_url="https://api.manus.ai",
            api_key="dummy-manus-key",
            client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
            sleep=no_wait,
            random_value=lambda: 0,
            max_rate_limit_retries=2,
        )
        with pytest.raises(ProviderRateLimitError):
            await provider.complete(completion_request())
        await provider.aclose()

    asyncio.run(scenario())
    assert attempts == 3


def test_manus_malformed_success_is_rejected_without_provider_details() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            content=b'{"ok":true,"private":"dummy-manus-key"}',
            headers={"Content-Type": "application/json"},
        )

    provider = ManusProvider(
        base_url="https://api.manus.ai",
        api_key="dummy-manus-key",
        client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )
    with pytest.raises(ProviderResponseError) as raised:
        asyncio.run(provider.complete(completion_request()))
    assert "dummy-manus-key" not in str(raised.value)
    asyncio.run(provider.aclose())


def test_manus_invalid_json_does_not_survive_as_exception_cause() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            content=b"dummy-manus-key and full private invalid json response",
            headers={"Content-Type": "application/json"},
        )

    provider = ManusProvider(
        base_url="https://api.manus.ai",
        api_key="dummy-manus-key",
        client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )
    with pytest.raises(ProviderResponseError) as raised:
        asyncio.run(provider.complete(completion_request()))
    assert raised.value.__cause__ is None
    assert "dummy-manus-key" not in str(raised.value)
    assert "full private invalid json response" not in str(raised.value)
    asyncio.run(provider.aclose())


def test_manus_timeout_best_effort_stops_remote_task() -> None:
    stopped: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/v2/task.create":
            return httpx.Response(
                200,
                json={"ok": True, "request_id": "create", "task_id": "task-timeout"},
            )
        if request.url.path == "/v2/task.listMessages":
            return httpx.Response(
                200,
                json={
                    "ok": True,
                    "request_id": "running",
                    "task_id": "task-timeout",
                    "messages": [
                        {
                            "id": "event-running",
                            "type": "status_update",
                            "timestamp": 1,
                            "status_update": {"agent_status": "running"},
                        }
                    ],
                    "has_more": False,
                },
            )
        if request.url.path == "/v2/task.stop":
            stopped.append(json.loads(request.content)["task_id"])
            return httpx.Response(200, json={"ok": True, "request_id": "stop"})
        raise AssertionError(f"unexpected Manus path {request.url.path}")

    async def scenario() -> None:
        provider = ManusProvider(
            base_url="https://api.manus.ai",
            api_key="dummy-manus-key",
            poll_interval_seconds=0.1,
            max_wait_seconds=1,
            client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        )
        request = replace(completion_request(), timeout_ms=20)
        with pytest.raises(ProviderTimeoutError) as raised:
            await provider.complete(request)
        assert raised.value.__cause__ is None
        await provider.aclose()

    asyncio.run(scenario())
    assert stopped == ["task-timeout"]


def test_manus_cancellation_best_effort_stops_remote_task() -> None:
    stopped: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/v2/task.create":
            return httpx.Response(
                200,
                json={"ok": True, "request_id": "create", "task_id": "task-cancel"},
            )
        if request.url.path == "/v2/task.listMessages":
            return httpx.Response(
                200,
                json={
                    "ok": True,
                    "request_id": "running",
                    "task_id": "task-cancel",
                    "messages": [
                        {
                            "id": "event-running",
                            "type": "status_update",
                            "timestamp": 1,
                            "status_update": {"agent_status": "running"},
                        }
                    ],
                    "has_more": False,
                },
            )
        if request.url.path == "/v2/task.stop":
            stopped.append(json.loads(request.content)["task_id"])
            return httpx.Response(200, json={"ok": True, "request_id": "stop"})
        raise AssertionError(f"unexpected Manus path {request.url.path}")

    async def scenario() -> None:
        sleeping = asyncio.Event()

        async def block_poll(delay: float) -> None:
            sleeping.set()
            await asyncio.Event().wait()

        provider = ManusProvider(
            base_url="https://api.manus.ai",
            api_key="dummy-manus-key",
            client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
            sleep=block_poll,
        )
        execution = asyncio.create_task(provider.complete(completion_request()))
        await asyncio.wait_for(sleeping.wait(), timeout=1)
        execution.cancel()
        with pytest.raises(asyncio.CancelledError):
            await execution
        await provider.aclose()

    asyncio.run(scenario())
    assert stopped == ["task-cancel"]


def test_manus_cancel_only_confirms_after_remote_stopped_status() -> None:
    stopped = False

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal stopped
        if request.url.path == "/v2/task.create":
            return httpx.Response(
                200,
                json={"ok": True, "request_id": "create", "task_id": "task-confirm-cancel"},
            )
        if request.url.path == "/v2/task.stop":
            stopped = True
            return httpx.Response(200, json={"ok": True, "request_id": "stop"})
        if request.url.path == "/v2/task.listMessages":
            status = "stopped" if stopped else "running"
            return httpx.Response(
                200,
                json={
                    "ok": True,
                    "request_id": f"status-{status}",
                    "task_id": "task-confirm-cancel",
                    "messages": [
                        {
                            "id": f"event-{status}",
                            "type": "status_update",
                            "timestamp": 1,
                            "status_update": {"agent_status": status},
                        }
                    ],
                    "has_more": False,
                },
            )
        raise AssertionError(f"unexpected Manus path {request.url.path}")

    async def scenario() -> None:
        sleeping = asyncio.Event()

        async def block_poll(delay: float) -> None:
            sleeping.set()
            await asyncio.Event().wait()

        provider = ManusProvider(
            base_url="https://api.manus.ai",
            api_key="dummy-manus-key",
            client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
            sleep=block_poll,
        )
        request = completion_request()
        execution = asyncio.create_task(provider.complete(request))
        await asyncio.wait_for(sleeping.wait(), timeout=1)
        assert await provider.cancel(request.run_id) is True
        execution.cancel()
        with pytest.raises(asyncio.CancelledError):
            await execution
        await provider.aclose()

    asyncio.run(scenario())
