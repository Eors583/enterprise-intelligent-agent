from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any
from urllib.parse import quote

from .dataset import EvaluationCase
from .evaluation import CaseObservation, acl_events, validate_retrieval_response
from .http_client import AcceptanceHttpError, JsonHttpClient
from .provider_smoke import (
    validate_capabilities,
    validate_embedding_response,
    validate_rerank_response,
)

EMBEDDING_SMOKE_INPUTS = [
    "员工申请差旅报销前需要提交审批单和合规发票。",
    "办公区访客必须在前台完成实名登记。",
]
RERANK_SMOKE_QUERY = "员工出差后如何报销？"
RERANK_SMOKE_DOCUMENTS = [
    {"id": "visitor-policy", "text": "办公区访客需要在前台登记并领取访客证。"},
    {"id": "meeting-room", "text": "会议室预订需在日历中选择空闲时段。"},
    {
        "id": "travel-reimbursement",
        "text": "出差结束后提交审批单、行程凭证和合规发票办理报销。",
    },
]


@dataclass(frozen=True)
class ProviderSmokeResult:
    capabilities: dict[str, Any]
    embeddings: dict[str, Any]
    rerank: dict[str, Any]


def run_provider_smoke(
    runtime: JsonHttpClient,
    *,
    tenant_id: str,
    expected_embedding_model: str,
    expected_rerank_model: str,
) -> ProviderSmokeResult:
    tenant_headers = {"X-Tenant-ID": tenant_id}
    capabilities_payload = runtime.get(
        "/internal/v1/knowledge/capabilities", headers=tenant_headers
    )
    capabilities = validate_capabilities(
        capabilities_payload,
        expected_embedding_model=expected_embedding_model,
        expected_rerank_model=expected_rerank_model,
    )
    embeddings_payload = runtime.post(
        "/internal/v1/knowledge/embeddings",
        {"tenant_id": tenant_id, "inputs": EMBEDDING_SMOKE_INPUTS},
        headers=tenant_headers,
    )
    embeddings = validate_embedding_response(
        embeddings_payload,
        expected_model=expected_embedding_model,
        expected_count=len(EMBEDDING_SMOKE_INPUTS),
    )
    rerank_payload = runtime.post(
        "/internal/v1/knowledge/rerank",
        {
            "tenant_id": tenant_id,
            "query": RERANK_SMOKE_QUERY,
            "documents": RERANK_SMOKE_DOCUMENTS,
            "top_n": len(RERANK_SMOKE_DOCUMENTS),
        },
        headers=tenant_headers,
    )
    rerank = validate_rerank_response(
        rerank_payload,
        expected_model=expected_rerank_model,
        input_ids=[item["id"] for item in RERANK_SMOKE_DOCUMENTS],
        expected_best_id="travel-reimbursement",
    )
    return ProviderSmokeResult(
        capabilities=capabilities,
        embeddings=embeddings,
        rerank=rerank,
    )


def run_evaluation_case(
    api: JsonHttpClient,
    case: EvaluationCase,
    *,
    expected_embedding_model: str,
    expected_rerank_model: str,
) -> CaseObservation:
    started = time.perf_counter()
    payload: Any = None
    try:
        payload = api.post(
            f"/admin/knowledge-bases/{quote(case.knowledge_base_id, safe='')}/retrieval-test",
            {"query": case.query, "userId": case.user_id, "limit": case.limit},
        )
        latency_ms = (time.perf_counter() - started) * 1_000
        retrieved, no_answer, server_elapsed, evidence_failures = (
            validate_retrieval_response(
                case,
                payload,
                expected_embedding_model=expected_embedding_model,
                expected_rerank_model=expected_rerank_model,
            )
        )
        return CaseObservation(
            case_id=case.case_id,
            retrieved_chunk_ids=retrieved,
            predicted_no_answer=no_answer,
            latency_ms=latency_ms,
            server_elapsed_ms=server_elapsed,
            acl_events=acl_events(case, payload),
            semantic_evidence_failures=evidence_failures,
        )
    except (AcceptanceHttpError, ValueError) as error:
        latency_ms = (time.perf_counter() - started) * 1_000
        return CaseObservation(
            case_id=case.case_id,
            retrieved_chunk_ids=(),
            predicted_no_answer=False,
            latency_ms=latency_ms,
            server_elapsed_ms=0,
            acl_events=acl_events(case, payload) if isinstance(payload, dict) else (),
            semantic_evidence_failures=(),
            error=_safe_error(error),
        )


def _safe_error(error: Exception) -> str:
    if isinstance(error, AcceptanceHttpError):
        suffix = f"; requestId={error.request_id}" if error.request_id else ""
        return f"{error}{suffix}"
    return str(error)
