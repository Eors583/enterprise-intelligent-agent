from __future__ import annotations

import asyncio
import json
import traceback
from typing import Any

import httpx
import pytest

from enterprise_ai_runtime.adapters.cohere_rerank_provider import CohereRerankProvider
from enterprise_ai_runtime.adapters.openai_embedding_provider import OpenAIEmbeddingProvider
from enterprise_ai_runtime.domain.errors import (
    ProviderAuthenticationError,
    ProviderRateLimitError,
    ProviderRequestError,
    ProviderResponseError,
    ProviderTimeoutError,
    ProviderUnavailableError,
)
from enterprise_ai_runtime.domain.knowledge_models import RerankDocument

DIMENSIONS = 1536


def vector(first: float = 0.5) -> list[float]:
    return [first, *([0.0] * (DIMENSIONS - 1))]


def test_openai_embedding_provider_sends_a_bounded_request_and_orders_results() -> None:
    captured: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["headers"] = request.headers
        captured["body"] = request.read()
        return httpx.Response(
            200,
            json={
                "model": "embed-model-deployment",
                "data": [
                    {"index": 1, "embedding": vector(0.2)},
                    {"index": 0, "embedding": vector(0.1)},
                ],
                "usage": {"prompt_tokens": 8, "total_tokens": 8},
            },
        )

    async def exercise() -> None:
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        provider = OpenAIEmbeddingProvider(
            base_url="https://embedding.example/v1",
            api_key="embedding-secret",
            model="embed-model-deployment",
            dimensions=DIMENSIONS,
            timeout_seconds=12,
            client=client,
        )
        result = await provider.embed(["first", "second"], request_id="req-embedding-1")
        assert [item.index for item in result.items] == [0, 1]
        assert result.dimensions == DIMENSIONS
        assert result.usage is not None
        assert result.usage.total_tokens == 8
        assert "embedding-secret" not in repr(provider)
        await provider.aclose()
        assert client.is_closed

    asyncio.run(exercise())
    assert captured["url"] == "https://embedding.example/v1/embeddings"
    headers = captured["headers"]
    assert isinstance(headers, httpx.Headers)
    assert headers["Authorization"] == "Bearer embedding-secret"
    assert headers["X-Request-ID"] == "req-embedding-1"
    body = captured["body"]
    assert isinstance(body, bytes)
    assert b'"dimensions":1536' in body
    assert b'"encoding_format":"float"' in body


@pytest.mark.parametrize(
    "data",
    [
        [{"index": 0, "embedding": [0.1] * (DIMENSIONS - 1)}],
        [{"index": 0, "embedding": [float("nan"), *([0.0] * (DIMENSIONS - 1))]}],
        [{"index": 0, "embedding": [0.0] * DIMENSIONS}],
        [
            {"index": 0, "embedding": vector(0.1)},
            {"index": 0, "embedding": vector(0.2)},
        ],
    ],
)
def test_openai_embedding_provider_rejects_unusable_vectors(
    data: list[dict[str, object]],
) -> None:
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            content=json.dumps({"model": "embed", "data": data}, allow_nan=True),
            headers={"Content-Type": "application/json"},
        )

    async def exercise() -> None:
        provider = OpenAIEmbeddingProvider(
            base_url="https://embedding.example/v1",
            api_key="secret",
            model="embed",
            dimensions=DIMENSIONS,
            timeout_seconds=10,
            client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        )
        inputs = ["one", "two"] if len(data) == 2 else ["one"]
        with pytest.raises(ProviderResponseError):
            await provider.embed(inputs, request_id="req-invalid-vector")
        await provider.aclose()

    asyncio.run(exercise())


def test_cohere_rerank_provider_maps_indexes_back_to_trusted_document_ids() -> None:
    captured: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["headers"] = request.headers
        captured["body"] = request.read()
        return httpx.Response(
            200,
            json={
                "results": [
                    {"index": 1, "relevance_score": 0.95},
                    {"index": 0, "relevance_score": 0.5},
                ]
            },
        )

    async def exercise() -> None:
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        provider = CohereRerankProvider(
            base_url="https://rerank.example/v2",
            api_key="rerank-secret",
            model="rerank-model",
            timeout_seconds=15,
            client=client,
        )
        result = await provider.rerank(
            "question",
            [
                RerankDocument(id="chunk-a", text="first"),
                RerankDocument(id="chunk-b", text="second"),
            ],
            top_n=2,
            request_id="req-rerank-1",
        )
        assert [item.id for item in result.results] == ["chunk-b", "chunk-a"]
        assert [item.index for item in result.results] == [1, 0]
        assert "rerank-secret" not in repr(provider)
        await provider.aclose()
        assert client.is_closed

    asyncio.run(exercise())
    assert captured["url"] == "https://rerank.example/v2/rerank"
    headers = captured["headers"]
    assert isinstance(headers, httpx.Headers)
    assert headers["Authorization"] == "Bearer rerank-secret"
    body = captured["body"]
    assert isinstance(body, bytes)
    assert b'"documents":["first","second"]' in body
    assert b'"return_documents":false' in body


@pytest.mark.parametrize(
    "results",
    [
        [],
        [{"index": 3, "relevance_score": 0.8}],
        [{"index": 0, "relevance_score": float("inf")}],
        [
            {"index": 0, "relevance_score": 0.5},
            {"index": 1, "relevance_score": 0.8},
        ],
    ],
)
def test_cohere_rerank_provider_rejects_incomplete_or_invalid_results(
    results: list[dict[str, object]],
) -> None:
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            content=json.dumps({"results": results}, allow_nan=True),
            headers={"Content-Type": "application/json"},
        )

    async def exercise() -> None:
        provider = CohereRerankProvider(
            base_url="https://rerank.example/v2",
            api_key="secret",
            model="rerank",
            timeout_seconds=10,
            client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        )
        documents = [
            RerankDocument(id="a", text="first"),
            RerankDocument(id="b", text="second"),
        ]
        top_n = 2 if len(results) == 2 else 1
        with pytest.raises(ProviderResponseError):
            await provider.rerank("query", documents, top_n=top_n, request_id="req-invalid-rerank")
        await provider.aclose()

    asyncio.run(exercise())


@pytest.mark.parametrize(
    ("status_code", "expected_error"),
    [
        (400, ProviderRequestError),
        (401, ProviderAuthenticationError),
        (403, ProviderAuthenticationError),
        (408, ProviderTimeoutError),
        (429, ProviderRateLimitError),
        (500, ProviderUnavailableError),
        (503, ProviderUnavailableError),
    ],
)
def test_knowledge_providers_map_http_errors_without_exposing_response_body(
    status_code: int,
    expected_error: type[Exception],
) -> None:
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(status_code, json={"error": "secret-upstream-detail"})

    async def exercise() -> None:
        provider = OpenAIEmbeddingProvider(
            base_url="https://embedding.example/v1",
            api_key="top-secret-key",
            model="embed",
            dimensions=DIMENSIONS,
            timeout_seconds=10,
            client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        )
        with pytest.raises(expected_error) as captured:
            await provider.embed(["text"], request_id="req-http-error")
        assert "secret-upstream-detail" not in str(captured.value)
        assert "top-secret-key" not in str(captured.value)
        await provider.aclose()

    asyncio.run(exercise())


@pytest.mark.parametrize("exception", [httpx.ReadTimeout, httpx.ConnectError])
def test_embedding_transport_errors_are_sanitized(
    exception: type[httpx.TransportError],
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise exception(
            "Authorization: Bearer top-secret-key private transport detail",
            request=request,
        )

    async def exercise() -> None:
        provider = OpenAIEmbeddingProvider(
            base_url="https://embedding.example/v1",
            api_key="top-secret-key",
            model="embed",
            dimensions=DIMENSIONS,
            timeout_seconds=10,
            client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        )
        expected_error = (
            ProviderTimeoutError if exception is httpx.ReadTimeout else ProviderUnavailableError
        )
        with pytest.raises(expected_error) as captured:
            await provider.embed(["text"], request_id="req-transport-error")
        rendered = "".join(traceback.format_exception(captured.type, captured.value, captured.tb))
        assert captured.value.__cause__ is None
        assert "Authorization" not in rendered
        assert "top-secret-key" not in str(captured.value)
        assert "top-secret-key" not in rendered
        await provider.aclose()

    asyncio.run(exercise())


@pytest.mark.parametrize(
    ("exception", "expected_error"),
    [
        (httpx.ReadTimeout, ProviderTimeoutError),
        (httpx.ConnectError, ProviderUnavailableError),
    ],
)
def test_rerank_transport_errors_are_sanitized(
    exception: type[httpx.TransportError],
    expected_error: type[Exception],
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise exception(
            "Authorization: Bearer rerank-secret private detail",
            request=request,
        )

    async def exercise() -> None:
        provider = CohereRerankProvider(
            base_url="https://rerank.example/v2",
            api_key="rerank-secret",
            model="rerank",
            timeout_seconds=10,
            client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        )
        with pytest.raises(expected_error) as captured:
            await provider.rerank(
                "query",
                [RerankDocument(id="a", text="answer")],
                top_n=1,
                request_id="req-rerank-timeout",
            )
        rendered = "".join(traceback.format_exception(captured.type, captured.value, captured.tb))
        assert captured.value.__cause__ is None
        assert "Authorization" not in rendered
        assert "rerank-secret" not in str(captured.value)
        assert "rerank-secret" not in rendered
        await provider.aclose()

    asyncio.run(exercise())


def test_knowledge_provider_owned_clients_ignore_environment_proxies() -> None:
    async def exercise() -> None:
        embedding = OpenAIEmbeddingProvider(
            base_url="https://embedding.example/v1",
            api_key="embedding-secret",
            model="embed",
            dimensions=DIMENSIONS,
            timeout_seconds=10,
        )
        rerank = CohereRerankProvider(
            base_url="https://rerank.example/v2",
            api_key="rerank-secret",
            model="rerank",
            timeout_seconds=10,
        )
        assert embedding._client.trust_env is False
        assert rerank._client.trust_env is False
        await embedding.aclose()
        await rerank.aclose()

    asyncio.run(exercise())


def test_embedding_readiness_requires_a_real_success_and_caches_the_evidence() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(
            200,
            json={
                "model": "embed",
                "data": [{"index": 0, "embedding": vector()}],
                "usage": {"prompt_tokens": 5, "total_tokens": 5},
            },
        )

    async def exercise() -> None:
        provider = OpenAIEmbeddingProvider(
            base_url="https://embedding.example/v1",
            api_key="secret",
            model="embed",
            dimensions=DIMENSIONS,
            timeout_seconds=10,
            client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        )
        assert await provider.is_ready() is True
        assert await provider.is_ready() is True
        assert len(requests) == 1
        body = json.loads(requests[0].read())
        assert body["input"] == ["enterprise knowledge embedding readiness probe"]
        await provider.aclose()
        assert await provider.is_ready() is False

    asyncio.run(exercise())


def test_embedding_readiness_is_not_configuration_only_and_caches_failure() -> None:
    request_count = 0

    def handler(_: httpx.Request) -> httpx.Response:
        nonlocal request_count
        request_count += 1
        return httpx.Response(401, json={"error": "credential detail must stay private"})

    async def exercise() -> None:
        provider = OpenAIEmbeddingProvider(
            base_url="https://embedding.example/v1",
            api_key="invalid-secret",
            model="embed",
            dimensions=DIMENSIONS,
            timeout_seconds=10,
            client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        )
        assert await provider.is_ready() is False
        assert await provider.is_ready() is False
        assert request_count == 1
        await provider.aclose()

    asyncio.run(exercise())


def test_successful_embedding_call_supplies_readiness_evidence_without_an_extra_probe() -> None:
    request_count = 0

    def handler(_: httpx.Request) -> httpx.Response:
        nonlocal request_count
        request_count += 1
        return httpx.Response(
            200,
            json={
                "model": "embed",
                "data": [{"index": 0, "embedding": vector()}],
            },
        )

    async def exercise() -> None:
        provider = OpenAIEmbeddingProvider(
            base_url="https://embedding.example/v1",
            api_key="secret",
            model="embed",
            dimensions=DIMENSIONS,
            timeout_seconds=10,
            client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        )
        await provider.embed(["business text"], request_id="req-business-embedding")
        assert await provider.is_ready() is True
        assert request_count == 1
        await provider.aclose()

    asyncio.run(exercise())


def test_rerank_readiness_requires_a_real_success_and_caches_the_evidence() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(
            200,
            json={"results": [{"index": 0, "relevance_score": 0.99}]},
        )

    async def exercise() -> None:
        provider = CohereRerankProvider(
            base_url="https://rerank.example/v2",
            api_key="secret",
            model="rerank",
            timeout_seconds=10,
            client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        )
        assert await provider.is_ready() is True
        assert await provider.is_ready() is True
        assert len(requests) == 1
        body = json.loads(requests[0].read())
        assert body["query"] == "enterprise knowledge rerank readiness probe"
        await provider.aclose()
        assert await provider.is_ready() is False

    asyncio.run(exercise())


def test_rerank_readiness_is_not_configuration_only() -> None:
    request_count = 0

    def handler(_: httpx.Request) -> httpx.Response:
        nonlocal request_count
        request_count += 1
        return httpx.Response(503, json={"error": "private provider failure"})

    async def exercise() -> None:
        provider = CohereRerankProvider(
            base_url="https://rerank.example/v2",
            api_key="secret",
            model="rerank",
            timeout_seconds=10,
            client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        )
        assert await provider.is_ready() is False
        assert await provider.is_ready() is False
        assert request_count == 1
        await provider.aclose()

    asyncio.run(exercise())
