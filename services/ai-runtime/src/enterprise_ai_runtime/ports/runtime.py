from __future__ import annotations

from typing import Protocol

from enterprise_ai_runtime.domain.models import RunExecutionResult, RunRecord


class RuntimePort(Protocol):
    """Run execution boundary used by the application service."""

    async def execute(self, run: RunRecord, request_id: str) -> RunExecutionResult: ...

    async def cancel(self, run: RunRecord) -> bool: ...

    async def is_ready(self) -> bool: ...

    async def aclose(self) -> None: ...
