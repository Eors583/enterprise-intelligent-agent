from __future__ import annotations

from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from pydantic import Field, HttpUrl, model_validator

from enterprise_ai_runtime.domain.models import StrictModel, TrustedModelRoute

Sha256 = str


class EvaluationMetricWeight(StrictModel):
    metric: str = Field(min_length=1, max_length=120, pattern=r"^[A-Z0-9_]+$")
    weight: float = Field(gt=0, le=1)


class EvaluationCase(StrictModel):
    case_id: UUID
    category: str = Field(min_length=1, max_length=120, pattern=r"^[A-Z0-9_]+$")
    input: str = Field(min_length=1, max_length=20_000)
    context: dict[str, Any] = Field(default_factory=dict, max_length=128)
    expected_behavior: str = Field(min_length=1, max_length=20_000)
    forbidden_behaviors: list[str] = Field(default_factory=list, max_length=100)
    metric_weights: list[EvaluationMetricWeight] = Field(min_length=1, max_length=20)
    evidence_ids: list[UUID] = Field(min_length=1, max_length=500)


class EvaluationThreshold(StrictModel):
    metric: str = Field(min_length=1, max_length=120, pattern=r"^[A-Z0-9_]+$")
    direction: Literal["AT_LEAST", "AT_MOST", "ZERO"]
    threshold: float = Field(ge=0)
    minimum_sample_count: int = Field(gt=0, le=1_000_000)
    required: bool


class EvaluationExecutionRequest(StrictModel):
    schema_version: Literal[1]
    tenant_id: UUID
    run_id: UUID
    runner_id: UUID
    runner_name: str = Field(min_length=1, max_length=500)
    nonce: Sha256 = Field(pattern=r"^[a-f0-9]{64}$")
    request_hash: Sha256 = Field(pattern=r"^[a-f0-9]{64}$")
    dataset_version_id: UUID
    dataset_content_hash: Sha256 = Field(pattern=r"^[a-f0-9]{64}$")
    subject_type: Literal["AGENT_VERSION", "KNOWLEDGE_VERSION", "COMPOSITE_RELEASE"]
    subject_id: UUID
    subject_version: int = Field(gt=0)
    subject_snapshot_hash: Sha256 = Field(pattern=r"^[a-f0-9]{64}$")
    system_prompt: str | None = Field(default=None, max_length=200_000)
    knowledge_context: str | None = Field(default=None, max_length=1_000_000)
    model_route: TrustedModelRoute | None = None
    cases: list[EvaluationCase] = Field(min_length=1, max_length=10_000)
    thresholds: list[EvaluationThreshold] = Field(min_length=1, max_length=100)
    evidence_origin: HttpUrl

    @model_validator(mode="after")
    def validate_subject_and_sealed_identity(self) -> EvaluationExecutionRequest:
        if self.subject_type == "KNOWLEDGE_VERSION":
            if self.knowledge_context is None or self.system_prompt is not None:
                raise ValueError("knowledge evaluation requires only a sealed knowledge context")
        elif self.system_prompt is None:
            raise ValueError("agent evaluation requires the sealed system prompt")
        if len({case.case_id for case in self.cases}) != len(self.cases):
            raise ValueError("evaluation cases must be unique")
        if len({threshold.metric for threshold in self.thresholds}) != len(self.thresholds):
            raise ValueError("evaluation thresholds must be unique")
        if not str(self.evidence_origin).startswith("https://"):
            raise ValueError("evaluation evidence origin must use HTTPS")
        return self


class EvaluationCaseResult(StrictModel):
    case_id: UUID
    judge_type: Literal["DETERMINISTIC_RULE", "SIGNED_CODE", "EXTERNAL_RUNNER"]
    passed: bool
    score: float = Field(ge=0, le=1)
    actual_behavior_hash: Sha256 = Field(pattern=r"^[a-f0-9]{64}$")
    evidence_ids: list[UUID] = Field(min_length=1, max_length=500)
    detail: str = Field(min_length=1, max_length=20_000)


class EvaluationMetricResult(StrictModel):
    metric: str = Field(min_length=1, max_length=120, pattern=r"^[A-Z0-9_]+$")
    numerator: float = Field(ge=0)
    denominator: float = Field(ge=0)
    value: float = Field(ge=0)
    threshold: float = Field(ge=0)
    direction: Literal["AT_LEAST", "AT_MOST", "ZERO"]
    sample_count: int = Field(ge=0)
    minimum_sample_count: int = Field(gt=0)
    passed: bool
    evidence_ids: list[UUID] = Field(min_length=1, max_length=500)


class EvaluationEvidenceBundle(StrictModel):
    schema_version: Literal[1]
    tenant_id: UUID
    run_id: UUID
    runner_id: UUID
    nonce: Sha256 = Field(pattern=r"^[a-f0-9]{64}$")
    request_hash: Sha256 = Field(pattern=r"^[a-f0-9]{64}$")
    subject_snapshot_hash: Sha256 = Field(pattern=r"^[a-f0-9]{64}$")
    dataset_content_hash: Sha256 = Field(pattern=r"^[a-f0-9]{64}$")
    case_results: list[EvaluationCaseResult] = Field(min_length=1, max_length=10_000)
    metrics: list[EvaluationMetricResult] = Field(min_length=1, max_length=100)
    generated_at: datetime


class EvaluationExecutionResponse(StrictModel):
    schema_version: Literal[1]
    algorithm: Literal["HMAC-SHA256"]
    key_fingerprint: Sha256 = Field(pattern=r"^[a-f0-9]{64}$")
    tenant_id: UUID
    run_id: UUID
    runner_id: UUID
    nonce: Sha256 = Field(pattern=r"^[a-f0-9]{64}$")
    request_hash: Sha256 = Field(pattern=r"^[a-f0-9]{64}$")
    result_payload_hash: Sha256 = Field(pattern=r"^[a-f0-9]{64}$")
    evidence_bundle_uri: HttpUrl
    evidence_bundle_hash: Sha256 = Field(pattern=r"^[a-f0-9]{64}$")
    issued_at: datetime
    signature: Sha256 = Field(pattern=r"^[a-f0-9]{64}$")
    evidence_bundle: EvaluationEvidenceBundle
