from __future__ import annotations

import unittest

from tools.semantic_acceptance.provider_smoke import (
    validate_capabilities,
    validate_embedding_response,
    validate_rerank_response,
)

EMBEDDING_MODEL = "embedding-model-immutable-v1"
RERANK_MODEL = "reranker-model-immutable-v1"


class ProviderSmokeValidationTest(unittest.TestCase):
    def test_accepts_ready_capabilities_and_nonzero_embeddings(self) -> None:
        capabilities = validate_capabilities(
            {
                "embeddings": {
                    "status": "ready",
                    "provider": "openai_compatible",
                    "model": EMBEDDING_MODEL,
                    "dimensions": 1536,
                },
                "rerank": {
                    "status": "ready",
                    "provider": "cohere_compatible",
                    "model": RERANK_MODEL,
                },
            },
            expected_embedding_model=EMBEDDING_MODEL,
            expected_rerank_model=RERANK_MODEL,
        )
        embeddings = validate_embedding_response(
            {
                "model": EMBEDDING_MODEL,
                "dimensions": 1536,
                "items": [
                    {"index": 0, "embedding": [1.0] + [0.0] * 1535},
                    {"index": 1, "embedding": [0.0, 1.0] + [0.0] * 1534},
                ],
            },
            expected_model=EMBEDDING_MODEL,
            expected_count=2,
        )

        self.assertEqual(capabilities["embeddingDimensions"], 1536)
        self.assertEqual(embeddings["minVectorNorm"], 1.0)

    def test_rejects_zero_and_identical_embedding_vectors(self) -> None:
        with self.assertRaisesRegex(ValueError, "non-zero"):
            validate_embedding_response(
                {
                    "model": EMBEDDING_MODEL,
                    "dimensions": 1536,
                    "items": [{"index": 0, "embedding": [0.0] * 1536}],
                },
                expected_model=EMBEDDING_MODEL,
                expected_count=1,
            )
        vector = [1.0] + [0.0] * 1535
        with self.assertRaisesRegex(ValueError, "identical"):
            validate_embedding_response(
                {
                    "model": EMBEDDING_MODEL,
                    "dimensions": 1536,
                    "items": [
                        {"index": 0, "embedding": vector},
                        {"index": 1, "embedding": vector},
                    ],
                },
                expected_model=EMBEDDING_MODEL,
                expected_count=2,
            )

    def test_rerank_smoke_requires_semantic_winner_and_score_margin(self) -> None:
        result = validate_rerank_response(
            {
                "model": RERANK_MODEL,
                "results": [
                    {
                        "id": "travel",
                        "index": 2,
                        "relevance_score": 0.91,
                    },
                    {"id": "visitor", "index": 0, "relevance_score": 0.2},
                    {"id": "meeting", "index": 1, "relevance_score": 0.1},
                ],
            },
            expected_model=RERANK_MODEL,
            input_ids=["visitor", "meeting", "travel"],
            expected_best_id="travel",
        )

        self.assertAlmostEqual(result["scoreMargin"], 0.71)

    def test_rejects_wrong_rerank_winner(self) -> None:
        with self.assertRaisesRegex(ValueError, "did not rank"):
            validate_rerank_response(
                {
                    "model": RERANK_MODEL,
                    "results": [
                        {"id": "visitor", "index": 0, "relevance_score": 0.9},
                        {"id": "travel", "index": 1, "relevance_score": 0.8},
                    ],
                },
                expected_model=RERANK_MODEL,
                input_ids=["visitor", "travel"],
                expected_best_id="travel",
            )


if __name__ == "__main__":
    unittest.main()
