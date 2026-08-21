from __future__ import annotations

import math
from typing import Any


def validate_capabilities(
    payload: Any,
    *,
    expected_embedding_model: str,
    expected_rerank_model: str,
    expected_dimensions: int = 1536,
) -> dict[str, Any]:
    body = _object(payload, "capabilities")
    embeddings = _object(body.get("embeddings"), "capabilities.embeddings")
    rerank = _object(body.get("rerank"), "capabilities.rerank")
    failures: list[str] = []
    if embeddings.get("status") != "ready":
        failures.append("embedding capability is not ready")
    if embeddings.get("provider") in (None, "disabled"):
        failures.append("embedding provider is disabled or missing")
    if embeddings.get("model") != expected_embedding_model:
        failures.append(
            "embedding capability model does not match the expected immutable model"
        )
    if embeddings.get("dimensions") != expected_dimensions:
        failures.append(
            f"embedding capability dimensions must be {expected_dimensions}"
        )
    if rerank.get("status") != "ready":
        failures.append("rerank capability is not ready")
    if rerank.get("provider") in (None, "disabled"):
        failures.append("rerank provider is disabled or missing")
    if rerank.get("model") != expected_rerank_model:
        failures.append(
            "rerank capability model does not match the expected immutable model"
        )
    if failures:
        raise ValueError("; ".join(failures))
    return {
        "embeddingProvider": embeddings["provider"],
        "embeddingModel": embeddings["model"],
        "embeddingDimensions": embeddings["dimensions"],
        "rerankProvider": rerank["provider"],
        "rerankModel": rerank["model"],
    }


def validate_embedding_response(
    payload: Any,
    *,
    expected_model: str,
    expected_count: int,
    expected_dimensions: int = 1536,
) -> dict[str, Any]:
    body = _object(payload, "embedding response")
    if body.get("model") != expected_model:
        raise ValueError(
            "embedding response model does not match the expected immutable model"
        )
    if body.get("dimensions") != expected_dimensions:
        raise ValueError(f"embedding response dimensions must be {expected_dimensions}")
    items = body.get("items")
    if not isinstance(items, list) or len(items) != expected_count:
        raise ValueError(
            f"embedding response must contain exactly {expected_count} items"
        )

    vectors: list[list[float]] = []
    norms: list[float] = []
    for expected_index, raw_item in enumerate(items):
        item = _object(raw_item, f"embedding item {expected_index}")
        if item.get("index") != expected_index:
            raise ValueError(
                "embedding response indexes must be contiguous and ordered"
            )
        raw_vector = item.get("embedding")
        if not isinstance(raw_vector, list) or len(raw_vector) != expected_dimensions:
            raise ValueError(
                f"each embedding must contain {expected_dimensions} components"
            )
        if not all(
            isinstance(component, (int, float))
            and not isinstance(component, bool)
            and math.isfinite(component)
            for component in raw_vector
        ):
            raise ValueError("embedding components must be finite numbers")
        vector = [float(component) for component in raw_vector]
        norm = math.sqrt(sum(component * component for component in vector))
        if not math.isfinite(norm) or norm <= 0:
            raise ValueError("embedding vectors must have a finite non-zero norm")
        vectors.append(vector)
        norms.append(norm)

    if len(vectors) > 1 and any(vector == vectors[0] for vector in vectors[1:]):
        raise ValueError("different smoke inputs must not return identical embeddings")
    return {
        "model": body["model"],
        "dimensions": body["dimensions"],
        "itemCount": len(items),
        "minVectorNorm": min(norms),
        "maxVectorNorm": max(norms),
        "usageReported": isinstance(body.get("usage"), dict),
    }


def validate_rerank_response(
    payload: Any,
    *,
    expected_model: str,
    input_ids: list[str],
    expected_best_id: str,
) -> dict[str, Any]:
    body = _object(payload, "rerank response")
    if body.get("model") != expected_model:
        raise ValueError(
            "rerank response model does not match the expected immutable model"
        )
    raw_results = body.get("results")
    if not isinstance(raw_results, list) or len(raw_results) != len(input_ids):
        raise ValueError("rerank smoke must return every input document")

    seen_ids: set[str] = set()
    seen_indexes: set[int] = set()
    scores: list[float] = []
    for raw_result in raw_results:
        result = _object(raw_result, "rerank result")
        result_id = result.get("id")
        index = result.get("index")
        score = result.get("relevance_score")
        if result_id not in input_ids or result_id in seen_ids:
            raise ValueError("rerank result ids must uniquely reference an input")
        if (
            isinstance(index, bool)
            or not isinstance(index, int)
            or index < 0
            or index >= len(input_ids)
            or index in seen_indexes
            or input_ids[index] != result_id
        ):
            raise ValueError("rerank indexes must uniquely match input positions")
        if (
            isinstance(score, bool)
            or not isinstance(score, (int, float))
            or not math.isfinite(score)
            or not 0 <= score <= 1
        ):
            raise ValueError("rerank scores must be finite numbers in [0, 1]")
        seen_ids.add(result_id)
        seen_indexes.add(index)
        scores.append(float(score))

    if scores != sorted(scores, reverse=True):
        raise ValueError("rerank results must be ordered by descending score")
    if raw_results[0]["id"] != expected_best_id:
        raise ValueError(
            "reranker did not rank the semantically relevant smoke document first"
        )
    if len(scores) > 1 and scores[0] <= scores[1]:
        raise ValueError("reranker smoke winner must have a strictly higher score")
    return {
        "model": body["model"],
        "resultCount": len(raw_results),
        "bestDocumentId": raw_results[0]["id"],
        "bestScore": scores[0],
        "scoreMargin": scores[0] - scores[1] if len(scores) > 1 else scores[0],
    }


def _object(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise TypeError(f"{label} must be a JSON object")
    return value
