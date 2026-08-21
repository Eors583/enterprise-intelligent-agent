from __future__ import annotations

import asyncio
from uuid import UUID

from enterprise_ai_runtime.domain.errors import (
    RunAlreadyExistsError,
    RunNotFoundError,
)
from enterprise_ai_runtime.domain.models import (
    RunErrorInfo,
    RunOutput,
    RunRecord,
    RunStatus,
    RunUsage,
    utc_now,
)
from enterprise_ai_runtime.domain.state import ensure_transition_allowed


class InMemoryRunStore:
    """Process-local development store; never use this adapter in production."""

    def __init__(self) -> None:
        self._runs: dict[tuple[str, UUID], RunRecord] = {}
        self._lock = asyncio.Lock()

    async def create(self, run: RunRecord) -> RunRecord:
        key = (run.tenant_id, run.run_id)
        async with self._lock:
            if key in self._runs:
                raise RunAlreadyExistsError(str(run.run_id))
            self._runs[key] = run.model_copy(deep=True)
            return self._runs[key].model_copy(deep=True)

    async def get(self, tenant_id: str, run_id: UUID) -> RunRecord:
        async with self._lock:
            run = self._runs.get((tenant_id, run_id))
            if run is None:
                # A tenant mismatch deliberately looks identical to a missing run.
                raise RunNotFoundError(str(run_id))
            return run.model_copy(deep=True)

    async def transition(
        self,
        tenant_id: str,
        run_id: UUID,
        target: RunStatus,
        *,
        error: RunErrorInfo | None = None,
        output: RunOutput | None = None,
        usage: RunUsage | None = None,
        request_id: str | None = None,
    ) -> RunRecord:
        key = (tenant_id, run_id)
        async with self._lock:
            current = self._runs.get(key)
            if current is None:
                raise RunNotFoundError(str(run_id))

            ensure_transition_allowed(current.status, target)
            now = utc_now()
            changes: dict[str, object] = {
                "status": target,
                "updated_at": now,
                "version": current.version + 1,
                "error": error,
                "output": output,
                "usage": usage,
            }
            if request_id is not None:
                changes["execution_request_id"] = request_id
            if target == RunStatus.RUNNING and current.started_at is None:
                changes["started_at"] = now
            if target.is_terminal:
                changes["finished_at"] = now

            updated = current.model_copy(update=changes, deep=True)
            self._runs[key] = updated
            return updated.model_copy(deep=True)

    async def is_ready(self) -> bool:
        return True

    async def aclose(self) -> None:
        return None
