from __future__ import annotations

import math
from collections.abc import Mapping, Sequence


def recall_at_k(
    retrieved_ids: Sequence[str], relevance: Mapping[str, float], k: int
) -> float:
    """Return binary recall at *k* for one answerable query."""
    if k <= 0:
        raise ValueError("k must be positive")
    relevant_ids = {item_id for item_id, grade in relevance.items() if grade > 0}
    if not relevant_ids:
        raise ValueError("recall is undefined without relevant items")
    hits = relevant_ids.intersection(retrieved_ids[:k])
    return len(hits) / len(relevant_ids)


def reciprocal_rank(
    retrieved_ids: Sequence[str], relevance: Mapping[str, float]
) -> float:
    relevant_ids = {item_id for item_id, grade in relevance.items() if grade > 0}
    if not relevant_ids:
        raise ValueError("reciprocal rank is undefined without relevant items")
    for rank, item_id in enumerate(retrieved_ids, start=1):
        if item_id in relevant_ids:
            return 1.0 / rank
    return 0.0


def mean_reciprocal_rank(
    ranked_results: Sequence[tuple[Sequence[str], Mapping[str, float]]],
) -> float:
    if not ranked_results:
        raise ValueError("MRR is undefined without answerable queries")
    return sum(
        reciprocal_rank(retrieved, relevance) for retrieved, relevance in ranked_results
    ) / len(ranked_results)


def dcg_at_k(
    retrieved_ids: Sequence[str], relevance: Mapping[str, float], k: int
) -> float:
    if k <= 0:
        raise ValueError("k must be positive")
    return sum(
        (2.0 ** relevance.get(item_id, 0.0) - 1.0) / math.log2(rank + 1)
        for rank, item_id in enumerate(retrieved_ids[:k], start=1)
    )


def ndcg_at_k(
    retrieved_ids: Sequence[str], relevance: Mapping[str, float], k: int
) -> float:
    if not any(grade > 0 for grade in relevance.values()):
        raise ValueError("nDCG is undefined without relevant items")
    ideal_grades = sorted(
        (grade for grade in relevance.values() if grade > 0), reverse=True
    )[:k]
    ideal = sum(
        (2.0**grade - 1.0) / math.log2(rank + 1)
        for rank, grade in enumerate(ideal_grades, start=1)
    )
    if ideal == 0:
        return 0.0
    return dcg_at_k(retrieved_ids, relevance, k) / ideal


def percentile(values: Sequence[float], quantile: float) -> float:
    """Nearest-rank percentile, suitable for an acceptance latency gate."""
    if not values:
        raise ValueError("percentile is undefined for an empty sample")
    if not 0 < quantile <= 1:
        raise ValueError("quantile must be in (0, 1]")
    ordered = sorted(values)
    rank = math.ceil(quantile * len(ordered))
    return ordered[rank - 1]
