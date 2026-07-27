from __future__ import annotations

from enterprise_ai_runtime.domain.errors import RuntimeNotConfiguredError
from enterprise_ai_runtime.domain.models import RunExecutionResult, RunRecord


class NoopRuntime:
    """Development runtime that intentionally performs no model or tool calls."""

    async def execute(self, run: RunRecord, request_id: str) -> RunExecutionResult:
        raise RuntimeNotConfiguredError()

    async def cancel(self, run: RunRecord) -> bool:
        # There is no external work to stop in the no-op implementation.
        return True

    async def is_ready(self) -> bool:
        return True

    async def aclose(self) -> None:
        return None
