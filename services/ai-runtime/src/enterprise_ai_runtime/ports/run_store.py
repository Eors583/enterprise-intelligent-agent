from __future__ import annotations

from typing import Protocol
from uuid import UUID

from enterprise_ai_runtime.domain.models import (
    RunErrorInfo,
    RunOutput,
    RunRecord,
    RunStatus,
    RunUsage,
)


class RunStorePort(Protocol):
    """Tenant-scoped persistence contract for run state."""

    async def create(self, run: RunRecord) -> RunRecord: ...

    async def get(self, tenant_id: str, run_id: UUID) -> RunRecord: ...

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
    ) -> RunRecord: ...

    async def is_ready(self) -> bool: ...

    async def aclose(self) -> None: ...
