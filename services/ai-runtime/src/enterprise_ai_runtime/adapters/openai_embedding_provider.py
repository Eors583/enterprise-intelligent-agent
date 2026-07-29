from __future__ import annotations

import json
import math
from collections.abc import Callable
from time import monotonic
from typing import Any

import httpx
from pydantic import ValidationError

from enterprise_ai_runtime.adapters.knowledge_http import (
    finite_float,
    non_negative_int,
    raise_for_provider_status,
)
from enterprise_ai_runtime.adapters.provider_readiness import ProviderReadinessEvidence
from enterprise_ai_runtime.domain.errors import (
    ProviderResponseError,
    ProviderTimeoutError,
    ProviderUnavailableError,
)
from enterprise_ai_runtime.domain.knowledge_models import (
    EmbeddingItem,
    EmbeddingResponse,
    EmbeddingUsage,
)


class OpenAIEmbeddingProvider:
    """OpenAI-compatible ``/embeddings`` adapter with a fixed vector dimension."""

    def __init__(
        self,
        *,
        base_url: str,
        api_key: str,
        model: str,
        dimensions: int,
        timeout_seconds: float,
        client: httpx.AsyncClient | None = None,
        readiness_success_ttl_seconds: float = 300.0,
        readiness_failure_ttl_seconds: float = 30.0,
        readiness_clock: Callable[[], float] = monotonic,
    ) -> None:
        self._endpoint = f"{base_url.rstrip('/')}/embeddings"
        self._api_key = api_key
        self._model = model
        self._dimensions = dimensions
        self._timeout_seconds = timeout_seconds
        self._client = client if client is not None else httpx.AsyncClient(trust_env=False)
        self._closed = False
        self._readiness = ProviderReadinessEvidence(
            success_ttl_seconds=readiness_success_ttl_seconds,
            failure_ttl_seconds=readiness_failure_ttl_seconds,
            clock=readiness_clock,
        )

    @property
    def model(self) -> str:
        return self._model

    @property
    def dimensions(self) -> int:
        return self._dimensions

    async def embed(self, inputs: list[str], *, request_id: str) -> EmbeddingResponse:
        try:
            response = await self._embed(inputs, request_id=request_id)
        except Exception:
            self._readiness.record_failure()
            raise
        self._readiness.record_success()
        return response

    async def _embed(self, inputs: list[str], *, request_id: str) -> EmbeddingResponse:
        payload = json.dumps(
            {
                "model": self._model,
                "input": inputs,
                "encoding_format": "float",
                "dimensions": self._dimensions,
            },
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
        try:
            response = await self._client.post(
                self._endpoint,
                content=payload,
                headers={
                    "Authorization": f"Bearer {self._api_key}",
                    "Content-Type": "application/json",
                    "X-Request-ID": request_id,
                    "X-Correlation-ID": request_id,
                },
                timeout=httpx.Timeout(self._timeout_seconds),
            )
        except httpx.TimeoutException:
            raise ProviderTimeoutError() from None
        except httpx.TransportError:
            raise ProviderUnavailableError() from None

        raise_for_provider_status(response.status_code)
        try:
            body = response.json()
            if not isinstance(body, dict):
                raise TypeError("response body must be an object")
            data = body.get("data")
            if not isinstance(data, list) or len(data) != len(inputs):
                raise TypeError("response data must contain one item per input")

            items: list[EmbeddingItem] = []
            seen_indexes: set[int] = set()
            for raw_item in data:
                if not isinstance(raw_item, dict):
                    raise TypeError("embedding item must be an object")
                index = raw_item.get("index")
                if isinstance(index, bool) or not isinstance(index, int):
                    raise TypeError("embedding index must be an integer")
                if index < 0 or index >= len(inputs) or index in seen_indexes:
                    raise ValueError("embedding indexes must uniquely cover all inputs")
                raw_embedding = raw_item.get("embedding")
                if not isinstance(raw_embedding, list) or len(raw_embedding) != self._dimensions:
                    raise ValueError("embedding dimension does not match configured dimension")
                seen_indexes.add(index)
                embedding = [finite_float(value) for value in raw_embedding]
                norm = math.hypot(*embedding)
                if not math.isfinite(norm) or norm == 0:
                    raise ValueError("embedding vector must have a finite non-zero norm")
                items.append(
                    EmbeddingItem(
                        index=index,
                        embedding=embedding,
                    )
                )
            if seen_indexes != set(range(len(inputs))):
                raise ValueError("embedding indexes must uniquely cover all inputs")

            usage = _embedding_usage(body.get("usage"))
            response_model = body.get("model") or self._model
            if not isinstance(response_model, str) or not response_model.strip():
                raise TypeError("response model must be text")
            return EmbeddingResponse(
                model=response_model,
                dimensions=self._dimensions,
                items=sorted(items, key=lambda item: item.index),
                usage=usage,
            )
        except (TypeError, ValueError, ValidationError) as error:
            raise ProviderResponseError() from error

    async def is_ready(self) -> bool:
        if self._closed:
            return False
        return await self._readiness.resolve(
            lambda: self.embed(
                ["enterprise knowledge embedding readiness probe"],
                request_id="knowledge-embedding-readiness",
            )
        )

    async def aclose(self) -> None:
        if not self._closed:
            self._closed = True
            self._readiness.record_failure()
            await self._client.aclose()


def _embedding_usage(raw_usage: Any) -> EmbeddingUsage | None:
    if raw_usage is None:
        return None
    if not isinstance(raw_usage, dict):
        raise TypeError("usage must be an object")
    raw_input_tokens = raw_usage.get("prompt_tokens", raw_usage.get("input_tokens"))
    return EmbeddingUsage(
        input_tokens=non_negative_int(raw_input_tokens),
        total_tokens=non_negative_int(raw_usage.get("total_tokens")),
    )
