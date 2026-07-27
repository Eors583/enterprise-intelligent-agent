from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from enterprise_ai_runtime.domain.errors import (
    ProviderAuthenticationError,
    ProviderRateLimitError,
    ProviderTimeoutError,
    ProviderUnavailableError,
)
from enterprise_ai_runtime.domain.knowledge_models import (
    EmbeddingItem,
    EmbeddingResponse,
    EmbeddingUsage,
    RerankDocument,
    RerankResponse,
    RerankResult,
)
from enterprise_ai_runtime.main import create_app
from enterprise_ai_runtime.services.knowledge_service import KnowledgeService


class StubEmbeddingProvider:
    model = "embedding-model"
    dimensions = 1536

    def __init__(self, error: Exception | None = None, *, ready: bool = True) -> None:
        self.error = error
        self.ready = ready
        self.closed = False

    async def embed(self, inputs: list[str], *, request_id: str) -> EmbeddingResponse:
        assert inputs == ["text"]
        assert request_id == "req-embedding-api"
        if self.error is not None:
            raise self.error
        return EmbeddingResponse(
            model=self.model,
            dimensions=self.dimensions,
            items=[EmbeddingItem(index=0, embedding=[0.5, *([0.0] * 1535)])],
            usage=EmbeddingUsage(input_tokens=1, total_tokens=1),
        )

    async def is_ready(self) -> bool:
        return self.ready and not self.closed

    async def aclose(self) -> None:
        self.closed = True


class StubRerankProvider:
    model = "rerank-model"

    def __init__(self) -> None:
        self.closed = False

    async def rerank(
        self,
        query: str,
        documents: list[RerankDocument],
        *,
        top_n: int,
        request_id: str,
    ) -> RerankResponse:
        assert query == "question"
        assert top_n == 1
        assert request_id == "req-rerank-api"
        return RerankResponse(
            model=self.model,
            results=[RerankResult(id=documents[0].id, index=0, relevance_score=0.9)],
        )

    async def is_ready(self) -> bool:
        return not self.closed

    async def aclose(self) -> None:
        self.closed = True


def test_knowledge_capabilities_are_disabled_by_default(client: TestClient) -> None:
    response = client.get(
        "/internal/v1/knowledge/capabilities",
        headers={"X-Tenant-ID": "tenant-a"},
    )
    assert response.status_code == 200
    assert response.json() == {
        "embeddings": {
            "status": "disabled",
            "provider": "disabled",
            "model": None,
            "dimensions": 1536,
        },
        "rerank": {
            "status": "disabled",
            "provider": "disabled",
            "model": None,
        },
    }


def test_knowledge_endpoints_require_and_enforce_tenant_context(client: TestClient) -> None:
    missing = client.post(
        "/internal/v1/knowledge/embeddings",
        json={"tenant_id": "tenant-a", "inputs": ["text"]},
    )
    assert missing.status_code == 422

    mismatch = client.post(
        "/internal/v1/knowledge/rerank",
        headers={"X-Tenant-ID": "tenant-b"},
        json={
            "tenant_id": "tenant-a",
            "query": "question",
            "documents": [{"id": "chunk-a", "text": "answer"}],
            "top_n": 1,
        },
    )
    assert mismatch.status_code == 400
    assert mismatch.json()["detail"] == {
        "code": "TENANT_CONTEXT_MISMATCH",
        "message": "X-Tenant-ID must match body tenant_id",
        "retryable": False,
    }


def test_disabled_knowledge_provider_fails_explicitly(client: TestClient) -> None:
    response = client.post(
        "/internal/v1/knowledge/embeddings",
        headers={"X-Tenant-ID": "tenant-a"},
        json={"tenant_id": "tenant-a", "inputs": ["text"]},
    )
    assert response.status_code == 503
    assert response.json()["detail"] == {
        "code": "KNOWLEDGE_CAPABILITY_DISABLED",
        "message": "knowledge embeddings capability is disabled",
        "retryable": False,
    }


def test_rerank_request_rejects_duplicate_ids_and_invalid_top_n() -> None:
    with TestClient(create_app()) as client:
        response = client.post(
            "/internal/v1/knowledge/rerank",
            headers={"X-Tenant-ID": "tenant-a"},
            json={
                "tenant_id": "tenant-a",
                "query": "question",
                "documents": [
                    {"id": "same", "text": "one"},
                    {"id": "same", "text": "two"},
                ],
                "top_n": 3,
            },
        )
    assert response.status_code == 422


def test_configured_knowledge_endpoints_return_the_internal_contract_and_close_resources() -> None:
    embedding_provider = StubEmbeddingProvider()
    rerank_provider = StubRerankProvider()
    service = KnowledgeService(
        embedding_provider=embedding_provider,
        rerank_provider=rerank_provider,
    )
    with TestClient(create_app(knowledge_service=service)) as client:
        capabilities = client.get(
            "/internal/v1/knowledge/capabilities",
            headers={"X-Tenant-ID": "tenant-a"},
        )
        embedded = client.post(
            "/internal/v1/knowledge/embeddings",
            headers={"X-Tenant-ID": "tenant-a", "X-Request-ID": "req-embedding-api"},
            json={"tenant_id": "tenant-a", "inputs": ["text"]},
        )
        reranked = client.post(
            "/internal/v1/knowledge/rerank",
            headers={"X-Tenant-ID": "tenant-a", "X-Request-ID": "req-rerank-api"},
            json={
                "tenant_id": "tenant-a",
                "query": "question",
                "documents": [{"id": "chunk-a", "text": "answer"}],
                "top_n": 1,
            },
        )

    assert capabilities.status_code == 200
    assert capabilities.json()["embeddings"]["status"] == "ready"
    assert capabilities.json()["rerank"]["status"] == "ready"
    assert embedded.status_code == 200
    assert embedded.json()["model"] == "embedding-model"
    assert embedded.json()["dimensions"] == 1536
    assert len(embedded.json()["items"][0]["embedding"]) == 1536
    assert embedded.json()["usage"] == {"input_tokens": 1, "total_tokens": 1}
    assert reranked.status_code == 200
    assert reranked.json() == {
        "model": "rerank-model",
        "results": [{"id": "chunk-a", "index": 0, "relevance_score": 0.9}],
    }
    assert embedding_provider.closed
    assert rerank_provider.closed


@pytest.mark.parametrize(
    ("error", "status_code", "code", "retryable"),
    [
        (ProviderTimeoutError(), 504, "PROVIDER_TIMEOUT", True),
        (ProviderRateLimitError(), 429, "PROVIDER_RATE_LIMITED", True),
        (
            ProviderAuthenticationError(),
            502,
            "PROVIDER_AUTHENTICATION_FAILED",
            False,
        ),
        (ProviderUnavailableError(), 502, "PROVIDER_UNAVAILABLE", True),
    ],
)
def test_knowledge_api_maps_provider_errors_to_sanitized_details(
    error: Exception,
    status_code: int,
    code: str,
    retryable: bool,
) -> None:
    service = KnowledgeService(embedding_provider=StubEmbeddingProvider(error))
    with TestClient(create_app(knowledge_service=service)) as client:
        response = client.post(
            "/internal/v1/knowledge/embeddings",
            headers={"X-Tenant-ID": "tenant-a", "X-Request-ID": "req-embedding-api"},
            json={"tenant_id": "tenant-a", "inputs": ["text"]},
        )
    assert response.status_code == status_code
    assert response.json()["detail"]["code"] == code
    assert response.json()["detail"]["retryable"] is retryable
    assert "upstream" not in response.json()["detail"]["message"]


def test_enabled_unready_knowledge_provider_blocks_readiness() -> None:
    service = KnowledgeService(embedding_provider=StubEmbeddingProvider(ready=False))
    with TestClient(create_app(knowledge_service=service)) as client:
        response = client.get("/health/ready")
    assert response.status_code == 503
    assert response.json()["status"] == "not_ready"
    assert response.json()["components"] == {
        "run_store": "ready",
        "runtime": "ready",
        "knowledge_embeddings": "not_ready",
    }
