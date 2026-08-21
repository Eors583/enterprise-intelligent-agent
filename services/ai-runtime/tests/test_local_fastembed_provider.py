from __future__ import annotations

import asyncio
import math

import pytest

from enterprise_ai_runtime.adapters.local_fastembed_provider import (
    LocalFastembedEmbeddingProvider,
    LocalFastembedRerankProvider,
)
from enterprise_ai_runtime.domain.errors import ProviderResponseError, ProviderUnavailableError
from enterprise_ai_runtime.domain.knowledge_models import RerankDocument


class FakeEmbeddingModel:
    def __init__(self, vectors: list[list[float]]) -> None:
        self.vectors = vectors
        self.calls: list[tuple[list[str], int]] = []

    def embed(self, inputs: list[str], *, batch_size: int) -> list[list[float]]:
        self.calls.append((inputs, batch_size))
        return self.vectors


class FakeRerankModel:
    def __init__(self, scores: list[float]) -> None:
        self.scores = scores
        self.calls: list[tuple[str, list[str], int]] = []

    def rerank(self, query: str, documents: list[str], *, batch_size: int) -> list[float]:
        self.calls.append((query, documents, batch_size))
        return self.scores


def test_local_embedding_normalizes_and_pads_without_changing_cosine_geometry() -> None:
    model = FakeEmbeddingModel([[3.0, 4.0], [0.0, 5.0]])
    provider = LocalFastembedEmbeddingProvider(
        model="local-test-model",
        dimensions=4,
        cache_dir="unused",
        threads=1,
        allow_download=False,
        model_factory=lambda: model,
    )

    response = asyncio.run(provider.embed(["甲", "乙"], request_id="request-a"))

    assert response.model == "local-fastembed:local-test-model:pad-4-v1"
    assert response.dimensions == 4
    assert response.usage is None
    assert response.items[0].embedding == pytest.approx([0.6, 0.8, 0.0, 0.0])
    assert response.items[1].embedding == pytest.approx([0.0, 1.0, 0.0, 0.0])
    assert math.isclose(
        sum(
            a * b
            for a, b in zip(
                response.items[0].embedding,
                response.items[1].embedding,
                strict=True,
            )
        ),
        0.8,
    )
    assert model.calls == [(["甲", "乙"], 2)]


def test_local_embedding_rejects_invalid_model_output_and_closes() -> None:
    provider = LocalFastembedEmbeddingProvider(
        model="local-test-model",
        dimensions=2,
        cache_dir="unused",
        threads=1,
        allow_download=False,
        model_factory=lambda: FakeEmbeddingModel([[0.0, 0.0]]),
    )
    with pytest.raises(ProviderResponseError):
        asyncio.run(provider.embed(["甲"], request_id="request-a"))

    asyncio.run(provider.aclose())
    with pytest.raises(ProviderUnavailableError):
        asyncio.run(provider.embed(["甲"], request_id="request-b"))


def test_local_cross_encoder_maps_logits_to_sorted_probabilities_and_original_ids() -> None:
    model = FakeRerankModel([-2.0, 3.0, 0.0])
    provider = LocalFastembedRerankProvider(
        model="local-rerank-model",
        cache_dir="unused",
        threads=1,
        allow_download=False,
        model_factory=lambda: model,
    )
    documents = [
        RerankDocument(id="a", text="不相关"),
        RerankDocument(id="b", text="最相关"),
        RerankDocument(id="c", text="一般相关"),
    ]

    response = asyncio.run(
        provider.rerank("问题", documents, top_n=2, request_id="request-rerank")
    )

    assert response.model == "local-fastembed:local-rerank-model:sigmoid-v1"
    assert [result.id for result in response.results] == ["b", "c"]
    assert [result.index for result in response.results] == [1, 2]
    assert response.results[0].relevance_score == pytest.approx(0.952574, abs=1e-6)
    assert response.results[1].relevance_score == pytest.approx(0.5)
    assert model.calls == [("问题", ["不相关", "最相关", "一般相关"], 3)]


def test_local_model_factory_failure_is_reported_as_provider_unavailable() -> None:
    def fail() -> None:
        raise OSError("model cache missing")

    provider = LocalFastembedRerankProvider(
        model="local-rerank-model",
        cache_dir="unused",
        threads=1,
        allow_download=False,
        model_factory=fail,
    )

    with pytest.raises(ProviderUnavailableError):
        asyncio.run(
            provider.rerank(
                "问题",
                [RerankDocument(id="a", text="答案")],
                top_n=1,
                request_id="request-rerank",
            )
        )
