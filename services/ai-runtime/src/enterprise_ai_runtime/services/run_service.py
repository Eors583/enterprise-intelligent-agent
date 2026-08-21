from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass, field
from hashlib import sha256
from uuid import UUID, uuid4

from enterprise_ai_runtime.domain.errors import (
    InvalidRunTransitionError,
    ProviderTimeoutError,
    ProviderUnavailableError,
    RunAlreadyExistsError,
    RunStreamReconciliationRequiredError,
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
    RunStreamDeltaEvent,
    RunStreamEvent,
    RunStreamTerminalEvent,
    RunStreamTerminalPayload,
    RunUsage,
    utc_now,
)
from enterprise_ai_runtime.ports.run_store import RunStorePort
from enterprise_ai_runtime.ports.runtime import (
    RuntimePort,
    RuntimeStreamDelta,
    RuntimeStreamTerminal,
)
from enterprise_ai_runtime.telemetry import (
    mark_span_result,
    record_stream_completion,
    record_stream_delta,
    runtime_span,
)

MAX_STREAM_EVENT_BYTES = 16_384
MAX_STREAM_OUTPUT_BYTES = 1_000_000
MAX_STREAM_EVENTS = 10_000


@dataclass(slots=True)
class _StreamSession:
    condition: asyncio.Condition = field(default_factory=asyncio.Condition)
    events: list[RunStreamEvent] = field(default_factory=list)
    terminal: bool = False
    task: asyncio.Task[None] | None = None
    failure: Exception | None = None


class RunService:
    def __init__(self, store: RunStorePort, runtime: RuntimePort) -> None:
        self._store = store
        self._runtime = runtime
        self._stream_sessions: dict[tuple[str, UUID], _StreamSession] = {}
        self._stream_sessions_lock = asyncio.Lock()

    async def create(self, command: RunCreateRequest, request_id: str) -> RunRecord:
        with runtime_span(
            "agent.run.create",
            {
                "tenant.id": command.tenant_id,
                "agent.id": command.agent_id,
                "agent.version": command.agent_version,
            },
        ) as span:
            now = utc_now()
            run = RunRecord(
                run_id=command.run_id or uuid4(),
                tenant_id=command.tenant_id,
                principal=command.principal,
                agent_id=command.agent_id,
                agent_version=command.agent_version,
                model_route=command.model_route,
                safety_context=command.safety_context,
                input=command.input,
                budget=command.budget,
                metadata=command.metadata,
                status=RunStatus.QUEUED,
                request_id=request_id,
                created_at=now,
                updated_at=now,
            )
            try:
                created = await self._store.create(run)
            except RunAlreadyExistsError:
                if command.run_id is None:
                    raise
                created = await self._store.get(command.tenant_id, command.run_id)
                if not _same_create_request(created, run):
                    raise
            span.set_attribute("agent.run.id", str(created.run_id))
            mark_span_result(span, status=created.status.value)
            return created

    async def get(self, tenant_id: str, run_id: UUID) -> RunRecord:
        return await self._store.get(tenant_id, run_id)

    async def stream(
        self,
        tenant_id: str,
        run_id: UUID,
        request_id: str,
        *,
        cursor: int = 0,
    ) -> AsyncIterator[RunStreamEvent]:
        current = await self._store.get(tenant_id, run_id)
        key = (tenant_id, run_id)
        async with self._stream_sessions_lock:
            session = self._stream_sessions.get(key)
            if session is None:
                if current.status == RunStatus.RUNNING:
                    # A Runtime process restart can leave a durable RUNNING row
                    # without the provider call that created it. Starting again
                    # would violate at-most-once dispatch.
                    raise RunStreamReconciliationRequiredError(str(run_id))
                session = _StreamSession()
                self._stream_sessions[key] = session
                if current.status.is_terminal:
                    session.events.append(_terminal_stream_event(current, 1, mode="terminal_only"))
                    session.terminal = True
                else:
                    session.task = asyncio.create_task(
                        self._drive_stream(session, tenant_id, run_id, request_id),
                        name=f"agent-run-stream:{run_id}",
                    )

        next_sequence = cursor + 1
        while True:
            async with session.condition:
                await session.condition.wait_for(
                    lambda target=next_sequence: (
                        session.terminal
                        or session.failure is not None
                        or len(session.events) >= target
                    )
                )
                if session.failure is not None:
                    raise session.failure
                available = [event for event in session.events if event.sequence >= next_sequence]
                terminal = session.terminal
            for event in available:
                next_sequence = event.sequence + 1
                yield event
                if isinstance(event, RunStreamTerminalEvent):
                    return
            if terminal:
                return

    async def _drive_stream(
        self,
        session: _StreamSession,
        tenant_id: str,
        run_id: UUID,
        request_id: str,
    ) -> None:
        stream_started = asyncio.get_running_loop().time()
        emitted_bytes = 0
        first_delta = True
        mode: str = "live"
        try:
            with runtime_span(
                "agent.run.stream",
                {"tenant.id": tenant_id, "agent.run.id": str(run_id)},
            ) as span:
                current = await self._store.get(tenant_id, run_id)
                if current.status != RunStatus.QUEUED:
                    if current.status.is_terminal:
                        await self._append_stream_event(
                            session,
                            _terminal_stream_event(current, 1, mode="terminal_only"),
                        )
                        mark_span_result(span, status=current.status.value)
                        return
                    raise RunStreamReconciliationRequiredError(str(run_id))
                try:
                    running = await self._store.transition(
                        tenant_id,
                        run_id,
                        RunStatus.RUNNING,
                        request_id=request_id,
                    )
                except InvalidRunTransitionError as error:
                    raced = await self._store.get(tenant_id, run_id)
                    if raced.status.is_terminal:
                        await self._append_stream_event(
                            session,
                            _terminal_stream_event(raced, 1, mode="terminal_only"),
                        )
                        mark_span_result(span, status=raced.status.value)
                        return
                    raise RunStreamReconciliationRequiredError(str(run_id)) from error

                result: RunExecutionResult | None = None
                stream_method = getattr(self._runtime, "stream", None)
                if stream_method is None:
                    mode = "terminal_only"
                    result = await self._runtime.execute(running, request_id)
                else:
                    async for runtime_event in stream_method(running, request_id):
                        if isinstance(runtime_event, RuntimeStreamDelta):
                            encoded = runtime_event.content.encode("utf-8")
                            if (
                                not encoded
                                or len(encoded) > MAX_STREAM_EVENT_BYTES
                                or len(session.events) + 1 >= MAX_STREAM_EVENTS
                            ):
                                raise RuntimeError("runtime emitted an invalid stream delta")
                            emitted_bytes += len(encoded)
                            if emitted_bytes > MAX_STREAM_OUTPUT_BYTES:
                                raise RuntimeError("runtime stream output limit exceeded")
                            sequence = len(session.events) + 1
                            await self._append_stream_event(
                                session,
                                RunStreamDeltaEvent(
                                    event_id=f"{run_id}:{sequence}",
                                    sequence=sequence,
                                    delta=runtime_event.content,
                                    delta_hash=sha256(encoded).hexdigest(),
                                    created_at=utc_now(),
                                ),
                            )
                            with runtime_span(
                                "agent.run.first_token" if first_delta else "agent.run.delta",
                                {
                                    "tenant.id": tenant_id,
                                    "agent.run.id": str(run_id),
                                    "agent.stream.sequence": sequence,
                                },
                            ) as delta_span:
                                mark_span_result(delta_span, status="received")
                            record_stream_delta(
                                first=first_delta,
                                elapsed_seconds=(
                                    asyncio.get_running_loop().time() - stream_started
                                    if first_delta
                                    else None
                                ),
                            )
                            first_delta = False
                            continue
                        if (
                            not isinstance(runtime_event, RuntimeStreamTerminal)
                            or result is not None
                        ):
                            raise RuntimeError("runtime emitted an invalid terminal event")
                        result = runtime_event.result
                        mode = runtime_event.mode

                if result is None:
                    raise RuntimeError("runtime stream ended without a result")
                budget_error = _budget_error(result, running.budget)
                if budget_error is not None:
                    finished = await self._finish_failed(
                        tenant_id,
                        run_id,
                        budget_error,
                        output=result.output,
                        usage=result.usage,
                    )
                else:
                    finished = await self._finish_terminal(
                        tenant_id,
                        run_id,
                        RunStatus.SUCCEEDED,
                        output=result.output,
                        usage=result.usage,
                    )
                await self._append_stream_event(
                    session,
                    _terminal_stream_event(
                        finished,
                        len(session.events) + 1,
                        mode=mode,
                    ),
                )
                span.set_attribute("agent.stream.mode", mode)
                span.set_attribute("agent.stream.delta_count", len(session.events) - 1)
                mark_span_result(
                    span,
                    status=finished.status.value,
                    error_code=finished.error.code if finished.error is not None else None,
                )
                record_stream_completion(
                    status=finished.status.value,
                    mode=mode,
                    elapsed_seconds=asyncio.get_running_loop().time() - stream_started,
                )
        except asyncio.CancelledError:
            finished = await self._finish_cancelled(tenant_id, run_id)
            await self._append_stream_event(
                session,
                _terminal_stream_event(
                    finished,
                    len(session.events) + 1,
                    mode=mode,
                ),
            )
            record_stream_completion(
                status=finished.status.value,
                mode=mode,
                elapsed_seconds=asyncio.get_running_loop().time() - stream_started,
            )
        except RuntimeExecutionError as error:
            if isinstance(error, (ProviderTimeoutError, ProviderUnavailableError)):
                await self._fail_stream_session(
                    session,
                    RunStreamReconciliationRequiredError(str(run_id)),
                )
                return
            finished = await self._finish_failed(
                tenant_id,
                run_id,
                _runtime_error_info(error),
            )
            await self._append_stream_event(
                session,
                _terminal_stream_event(
                    finished,
                    len(session.events) + 1,
                    mode=mode,
                ),
            )
            record_stream_completion(
                status=finished.status.value,
                mode=mode,
                elapsed_seconds=asyncio.get_running_loop().time() - stream_started,
            )
        except RunStreamReconciliationRequiredError as error:
            await self._fail_stream_session(session, error)
        except Exception:
            # The provider may have accepted the request before an unexpected
            # transport/runtime failure. Preserve ambiguity instead of making
            # the Run retryable and risking a second paid execution.
            await self._fail_stream_session(
                session,
                RunStreamReconciliationRequiredError(str(run_id)),
            )
            return

    @staticmethod
    async def _append_stream_event(
        session: _StreamSession,
        event: RunStreamEvent,
    ) -> None:
        async with session.condition:
            if session.terminal:
                return
            session.events.append(event)
            if isinstance(event, RunStreamTerminalEvent):
                session.terminal = True
            session.condition.notify_all()

    @staticmethod
    async def _fail_stream_session(session: _StreamSession, error: Exception) -> None:
        async with session.condition:
            session.failure = error
            session.condition.notify_all()

    async def execute(self, tenant_id: str, run_id: UUID, request_id: str) -> RunRecord:
        with runtime_span(
            "agent.run.execute",
            {"tenant.id": tenant_id, "agent.run.id": str(run_id)},
        ) as span:
            result = await self._execute(tenant_id, run_id, request_id)
            if result.usage is not None:
                span.set_attribute("gen_ai.usage.input_tokens", result.usage.input_tokens)
                span.set_attribute("gen_ai.usage.output_tokens", result.usage.output_tokens)
                span.set_attribute("enterprise.ai.cost_micros", result.usage.cost_micros)
            mark_span_result(
                span,
                status=result.status.value,
                error_code=result.error.code if result.error is not None else None,
            )
            return result

    async def _execute(self, tenant_id: str, run_id: UUID, request_id: str) -> RunRecord:
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
                _runtime_error_info(error),
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
        with runtime_span(
            "agent.run.cancel",
            {"tenant.id": tenant_id, "agent.run.id": str(run_id)},
        ) as span:
            current = await self._store.get(tenant_id, run_id)
            if current.status == RunStatus.CANCELLED:
                mark_span_result(span, status=current.status.value)
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
                unconfirmed = await self._store.get(tenant_id, run_id)
                span.set_attribute("agent.run.cancel.confirmed", False)
                mark_span_result(span, status=unconfirmed.status.value)
                return unconfirmed
            cancelled = await self._finish_cancelled(tenant_id, run_id)
            span.set_attribute("agent.run.cancel.confirmed", True)
            mark_span_result(span, status=cancelled.status.value)
            return cancelled

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


def _same_create_request(existing: RunRecord, requested: RunRecord) -> bool:
    return (
        existing.tenant_id == requested.tenant_id
        and existing.principal == requested.principal
        and existing.agent_id == requested.agent_id
        and existing.agent_version == requested.agent_version
        and existing.model_route == requested.model_route
        and existing.safety_context == requested.safety_context
        and existing.input == requested.input
        and existing.budget == requested.budget
        and existing.metadata == requested.metadata
        and existing.request_id == requested.request_id
    )


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


def _runtime_error_info(error: RuntimeExecutionError) -> RunErrorInfo:
    return RunErrorInfo(
        code=error.code,
        message=error.public_message,
        retryable=error.retryable,
        model_attempts=list(getattr(error, "model_attempts", ())),
        safety_decision=getattr(error, "safety_decision", None),
    )


def _terminal_stream_event(
    run: RunRecord,
    sequence: int,
    *,
    mode: str,
) -> RunStreamTerminalEvent:
    event_type = "terminal_only" if mode == "terminal_only" else "terminal"
    return RunStreamTerminalEvent(
        event_id=f"{run.run_id}:{sequence}",
        sequence=sequence,
        type=event_type,
        run=RunStreamTerminalPayload(
            run_id=run.run_id,
            status=run.status,
            output=run.output,
            usage=run.usage,
            error=run.error,
        ),
        created_at=utc_now(),
    )
