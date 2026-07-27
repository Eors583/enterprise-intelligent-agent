from __future__ import annotations

from enterprise_ai_runtime.domain.errors import KnowledgeCapabilityDisabledError
from enterprise_ai_runtime.domain.knowledge_models import (
    CapabilityStatus,
    EmbeddingCapability,
    EmbeddingRequest,
    EmbeddingResponse,
    KnowledgeCapabilitiesResponse,
    RerankCapability,
    RerankRequest,
    RerankResponse,
)
from enterprise_ai_runtime.ports.knowledge import (
    EmbeddingProviderPort,
    RerankProviderPort,
)


class KnowledgeService:
    def __init__(
        self,
        *,
        embedding_provider: EmbeddingProviderPort | None = None,
        rerank_provider: RerankProviderPort | None = None,
        embedding_dimensions: int = 1536,
    ) -> None:
        self._embedding_provider = embedding_provider
        self._rerank_provider = rerank_provider
        self._embedding_dimensions = embedding_dimensions

    async def embed(self, command: EmbeddingRequest, *, request_id: str) -> EmbeddingResponse:
        if self._embedding_provider is None:
            raise KnowledgeCapabilityDisabledError("embeddings")
        return await self._embedding_provider.embed(command.inputs, request_id=request_id)

    async def rerank(self, command: RerankRequest, *, request_id: str) -> RerankResponse:
        if self._rerank_provider is None:
            raise KnowledgeCapabilityDisabledError("rerank")
        return await self._rerank_provider.rerank(
            command.query,
            command.documents,
            top_n=command.top_n,
            request_id=request_id,
        )

    async def capabilities(self) -> KnowledgeCapabilitiesResponse:
        embedding_status = CapabilityStatus.DISABLED
        if self._embedding_provider is not None:
            embedding_status = (
                CapabilityStatus.READY
                if await self._embedding_provider.is_ready()
                else CapabilityStatus.NOT_READY
            )
        rerank_status = CapabilityStatus.DISABLED
        if self._rerank_provider is not None:
            rerank_status = (
                CapabilityStatus.READY
                if await self._rerank_provider.is_ready()
                else CapabilityStatus.NOT_READY
            )
        return KnowledgeCapabilitiesResponse(
            embeddings=EmbeddingCapability(
                status=embedding_status,
                provider=(
                    "openai_compatible" if self._embedding_provider is not None else "disabled"
                ),
                model=(
                    self._embedding_provider.model
                    if self._embedding_provider is not None
                    else None
                ),
                dimensions=self._embedding_dimensions,
            ),
            rerank=RerankCapability(
                status=rerank_status,
                provider="cohere_compatible" if self._rerank_provider is not None else "disabled",
                model=self._rerank_provider.model if self._rerank_provider is not None else None,
            ),
        )

    async def readiness_components(self) -> dict[str, bool]:
        components: dict[str, bool] = {}
        if self._embedding_provider is not None:
            components["knowledge_embeddings"] = await self._embedding_provider.is_ready()
        if self._rerank_provider is not None:
            components["knowledge_rerank"] = await self._rerank_provider.is_ready()
        return components

    async def aclose(self) -> None:
        try:
            if self._embedding_provider is not None:
                await self._embedding_provider.aclose()
        finally:
            if self._rerank_provider is not None:
                await self._rerank_provider.aclose()
