from __future__ import annotations

import asyncio
import hashlib
import json
import re
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from uuid import UUID

from enterprise_ai_runtime.config import ModelRouteCatalogEntry
from enterprise_ai_runtime.domain.errors import (
    ProviderRateLimitError,
    ProviderResponseError,
    RuntimeExecutionError,
    UnsupportedRuntimeInputError,
)
from enterprise_ai_runtime.domain.models import (
    ModelAttemptReceipt,
    RunExecutionResult,
    RunRecord,
    SafetyDecision,
)
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

_PRIVATE_KEY = re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----")
_BEARER = re.compile(r"\bBearer\s+[A-Za-z0-9._~+/-]{20,}={0,2}\b", re.IGNORECASE)
_SECRET = re.compile(
    r"\b(?:api[_ -]?key|secret|password|access[_ -]?token)\s*[:=]\s*"
    r"[\"']?[A-Za-z0-9._~+/-]{12,}={0,2}[\"']?",
    re.IGNORECASE,
)
_EMAIL = re.compile(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", re.IGNORECASE)
_PHONE = re.compile(r"(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)")
_OUTPUT_SAFETY_LOOKBEHIND = 512
_MAX_OUTPUT_CHARACTERS = 1_000_000


class UntrustedModelRouteError(RuntimeExecutionError):
    def __init__(self) -> None:
        super().__init__(
            "UNTRUSTED_MODEL_ROUTE",
            "the requested model route is not in the Runtime allowlist",
            retryable=False,
        )


class RoutedExecutionError(RuntimeExecutionError):
    def __init__(
        self,
        source: RuntimeExecutionError,
        *,
        attempts: list[ModelAttemptReceipt],
        safety_decision: SafetyDecision | None = None,
    ) -> None:
        retryable = source.retryable and not any(
            attempt.outcome == "UNKNOWN" for attempt in attempts
        )
        super().__init__(source.code, source.public_message, retryable=retryable)
        self.model_attempts = tuple(attempts)
        self.safety_decision = safety_decision


class OutputSafetyBlockedError(RuntimeExecutionError):
    def __init__(
        self,
        reason_code: str = "GENERATED_SECRET_MATERIAL_DETECTED",
    ) -> None:
        super().__init__(
            "AI_SAFETY_OUTPUT_BLOCKED",
            "model output was blocked by the configured safety policy",
            retryable=False,
        )
        self.reason_code = reason_code


@dataclass(slots=True)
class _Circuit:
    failures: int = 0
    opened_until: datetime | None = None


class RoutedProviderRuntime:
    """Executes only immutable routes that exactly match the server allowlist.

    Provider endpoints and credentials are constructor-owned. The Run request
    carries identifiers and model names only and can never select a URL or key.
    """

    def __init__(
        self,
        provider: ProviderPort,
        *,
        catalog: tuple[ModelRouteCatalogEntry, ...],
        require_route: bool,
    ) -> None:
        self._provider = provider
        self._catalog = {entry.route_key: entry for entry in catalog}
        self._require_route = require_route
        self._circuits: dict[str, _Circuit] = {}
        self._active: dict[UUID, asyncio.Task[RunExecutionResult]] = {}
        self._lock = asyncio.Lock()

    async def execute(self, run: RunRecord, request_id: str) -> RunExecutionResult:
        self._validate_input(run)
        route = run.model_route
        if route is None:
            if self._require_route:
                raise UntrustedModelRouteError()
            raise UnsupportedRuntimeInputError("a trusted model route is required")
        if route.maximum_attempts > run.budget.max_steps:
            raise UnsupportedRuntimeInputError("model route exceeds the Run step budget")

        task = asyncio.current_task()
        if task is None:
            raise RuntimeError("runtime execution requires an asyncio task")
        async with self._lock:
            self._active[run.run_id] = task
        attempts: list[ModelAttemptReceipt] = []
        try:
            for candidate in route.candidates[: route.maximum_attempts]:
                entry = self._trusted_entry(candidate)
                started_at = datetime.now(UTC)
                if self._circuit_is_open(entry.route_key, started_at):
                    attempts.append(
                        _attempt(
                            candidate=candidate,
                            outcome="REJECTED",
                            reason_code="MODEL_CIRCUIT_OPEN",
                            retry_safe=True,
                            started_at=started_at,
                        )
                    )
                    continue
                try:
                    result = await self._provider.complete(
                        ProviderCompletionRequest(
                            messages=tuple(run.input.messages),
                            model=entry.model,
                            timeout_ms=run.budget.timeout_ms,
                            max_input_tokens=run.budget.max_input_tokens,
                            max_output_tokens=run.budget.max_output_tokens,
                            request_id=request_id,
                            run_id=run.run_id,
                        )
                    )
                except RuntimeExecutionError as error:
                    # A provider rate-limit is a pre-execution refusal and the
                    # only failure proven safe for a second paid dispatch.
                    retry_safe = isinstance(error, ProviderRateLimitError)
                    outcome = "FAILED" if retry_safe or not error.retryable else "UNKNOWN"
                    attempts.append(
                        _attempt(
                            candidate=candidate,
                            outcome=outcome,
                            reason_code=error.code,
                            retry_safe=retry_safe,
                            started_at=started_at,
                        )
                    )
                    self._record_failure(
                        entry.route_key,
                        threshold=route.circuit_failure_threshold,
                        open_seconds=route.circuit_open_seconds,
                    )
                    if retry_safe:
                        continue
                    raise RoutedExecutionError(error, attempts=attempts) from error

                self._circuits[entry.route_key] = _Circuit()
                attempts.append(
                    _attempt(
                        candidate=candidate,
                        outcome="SUCCEEDED",
                        reason_code=None,
                        retry_safe=False,
                        started_at=started_at,
                    )
                )
                output, safety = _safe_output(result.output.content)
                if safety.action == "BLOCK":
                    raise RoutedExecutionError(
                        OutputSafetyBlockedError(),
                        attempts=attempts,
                        safety_decision=safety,
                    )
                return result.model_copy(
                    update={
                        "output": result.output.model_copy(
                            update={
                                "content": output,
                                "model": entry.model,
                                "model_attempts": attempts,
                                "safety_decision": safety,
                            }
                        )
                    },
                    deep=True,
                )
            raise RoutedExecutionError(
                ProviderRateLimitError(),
                attempts=attempts,
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
        self._validate_input(run)
        route = run.model_route
        if route is None:
            if self._require_route:
                raise UntrustedModelRouteError()
            raise UnsupportedRuntimeInputError("a trusted model route is required")
        if route.maximum_attempts > run.budget.max_steps:
            raise UnsupportedRuntimeInputError("model route exceeds the Run step budget")

        task = asyncio.current_task()
        if task is None:
            raise RuntimeError("runtime execution requires an asyncio task")
        async with self._lock:
            self._active[run.run_id] = task
        attempts: list[ModelAttemptReceipt] = []
        try:
            for candidate in route.candidates[: route.maximum_attempts]:
                entry = self._trusted_entry(candidate)
                started_at = datetime.now(UTC)
                if self._circuit_is_open(entry.route_key, started_at):
                    attempts.append(
                        _attempt(
                            candidate=candidate,
                            outcome="REJECTED",
                            reason_code="MODEL_CIRCUIT_OPEN",
                            retry_safe=True,
                            started_at=started_at,
                        )
                    )
                    continue

                request = ProviderCompletionRequest(
                    messages=tuple(run.input.messages),
                    model=entry.model,
                    timeout_ms=run.budget.timeout_ms,
                    max_input_tokens=run.budget.max_input_tokens,
                    max_output_tokens=run.budget.max_output_tokens,
                    request_id=request_id,
                    run_id=run.run_id,
                )
                provider_stream_factory = getattr(self._provider, "stream", None)
                if provider_stream_factory is None:
                    try:
                        result = await self._provider.complete(request)
                    except RuntimeExecutionError as error:
                        retry_safe = isinstance(error, ProviderRateLimitError)
                        outcome = "FAILED" if retry_safe or not error.retryable else "UNKNOWN"
                        attempts.append(
                            _attempt(
                                candidate=candidate,
                                outcome=outcome,
                                reason_code=error.code,
                                retry_safe=retry_safe,
                                started_at=started_at,
                            )
                        )
                        self._record_failure(
                            entry.route_key,
                            threshold=route.circuit_failure_threshold,
                            open_seconds=route.circuit_open_seconds,
                        )
                        if retry_safe:
                            continue
                        raise RoutedExecutionError(error, attempts=attempts) from error
                    output, safety = _safe_output(result.output.content)
                    self._circuits[entry.route_key] = _Circuit()
                    attempts.append(
                        _attempt(
                            candidate=candidate,
                            outcome="SUCCEEDED",
                            reason_code=None,
                            retry_safe=False,
                            started_at=started_at,
                        )
                    )
                    if safety.action == "BLOCK":
                        raise RoutedExecutionError(
                            OutputSafetyBlockedError(),
                            attempts=attempts,
                            safety_decision=safety,
                        )
                    yield RuntimeStreamTerminal(
                        result=result.model_copy(
                            update={
                                "output": result.output.model_copy(
                                    update={
                                        "content": output,
                                        "model": entry.model,
                                        "model_attempts": attempts,
                                        "safety_decision": safety,
                                    }
                                )
                            },
                            deep=True,
                        ),
                        mode="terminal_only",
                    )
                    return

                guard = _IncrementalOutputGuard()
                terminal: ProviderStreamTerminal | None = None
                provider_stream = provider_stream_factory(request)
                try:
                    async for event in provider_stream:
                        if terminal is not None:
                            raise ProviderResponseError()
                        if isinstance(event, ProviderStreamDelta):
                            released = guard.accept(event.content)
                            if released:
                                yield RuntimeStreamDelta(content=released)
                            continue
                        if not isinstance(event, ProviderStreamTerminal):
                            raise ProviderResponseError()
                        terminal = event
                    if terminal is None:
                        raise ProviderResponseError()
                    released, safety = guard.finish(terminal.result.output.content)
                    if released:
                        yield RuntimeStreamDelta(content=released)
                except OutputSafetyBlockedError as error:
                    attempts.append(
                        _attempt(
                            candidate=candidate,
                            outcome="UNKNOWN",
                            reason_code=error.code,
                            retry_safe=False,
                            started_at=started_at,
                        )
                    )
                    self._record_failure(
                        entry.route_key,
                        threshold=route.circuit_failure_threshold,
                        open_seconds=route.circuit_open_seconds,
                    )
                    raise RoutedExecutionError(
                        error,
                        attempts=attempts,
                        safety_decision=guard.block_decision(error.reason_code),
                    ) from error
                except RuntimeExecutionError as error:
                    # Any provider delta proves that execution started, even if
                    # it is still inside the safety look-behind and has not
                    # reached the caller. Retrying that ambiguous dispatch
                    # could duplicate cost or side effects.
                    retry_safe = (
                        isinstance(error, ProviderRateLimitError) and guard.raw_characters == 0
                    )
                    outcome = "FAILED" if retry_safe or not error.retryable else "UNKNOWN"
                    attempts.append(
                        _attempt(
                            candidate=candidate,
                            outcome=outcome,
                            reason_code=error.code,
                            retry_safe=retry_safe,
                            started_at=started_at,
                        )
                    )
                    self._record_failure(
                        entry.route_key,
                        threshold=route.circuit_failure_threshold,
                        open_seconds=route.circuit_open_seconds,
                    )
                    if retry_safe:
                        continue
                    raise RoutedExecutionError(error, attempts=attempts) from error
                finally:
                    close = getattr(provider_stream, "aclose", None)
                    if callable(close):
                        await close()

                self._circuits[entry.route_key] = _Circuit()
                attempts.append(
                    _attempt(
                        candidate=candidate,
                        outcome="SUCCEEDED",
                        reason_code=None,
                        retry_safe=False,
                        started_at=started_at,
                    )
                )
                assert terminal is not None
                result = terminal.result.model_copy(
                    update={
                        "output": terminal.result.output.model_copy(
                            update={
                                "content": guard.safe_content,
                                "model": entry.model,
                                "model_attempts": attempts,
                                "safety_decision": safety,
                            }
                        )
                    },
                    deep=True,
                )
                yield RuntimeStreamTerminal(result=result, mode=terminal.mode)
                return
            raise RoutedExecutionError(
                ProviderRateLimitError(),
                attempts=attempts,
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
        if self._require_route and not self._catalog:
            return False
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

    def _trusted_entry(self, candidate) -> ModelRouteCatalogEntry:
        entry = self._catalog.get(candidate.route_key)
        if (
            entry is None
            or entry.catalog_version_id != candidate.catalog_version_id
            or entry.provider != candidate.provider
            or entry.model != candidate.model
            or entry.credential_reference != candidate.credential_reference
        ):
            raise UntrustedModelRouteError()
        return entry

    def _circuit_is_open(self, route_key: str, now: datetime) -> bool:
        circuit = self._circuits.get(route_key)
        if circuit is None or circuit.opened_until is None:
            return False
        if circuit.opened_until <= now:
            circuit.opened_until = None
            return False
        return True

    def _record_failure(self, route_key: str, *, threshold: int, open_seconds: int) -> None:
        circuit = self._circuits.setdefault(route_key, _Circuit())
        circuit.failures += 1
        if circuit.failures >= threshold:
            circuit.opened_until = datetime.now(UTC) + timedelta(seconds=open_seconds)

    @staticmethod
    def _validate_input(run: RunRecord) -> None:
        if run.input.attachments:
            raise UnsupportedRuntimeInputError(
                "the configured model runtime does not support asset attachments yet"
            )
        if run.safety_context is None or not run.safety_context.knowledge_is_untrusted_data:
            raise UnsupportedRuntimeInputError("trusted safety context is required")
        route = run.model_route
        if route is not None:
            order = ("PUBLIC", "INTERNAL", "CONFIDENTIAL", "RESTRICTED")
            input_classification = run.safety_context.input_decision.classification
            if order.index(input_classification) > order.index(route.maximum_classification):
                raise UnsupportedRuntimeInputError(
                    "input classification exceeds the trusted model route maximum"
                )
            if (
                route.effective_classification is not None
                and input_classification != route.effective_classification
            ):
                raise UnsupportedRuntimeInputError(
                    "input classification does not match the trusted route snapshot"
                )
        serialized = json.dumps(
            [
                {
                    "role": message.role.value,
                    "content": message.content,
                    "name": message.name,
                    "tool_call_id": message.tool_call_id,
                }
                for message in run.input.messages
            ],
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
        if len(serialized) + 512 > run.budget.max_input_tokens:
            raise UnsupportedRuntimeInputError(
                "input exceeds the conservative preflight token budget"
            )


def _attempt(
    *,
    candidate,
    outcome: str,
    reason_code: str | None,
    retry_safe: bool,
    started_at: datetime,
) -> ModelAttemptReceipt:
    return ModelAttemptReceipt(
        attempt_number=candidate.ordinal,
        catalog_version_id=candidate.catalog_version_id,
        route_key=candidate.route_key,
        provider=candidate.provider,
        model=candidate.model,
        outcome=outcome,
        reason_code=reason_code,
        retry_safe=retry_safe,
        started_at=started_at,
        finished_at=datetime.now(UTC),
    )


def _safe_output(content: str) -> tuple[str, SafetyDecision]:
    content_hash = hashlib.sha256(content.encode("utf-8")).hexdigest()
    if _PRIVATE_KEY.search(content) or _BEARER.search(content) or _SECRET.search(content):
        decision = _decision(
            classification="RESTRICTED",
            action="BLOCK",
            reason_codes=["GENERATED_SECRET_MATERIAL_DETECTED"],
            content_sha256=content_hash,
            redacted_content_sha256=None,
        )
        return "", decision
    redacted = _PHONE.sub("[REDACTED_PHONE]", _EMAIL.sub("[REDACTED_EMAIL]", content))
    if redacted != content:
        redacted_hash = hashlib.sha256(redacted.encode("utf-8")).hexdigest()
        return redacted, _decision(
            classification="CONFIDENTIAL",
            action="REDACT",
            reason_codes=["GENERATED_PII_MINIMIZED"],
            content_sha256=content_hash,
            redacted_content_sha256=redacted_hash,
        )
    return content, _decision(
        classification="INTERNAL",
        action="ALLOW",
        reason_codes=["NO_SENSITIVE_PATTERN_DETECTED"],
        content_sha256=content_hash,
        redacted_content_sha256=None,
    )


@dataclass(slots=True)
class _IncrementalOutputGuard:
    """Bounded look-behind that never releases undecided sensitive text."""

    pending: str = ""
    safe_parts: list[str] = field(default_factory=list)
    raw_parts: list[str] = field(default_factory=list)
    raw_characters: int = 0

    @property
    def safe_content(self) -> str:
        return "".join(self.safe_parts)

    def accept(self, content: str) -> str:
        if not content:
            return ""
        self.raw_parts.append(content)
        self.raw_characters += len(content)
        if self.raw_characters > _MAX_OUTPUT_CHARACTERS:
            raise ProviderResponseError()
        self.pending += content
        self._raise_if_blocked()
        cutoff = max(0, len(self.pending) - _OUTPUT_SAFETY_LOOKBEHIND)
        cutoff = _safe_release_cutoff(self.pending, cutoff)
        if cutoff == 0:
            return ""
        released = _redact(self.pending[:cutoff])
        self.pending = self.pending[cutoff:]
        self.safe_parts.append(released)
        return released

    def finish(self, terminal_content: str) -> tuple[str, SafetyDecision]:
        raw_content = "".join(self.raw_parts)
        if raw_content != terminal_content:
            raise ProviderResponseError()
        self._raise_if_blocked()
        released = _redact(self.pending)
        self.pending = ""
        if released:
            self.safe_parts.append(released)
        safe_content = self.safe_content
        content_hash = hashlib.sha256(raw_content.encode("utf-8")).hexdigest()
        if safe_content != raw_content:
            safety = _decision(
                classification="CONFIDENTIAL",
                action="REDACT",
                reason_codes=["GENERATED_PII_MINIMIZED"],
                content_sha256=content_hash,
                redacted_content_sha256=hashlib.sha256(safe_content.encode("utf-8")).hexdigest(),
            )
        else:
            safety = _decision(
                classification="INTERNAL",
                action="ALLOW",
                reason_codes=["NO_SENSITIVE_PATTERN_DETECTED"],
                content_sha256=content_hash,
                redacted_content_sha256=None,
            )
        return released, safety

    def block_decision(self, reason_code: str) -> SafetyDecision:
        observed = "".join(self.raw_parts)
        return _decision(
            classification="RESTRICTED",
            action="BLOCK",
            reason_codes=[reason_code],
            content_sha256=hashlib.sha256(observed.encode("utf-8")).hexdigest(),
            redacted_content_sha256=None,
        )

    def _raise_if_blocked(self) -> None:
        if (
            _PRIVATE_KEY.search(self.pending)
            or _BEARER.search(self.pending)
            or _SECRET.search(self.pending)
        ):
            raise OutputSafetyBlockedError()
        possible_email = _possible_email(self.pending)
        if possible_email is not None and len(self.pending) - possible_email.start() > 320:
            raise OutputSafetyBlockedError("GENERATED_UNBOUNDED_PII_DETECTED")


def _safe_release_cutoff(content: str, cutoff: int) -> int:
    for pattern in (_EMAIL, _PHONE):
        for match in pattern.finditer(content):
            if match.start() < cutoff < match.end():
                cutoff = match.start()
    possible_email = _possible_email(content)
    if possible_email is not None and possible_email.start() < cutoff:
        if len(content) - possible_email.start() > 320:
            raise OutputSafetyBlockedError("GENERATED_UNBOUNDED_PII_DETECTED")
        cutoff = possible_email.start()
    # Preserve any dangerous prefix at the end of the window. This prevents a
    # long credential from leaking its prefix before it reaches the blocking
    # detector's minimum token length.
    for pattern in (
        re.compile(r"\bBearer\s+[A-Za-z0-9._~+/-]*={0,2}$", re.IGNORECASE),
        re.compile(
            r"\b(?:api[_ -]?key|secret|password|access[_ -]?token)"
            r"\s*[:=]\s*[\"']?[A-Za-z0-9._~+/-]*={0,2}$",
            re.IGNORECASE,
        ),
        re.compile(r"-----BEGIN [^\r\n]*$", re.IGNORECASE),
    ):
        match = pattern.search(content)
        if match is not None and match.start() < cutoff:
            if len(content) - match.start() > _OUTPUT_SAFETY_LOOKBEHIND:
                raise OutputSafetyBlockedError()
            cutoff = match.start()
    return cutoff


def _possible_email(content: str) -> re.Match[str] | None:
    return re.search(
        r"(?<![A-Z0-9._%+-])[A-Z0-9._%+-]+@[A-Z0-9.-]*$",
        content,
        re.IGNORECASE,
    )


def _redact(content: str) -> str:
    return _PHONE.sub("[REDACTED_PHONE]", _EMAIL.sub("[REDACTED_EMAIL]", content))


def _decision(
    *,
    classification: str,
    action: str,
    reason_codes: list[str],
    content_sha256: str,
    redacted_content_sha256: str | None,
) -> SafetyDecision:
    core = {
        "direction": "OUTPUT",
        "classification": classification,
        "action": action,
        "reason_codes": reason_codes,
        "content_sha256": content_sha256,
        "redacted_content_sha256": redacted_content_sha256,
        "detector_version": "deterministic-output-guard-v1",
    }
    canonical = json.dumps(core, sort_keys=True, separators=(",", ":"))
    return SafetyDecision(
        **core,
        decision_hash=hashlib.sha256(canonical.encode("utf-8")).hexdigest(),
    )
