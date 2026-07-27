from __future__ import annotations

import math
import unittest

from tools.semantic_acceptance.metrics import (
    mean_reciprocal_rank,
    ndcg_at_k,
    percentile,
    recall_at_k,
    reciprocal_rank,
)


class MetricsTest(unittest.TestCase):
    def test_recall_and_reciprocal_rank(self) -> None:
        relevance = {"a": 1.0, "c": 1.0}
        retrieved = ["x", "a", "y", "c"]

        self.assertEqual(recall_at_k(retrieved, relevance, 3), 0.5)
        self.assertEqual(reciprocal_rank(retrieved, relevance), 0.5)
        self.assertEqual(
            mean_reciprocal_rank([(retrieved, relevance), (["c"], relevance)]), 0.75
        )

    def test_ndcg_uses_graded_relevance(self) -> None:
        relevance = {"best": 3.0, "useful": 1.0}

        self.assertEqual(ndcg_at_k(["best", "useful"], relevance, 10), 1.0)
        self.assertLess(ndcg_at_k(["useful", "best"], relevance, 10), 1.0)
        expected = ((2**1 - 1) + (2**3 - 1) / math.log2(3)) / (
            (2**3 - 1) + (2**1 - 1) / math.log2(3)
        )
        self.assertAlmostEqual(ndcg_at_k(["useful", "best"], relevance, 10), expected)

    def test_nearest_rank_p95(self) -> None:
        self.assertEqual(percentile(list(range(1, 21)), 0.95), 19)
        self.assertEqual(percentile([42], 0.95), 42)

    def test_empty_metric_inputs_are_rejected(self) -> None:
        with self.assertRaises(ValueError):
            recall_at_k([], {}, 5)
        with self.assertRaises(ValueError):
            ndcg_at_k([], {}, 10)
        with self.assertRaises(ValueError):
            percentile([], 0.95)


if __name__ == "__main__":
    unittest.main()
