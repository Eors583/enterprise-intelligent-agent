from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from .dataset import EvaluationCase
from .metrics import mean_reciprocal_rank, ndcg_at_k, percentile, recall_at_k


@dataclass(frozen=True)
class AcceptanceThresholds:
    min_recall_at_5: float = 0.8
    min_mrr: float = 0.7
    min_ndcg_at_10: float = 0.7
    min_no_answer_accuracy: float = 0.9
    max_p95_ms: float = 3_000.0
    max_acl_leaks: int = 0

    def __post_init__(self) -> None:
        for name in (
            "min_recall_at_5",
            "min_mrr",
            "min_ndcg_at_10",
            "min_no_answer_accuracy",
        ):
            value = getattr(self, name)
            if not 0 <= value <= 1:
                raise ValueError(f"{name} must be in [0, 1]")
        if self.max_p95_ms <= 0:
            raise ValueError("max_p95_ms must be positive")
        if self.max_acl_leaks < 0:
            raise ValueError("max_acl_leaks must not be negative")

    def as_report(self) -> dict[str, float | int]:
        return {
            "recallAt5Min": self.min_recall_at_5,
            "mrrMin": self.min_mrr,
            "ndcgAt10Min": self.min_ndcg_at_10,
            "noAnswerAccuracyMin": self.min_no_answer_accuracy,
            "p95LatencyMsMax": self.max_p95_ms,
            "aclLeakCountMax": self.max_acl_leaks,
        }


@dataclass(frozen=True)
class CaseObservation:
    case_id: str
    retrieved_chunk_ids: tuple[str, ...]
    predicted_no_answer: bool
    latency_ms: float
    server_elapsed_ms: float
    acl_events: tuple[str, ...]
    semantic_evidence_failures: tuple[str, ...]
    error: str | None = None


def evaluate_cases(
    cases: tuple[EvaluationCase, ...],
    observations: tuple[CaseObservation, ...],
    thresholds: AcceptanceThresholds,
) -> dict[str, Any]:
    case_by_id = {case.case_id: case for case in cases}
    observation_by_id: dict[str, CaseObservation] = {}
    duplicate_observations: list[str] = []
    for observation in observations:
        if observation.case_id in observation_by_id:
            duplicate_observations.append(observation.case_id)
        observation_by_id[observation.case_id] = observation

    unknown_observations = sorted(set(observation_by_id) - set(case_by_id))
    missing_observations = sorted(set(case_by_id) - set(observation_by_id))
    successful = [
        observation
        for observation in observations
        if observation.error is None and observation.case_id in case_by_id
    ]
    answerable_pairs = [
        (case_by_id[observation.case_id], observation)
        for observation in successful
        if not case_by_id[observation.case_id].expected_no_answer
    ]

    recall_values = [
        recall_at_k(observation.retrieved_chunk_ids, case.relevance, 5)
        for case, observation in answerable_pairs
    ]
    ndcg_values = [
        ndcg_at_k(observation.retrieved_chunk_ids, case.relevance, 10)
        for case, observation in answerable_pairs
    ]
    recall_at_5 = sum(recall_values) / len(recall_values) if recall_values else None
    mrr = (
        mean_reciprocal_rank(
            [
                (observation.retrieved_chunk_ids, case.relevance)
                for case, observation in answerable_pairs
            ]
        )
        if answerable_pairs
        else None
    )
    ndcg_at_10 = sum(ndcg_values) / len(ndcg_values) if ndcg_values else None
    no_answer_correct = sum(
        observation.predicted_no_answer
        == case_by_id[observation.case_id].expected_no_answer
        for observation in successful
    )
    no_answer_accuracy = no_answer_correct / len(successful) if successful else None
    p95_ms = (
        percentile([item.latency_ms for item in successful], 0.95)
        if successful
        else None
    )
    # A malformed response must not hide a leak that is still observable in its payload.
    acl_leak_count = sum(len(item.acl_events) for item in observations)
    semantic_evidence_failure_count = sum(
        len(item.semantic_evidence_failures) for item in successful
    )
    request_errors = [item for item in observations if item.error is not None]

    failures: list[str] = []
    if duplicate_observations:
        failures.append(
            "duplicate observations: " + ", ".join(sorted(duplicate_observations))
        )
    if unknown_observations:
        failures.append("unknown observations: " + ", ".join(unknown_observations))
    if missing_observations:
        failures.append("missing observations: " + ", ".join(missing_observations))
    if request_errors:
        failures.append(f"{len(request_errors)} API evaluation request(s) failed")
    if len(successful) != len(cases):
        failures.append(
            f"only {len(successful)}/{len(cases)} cases completed successfully"
        )
    _minimum_failure(failures, "Recall@5", recall_at_5, thresholds.min_recall_at_5)
    _minimum_failure(failures, "MRR", mrr, thresholds.min_mrr)
    _minimum_failure(failures, "nDCG@10", ndcg_at_10, thresholds.min_ndcg_at_10)
    _minimum_failure(
        failures,
        "no-answer accuracy",
        no_answer_accuracy,
        thresholds.min_no_answer_accuracy,
    )
    if p95_ms is None:
        failures.append("P95 latency is unavailable")
    elif p95_ms > thresholds.max_p95_ms:
        failures.append(
            f"P95 latency {p95_ms:.3f}ms exceeds {thresholds.max_p95_ms:.3f}ms"
        )
    if acl_leak_count > thresholds.max_acl_leaks:
        failures.append(
            f"ACL leak count {acl_leak_count} exceeds {thresholds.max_acl_leaks}"
        )
    if semantic_evidence_failure_count:
        failures.append(
            f"{semantic_evidence_failure_count} semantic-chain evidence assertion(s) failed"
        )

    return {
        "metrics": {
            "recallAt5": recall_at_5,
            "mrr": mrr,
            "ndcgAt10": ndcg_at_10,
            "noAnswerAccuracy": no_answer_accuracy,
            "p95LatencyMs": p95_ms,
            "aclLeakCount": acl_leak_count,
            "semanticEvidenceFailureCount": semantic_evidence_failure_count,
            "evaluatedCaseCount": len(successful),
            "answerableMetricCaseCount": len(answerable_pairs),
            "noAnswerAccuracyDenominator": len(successful),
        },
        "thresholds": thresholds.as_report(),
        "failures": failures,
        "cases": [
            {
                "caseId": observation.case_id,
                "expectedNoAnswer": case_by_id.get(
                    observation.case_id
                ).expected_no_answer
                if observation.case_id in case_by_id
                else None,
                "predictedNoAnswer": observation.predicted_no_answer,
                "retrievedChunkIds": list(observation.retrieved_chunk_ids),
                "latencyMs": observation.latency_ms,
                "serverElapsedMs": observation.server_elapsed_ms,
                "aclEvents": list(observation.acl_events),
                "semanticEvidenceFailures": list(
                    observation.semantic_evidence_failures
                ),
                "error": observation.error,
            }
            for observation in observations
        ],
    }


def acl_events(case: EvaluationCase, payload: dict[str, Any]) -> tuple[str, ...]:
    events: set[str] = set()
    items = payload.get("items")
    if isinstance(items, list):
        for raw_item in items:
            if not isinstance(raw_item, dict):
                continue
            chunk_id = _normalized_id(raw_item.get("chunkId"))
            document_id = _normalized_id(raw_item.get("documentId"))
            knowledge_base_id = _normalized_id(raw_item.get("knowledgeBaseId"))
            if (
                knowledge_base_id is not None
                and knowledge_base_id != case.knowledge_base_id
            ):
                events.add(f"result:unexpected-knowledge-base:{knowledge_base_id}")
            if chunk_id in case.forbidden_chunk_ids:
                events.add(f"result:chunk:{chunk_id}")
            if document_id in case.forbidden_document_ids:
                events.add(f"result:document:{document_id}")
            if knowledge_base_id in case.forbidden_knowledge_base_ids:
                events.add(f"result:knowledge-base:{knowledge_base_id}")
    accessible = payload.get("accessibleKnowledgeBaseIds")
    if isinstance(accessible, list):
        for raw_id in accessible:
            knowledge_base_id = _normalized_id(raw_id)
            if (
                knowledge_base_id is not None
                and knowledge_base_id != case.knowledge_base_id
            ):
                events.add(f"scope:unexpected-knowledge-base:{knowledge_base_id}")
            if knowledge_base_id in case.forbidden_knowledge_base_ids:
                events.add(f"scope:knowledge-base:{knowledge_base_id}")
    return tuple(sorted(events))


def validate_retrieval_response(
    case: EvaluationCase,
    payload: Any,
    *,
    expected_embedding_model: str,
    expected_rerank_model: str,
) -> tuple[tuple[str, ...], bool, float, tuple[str, ...]]:
    if not isinstance(payload, dict):
        raise TypeError("retrieval response must be a JSON object")
    if payload.get("query") != case.query:
        raise ValueError("retrieval response query does not match the request")
    if _normalized_id(payload.get("simulatedUserId")) != case.user_id:
        raise ValueError(
            "retrieval response simulatedUserId does not match the request"
        )
    accessible = payload.get("accessibleKnowledgeBaseIds")
    if not isinstance(accessible, list):
        raise TypeError(
            "retrieval response accessibleKnowledgeBaseIds must be an array"
        )
    accessible_ids = [_normalized_id(item) for item in accessible]
    if any(item is None for item in accessible_ids):
        raise ValueError("accessible knowledge base ids must be UUIDs")
    if len(accessible_ids) != len(set(accessible_ids)):
        raise ValueError("accessible knowledge base ids must be unique")
    items = payload.get("items")
    if not isinstance(items, list):
        raise TypeError("retrieval response items must be an array")
    if len(items) > case.limit:
        raise ValueError("retrieval response contains more items than requested")
    mode = payload.get("mode")
    if mode not in {"LEXICAL", "HYBRID"}:
        raise ValueError("retrieval response mode is invalid")
    reranker = payload.get("reranker")
    if reranker not in {"LEXICAL", "RRF", "CROSS_ENCODER"}:
        raise ValueError("retrieval response reranker is invalid")
    for field in ("embeddingModel", "rerankerModel"):
        value = payload.get(field)
        if value is not None and (not isinstance(value, str) or not value):
            raise ValueError(
                f"retrieval response {field} must be non-empty text or null"
            )
    degraded_reason = payload.get("degradedReason")
    if degraded_reason is not None and (
        not isinstance(degraded_reason, str) or not degraded_reason
    ):
        raise ValueError(
            "retrieval response degradedReason must be non-empty text or null"
        )
    _nonnegative_int(payload.get("lexicalCandidateCount"), "lexicalCandidateCount")
    vector_count = _nonnegative_int(
        payload.get("vectorCandidateCount"), "vectorCandidateCount"
    )
    coverage = payload.get("semanticCoverage")
    if not _is_finite_number(coverage) or not 0 <= float(coverage) <= 1:
        raise ValueError("retrieval response semanticCoverage must be in [0, 1]")
    if mode == "HYBRID" and vector_count == 0:
        raise ValueError("HYBRID mode requires real vector candidates")
    if mode == "LEXICAL" and vector_count != 0:
        raise ValueError("LEXICAL mode must not report vector candidates")
    no_answer = payload.get("noAnswer")
    if not isinstance(no_answer, bool):
        raise TypeError("retrieval response noAnswer must be a boolean")
    if no_answer != (len(items) == 0):
        raise ValueError("retrieval response noAnswer is inconsistent with items")
    server_elapsed_ms = payload.get("elapsedMs")
    if (
        isinstance(server_elapsed_ms, bool)
        or not isinstance(server_elapsed_ms, (int, float))
        or server_elapsed_ms < 0
    ):
        raise ValueError("retrieval response elapsedMs must be non-negative")

    retrieved_ids: list[str] = []
    final_scores: list[float] = []
    for item in items:
        if not isinstance(item, dict):
            raise TypeError("retrieval response items must be objects")
        chunk_id = _normalized_id(item.get("chunkId"))
        if chunk_id is None:
            raise ValueError("retrieval item chunkId must be a UUID")
        if chunk_id in retrieved_ids:
            raise ValueError("retrieval response must not contain duplicate chunks")
        knowledge_base_id = _normalized_id(item.get("knowledgeBaseId"))
        document_id = _normalized_id(item.get("documentId"))
        if knowledge_base_id is None or document_id is None:
            raise ValueError(
                "retrieval item knowledgeBaseId and documentId must be UUIDs"
            )
        final_score = _finite_number(
            item.get("finalScore"), "retrieval item finalScore"
        )
        retrieved_ids.append(chunk_id)
        final_scores.append(final_score)
    if final_scores != sorted(final_scores, reverse=True):
        raise ValueError("retrieval items must be ordered by descending finalScore")

    evidence_failures: list[str] = []
    if case.semantic_required:
        if payload.get("mode") != "HYBRID":
            evidence_failures.append("mode is not HYBRID")
        if payload.get("embeddingModel") != expected_embedding_model:
            evidence_failures.append("embedding model does not match")
        if payload.get("reranker") != "CROSS_ENCODER":
            evidence_failures.append("reranker is not CROSS_ENCODER")
        if payload.get("rerankerModel") != expected_rerank_model:
            evidence_failures.append("reranker model does not match")
        if payload.get("degradedReason") is not None:
            evidence_failures.append("retrieval reported a degraded reason")
        if vector_count <= 0:
            evidence_failures.append("no real vector candidates were observed")
        if float(coverage) <= 0:
            evidence_failures.append("semantic coverage is zero or invalid")
        for item in items:
            if not _is_finite_number(item.get("semanticScore")):
                evidence_failures.append("a returned item has no semantic score")
                break
        for item in items:
            if not _is_finite_number(item.get("rerankerScore")):
                evidence_failures.append("a returned item has no reranker score")
                break

    return (
        tuple(retrieved_ids),
        no_answer,
        float(server_elapsed_ms),
        tuple(evidence_failures),
    )


def _minimum_failure(
    failures: list[str], label: str, actual: float | None, expected: float
) -> None:
    if actual is None:
        failures.append(f"{label} is unavailable")
    elif actual < expected:
        failures.append(f"{label} {actual:.6f} is below {expected:.6f}")


def _normalized_id(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    try:
        return str(UUID(value))
    except ValueError:
        return None


def _is_finite_number(value: Any) -> bool:
    return (
        not isinstance(value, bool)
        and isinstance(value, (int, float))
        and math.isfinite(value)
    )


def _finite_number(value: Any, label: str) -> float:
    if not _is_finite_number(value):
        raise ValueError(f"{label} must be a finite number")
    return float(value)


def _nonnegative_int(value: Any, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError(f"retrieval response {label} must be a non-negative integer")
    return value
