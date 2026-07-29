from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from uuid import UUID

from enterprise_ai_runtime.domain.errors import (
    InputTokenBudgetPreflightError,
    UnsupportedRuntimeInputError,
)
from enterprise_ai_runtime.domain.models import RunExecutionResult, RunRecord
from enterprise_ai_runtime.ports.provider import (
    ProviderCompletionRequest,
    ProviderPort,
    ProviderStreamDelta,
    ProviderStreamTerminal,
)
from enterprise_ai_runtime.ports.runtime import (
    RuntimeStreamDelta,
    RuntimeStreamEvent,
    RuntimeStreamTerminal,
)


class ProviderRuntime:
    """Maps durable runs to a provider and tracks in-process calls for cancellation."""

    def __init__(self, provider: ProviderPort, *, model: str) -> None:
        self._provider = provider
        self._model = model
        self._active: dict[UUID, asyncio.Task[RunExecutionResult]] = {}
        self._lock = asyncio.Lock()

    async def execute(self, run: RunRecord, request_id: str) -> RunExecutionResult:
        self._validate(run)

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

    async def stream(
        self,
        run: RunRecord,
        request_id: str,
    ) -> AsyncIterator[RuntimeStreamEvent]:
        self._validate(run)
        task = asyncio.current_task()
        if task is None:
            raise RuntimeError("runtime streaming requires an asyncio task")
        async with self._lock:
            self._active[run.run_id] = task
        request = ProviderCompletionRequest(
            messages=tuple(run.input.messages),
            model=self._model,
            timeout_ms=run.budget.timeout_ms,
            max_input_tokens=run.budget.max_input_tokens,
            max_output_tokens=run.budget.max_output_tokens,
            request_id=request_id,
            run_id=run.run_id,
        )
        try:
            provider_stream = getattr(self._provider, "stream", None)
            if provider_stream is None:
                # Manus and other task-based providers expose a terminal result
                # only. This is intentionally labelled instead of fabricating
                # token streaming from their polling lifecycle.
                result = await self._provider.complete(request)
                yield RuntimeStreamTerminal(result=result, mode="terminal_only")
                return
            saw_terminal = False
            async for event in provider_stream(request):
                if isinstance(event, ProviderStreamDelta):
                    if saw_terminal:
                        raise RuntimeError("provider emitted a delta after its terminal event")
                    yield RuntimeStreamDelta(content=event.content)
                    continue
                if not isinstance(event, ProviderStreamTerminal) or saw_terminal:
                    raise RuntimeError("provider emitted an invalid stream event")
                saw_terminal = True
                yield RuntimeStreamTerminal(result=event.result, mode=event.mode)
            if not saw_terminal:
                raise RuntimeError("provider stream ended without a terminal event")
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

    @staticmethod
    def _validate(run: RunRecord) -> None:
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
