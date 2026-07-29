from __future__ import annotations

from datetime import UTC, datetime
from enum import StrEnum
from typing import Annotated, Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

Identifier = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True,
        min_length=1,
        max_length=128,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9._:@/-]*$",
    ),
]
VersionIdentifier = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=128),
]


def utc_now() -> datetime:
    return datetime.now(UTC)


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class PrincipalType(StrEnum):
    USER = "user"
    SERVICE = "service"
    AGENT = "agent"


class PrincipalContext(StrictModel):
    principal_id: Identifier
    principal_type: PrincipalType
    roles: list[Identifier] = Field(default_factory=list, max_length=64)
    scopes: list[Identifier] = Field(default_factory=list, max_length=128)


class MessageRole(StrEnum):
    SYSTEM = "system"
    USER = "user"
    ASSISTANT = "assistant"
    TOOL = "tool"


class RunMessage(StrictModel):
    role: MessageRole
    content: str = Field(min_length=1, max_length=200_000)
    name: Identifier | None = None
    tool_call_id: Identifier | None = None

    @model_validator(mode="after")
    def validate_tool_message(self) -> RunMessage:
        if self.role == MessageRole.TOOL and self.tool_call_id is None:
            raise ValueError("tool messages require tool_call_id")
        return self


class AttachmentRef(StrictModel):
    asset_id: Identifier
    media_type: str = Field(min_length=1, max_length=128, pattern=r"^[^/\s]+/[^/\s]+$")
    name: str | None = Field(default=None, min_length=1, max_length=255)


class RunInput(StrictModel):
    messages: list[RunMessage] = Field(min_length=1, max_length=100)
    attachments: list[AttachmentRef] = Field(default_factory=list, max_length=32)
    variables: dict[str, Any] = Field(default_factory=dict, max_length=128)


class RunBudget(StrictModel):
    max_input_tokens: int = Field(ge=1, le=2_000_000)
    max_output_tokens: int = Field(ge=1, le=200_000)
    max_steps: int = Field(default=1, ge=1, le=1_000)
    max_tool_calls: int = Field(ge=0, le=1_000)
    timeout_ms: int = Field(ge=100, le=3_600_000)
    max_cost_micros: int = Field(ge=0, le=10_000_000_000)


class ModelRouteCandidate(StrictModel):
    ordinal: int = Field(ge=1, le=3)
    catalog_version_id: UUID
    route_key: str = Field(min_length=1, max_length=120, pattern=r"^[A-Z0-9][A-Z0-9._-]*$")
    provider: Literal["OPENAI_COMPATIBLE", "MANUS"]
    model: str = Field(min_length=1, max_length=256)
    credential_reference: str = Field(
        min_length=1,
        max_length=300,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9._:/-]*$",
    )

    @model_validator(mode="after")
    def reject_inline_credentials(self) -> ModelRouteCandidate:
        normalized = self.credential_reference.lower()
        if any(marker in normalized for marker in ("secret=", "token=", "key=")):
            raise ValueError("model routes must carry credential references only")
        return self


class TrustedModelRoute(StrictModel):
    schema_version: Literal[1]
    policy_version_id: UUID
    policy_version: int = Field(ge=1)
    policy_hash: str = Field(pattern=r"^[a-f0-9]{64}$")
    task_class: str = Field(min_length=1, max_length=120, pattern=r"^[A-Z0-9][A-Z0-9._-]*$")
    maximum_classification: Literal["PUBLIC", "INTERNAL", "CONFIDENTIAL", "RESTRICTED"]
    effective_classification: Literal["PUBLIC", "INTERNAL", "CONFIDENTIAL", "RESTRICTED"] | None = (
        None
    )
    required_capabilities: list[str] = Field(min_length=1, max_length=32)
    maximum_attempts: int = Field(ge=1, le=3)
    circuit_failure_threshold: int = Field(ge=1, le=100)
    circuit_open_seconds: int = Field(ge=1, le=86_400)
    candidates: list[ModelRouteCandidate] = Field(min_length=1, max_length=3)

    @model_validator(mode="after")
    def validate_candidates(self) -> TrustedModelRoute:
        if len(self.candidates) > self.maximum_attempts:
            raise ValueError("model route candidates exceed the attempt budget")
        if [candidate.ordinal for candidate in self.candidates] != list(
            range(1, len(self.candidates) + 1)
        ):
            raise ValueError("model route candidate ordinals must be contiguous")
        if len({candidate.route_key for candidate in self.candidates}) != len(self.candidates):
            raise ValueError("model route candidates must be unique")
        if self.effective_classification is not None and _classification_rank(
            self.effective_classification
        ) > _classification_rank(self.maximum_classification):
            raise ValueError("effective classification exceeds the route maximum")
        return self


class SafetyDecision(StrictModel):
    direction: Literal["INPUT", "OUTPUT"]
    classification: Literal["PUBLIC", "INTERNAL", "CONFIDENTIAL", "RESTRICTED"]
    action: Literal["ALLOW", "REDACT", "BLOCK"]
    reason_codes: list[str] = Field(min_length=1, max_length=32)
    content_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    redacted_content_sha256: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")
    detector_version: str = Field(min_length=1, max_length=120)
    decision_hash: str = Field(pattern=r"^[a-f0-9]{64}$")


class SafetyContext(StrictModel):
    input_decision: SafetyDecision
    knowledge_is_untrusted_data: Literal[True]

    @model_validator(mode="after")
    def validate_input_decision(self) -> SafetyContext:
        if self.input_decision.direction != "INPUT":
            raise ValueError("safety context must carry an input decision")
        if self.input_decision.action == "BLOCK":
            raise ValueError("blocked input must not reach the Runtime")
        return self


class RunCreateRequest(StrictModel):
    tenant_id: Identifier
    principal: PrincipalContext
    agent_id: Identifier
    agent_version: VersionIdentifier
    model_route: TrustedModelRoute | None = None
    safety_context: SafetyContext | None = None
    input: RunInput
    budget: RunBudget
    metadata: dict[str, Any] = Field(default_factory=dict, max_length=64)

    @model_validator(mode="after")
    def validate_route_classification(self) -> RunCreateRequest:
        _validate_route_safety_classification(self.model_route, self.safety_context)
        return self


class RunStatus(StrEnum):
    QUEUED = "queued"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"

    @property
    def is_terminal(self) -> bool:
        return self in {self.SUCCEEDED, self.FAILED, self.CANCELLED}


class ModelAttemptReceipt(StrictModel):
    attempt_number: int = Field(ge=1, le=3)
    catalog_version_id: UUID
    route_key: str = Field(min_length=1, max_length=120, pattern=r"^[A-Z0-9][A-Z0-9._-]*$")
    provider: Literal["OPENAI_COMPATIBLE", "MANUS"]
    model: str = Field(min_length=1, max_length=256)
    outcome: Literal["SUCCEEDED", "FAILED", "UNKNOWN", "REJECTED"]
    reason_code: str | None = Field(default=None, pattern=r"^[A-Z0-9_]{1,120}$")
    retry_safe: bool
    started_at: datetime
    finished_at: datetime

    @model_validator(mode="after")
    def validate_period(self) -> ModelAttemptReceipt:
        if self.finished_at < self.started_at:
            raise ValueError("model attempt cannot finish before it starts")
        return self


class RunErrorInfo(StrictModel):
    code: Identifier
    message: str = Field(min_length=1, max_length=2_000)
    retryable: bool = False
    model_attempts: list[ModelAttemptReceipt] = Field(default_factory=list, max_length=3)
    safety_decision: SafetyDecision | None = None


class RunUsage(StrictModel):
    input_tokens: int = Field(ge=0)
    output_tokens: int = Field(ge=0)
    total_tokens: int = Field(ge=0)
    tool_calls: int = Field(default=0, ge=0)
    cost_micros: int = Field(default=0, ge=0)
    tokens_reported: bool = True
    cost_reported: bool = True


class RunOutput(StrictModel):
    content: str = Field(max_length=1_000_000)
    finish_reason: str = Field(min_length=1, max_length=128)
    model: str = Field(min_length=1, max_length=256)
    provider: Identifier
    response_id: str | None = Field(default=None, min_length=1, max_length=256)
    model_attempts: list[ModelAttemptReceipt] = Field(default_factory=list, max_length=3)
    safety_decision: SafetyDecision | None = None


class RunExecutionResult(StrictModel):
    output: RunOutput
    usage: RunUsage


class RunRecord(StrictModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    run_id: UUID
    tenant_id: Identifier
    principal: PrincipalContext
    agent_id: Identifier
    agent_version: VersionIdentifier
    model_route: TrustedModelRoute | None = None
    safety_context: SafetyContext | None = None
    input: RunInput
    budget: RunBudget
    metadata: dict[str, Any]
    status: RunStatus
    request_id: str
    execution_request_id: str | None = None
    created_at: datetime
    updated_at: datetime
    started_at: datetime | None = None
    finished_at: datetime | None = None
    error: RunErrorInfo | None = None
    output: RunOutput | None = None
    usage: RunUsage | None = None
    version: int = Field(default=1, ge=1)

    @model_validator(mode="after")
    def validate_route_classification(self) -> RunRecord:
        _validate_route_safety_classification(self.model_route, self.safety_context)
        return self


class RunCreateResponse(StrictModel):
    run_id: UUID
    status: RunStatus
    request_id: str


class RunStreamDeltaEvent(StrictModel):
    event_id: str = Field(min_length=3, max_length=200)
    sequence: int = Field(ge=1, le=10_000)
    type: Literal["delta"] = "delta"
    delta: str = Field(min_length=1, max_length=16_384)
    delta_hash: str = Field(pattern=r"^[a-f0-9]{64}$")
    created_at: datetime


class RunStreamTerminalPayload(StrictModel):
    run_id: UUID
    status: RunStatus
    output: RunOutput | None = None
    usage: RunUsage | None = None
    error: RunErrorInfo | None = None


class RunStreamTerminalEvent(StrictModel):
    event_id: str = Field(min_length=3, max_length=200)
    sequence: int = Field(ge=1, le=10_000)
    type: Literal["terminal", "terminal_only"]
    run: RunStreamTerminalPayload
    created_at: datetime


RunStreamEvent = RunStreamDeltaEvent | RunStreamTerminalEvent


class HealthResponse(StrictModel):
    status: Literal["ok", "ready", "not_ready"]
    service: str = "enterprise-ai-runtime"
    components: dict[str, Literal["ready", "not_ready"]] | None = None


class DependencyHealthComponent(StrictModel):
    status: Literal["ready", "degraded", "disabled"]
    configured: bool
    evidence: Literal["lifecycle_probe", "otlp_export_probe"] = "lifecycle_probe"
    external_connectivity_verified: bool = False
    fallback_mode: str | None = None
    last_successful_export_at: datetime | None = Field(
        default=None,
        exclude_if=lambda value: value is None,
    )
    stale: bool | None = Field(default=None, exclude_if=lambda value: value is None)


class DependencyHealthResponse(StrictModel):
    status: Literal["ready", "degraded"]
    service: str = "enterprise-ai-runtime"
    components: dict[str, DependencyHealthComponent]


class ModelRoutingReadinessRoute(StrictModel):
    route_key: str = Field(min_length=1, max_length=120, pattern=r"^[A-Z0-9][A-Z0-9._-]*$")
    catalog_version_id: UUID
    provider: Literal["OPENAI_COMPATIBLE", "MANUS"]
    model: str = Field(min_length=1, max_length=256)
    configuration_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")


class ModelRoutingReadinessResponse(StrictModel):
    status: Literal["ready", "not_ready"]
    require_trusted_route: bool
    provider_ready: bool
    evidence: Literal["local_configuration_probe"] = "local_configuration_probe"
    external_connectivity_verified: Literal[False] = False
    checked_at: datetime
    routes: list[ModelRoutingReadinessRoute] = Field(max_length=500)


def _classification_rank(value: str) -> int:
    return ("PUBLIC", "INTERNAL", "CONFIDENTIAL", "RESTRICTED").index(value)


def _validate_route_safety_classification(
    route: TrustedModelRoute | None,
    safety: SafetyContext | None,
) -> None:
    if route is None or safety is None:
        return
    classification = safety.input_decision.classification
    if _classification_rank(classification) > _classification_rank(route.maximum_classification):
        raise ValueError("input classification exceeds the route maximum")
    if (
        route.effective_classification is not None
        and classification != route.effective_classification
    ):
        raise ValueError("input classification does not match the snapshotted effective level")
