from __future__ import annotations

import asyncio
import math
from collections.abc import Callable, Iterable
from typing import Any

from enterprise_ai_runtime.adapters.provider_readiness import ProviderReadinessEvidence
from enterprise_ai_runtime.domain.errors import ProviderResponseError, ProviderUnavailableError
from enterprise_ai_runtime.domain.knowledge_models import (
    EmbeddingItem,
    EmbeddingResponse,
    RerankDocument,
    RerankResponse,
    RerankResult,
)

ModelFactory = Callable[[], Any]


class LocalFastembedEmbeddingProvider:
    """CPU-local FastEmbed adapter that preserves the existing pgvector dimension contract."""

    provider = "local_fastembed"

    def __init__(
        self,
        *,
        model: str,
        dimensions: int,
        cache_dir: str,
        threads: int,
        allow_download: bool,
        model_factory: ModelFactory | None = None,
    ) -> None:
        self._source_model = model
        self._model_name = f"local-fastembed:{model}:pad-{dimensions}-v1"
        self._dimensions = dimensions
        self._cache_dir = cache_dir
        self._threads = threads
        self._allow_download = allow_download
        self._model_factory = model_factory
        self._model: Any | None = None
        self._model_lock = asyncio.Lock()
        self._inference_lock = asyncio.Lock()
        self._closed = False
        self._readiness = ProviderReadinessEvidence()

    @property
    def model(self) -> str:
        return self._model_name

    @property
    def dimensions(self) -> int:
        return self._dimensions

    async def embed(self, inputs: list[str], *, request_id: str) -> EmbeddingResponse:
        del request_id
        if self._closed:
            raise ProviderUnavailableError()
        try:
            model = await self._resolve_model()
            async with self._inference_lock:
                raw_vectors = await asyncio.to_thread(
                    lambda: list(model.embed(inputs, batch_size=min(64, len(inputs))))
                )
            vectors = [_normalize_and_pad(vector, self._dimensions) for vector in raw_vectors]
            if len(vectors) != len(inputs):
                raise ValueError("local embedding result count does not match inputs")
            response = EmbeddingResponse(
                model=self._model_name,
                dimensions=self._dimensions,
                items=[
                    EmbeddingItem(index=index, embedding=vector)
                    for index, vector in enumerate(vectors)
                ],
                usage=None,
            )
        except ProviderUnavailableError:
            self._readiness.record_failure()
            raise
        except (TypeError, ValueError) as error:
            self._readiness.record_failure()
            raise ProviderResponseError() from error
        except Exception as error:
            self._readiness.record_failure()
            raise ProviderUnavailableError() from error
        self._readiness.record_success()
        return response

    async def is_ready(self) -> bool:
        if self._closed:
            return False
        return await self._readiness.resolve(
            lambda: self.embed(
                ["企业知识库向量服务就绪探针"],
                request_id="local-embedding-readiness",
            )
        )

    async def aclose(self) -> None:
        self._closed = True
        self._model = None
        self._readiness.record_failure()

    async def _resolve_model(self) -> Any:
        if self._model is not None:
            return self._model
        async with self._model_lock:
            if self._model is not None:
                return self._model
            factory = self._model_factory or self._default_model_factory
            self._model = await asyncio.to_thread(factory)
            return self._model

    def _default_model_factory(self) -> Any:
        from fastembed import TextEmbedding

        return TextEmbedding(
            self._source_model,
            cache_dir=self._cache_dir,
            threads=self._threads,
            lazy_load=False,
            local_files_only=not self._allow_download,
        )


class LocalFastembedRerankProvider:
    """CPU-local BGE cross-encoder reranker with normalized relevance scores."""

    provider = "local_fastembed"

    def __init__(
        self,
        *,
        model: str,
        cache_dir: str,
        threads: int,
        allow_download: bool,
        model_factory: ModelFactory | None = None,
    ) -> None:
        self._source_model = model
        self._model_name = f"local-fastembed:{model}:sigmoid-v1"
        self._cache_dir = cache_dir
        self._threads = threads
        self._allow_download = allow_download
        self._model_factory = model_factory
        self._model: Any | None = None
        self._model_lock = asyncio.Lock()
        self._inference_lock = asyncio.Lock()
        self._closed = False
        self._readiness = ProviderReadinessEvidence()

    @property
    def model(self) -> str:
        return self._model_name

    async def rerank(
        self,
        query: str,
        documents: list[RerankDocument],
        *,
        top_n: int,
        request_id: str,
    ) -> RerankResponse:
        del request_id
        if self._closed:
            raise ProviderUnavailableError()
        try:
            model = await self._resolve_model()
            async with self._inference_lock:
                raw_scores = await asyncio.to_thread(
                    lambda: list(
                        model.rerank(
                            query,
                            [document.text for document in documents],
                            batch_size=min(32, len(documents)),
                        )
                    )
                )
            if len(raw_scores) != len(documents):
                raise ValueError("local rerank result count does not match documents")
            ranked = sorted(
                (
                    (index, _sigmoid(float(score)))
                    for index, score in enumerate(raw_scores)
                    if math.isfinite(float(score))
                ),
                key=lambda item: (-item[1], item[0]),
            )
            if len(ranked) != len(documents):
                raise ValueError("local rerank returned a non-finite score")
            response = RerankResponse(
                model=self._model_name,
                results=[
                    RerankResult(
                        id=documents[index].id,
                        index=index,
                        relevance_score=score,
                    )
                    for index, score in ranked[:top_n]
                ],
            )
        except ProviderUnavailableError:
            self._readiness.record_failure()
            raise
        except (TypeError, ValueError) as error:
            self._readiness.record_failure()
            raise ProviderResponseError() from error
        except Exception as error:
            self._readiness.record_failure()
            raise ProviderUnavailableError() from error
        self._readiness.record_success()
        return response

    async def is_ready(self) -> bool:
        if self._closed:
            return False
        return await self._readiness.resolve(
            lambda: self.rerank(
                "员工如何申请休假？",
                [RerankDocument(id="readiness", text="员工应提交请假单并等待主管审批。")],
                top_n=1,
                request_id="local-rerank-readiness",
            )
        )

    async def aclose(self) -> None:
        self._closed = True
        self._model = None
        self._readiness.record_failure()

    async def _resolve_model(self) -> Any:
        if self._model is not None:
            return self._model
        async with self._model_lock:
            if self._model is not None:
                return self._model
            factory = self._model_factory or self._default_model_factory
            self._model = await asyncio.to_thread(factory)
            return self._model

    def _default_model_factory(self) -> Any:
        from fastembed.rerank.cross_encoder import TextCrossEncoder

        return TextCrossEncoder(
            self._source_model,
            cache_dir=self._cache_dir,
            threads=self._threads,
            lazy_load=False,
            local_files_only=not self._allow_download,
        )


def _normalize_and_pad(vector: Iterable[Any], dimensions: int) -> list[float]:
    values = [float(value) for value in vector]
    if not values or len(values) > dimensions or not all(math.isfinite(value) for value in values):
        raise ValueError("local embedding has an invalid dimension or value")
    norm = math.sqrt(sum(value * value for value in values))
    if not math.isfinite(norm) or norm == 0:
        raise ValueError("local embedding must have a finite non-zero norm")
    normalized = [value / norm for value in values]
    return [*normalized, *([0.0] * (dimensions - len(normalized)))]


def _sigmoid(value: float) -> float:
    if value >= 0:
        return 1.0 / (1.0 + math.exp(-value))
    exponent = math.exp(value)
    return exponent / (1.0 + exponent)
