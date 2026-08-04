from __future__ import annotations

from typing import Protocol

from enterprise_ai_runtime.domain.knowledge_models import (
    EmbeddingResponse,
    RerankDocument,
    RerankResponse,
)


class EmbeddingProviderPort(Protocol):
    @property
    def provider(self) -> str: ...

    @property
    def model(self) -> str: ...

    @property
    def dimensions(self) -> int: ...

    async def embed(self, inputs: list[str], *, request_id: str) -> EmbeddingResponse: ...

    async def is_ready(self) -> bool: ...

    async def aclose(self) -> None: ...


class RerankProviderPort(Protocol):
    @property
    def provider(self) -> str: ...

    @property
    def model(self) -> str: ...

    async def rerank(
        self,
        query: str,
        documents: list[RerankDocument],
        *,
        top_n: int,
        request_id: str,
    ) -> RerankResponse: ...

    async def is_ready(self) -> bool: ...

    async def aclose(self) -> None: ...
