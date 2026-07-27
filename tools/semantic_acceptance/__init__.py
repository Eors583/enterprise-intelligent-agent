"""Offline-first semantic retrieval acceptance harness."""

from .evaluation import AcceptanceThresholds, evaluate_cases
from .metrics import mean_reciprocal_rank, ndcg_at_k, percentile, recall_at_k

__all__ = [
    "AcceptanceThresholds",
    "evaluate_cases",
    "mean_reciprocal_rank",
    "ndcg_at_k",
    "percentile",
    "recall_at_k",
]
