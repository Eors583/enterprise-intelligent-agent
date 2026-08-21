from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Literal, Protocol

from enterprise_ai_runtime.domain.models import RunExecutionResult, RunRecord


@dataclass(frozen=True, slots=True)
class RuntimeStreamDelta:
    content: str


@dataclass(frozen=True, slots=True)
class RuntimeStreamTerminal:
    result: RunExecutionResult
    mode: Literal["live", "terminal_only"]


RuntimeStreamEvent = RuntimeStreamDelta | RuntimeStreamTerminal


class RuntimePort(Protocol):
    """Run execution boundary used by the application service."""

    async def execute(self, run: RunRecord, request_id: str) -> RunExecutionResult: ...

    def stream(self, run: RunRecord, request_id: str) -> AsyncIterator[RuntimeStreamEvent]: ...

    async def cancel(self, run: RunRecord) -> bool: ...

    async def is_ready(self) -> bool: ...

    async def aclose(self) -> None: ...
