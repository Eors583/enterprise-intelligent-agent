from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Literal, Protocol
from uuid import UUID

from enterprise_ai_runtime.domain.models import RunExecutionResult, RunMessage


@dataclass(frozen=True, slots=True)
class ProviderCompletionRequest:
    """Provider-neutral chat completion request with explicit execution bounds."""

    messages: tuple[RunMessage, ...]
    model: str
    timeout_ms: int
    max_input_tokens: int
    max_output_tokens: int
    request_id: str
    run_id: UUID


@dataclass(frozen=True, slots=True)
class ProviderStreamDelta:
    content: str


@dataclass(frozen=True, slots=True)
class ProviderStreamTerminal:
    result: RunExecutionResult
    mode: Literal["live", "terminal_only"]


ProviderStreamEvent = ProviderStreamDelta | ProviderStreamTerminal


class ProviderPort(Protocol):
    async def complete(self, request: ProviderCompletionRequest) -> RunExecutionResult: ...

    def stream(self, request: ProviderCompletionRequest) -> AsyncIterator[ProviderStreamEvent]: ...

    async def cancel(self, run_id: UUID) -> bool:
        """Return true only after the provider confirms remote execution stopped."""
        ...

    async def is_ready(self) -> bool: ...

    async def aclose(self) -> None: ...
