from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from uuid import UUID, uuid4

from enterprise_ai_runtime.domain.errors import (
    InvalidRunTransitionError,
    RuntimeExecutionError,
)
from enterprise_ai_runtime.domain.models import (
    RunBudget,
    RunCreateRequest,
    RunErrorInfo,
    RunExecutionResult,
    RunOutput,
    RunRecord,
    RunStatus,
    RunUsage,
    utc_now,
)
from enterprise_ai_runtime.ports.run_store import RunStorePort
from enterprise_ai_runtime.ports.runtime import RuntimePort


class RunService:
    def __init__(self, store: RunStorePort, runtime: RuntimePort) -> None:
        self._store = store
        self._runtime = runtime

    async def create(self, command: RunCreateRequest, request_id: str) -> RunRecord:
        now = utc_now()
        run = RunRecord(
            run_id=uuid4(),
            tenant_id=command.tenant_id,
            principal=command.principal,
            agent_id=command.agent_id,
            agent_version=command.agent_version,
            input=command.input,
            budget=command.budget,
            metadata=command.metadata,
            status=RunStatus.QUEUED,
            request_id=request_id,
            created_at=now,
            updated_at=now,
        )
        return await self._store.create(run)

    async def get(self, tenant_id: str, run_id: UUID) -> RunRecord:
        return await self._store.get(tenant_id, run_id)

    async def execute(self, tenant_id: str, run_id: UUID, request_id: str) -> RunRecord:
        current = await self._store.get(tenant_id, run_id)
        if current.status != RunStatus.QUEUED:
            # Running and terminal records are stable idempotency results. A durable worker can
            # later add leases for recovery of abandoned RUNNING records.
            return current

        try:
            running = await self._store.transition(
                tenant_id,
                run_id,
                RunStatus.RUNNING,
                request_id=request_id,
            )
        except InvalidRunTransitionError:
            # A concurrent execute/cancel request won the state transition.
            return await self._store.get(tenant_id, run_id)

        try:
            result = await self._runtime.execute(running, request_id)
        except asyncio.CancelledError:
            return await self._finish_cancelled(tenant_id, run_id)
        except RuntimeExecutionError as error:
            return await self._finish_failed(
                tenant_id,
                run_id,
                RunErrorInfo(
                    code=error.code,
                    message=error.public_message,
                    retryable=error.retryable,
                ),
            )
        except Exception:
            # Provider details and secrets must never cross the runtime boundary.
            return await self._finish_failed(
                tenant_id,
                run_id,
                RunErrorInfo(
                    code="RUNTIME_EXECUTION_FAILED",
                    message="runtime execution failed unexpectedly",
                    retryable=True,
                ),
            )

        budget_error = _budget_error(result, running.budget)
        if budget_error is not None:
            return await self._finish_failed(
                tenant_id,
                run_id,
                budget_error,
                output=result.output,
                usage=result.usage,
            )

        return await self._finish_terminal(
            tenant_id,
            run_id,
            RunStatus.SUCCEEDED,
            output=result.output,
            usage=result.usage,
        )

    async def cancel(self, tenant_id: str, run_id: UUID) -> RunRecord:
        current = await self._store.get(tenant_id, run_id)
        if current.status == RunStatus.CANCELLED:
            return current
        if current.status in {RunStatus.SUCCEEDED, RunStatus.FAILED}:
            raise InvalidRunTransitionError(
                current=current.status.value,
                target=RunStatus.CANCELLED.value,
            )

        confirmed = await self._runtime.cancel(current)
        if not confirmed:
            # Do not claim cancellation merely because a local HTTP request was
            # interrupted. The caller can keep polling the durable provider run.
            return await self._store.get(tenant_id, run_id)
        return await self._finish_cancelled(tenant_id, run_id)

    async def readiness(self) -> tuple[bool, bool]:
        async def safe_ready(check: Callable[[], Awaitable[bool]]) -> bool:
            try:
                return bool(await check())
            except Exception:
                return False

        store_ready, runtime_ready = await asyncio.gather(
            safe_ready(self._store.is_ready),
            safe_ready(self._runtime.is_ready),
        )
        return store_ready, runtime_ready

    async def _finish_failed(
        self,
        tenant_id: str,
        run_id: UUID,
        error: RunErrorInfo,
        *,
        output: RunOutput | None = None,
        usage: RunUsage | None = None,
    ) -> RunRecord:
        return await self._finish_terminal(
            tenant_id,
            run_id,
            RunStatus.FAILED,
            error=error,
            output=output,
            usage=usage,
        )

    async def _finish_cancelled(self, tenant_id: str, run_id: UUID) -> RunRecord:
        return await self._finish_terminal(tenant_id, run_id, RunStatus.CANCELLED)

    async def _finish_terminal(
        self,
        tenant_id: str,
        run_id: UUID,
        status: RunStatus,
        *,
        error: RunErrorInfo | None = None,
        output: RunOutput | None = None,
        usage: RunUsage | None = None,
    ) -> RunRecord:
        try:
            return await self._store.transition(
                tenant_id,
                run_id,
                status,
                error=error,
                output=output,
                usage=usage,
            )
        except InvalidRunTransitionError:
            current = await self._store.get(tenant_id, run_id)
            if current.status.is_terminal:
                return current
            raise


def _budget_error(result: RunExecutionResult, budget: RunBudget) -> RunErrorInfo | None:
    usage = result.usage
    if usage.input_tokens > budget.max_input_tokens:
        return RunErrorInfo(
            code="INPUT_TOKEN_BUDGET_EXCEEDED",
            message="provider input token usage exceeded the run budget",
            retryable=False,
        )
    if usage.output_tokens > budget.max_output_tokens:
        return RunErrorInfo(
            code="OUTPUT_TOKEN_BUDGET_EXCEEDED",
            message="provider output token usage exceeded the run budget",
            retryable=False,
        )
    if usage.tool_calls > budget.max_tool_calls:
        return RunErrorInfo(
            code="TOOL_CALL_BUDGET_EXCEEDED",
            message="provider tool call usage exceeded the run budget",
            retryable=False,
        )
    if usage.cost_micros > budget.max_cost_micros:
        return RunErrorInfo(
            code="COST_BUDGET_EXCEEDED",
            message="provider cost exceeded the run budget",
            retryable=False,
        )
    return None
