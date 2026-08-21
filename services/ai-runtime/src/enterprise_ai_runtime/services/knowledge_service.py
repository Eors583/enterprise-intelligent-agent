from __future__ import annotations

from enterprise_ai_runtime.domain.errors import (
    KnowledgeCapabilityDisabledError,
    KnowledgeEmbeddingProfileMismatchError,
)
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
from enterprise_ai_runtime.telemetry import mark_span_result, runtime_span


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
        with runtime_span(
            "knowledge.embedding.generate",
            {
                "tenant.id": command.tenant_id,
                "knowledge.input_count": len(command.inputs),
                "knowledge.embedding.dimensions": self._embedding_dimensions,
            },
        ) as span:
            if self._embedding_provider is None:
                raise KnowledgeCapabilityDisabledError("embeddings")
            if (
                command.expected_model is not None
                and command.expected_model != self._embedding_provider.model
            ) or (
                command.expected_dimensions is not None
                and command.expected_dimensions != self._embedding_dimensions
            ):
                raise KnowledgeEmbeddingProfileMismatchError()
            response = await self._embedding_provider.embed(
                command.inputs,
                request_id=request_id,
            )
            if (
                command.expected_model is not None
                and command.expected_model != response.model
            ) or (
                command.expected_dimensions is not None
                and command.expected_dimensions != response.dimensions
            ):
                raise KnowledgeEmbeddingProfileMismatchError()
            span.set_attribute("gen_ai.request.model", response.model)
            mark_span_result(span, status="succeeded")
            return response

    async def rerank(self, command: RerankRequest, *, request_id: str) -> RerankResponse:
        with runtime_span(
            "knowledge.rerank",
            {
                "tenant.id": command.tenant_id,
                "knowledge.candidate_count": len(command.documents),
                "knowledge.result_limit": command.top_n,
            },
        ) as span:
            if self._rerank_provider is None:
                raise KnowledgeCapabilityDisabledError("rerank")
            response = await self._rerank_provider.rerank(
                command.query,
                command.documents,
                top_n=command.top_n,
                request_id=request_id,
            )
            span.set_attribute("gen_ai.request.model", response.model)
            mark_span_result(span, status="succeeded")
            return response

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
                    getattr(self._embedding_provider, "provider", "openai_compatible")
                    if self._embedding_provider is not None
                    else "disabled"
                ),
                model=(
                    self._embedding_provider.model if self._embedding_provider is not None else None
                ),
                dimensions=self._embedding_dimensions,
            ),
            rerank=RerankCapability(
                status=rerank_status,
                provider=(
                    getattr(self._rerank_provider, "provider", "cohere_compatible")
                    if self._rerank_provider is not None
                    else "disabled"
                ),
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
