from __future__ import annotations

import asyncio
import json
import traceback
from uuid import UUID

import httpx
import pytest
from fastapi.testclient import TestClient

from enterprise_ai_runtime.adapters.openai_compatible_provider import (
    OpenAICompatibleProvider,
)
from enterprise_ai_runtime.adapters.provider_runtime import ProviderRuntime
from enterprise_ai_runtime.domain.errors import (
    ProviderAuthenticationError,
    ProviderRateLimitError,
    ProviderRequestError,
    ProviderResponseError,
    ProviderTimeoutError,
    ProviderUnavailableError,
)
from enterprise_ai_runtime.domain.models import MessageRole, RunMessage
from enterprise_ai_runtime.main import create_app
from enterprise_ai_runtime.ports.provider import (
    ProviderCompletionRequest,
    ProviderStreamDelta,
    ProviderStreamTerminal,
)


class FragmentedByteStream(httpx.AsyncByteStream):
    def __init__(self, content: bytes, *, chunk_size: int = 7) -> None:
        self._content = content
        self._chunk_size = chunk_size

    async def __aiter__(self):
        for offset in range(0, len(self._content), self._chunk_size):
            yield self._content[offset : offset + self._chunk_size]


def completion_request() -> ProviderCompletionRequest:
    return ProviderCompletionRequest(
        messages=(RunMessage(role=MessageRole.USER, content="Hello"),),
        model="model-a",
        timeout_ms=1_500,
        max_input_tokens=10_000,
        max_output_tokens=321,
        request_id="req-provider-1",
        run_id=UUID("00000000-0000-4000-8000-000000000001"),
    )


def _sse(*values: object) -> bytes:
    frames = []
    for value in values:
        data = value if isinstance(value, str) else json.dumps(value, separators=(",", ":"))
        frames.append(f"data: {data}\n\n")
    return "".join(frames).encode()


def test_provider_maps_structured_request_response_and_timeout() -> None:
    captured: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["headers"] = request.headers
        captured["payload"] = json.loads(request.content)
        captured["timeout"] = request.extensions["timeout"]
        return httpx.Response(
            200,
            json={
                "id": "completion-1",
                "model": "model-a-20260715",
                "choices": [
                    {
                        "message": {"role": "assistant", "content": "Hi"},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {
                    "prompt_tokens": 7,
                    "completion_tokens": 2,
                    "total_tokens": 9,
                    "cost_micros": 42,
                },
            },
        )

    async def scenario() -> None:
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        provider = OpenAICompatibleProvider(
            base_url="https://provider.example/v1",
            api_key="top-secret-key",
            client=client,
        )
        result = await provider.complete(completion_request())
        assert result.output.content == "Hi"
        assert result.output.model == "model-a-20260715"
        assert result.usage.total_tokens == 9
        assert result.usage.cost_micros == 42
        assert result.usage.tokens_reported is True
        assert result.usage.cost_reported is True
        await provider.aclose()

    asyncio.run(scenario())
    assert captured["url"] == "https://provider.example/v1/chat/completions"
    headers = captured["headers"]
    assert isinstance(headers, httpx.Headers)
    assert headers["Authorization"] == "Bearer top-secret-key"
    assert headers["X-Request-ID"] == "req-provider-1"
    payload = captured["payload"]
    assert isinstance(payload, dict)
    assert payload["model"] == "model-a"
    assert payload["max_tokens"] == 321
    assert payload["messages"] == [{"role": "user", "content": "Hello"}]
    timeout = captured["timeout"]
    assert isinstance(timeout, dict)
    assert timeout["read"] == 1.5


def test_provider_marks_missing_usage_and_cost_as_unreported() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "id": "completion-without-usage",
                "model": "model-a",
                "choices": [
                    {
                        "message": {"role": "assistant", "content": "Hi"},
                        "finish_reason": "stop",
                    }
                ],
            },
        )

    async def scenario() -> None:
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        provider = OpenAICompatibleProvider(
            base_url="https://provider.example/v1",
            api_key="top-secret-key",
            client=client,
        )
        result = await provider.complete(completion_request())
        assert result.usage.total_tokens == 0
        assert result.usage.cost_micros == 0
        assert result.usage.tokens_reported is False
        assert result.usage.cost_reported is False
        await provider.aclose()

    asyncio.run(scenario())


def test_provider_rejects_reported_zero_tokens_for_a_successful_answer() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "id": "completion-with-false-zero-usage",
                "model": "model-a",
                "choices": [
                    {
                        "message": {"role": "assistant", "content": "Hi"},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {
                    "prompt_tokens": 0,
                    "completion_tokens": 0,
                    "total_tokens": 0,
                },
            },
        )

    async def scenario() -> None:
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        provider = OpenAICompatibleProvider(
            base_url="https://provider.example/v1",
            api_key="top-secret-key",
            client=client,
        )
        with pytest.raises(ProviderResponseError):
            await provider.complete(completion_request())
        await provider.aclose()

    asyncio.run(scenario())


@pytest.mark.parametrize(
    ("exception", "expected_error"),
    [
        (httpx.ReadTimeout, ProviderTimeoutError),
        (httpx.ConnectError, ProviderUnavailableError),
    ],
)
def test_provider_maps_sanitized_transport_errors(
    exception: type[httpx.TransportError],
    expected_error: type[Exception],
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise exception(
            "Authorization: Bearer top-secret-key private transport detail",
            request=request,
        )

    async def scenario() -> None:
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        provider = OpenAICompatibleProvider(
            base_url="https://provider.example/v1",
            api_key="top-secret-key",
            client=client,
        )
        with pytest.raises(expected_error) as raised:
            await provider.complete(completion_request())
        rendered = "".join(traceback.format_exception(raised.type, raised.value, raised.tb))
        assert raised.value.__cause__ is None
        assert "Authorization" not in rendered
        assert "top-secret-key" not in rendered
        await provider.aclose()

    asyncio.run(scenario())


def test_provider_owned_client_ignores_environment_proxies() -> None:
    async def scenario() -> None:
        provider = OpenAICompatibleProvider(
            base_url="https://provider.example/v1",
            api_key="top-secret-key",
        )
        assert provider._client.trust_env is False
        await provider.aclose()

    asyncio.run(scenario())


@pytest.mark.parametrize(
    ("status_code", "error_type"),
    [
        (401, ProviderAuthenticationError),
        (403, ProviderAuthenticationError),
        (408, ProviderTimeoutError),
        (429, ProviderRateLimitError),
        (400, ProviderRequestError),
        (422, ProviderRequestError),
        (500, ProviderUnavailableError),
        (503, ProviderUnavailableError),
    ],
)
def test_provider_maps_http_statuses(
    status_code: int,
    error_type: type[Exception],
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status_code, json={"error": "private-provider-detail"})

    async def scenario() -> None:
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        provider = OpenAICompatibleProvider(
            base_url="https://provider.example/v1",
            api_key="top-secret-key",
            client=client,
        )
        with pytest.raises(error_type):
            await provider.complete(completion_request())
        await provider.aclose()

    asyncio.run(scenario())


def test_provider_does_not_expose_key_or_error_body(caplog: pytest.LogCaptureFixture) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"error": "top-secret-key was rejected"})

    async def scenario() -> None:
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        provider = OpenAICompatibleProvider(
            base_url="https://provider.example/v1",
            api_key="top-secret-key",
            client=client,
        )
        with pytest.raises(ProviderAuthenticationError) as raised:
            await provider.complete(completion_request())
        assert "top-secret-key" not in str(raised.value)
        await provider.aclose()

    asyncio.run(scenario())
    assert "top-secret-key" not in caplog.text


def test_provider_rejects_malformed_success_response() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"choices": []})

    async def scenario() -> None:
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        provider = OpenAICompatibleProvider(
            base_url="https://provider.example/v1",
            api_key="top-secret-key",
            client=client,
        )
        with pytest.raises(ProviderResponseError):
            await provider.complete(completion_request())
        await provider.aclose()

    asyncio.run(scenario())


def test_provider_streams_strict_sse_and_requires_trusted_terminal_usage() -> None:
    captured: dict[str, object] = {}
    body = _sse(
        {
            "id": "completion-stream-1",
            "model": "model-a-20260728",
            "choices": [{"index": 0, "delta": {"content": "Hel"}, "finish_reason": None}],
        },
        {
            "id": "completion-stream-1",
            "model": "model-a-20260728",
            "choices": [{"index": 0, "delta": {"content": "lo"}, "finish_reason": None}],
        },
        {
            "id": "completion-stream-1",
            "model": "model-a-20260728",
            "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
        },
        {
            "id": "completion-stream-1",
            "model": "model-a-20260728",
            "choices": [],
            "usage": {
                "prompt_tokens": 7,
                "completion_tokens": 2,
                "total_tokens": 9,
                "cost_micros": 42,
            },
        },
        "[DONE]",
    )

    def handler(request: httpx.Request) -> httpx.Response:
        captured["payload"] = json.loads(request.content)
        captured["headers"] = request.headers
        return httpx.Response(
            200,
            headers={"content-type": "text/event-stream; charset=utf-8"},
            stream=FragmentedByteStream(body),
        )

    async def scenario() -> None:
        provider = OpenAICompatibleProvider(
            base_url="https://provider.example/v1",
            api_key="top-secret-key",
            client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        )
        events = [event async for event in provider.stream(completion_request())]
        assert [event.content for event in events if isinstance(event, ProviderStreamDelta)] == [
            "Hel",
            "lo",
        ]
        terminal = events[-1]
        assert isinstance(terminal, ProviderStreamTerminal)
        assert terminal.mode == "live"
        assert terminal.result.output.content == "Hello"
        assert terminal.result.output.finish_reason == "stop"
        assert terminal.result.usage.total_tokens == 9
        assert terminal.result.usage.tokens_reported is True
        await provider.aclose()

    asyncio.run(scenario())
    payload = captured["payload"]
    assert isinstance(payload, dict)
    assert payload["stream"] is True
    assert payload["stream_options"] == {"include_usage": True}
    headers = captured["headers"]
    assert isinstance(headers, httpx.Headers)
    assert headers["Accept"] == "text/event-stream"


@pytest.mark.parametrize(
    "body",
    [
        _sse(
            {
                "id": "completion-stream-1",
                "model": "model-a",
                "choices": [{"index": 0, "delta": {"content": "Hi"}, "finish_reason": "stop"}],
            },
            "[DONE]",
        ),
        b"data: {malformed-json}\n\n",
        b"data: "
        + json.dumps(
            {
                "id": "completion-stream-1",
                "model": "model-a",
                "choices": [
                    {
                        "index": 0,
                        "delta": {"content": "x" * 16_385},
                        "finish_reason": None,
                    }
                ],
            }
        ).encode()
        + b"\n\n",
        b"data: " + (b"x" * 65_537) + b"\n\n",
    ],
    ids=["missing-usage", "malformed-json", "oversized-delta", "oversized-event"],
)
def test_provider_stream_rejects_malformed_or_unbounded_sse(body: bytes) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={"content-type": "text/event-stream"},
            stream=FragmentedByteStream(body),
        )

    async def scenario() -> None:
        provider = OpenAICompatibleProvider(
            base_url="https://provider.example/v1",
            api_key="top-secret-key",
            client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        )
        with pytest.raises(ProviderResponseError):
            _ = [event async for event in provider.stream(completion_request())]
        await provider.aclose()

    asyncio.run(scenario())


def test_provider_stream_maps_rate_limit_without_exposing_provider_body() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(429, content=b"top-secret-key private upstream response")

    async def scenario() -> None:
        provider = OpenAICompatibleProvider(
            base_url="https://provider.example/v1",
            api_key="top-secret-key",
            client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        )
        with pytest.raises(ProviderRateLimitError) as raised:
            _ = [event async for event in provider.stream(completion_request())]
        assert "top-secret-key" not in str(raised.value)
        assert "private upstream response" not in str(raised.value)
        await provider.aclose()

    asyncio.run(scenario())


@pytest.mark.parametrize(
    ("exception", "expected_error"),
    [
        (httpx.ReadTimeout, ProviderTimeoutError),
        (httpx.ConnectError, ProviderUnavailableError),
    ],
)
def test_provider_stream_suppresses_transport_exception_context(
    exception: type[httpx.TransportError],
    expected_error: type[Exception],
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise exception(
            "Authorization: Bearer top-secret-key streamed transport detail",
            request=request,
        )

    async def scenario() -> None:
        provider = OpenAICompatibleProvider(
            base_url="https://provider.example/v1",
            api_key="top-secret-key",
            client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        )
        with pytest.raises(expected_error) as raised:
            _ = [event async for event in provider.stream(completion_request())]
        rendered = "".join(traceback.format_exception(raised.type, raised.value, raised.tb))
        assert raised.value.__cause__ is None
        assert "Authorization" not in rendered
        assert "top-secret-key" not in rendered
        await provider.aclose()

    asyncio.run(scenario())


def test_api_key_and_provider_body_never_reach_run_response(
    run_payload: dict[str, object],
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            401,
            json={"error": "top-secret-key and internal-provider-detail"},
        )

    provider = OpenAICompatibleProvider(
        base_url="https://provider.example/v1",
        api_key="top-secret-key",
        client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )
    runtime = ProviderRuntime(provider, model="model-a")
    with TestClient(create_app(runtime=runtime)) as client:
        created = client.post(
            "/internal/v1/runs",
            headers={"X-Tenant-ID": "tenant-a"},
            json=run_payload,
        )
        response = client.post(
            f"/internal/v1/runs/{created.json()['run_id']}/execute",
            headers={"X-Tenant-ID": "tenant-a"},
        )

    assert response.status_code == 200
    assert response.json()["error"]["code"] == "PROVIDER_AUTHENTICATION_FAILED"
    assert "top-secret-key" not in response.text
    assert "internal-provider-detail" not in response.text
