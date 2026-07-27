from __future__ import annotations

import asyncio
import json
from uuid import UUID

from enterprise_ai_runtime.domain.errors import (
    InputTokenBudgetPreflightError,
    UnsupportedRuntimeInputError,
)
from enterprise_ai_runtime.domain.models import RunExecutionResult, RunRecord
from enterprise_ai_runtime.ports.provider import ProviderCompletionRequest, ProviderPort


class ProviderRuntime:
    """Maps durable runs to a provider and tracks in-process calls for cancellation."""

    def __init__(self, provider: ProviderPort, *, model: str) -> None:
        self._provider = provider
        self._model = model
        self._active: dict[UUID, asyncio.Task[RunExecutionResult]] = {}
        self._lock = asyncio.Lock()

    async def execute(self, run: RunRecord, request_id: str) -> RunExecutionResult:
        if run.input.attachments:
            raise UnsupportedRuntimeInputError(
                "the configured model runtime does not support asset attachments yet"
            )
        if _conservative_input_token_upper_bound(run) > run.budget.max_input_tokens:
            # Byte-level BPE tokenizers cannot emit more ordinary text tokens
            # than the UTF-8 payload has bytes. Including a fixed protocol
            # allowance gives a provider-independent fail-closed bound without
            # trusting post-paid usage reporting.
            raise InputTokenBudgetPreflightError()

        task = asyncio.current_task()
        if task is None:
            raise RuntimeError("runtime execution requires an asyncio task")

        async with self._lock:
            self._active[run.run_id] = task
        try:
            return await self._provider.complete(
                ProviderCompletionRequest(
                    messages=tuple(run.input.messages),
                    model=self._model,
                    timeout_ms=run.budget.timeout_ms,
                    max_input_tokens=run.budget.max_input_tokens,
                    max_output_tokens=run.budget.max_output_tokens,
                    request_id=request_id,
                    run_id=run.run_id,
                )
            )
        finally:
            async with self._lock:
                if self._active.get(run.run_id) is task:
                    self._active.pop(run.run_id, None)

    async def cancel(self, run: RunRecord) -> bool:
        confirmed = await self._provider.cancel(run.run_id)
        if not confirmed:
            return False
        async with self._lock:
            task = self._active.get(run.run_id)
        if task is not None and task is not asyncio.current_task():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        return True

    async def is_ready(self) -> bool:
        return await self._provider.is_ready()

    async def aclose(self) -> None:
        async with self._lock:
            tasks = list(self._active.values())
            self._active.clear()
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        await self._provider.aclose()


def _conservative_input_token_upper_bound(run: RunRecord) -> int:
    payload = [
        {
            "role": message.role.value,
            "content": message.content,
            "name": message.name,
            "tool_call_id": message.tool_call_id,
        }
        for message in run.input.messages
    ]
    serialized = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return len(serialized) + 512
