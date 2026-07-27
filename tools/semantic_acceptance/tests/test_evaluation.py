from __future__ import annotations

import unittest

from tools.semantic_acceptance.dataset import EvaluationCase
from tools.semantic_acceptance.evaluation import (
    AcceptanceThresholds,
    CaseObservation,
    acl_events,
    evaluate_cases,
    validate_retrieval_response,
)

KB_ID = "10000000-0000-4000-8000-000000000001"
USER_ID = "20000000-0000-4000-8000-000000000001"
RELEVANT = "30000000-0000-4000-8000-000000000001"
OTHER = "30000000-0000-4000-8000-000000000002"
FORBIDDEN = "30000000-0000-4000-8000-000000000003"
DOCUMENT = "40000000-0000-4000-8000-000000000001"
EMBEDDING_MODEL = "embedding-model-immutable-v1"
RERANK_MODEL = "reranker-model-immutable-v1"


class EvaluationTest(unittest.TestCase):
    def test_metrics_and_thresholds_pass_only_complete_observations(self) -> None:
        answerable = _case("answerable", relevance={RELEVANT: 3.0})
        no_answer = _case(
            "no-answer", expected_no_answer=True, semantic_required=True, relevance={}
        )
        observations = (
            _observation("answerable", (RELEVANT, OTHER), False, 100),
            _observation("no-answer", (), True, 120),
        )

        result = evaluate_cases(
            (answerable, no_answer), observations, AcceptanceThresholds(max_p95_ms=200)
        )

        self.assertEqual(result["failures"], [])
        self.assertEqual(result["metrics"]["recallAt5"], 1.0)
        self.assertEqual(result["metrics"]["mrr"], 1.0)
        self.assertEqual(result["metrics"]["noAnswerAccuracy"], 1.0)

    def test_request_error_and_acl_leak_force_failure(self) -> None:
        case = _case("case", relevance={RELEVANT: 1.0})
        result = evaluate_cases(
            (case,),
            (
                CaseObservation(
                    case_id="case",
                    retrieved_chunk_ids=(),
                    predicted_no_answer=False,
                    latency_ms=10,
                    server_elapsed_ms=0,
                    acl_events=("result:chunk:forbidden",),
                    semantic_evidence_failures=(),
                    error="HTTP 500",
                ),
            ),
            AcceptanceThresholds(),
        )

        self.assertTrue(any("request" in failure for failure in result["failures"]))
        self.assertTrue(any("only 0/1" in failure for failure in result["failures"]))

    def test_quality_and_acl_threshold_failures_are_explicit(self) -> None:
        case = _case("low-quality", relevance={RELEVANT: 1.0})
        result = evaluate_cases(
            (case,),
            (
                CaseObservation(
                    case_id="low-quality",
                    retrieved_chunk_ids=(OTHER,),
                    predicted_no_answer=False,
                    latency_ms=101,
                    server_elapsed_ms=80,
                    acl_events=(f"result:chunk:{FORBIDDEN}",),
                    semantic_evidence_failures=(),
                ),
            ),
            AcceptanceThresholds(max_p95_ms=100),
        )

        self.assertTrue(any("Recall@5" in failure for failure in result["failures"]))
        self.assertTrue(any("MRR" in failure for failure in result["failures"]))
        self.assertTrue(any("nDCG@10" in failure for failure in result["failures"]))
        self.assertTrue(any("P95" in failure for failure in result["failures"]))
        self.assertTrue(any("ACL leak" in failure for failure in result["failures"]))

    def test_acl_events_detect_result_and_accessible_scope(self) -> None:
        case = _case(
            "acl",
            relevance={RELEVANT: 1.0},
            forbidden_chunk_ids=frozenset({FORBIDDEN}),
            forbidden_knowledge_base_ids=frozenset({KB_ID}),
        )
        events = acl_events(
            case,
            {
                "accessibleKnowledgeBaseIds": [KB_ID],
                "items": [
                    {
                        "chunkId": FORBIDDEN,
                        "documentId": DOCUMENT,
                        "knowledgeBaseId": KB_ID,
                    }
                ],
            },
        )

        self.assertEqual(len(events), 3)
        self.assertIn(f"result:chunk:{FORBIDDEN}", events)
        self.assertIn(f"scope:knowledge-base:{KB_ID}", events)

    def test_acl_events_treat_cross_scope_result_as_a_leak_without_a_deny_label(
        self,
    ) -> None:
        other_base = "10000000-0000-4000-8000-000000000002"
        case = _case("scope", relevance={RELEVANT: 1.0})

        events = acl_events(
            case,
            {
                "accessibleKnowledgeBaseIds": [other_base],
                "items": [
                    {
                        "chunkId": OTHER,
                        "documentId": DOCUMENT,
                        "knowledgeBaseId": other_base,
                    }
                ],
            },
        )

        self.assertIn(f"result:unexpected-knowledge-base:{other_base}", events)
        self.assertIn(f"scope:unexpected-knowledge-base:{other_base}", events)

    def test_accepts_complete_hybrid_cross_encoder_evidence(self) -> None:
        case = _case("semantic-ok", relevance={RELEVANT: 1.0})
        retrieved, no_answer, elapsed, failures = validate_retrieval_response(
            case,
            {
                "query": case.query,
                "simulatedUserId": USER_ID,
                "accessibleKnowledgeBaseIds": [KB_ID],
                "items": [
                    {
                        "chunkId": RELEVANT,
                        "documentId": DOCUMENT,
                        "knowledgeBaseId": KB_ID,
                        "semanticScore": 0.81,
                        "rerankerScore": 0.92,
                        "finalScore": 0.92,
                    }
                ],
                "noAnswer": False,
                "elapsedMs": 25,
                "mode": "HYBRID",
                "embeddingModel": EMBEDDING_MODEL,
                "reranker": "CROSS_ENCODER",
                "rerankerModel": RERANK_MODEL,
                "degradedReason": None,
                "lexicalCandidateCount": 8,
                "vectorCandidateCount": 8,
                "semanticCoverage": 1,
            },
            expected_embedding_model=EMBEDDING_MODEL,
            expected_rerank_model=RERANK_MODEL,
        )

        self.assertEqual(retrieved, (RELEVANT,))
        self.assertFalse(no_answer)
        self.assertEqual(elapsed, 25)
        self.assertEqual(failures, ())

    def test_semantic_evidence_rejects_lexical_only_response(self) -> None:
        case = _case("semantic", relevance={RELEVANT: 1.0})
        _, _, _, failures = validate_retrieval_response(
            case,
            {
                "query": case.query,
                "simulatedUserId": USER_ID,
                "accessibleKnowledgeBaseIds": [],
                "items": [],
                "noAnswer": True,
                "elapsedMs": 5,
                "mode": "LEXICAL",
                "embeddingModel": None,
                "reranker": "LEXICAL",
                "rerankerModel": None,
                "degradedReason": "KNOWLEDGE_VECTOR_CANDIDATES_EMPTY",
                "lexicalCandidateCount": 0,
                "vectorCandidateCount": 0,
                "semanticCoverage": 0,
            },
            expected_embedding_model=EMBEDDING_MODEL,
            expected_rerank_model=RERANK_MODEL,
        )

        self.assertGreaterEqual(len(failures), 6)
        self.assertIn("no real vector candidates were observed", failures)


def _case(
    case_id: str,
    *,
    expected_no_answer: bool = False,
    semantic_required: bool = True,
    relevance: dict[str, float],
    forbidden_chunk_ids: frozenset[str] = frozenset(),
    forbidden_knowledge_base_ids: frozenset[str] = frozenset(),
) -> EvaluationCase:
    return EvaluationCase(
        case_id=case_id,
        query="差旅费用如何报销？",
        knowledge_base_id=KB_ID,
        user_id=USER_ID,
        expected_no_answer=expected_no_answer,
        semantic_required=semantic_required,
        relevance=relevance,
        forbidden_chunk_ids=forbidden_chunk_ids,
        forbidden_document_ids=frozenset(),
        forbidden_knowledge_base_ids=forbidden_knowledge_base_ids,
        limit=10,
    )


def _observation(
    case_id: str, retrieved: tuple[str, ...], no_answer: bool, latency_ms: float
) -> CaseObservation:
    return CaseObservation(
        case_id=case_id,
        retrieved_chunk_ids=retrieved,
        predicted_no_answer=no_answer,
        latency_ms=latency_ms,
        server_elapsed_ms=latency_ms - 10,
        acl_events=(),
        semantic_evidence_failures=(),
    )


if __name__ == "__main__":
    unittest.main()
