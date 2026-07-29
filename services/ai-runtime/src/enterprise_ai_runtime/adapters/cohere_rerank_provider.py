from __future__ import annotations

import json
from collections.abc import Callable
from time import monotonic

import httpx
from pydantic import ValidationError

from enterprise_ai_runtime.adapters.knowledge_http import (
    finite_float,
    raise_for_provider_status,
)
from enterprise_ai_runtime.adapters.provider_readiness import ProviderReadinessEvidence
from enterprise_ai_runtime.domain.errors import (
    ProviderResponseError,
    ProviderTimeoutError,
    ProviderUnavailableError,
)
from enterprise_ai_runtime.domain.knowledge_models import (
    RerankDocument,
    RerankResponse,
    RerankResult,
)


class CohereRerankProvider:
    """Cohere-compatible ``/rerank`` adapter that never trusts provider document ids."""

    def __init__(
        self,
        *,
        base_url: str,
        api_key: str,
        model: str,
        timeout_seconds: float,
        client: httpx.AsyncClient | None = None,
        readiness_success_ttl_seconds: float = 300.0,
        readiness_failure_ttl_seconds: float = 30.0,
        readiness_clock: Callable[[], float] = monotonic,
    ) -> None:
        self._endpoint = f"{base_url.rstrip('/')}/rerank"
        self._api_key = api_key
        self._model = model
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

    async def rerank(
        self,
        query: str,
        documents: list[RerankDocument],
        *,
        top_n: int,
        request_id: str,
    ) -> RerankResponse:
        try:
            response = await self._rerank(
                query,
                documents,
                top_n=top_n,
                request_id=request_id,
            )
        except Exception:
            self._readiness.record_failure()
            raise
        self._readiness.record_success()
        return response

    async def _rerank(
        self,
        query: str,
        documents: list[RerankDocument],
        *,
        top_n: int,
        request_id: str,
    ) -> RerankResponse:
        payload = json.dumps(
            {
                "model": self._model,
                "query": query,
                "documents": [document.text for document in documents],
                "top_n": top_n,
                "return_documents": False,
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
            raw_results = body.get("results")
            if not isinstance(raw_results, list) or len(raw_results) != top_n:
                raise TypeError("rerank results must contain exactly top_n items")

            results: list[RerankResult] = []
            seen_indexes: set[int] = set()
            previous_score: float | None = None
            for raw_result in raw_results:
                if not isinstance(raw_result, dict):
                    raise TypeError("rerank result must be an object")
                index = raw_result.get("index")
                if isinstance(index, bool) or not isinstance(index, int):
                    raise TypeError("rerank index must be an integer")
                if index < 0 or index >= len(documents) or index in seen_indexes:
                    raise ValueError("rerank indexes must be unique and reference an input")
                score = finite_float(raw_result.get("relevance_score"))
                if not 0 <= score <= 1:
                    raise ValueError("relevance_score must be between zero and one")
                if previous_score is not None and score > previous_score:
                    raise ValueError("rerank results must be ordered by descending relevance")
                seen_indexes.add(index)
                previous_score = score
                results.append(
                    RerankResult(
                        id=documents[index].id,
                        index=index,
                        relevance_score=score,
                    )
                )
            return RerankResponse(model=self._model, results=results)
        except (TypeError, ValueError, ValidationError) as error:
            raise ProviderResponseError() from error

    async def is_ready(self) -> bool:
        if self._closed:
            return False
        return await self._readiness.resolve(
            lambda: self.rerank(
                "enterprise knowledge rerank readiness probe",
                [
                    RerankDocument(
                        id="readiness-document",
                        text="enterprise knowledge rerank readiness probe",
                    )
                ],
                top_n=1,
                request_id="knowledge-rerank-readiness",
            )
        )

    async def aclose(self) -> None:
        if not self._closed:
            self._closed = True
            self._readiness.record_failure()
            await self._client.aclose()
