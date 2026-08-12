from __future__ import annotations

import math
from enum import StrEnum
from typing import Annotated, Literal

from pydantic import Field, StringConstraints, model_validator

from enterprise_ai_runtime.domain.models import Identifier, StrictModel

KnowledgeText = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=200_000),
]
DocumentIdentifier = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=256),
]
FiniteFloat = Annotated[float, Field(allow_inf_nan=False)]


class EmbeddingRequest(StrictModel):
    tenant_id: Identifier
    inputs: list[KnowledgeText] = Field(min_length=1, max_length=128)
    expected_model: str | None = Field(default=None, min_length=1, max_length=200)
    expected_dimensions: int | None = Field(default=None, ge=1, le=16_000)

    @model_validator(mode="after")
    def validate_total_input_size(self) -> EmbeddingRequest:
        if sum(len(value) for value in self.inputs) > 1_000_000:
            raise ValueError("embedding inputs must not exceed 1000000 characters in total")
        return self


class EmbeddingItem(StrictModel):
    index: int = Field(ge=0)
    embedding: list[FiniteFloat] = Field(min_length=1)


class EmbeddingUsage(StrictModel):
    input_tokens: int = Field(ge=0)
    total_tokens: int = Field(ge=0)

    @model_validator(mode="after")
    def validate_total_tokens(self) -> EmbeddingUsage:
        if self.total_tokens < self.input_tokens:
            raise ValueError("total_tokens must not be less than input_tokens")
        return self


class EmbeddingResponse(StrictModel):
    model: str = Field(min_length=1, max_length=200)
    dimensions: int = Field(ge=1)
    items: list[EmbeddingItem] = Field(min_length=1)
    usage: EmbeddingUsage | None = None

    @model_validator(mode="after")
    def validate_items(self) -> EmbeddingResponse:
        indexes = [item.index for item in self.items]
        if sorted(indexes) != list(range(len(self.items))):
            raise ValueError("embedding item indexes must be contiguous and unique")
        for item in self.items:
            if len(item.embedding) != self.dimensions:
                raise ValueError("embedding item dimension does not match dimensions")
            norm = math.hypot(*item.embedding)
            if not math.isfinite(norm) or norm == 0:
                raise ValueError("embedding vector must have a finite non-zero norm")
        return self


class RerankDocument(StrictModel):
    id: DocumentIdentifier
    text: KnowledgeText


class RerankRequest(StrictModel):
    tenant_id: Identifier
    query: KnowledgeText
    documents: list[RerankDocument] = Field(min_length=1, max_length=128)
    top_n: int = Field(ge=1, le=128)

    @model_validator(mode="after")
    def validate_documents(self) -> RerankRequest:
        if self.top_n > len(self.documents):
            raise ValueError("top_n must not exceed the number of documents")
        document_ids = [document.id for document in self.documents]
        if len(document_ids) != len(set(document_ids)):
            raise ValueError("document ids must be unique")
        if len(self.query) + sum(len(document.text) for document in self.documents) > 1_000_000:
            raise ValueError("rerank inputs must not exceed 1000000 characters in total")
        return self


class RerankResult(StrictModel):
    id: DocumentIdentifier
    index: int = Field(ge=0)
    relevance_score: FiniteFloat = Field(ge=0, le=1)


class RerankResponse(StrictModel):
    model: str = Field(min_length=1, max_length=200)
    results: list[RerankResult]

    @model_validator(mode="after")
    def validate_results(self) -> RerankResponse:
        ids = [result.id for result in self.results]
        indexes = [result.index for result in self.results]
        if len(ids) != len(set(ids)) or len(indexes) != len(set(indexes)):
            raise ValueError("rerank result ids and indexes must be unique")
        scores = [result.relevance_score for result in self.results]
        if scores != sorted(scores, reverse=True):
            raise ValueError("rerank results must be ordered by descending relevance")
        return self


class CapabilityStatus(StrEnum):
    DISABLED = "disabled"
    READY = "ready"
    NOT_READY = "not_ready"


class EmbeddingCapability(StrictModel):
    status: CapabilityStatus
    provider: Literal["disabled", "openai_compatible", "local_fastembed"]
    model: str | None = None
    dimensions: int = Field(ge=1)


class RerankCapability(StrictModel):
    status: CapabilityStatus
    provider: Literal["disabled", "cohere_compatible", "local_fastembed"]
    model: str | None = None


class KnowledgeCapabilitiesResponse(StrictModel):
    embeddings: EmbeddingCapability
    rerank: RerankCapability
