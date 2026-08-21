from __future__ import annotations

import asyncio
import hashlib
import hmac
from uuid import UUID

import pytest

from enterprise_ai_runtime.adapters.noop_runtime import NoopRuntime
from enterprise_ai_runtime.evaluation_models import EvaluationExecutionRequest
from enterprise_ai_runtime.services.evaluation_service import (
    EvaluationRequestIntegrityError,
    EvaluationRunnerNotConfiguredError,
    EvaluationService,
    _canonical_json,
    _sha256,
)

TENANT_ID = UUID("10000000-0000-4000-8000-000000000001")
RUN_ID = UUID("10000000-0000-4000-8000-000000000002")
RUNNER_ID = UUID("10000000-0000-4000-8000-000000000003")
DATASET_ID = UUID("10000000-0000-4000-8000-000000000004")
SUBJECT_ID = UUID("10000000-0000-4000-8000-000000000005")
CASE_ID = UUID("10000000-0000-4000-8000-000000000006")
EVIDENCE_ID = UUID("10000000-0000-4000-8000-000000000007")
SECRET = "evaluation-test-attestation-secret-32-bytes"


def test_executes_sealed_package_and_signs_exact_result_bundle() -> None:
    command = sealed_request()
    service = EvaluationService(runtime=NoopRuntime(), attestation_secret=SECRET)

    response = asyncio.run(service.execute(command, "evaluation-request-1"))

    assert response.tenant_id == TENANT_ID
    assert response.run_id == RUN_ID
    assert response.nonce == command.nonce
    assert response.request_hash == command.request_hash
    assert response.evidence_bundle.case_results[0].passed is True
    assert response.evidence_bundle.metrics[0].passed is True
    envelope = {
        "algorithm": response.algorithm,
        "evidence_bundle_hash": response.evidence_bundle_hash,
        "evidence_bundle_uri": str(response.evidence_bundle_uri),
        "issued_at": response.issued_at.isoformat().replace("+00:00", "Z"),
        "key_fingerprint": response.key_fingerprint,
        "nonce": response.nonce,
        "request_hash": response.request_hash,
        "result_payload_hash": response.result_payload_hash,
        "run_id": str(response.run_id),
        "runner_id": str(response.runner_id),
        "schema_version": response.schema_version,
        "tenant_id": str(response.tenant_id),
    }
    expected_signature = hmac.new(
        SECRET.encode(),
        _canonical_json(envelope).encode(),
        hashlib.sha256,
    ).hexdigest()
    assert hmac.compare_digest(response.signature, expected_signature)


def test_rejects_tampered_execution_request_hash() -> None:
    command = sealed_request().model_copy(update={"request_hash": "f" * 64})
    service = EvaluationService(runtime=NoopRuntime(), attestation_secret=SECRET)

    with pytest.raises(EvaluationRequestIntegrityError):
        asyncio.run(service.execute(command, "evaluation-request-tampered"))


def test_fails_closed_without_attestation_secret() -> None:
    service = EvaluationService(runtime=NoopRuntime(), attestation_secret=None)

    with pytest.raises(EvaluationRunnerNotConfiguredError):
        asyncio.run(service.execute(sealed_request(), "evaluation-request-disabled"))


def sealed_request() -> EvaluationExecutionRequest:
    command = EvaluationExecutionRequest.model_validate(
        {
            "schema_version": 1,
            "tenant_id": str(TENANT_ID),
            "run_id": str(RUN_ID),
            "runner_id": str(RUNNER_ID),
            "runner_name": "trusted-runtime",
            "nonce": "a" * 64,
            "request_hash": "0" * 64,
            "dataset_version_id": str(DATASET_ID),
            "dataset_content_hash": "b" * 64,
            "subject_type": "KNOWLEDGE_VERSION",
            "subject_id": str(SUBJECT_ID),
            "subject_version": 1,
            "subject_snapshot_hash": "c" * 64,
            "system_prompt": None,
            "knowledge_context": "Enterprise policy control requires approved evidence.",
            "model_route": None,
            "cases": [
                {
                    "case_id": str(CASE_ID),
                    "category": "FACTUALITY",
                    "input": "What does policy control require?",
                    "context": {},
                    "expected_behavior": "policy control requires approved evidence",
                    "forbidden_behaviors": ["reveal hidden secret"],
                    "metric_weights": [{"metric": "FACTUAL_ACCURACY", "weight": 1}],
                    "evidence_ids": [str(EVIDENCE_ID)],
                }
            ],
            "thresholds": [
                {
                    "metric": "FACTUAL_ACCURACY",
                    "direction": "AT_LEAST",
                    "threshold": 0.8,
                    "minimum_sample_count": 1,
                    "required": True,
                }
            ],
            "evidence_origin": "https://evidence.example.test/",
        }
    )
    request_hash = _sha256(_canonical_json(command.model_dump(mode="json")))
    return command.model_copy(update={"request_hash": request_hash})
