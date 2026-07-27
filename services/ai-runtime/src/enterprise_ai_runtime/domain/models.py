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
    max_tool_calls: int = Field(ge=0, le=1_000)
    timeout_ms: int = Field(ge=100, le=3_600_000)
    max_cost_micros: int = Field(ge=0, le=10_000_000_000)


class RunCreateRequest(StrictModel):
    tenant_id: Identifier
    principal: PrincipalContext
    agent_id: Identifier
    agent_version: VersionIdentifier
    input: RunInput
    budget: RunBudget
    metadata: dict[str, Any] = Field(default_factory=dict, max_length=64)


class RunStatus(StrEnum):
    QUEUED = "queued"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"

    @property
    def is_terminal(self) -> bool:
        return self in {self.SUCCEEDED, self.FAILED, self.CANCELLED}


class RunErrorInfo(StrictModel):
    code: Identifier
    message: str = Field(min_length=1, max_length=2_000)
    retryable: bool = False


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


class RunCreateResponse(StrictModel):
    run_id: UUID
    status: RunStatus
    request_id: str


class HealthResponse(StrictModel):
    status: Literal["ok", "ready", "not_ready"]
    service: str = "enterprise-ai-runtime"
    components: dict[str, Literal["ready", "not_ready"]] | None = None
