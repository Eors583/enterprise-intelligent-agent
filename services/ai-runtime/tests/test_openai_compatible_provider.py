from __future__ import annotations

import asyncio
import json
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
from enterprise_ai_runtime.ports.provider import ProviderCompletionRequest


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


def test_provider_maps_timeout() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("secret provider detail", request=request)

    async def scenario() -> None:
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        provider = OpenAICompatibleProvider(
            base_url="https://provider.example/v1",
            api_key="top-secret-key",
            client=client,
        )
        with pytest.raises(ProviderTimeoutError) as raised:
            await provider.complete(completion_request())
        assert "secret" not in str(raised.value)
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
