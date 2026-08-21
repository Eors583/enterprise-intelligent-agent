from __future__ import annotations

import asyncio
import json
import logging
import math
import random
from collections.abc import Awaitable, Callable
from datetime import datetime
from typing import Any
from uuid import UUID

import httpx
from pydantic import ValidationError

from enterprise_ai_runtime.adapters.provider_readiness import ProviderReadinessEvidence
from enterprise_ai_runtime.domain.errors import (
    ProviderAuthenticationError,
    ProviderInteractionRequiredError,
    ProviderRateLimitError,
    ProviderRequestError,
    ProviderResponseError,
    ProviderTaskError,
    ProviderTimeoutError,
    ProviderUnavailableError,
    RuntimeExecutionError,
)
from enterprise_ai_runtime.domain.models import RunExecutionResult, RunOutput, RunUsage
from enterprise_ai_runtime.ports.provider import ProviderCompletionRequest

Sleep = Callable[[float], Awaitable[None]]
RandomValue = Callable[[], float]

logger = logging.getLogger(__name__)


class ManusProvider:
    """Manus API v2 adapter using one isolated remote task for every platform Run."""

    def __init__(
        self,
        *,
        base_url: str,
        api_key: str,
        project_id: str | None = None,
        poll_interval_seconds: float = 2.0,
        max_wait_seconds: float = 300.0,
        proxy_url: str | None = None,
        client: httpx.AsyncClient | None = None,
        sleep: Sleep = asyncio.sleep,
        random_value: RandomValue = random.random,
        max_rate_limit_retries: int = 3,
        max_incomplete_response_retries: int = 4,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._api_key = api_key
        self._project_id = project_id
        self._poll_interval_seconds = poll_interval_seconds
        self._max_wait_seconds = max_wait_seconds
        self._client = (
            client if client is not None else httpx.AsyncClient(proxy=proxy_url, trust_env=False)
        )
        self._sleep = sleep
        self._random_value = random_value
        self._max_rate_limit_retries = max_rate_limit_retries
        self._max_incomplete_response_retries = max(0, max_incomplete_response_retries)
        self._readiness = ProviderReadinessEvidence()
        self._task_ids: dict[UUID, str] = {}
        self._task_ids_lock = asyncio.Lock()
        self._closed = False

    async def complete(self, request: ProviderCompletionRequest) -> RunExecutionResult:
        task_id: str | None = None
        try:
            task_id = await self._create_task(request)
            async with self._task_ids_lock:
                self._task_ids[request.run_id] = task_id
            # Manus tasks are asynchronous and can legitimately outlive the former
            # five-minute Run budget. Once Manus returns a task id, continue polling
            # until a terminal provider state or an explicit user cancellation.
            return await self._wait_for_result(task_id, request)
        except asyncio.CancelledError:
            await self._stop_after_interruption(task_id)
            raise
        except RuntimeExecutionError:
            await self._stop_after_interruption(task_id)
            raise
        finally:
            if task_id is not None:
                async with self._task_ids_lock:
                    if self._task_ids.get(request.run_id) == task_id:
                        self._task_ids.pop(request.run_id, None)

    async def cancel(self, run_id: UUID) -> bool:
        async with self._task_ids_lock:
            task_id = self._task_ids.get(run_id)
        if task_id is None or self._closed:
            return False

        try:
            async with asyncio.timeout(5.0):
                await self._request_json(
                    "POST",
                    "/v2/task.stop",
                    json_body={"task_id": task_id},
                )
                for attempt in range(5):
                    body = await self._request_json(
                        "GET",
                        "/v2/task.listMessages",
                        params={
                            "task_id": task_id,
                            "order": "desc",
                            "limit": "200",
                            "verbose": "false",
                        },
                    )
                    _validate_task_read_envelope(body, task_id)
                    status = _latest_status(_events(body))
                    if status in {"stopped", "error"}:
                        return True
                    if attempt < 4:
                        await self._sleep(min(self._poll_interval_seconds, 1.0))
        except (TimeoutError, RuntimeExecutionError):
            return False
        return False

    async def is_ready(self) -> bool:
        if self._closed:
            return False
        # `task.list` authenticates the configured API key without starting a
        # paid model task. Cache the result so readiness polling does not
        # amplify provider traffic or consume the endpoint rate limit.
        return await self._readiness.resolve(self._probe_readiness)

    async def _probe_readiness(self) -> None:
        body = await self._request_json(
            "GET",
            "/v2/task.list",
            params={"limit": "1", "order": "desc"},
        )
        _required_string(body, "request_id")
        tasks = body.get("data")
        has_more = body.get("has_more")
        if (
            not isinstance(tasks, list)
            or any(not isinstance(task, dict) for task in tasks)
            or not isinstance(has_more, bool)
        ):
            raise ProviderResponseError()
        if has_more and not isinstance(body.get("next_cursor"), str):
            raise ProviderResponseError()
        for task in tasks:
            if (
                not isinstance(task.get("id"), str)
                or not task["id"]
                or task.get("status") not in {"running", "stopped", "waiting", "error"}
            ):
                raise ProviderResponseError()

    async def aclose(self) -> None:
        if not self._closed:
            self._closed = True
            await self._client.aclose()

    async def _create_task(self, request: ProviderCompletionRequest) -> str:
        payload: dict[str, Any] = {
            # An omitted connector list inherits the Manus account/project defaults.
            # Enterprise chat runs must not silently gain access to account connectors.
            "message": {
                "content": [{"type": "text", "text": _render_messages(request)}],
                "connectors": [],
            },
            "interactive_mode": False,
            "hide_in_task_list": True,
            "share_visibility": "private",
            "agent_profile": request.model,
            "locale": "zh-CN",
            "title": f"enterprise-run-{request.run_id}",
        }
        if self._project_id is not None:
            payload["project_id"] = self._project_id

        body = await self._request_json("POST", "/v2/task.create", json_body=payload)
        _required_string(body, "request_id")
        return _required_string(body, "task_id")

    async def _wait_for_result(
        self,
        task_id: str,
        request: ProviderCompletionRequest,
    ) -> RunExecutionResult:
        incomplete_response_attempts = 0
        transient_read_attempts = 0
        while True:
            try:
                body = await self._request_json(
                    "GET",
                    "/v2/task.listMessages",
                    params={
                        "task_id": task_id,
                        "order": "desc",
                        "limit": "200",
                        "verbose": "false",
                    },
                )
                _validate_task_read_envelope(body, task_id)
            except (ProviderTimeoutError, ProviderUnavailableError, ProviderRateLimitError):
                delay = min(30.0, self._poll_interval_seconds * (2**transient_read_attempts))
                transient_read_attempts = min(transient_read_attempts + 1, 4)
                logger.warning(
                    "manus_task_read_transient outcome=retry delay_seconds=%.2f",
                    delay,
                )
                await self._sleep(delay)
                continue
            except ProviderResponseError:
                incomplete_response_attempts = await self._retry_incomplete_response(
                    stage="response_envelope",
                    previous_attempts=incomplete_response_attempts,
                )
                continue

            transient_read_attempts = 0

            try:
                events = _events(body)
            except ProviderResponseError:
                incomplete_response_attempts = await self._retry_incomplete_response(
                    stage="messages",
                    previous_attempts=incomplete_response_attempts,
                )
                continue

            try:
                status = _latest_status(events)
            except ProviderResponseError:
                incomplete_response_attempts = await self._retry_incomplete_response(
                    stage="status",
                    previous_attempts=incomplete_response_attempts,
                )
                continue

            if status == "stopped":
                try:
                    result = _terminal_assistant_result(events, task_id, request.model)
                except ProviderResponseError:
                    incomplete_response_attempts = await self._retry_incomplete_response(
                        stage="assistant_message",
                        previous_attempts=incomplete_response_attempts,
                    )
                    continue
                return result
            elif status == "waiting":
                raise ProviderInteractionRequiredError()
            elif status == "error":
                raise ProviderTaskError()
            elif status not in {None, "running"}:
                incomplete_response_attempts = await self._retry_incomplete_response(
                    stage="status_value",
                    previous_attempts=incomplete_response_attempts,
                )
                continue

            # A structurally valid poll proves the task read endpoint is coherent again.
            # Only consecutive incomplete responses consume this retry budget.
            incomplete_response_attempts = 0
            await self._sleep(self._poll_interval_seconds)

    async def _retry_incomplete_response(
        self,
        *,
        stage: str,
        previous_attempts: int,
    ) -> int:
        attempt = previous_attempts + 1
        max_attempts = self._max_incomplete_response_retries + 1
        if attempt >= max_attempts:
            logger.warning(
                "manus_task_read_invalid stage=%s outcome=exhausted attempts=%d",
                stage,
                attempt,
            )
            raise ProviderResponseError() from None

        delay = _task_visibility_retry_delay(previous_attempts)
        logger.warning(
            "manus_task_read_invalid stage=%s outcome=retry attempt=%d max_attempts=%d "
            "delay_seconds=%.2f",
            stage,
            attempt,
            max_attempts,
            delay,
        )
        await self._sleep(delay)
        return attempt

    async def _request_json(
        self,
        method: str,
        path: str,
        *,
        json_body: dict[str, Any] | None = None,
        params: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        rate_limit_attempts = 0
        task_visibility_attempts = 0
        while True:
            try:
                # task.create has no provider idempotency key. A client-side timeout could
                # leave a paid remote task running without returning its task id, so wait
                # for a definite response or caller cancellation instead of guessing and
                # creating a duplicate task. Poll/read calls remain individually bounded;
                # their transient failures are retried against the same task id.
                request_timeout = (
                    None
                    if path == "/v2/task.create"
                    else httpx.Timeout(min(30.0, self._max_wait_seconds))
                )
                response = await self._client.request(
                    method,
                    f"{self._base_url}{path}",
                    json=json_body,
                    params=params,
                    headers=self._headers(),
                    timeout=request_timeout,
                )
            except httpx.TimeoutException:
                # The HTTP exception retains its request object, including secret headers.
                raise ProviderTimeoutError() from None
            except httpx.TransportError:
                raise ProviderUnavailableError() from None

            if response.status_code == 429:
                if rate_limit_attempts >= self._max_rate_limit_retries:
                    raise ProviderRateLimitError()
                await self._sleep(_retry_delay(response, rate_limit_attempts, self._random_value))
                rate_limit_attempts += 1
                continue

            # A freshly-created Manus task can briefly be absent from the event-read
            # replica. Retrying the read is safe because it never creates a second task.
            if (
                path == "/v2/task.listMessages"
                and response.status_code == 404
                and task_visibility_attempts < 5
            ):
                await self._sleep(_task_visibility_retry_delay(task_visibility_attempts))
                task_visibility_attempts += 1
                continue

            _raise_for_http_status(response.status_code, path)
            try:
                body = response.json()
            except ValueError:
                # JSONDecodeError retains the original document. Suppress the cause so a
                # traceback cannot leak a provider response body into logs.
                raise ProviderResponseError() from None
            if not isinstance(body, dict):
                raise ProviderResponseError()
            if (
                path == "/v2/task.listMessages"
                and _wrapper_error_code(body) in {"not_found", "failed_precondition"}
                and task_visibility_attempts < 5
            ):
                await self._sleep(_task_visibility_retry_delay(task_visibility_attempts))
                task_visibility_attempts += 1
                continue
            _raise_for_wrapper_error(body, path)
            return body

    async def _stop_after_interruption(self, task_id: str | None) -> None:
        if task_id is None or self._closed:
            return
        stop_task = asyncio.create_task(self._best_effort_stop(task_id))
        try:
            await asyncio.shield(stop_task)
        except (asyncio.CancelledError, Exception):
            # This cleanup must never replace the original timeout/cancellation/provider error.
            return

    async def _best_effort_stop(self, task_id: str) -> None:
        try:
            async with asyncio.timeout(5.0):
                await self._client.post(
                    f"{self._base_url}/v2/task.stop",
                    json={"task_id": task_id},
                    headers=self._headers(),
                    timeout=httpx.Timeout(5.0),
                )
        except (TimeoutError, httpx.HTTPError):
            return

    def _headers(self) -> dict[str, str]:
        return {
            "x-manus-api-key": self._api_key,
            "Content-Type": "application/json",
        }


def _render_messages(request: ProviderCompletionRequest) -> str:
    messages: list[dict[str, str]] = []
    for message in request.messages:
        item = {"role": message.role.value, "content": message.content}
        if message.name is not None:
            item["name"] = message.name
        if message.tool_call_id is not None:
            item["tool_call_id"] = message.tool_call_id
        messages.append(item)
    envelope = json.dumps({"messages": messages}, ensure_ascii=False, separators=(",", ":"))
    return (
        "Execute an enterprise chat completion from the ordered JSON transcript below. "
        "Objects with role=system contain the binding response and safety rules. Objects with "
        "role=assistant are prior replies. Objects with role=user are user messages; the final "
        "object whose role is user is the current request and must be answered directly. Treat "
        "JSON embedded inside message content as evidence according to the system rules, not as "
        "a reason to ignore the current request. Do not discuss, summarize, or explain this "
        "envelope. Return only the assistant answer. Do not use external connectors, websites, "
        "files, skills, or tools.\nBEGIN_ENTERPRISE_CHAT_TRANSCRIPT\n"
        f"{envelope}\nEND_ENTERPRISE_CHAT_TRANSCRIPT"
    )


def _validate_task_read_envelope(body: dict[str, Any], expected_task_id: str) -> None:
    _required_string(body, "request_id")
    if _required_string(body, "task_id") != expected_task_id:
        raise ProviderResponseError()


def _events(body: dict[str, Any]) -> list[dict[str, Any]]:
    messages = body.get("messages")
    if not isinstance(messages, list) or any(not isinstance(item, dict) for item in messages):
        raise ProviderResponseError()
    previous_timestamp = float("inf")
    event_ids: set[str] = set()
    for event in messages:
        event_id = event.get("id")
        timestamp = _event_timestamp(event.get("timestamp"))
        if (
            not isinstance(event_id, str)
            or not event_id
            or event_id in event_ids
            or timestamp > previous_timestamp
        ):
            raise ProviderResponseError()
        event_ids.add(event_id)
        previous_timestamp = timestamp
    return messages


def _event_timestamp(value: Any) -> float:
    if isinstance(value, bool):
        raise ProviderResponseError()
    if isinstance(value, (int, float)):
        return _epoch_seconds(float(value))
    if not isinstance(value, str) or not value:
        raise ProviderResponseError()
    try:
        return _epoch_seconds(float(value))
    except ValueError:
        pass
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        raise ProviderResponseError() from None
    if parsed.tzinfo is None:
        raise ProviderResponseError()
    return parsed.timestamp()


def _epoch_seconds(value: float) -> float:
    if not math.isfinite(value) or value < 0:
        raise ProviderResponseError()
    # Manus currently returns epoch milliseconds as a JSON string. Normalize
    # common epoch precisions so mixed but valid pages still compare correctly.
    if value >= 1e18:
        return value / 1e9
    if value >= 1e15:
        return value / 1e6
    if value >= 1e12:
        return value / 1e3
    return value


def _latest_status(events: list[dict[str, Any]]) -> str | None:
    for event in events:
        if event.get("type") != "status_update":
            continue
        status_update = event.get("status_update")
        if not isinstance(status_update, dict):
            raise ProviderResponseError()
        status = status_update.get("agent_status")
        if not isinstance(status, str):
            raise ProviderResponseError()
        return status
    return None


def _terminal_assistant_result(
    events: list[dict[str, Any]],
    task_id: str,
    model: str,
) -> RunExecutionResult:
    terminal_index = next(
        (index for index, event in enumerate(events) if event.get("type") == "status_update"),
        None,
    )
    if terminal_index is None:
        raise ProviderResponseError()
    terminal = events[terminal_index]
    status_update = terminal.get("status_update")
    if not isinstance(status_update, dict) or status_update.get("agent_status") != "stopped":
        raise ProviderResponseError()
    # `order=desc` guarantees the first assistant after the latest terminal status is
    # the final answer for this newly-created task. An assistant newer than the terminal
    # status would indicate a stale or incoherent event page and must not be accepted.
    if any(event.get("type") == "assistant_message" for event in events[:terminal_index]):
        raise ProviderResponseError()
    assistant = next(
        (
            event
            for event in events[terminal_index + 1 :]
            if event.get("type") == "assistant_message"
        ),
        None,
    )
    if assistant is None:
        raise ProviderResponseError()
    assistant_message = assistant.get("assistant_message")
    if not isinstance(assistant_message, dict):
        raise ProviderResponseError()
    answer = assistant_message.get("content")
    if not isinstance(answer, str) or not answer.strip():
        raise ProviderResponseError()
    try:
        return RunExecutionResult(
            output=RunOutput(
                content=answer,
                finish_reason="stop",
                model=model,
                provider="manus",
                response_id=_required_string(assistant, "id") or task_id,
            ),
            # Manus reports account credits rather than token counts or currency micros.
            # Keep these values explicitly unknown/zero until the platform gains a provider-
            # specific usage model; do not invent token or monetary measurements.
            usage=RunUsage(
                input_tokens=0,
                output_tokens=0,
                total_tokens=0,
                tool_calls=0,
                cost_micros=0,
                tokens_reported=False,
                cost_reported=False,
            ),
        )
    except ValidationError:
        # Pydantic validation errors include rejected input values; suppress them at the
        # provider boundary so generated content cannot be copied into exception logs.
        raise ProviderResponseError() from None


def _required_string(body: dict[str, Any], key: str) -> str:
    value = body.get(key)
    if not isinstance(value, str) or not value:
        raise ProviderResponseError()
    return value


def _raise_for_wrapper_error(body: dict[str, Any], path: str) -> None:
    ok = body.get("ok")
    if ok is True:
        return
    if ok is not False:
        raise ProviderResponseError()
    error = body.get("error")
    if not isinstance(error, dict) or not isinstance(error.get("code"), str):
        raise ProviderResponseError()
    code = error["code"].lower()
    if code in {"permission_denied", "unauthenticated"}:
        raise ProviderAuthenticationError()
    if code == "rate_limited":
        raise ProviderRateLimitError()
    if code in {"timeout", "deadline_exceeded"}:
        raise ProviderTimeoutError()
    if code in {"invalid_argument", "not_found", "failed_precondition"}:
        raise _request_rejected(path, code)
    if code in {"internal", "internal_error", "service_unavailable", "unavailable"}:
        raise ProviderUnavailableError()
    raise ProviderResponseError()


def _wrapper_error_code(body: dict[str, Any]) -> str | None:
    if body.get("ok") is not False:
        return None
    error = body.get("error")
    if not isinstance(error, dict):
        return None
    code = error.get("code")
    return code.lower() if isinstance(code, str) else None


def _raise_for_http_status(status_code: int, path: str) -> None:
    if status_code < 400:
        return
    if status_code in {401, 403}:
        raise ProviderAuthenticationError()
    if status_code == 408:
        raise ProviderTimeoutError()
    if status_code == 429:
        raise ProviderRateLimitError()
    if 400 <= status_code < 500:
        category = {
            400: "invalid_argument",
            404: "not_found",
            409: "failed_precondition",
            422: "invalid_argument",
        }.get(status_code, "rejected")
        raise _request_rejected(path, category)
    if status_code >= 500:
        raise ProviderUnavailableError()
    raise ProviderResponseError()


def _request_rejected(path: str, category: str) -> ProviderRequestError:
    if path != "/v2/task.create":
        return ProviderRequestError()
    if category == "invalid_argument":
        return ProviderRequestError(
            "MANUS_TASK_CREATE_INVALID_ARGUMENT",
            "Manus rejected the task creation input",
        )
    if category == "not_found":
        return ProviderRequestError(
            "MANUS_TASK_CREATE_TARGET_NOT_FOUND",
            "Manus could not find the configured project or model target",
        )
    if category == "failed_precondition":
        return ProviderRequestError(
            "MANUS_TASK_CREATE_PRECONDITION_FAILED",
            "Manus rejected a task creation precondition",
        )
    return ProviderRequestError(
        "MANUS_TASK_CREATE_REJECTED",
        "Manus rejected the task creation request",
    )


def _retry_delay(
    response: httpx.Response,
    attempt: int,
    random_value: RandomValue,
) -> float:
    retry_after = response.headers.get("Retry-After")
    base_delay: float
    try:
        base_delay = float(retry_after) if retry_after is not None else 2.0**attempt
    except ValueError:
        base_delay = 2.0**attempt
    base_delay = min(max(base_delay, 0.0), 30.0)
    jitter = min(max(random_value(), 0.0), 1.0) * min(base_delay * 0.2, 1.0)
    return base_delay + jitter


def _task_visibility_retry_delay(attempt: int) -> float:
    return min(0.25 * (2**attempt), 2.0)
