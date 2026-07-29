from __future__ import annotations

import json
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any
from uuid import UUID

import httpx
from pydantic import ValidationError

from enterprise_ai_runtime.domain.errors import (
    ProviderAuthenticationError,
    ProviderRateLimitError,
    ProviderRequestError,
    ProviderResponseError,
    ProviderTimeoutError,
    ProviderUnavailableError,
)
from enterprise_ai_runtime.domain.models import (
    RunExecutionResult,
    RunOutput,
    RunUsage,
)
from enterprise_ai_runtime.ports.provider import (
    ProviderCompletionRequest,
    ProviderStreamDelta,
    ProviderStreamEvent,
    ProviderStreamTerminal,
)

MAX_SSE_EVENT_BYTES = 65_536
MAX_SSE_WIRE_BYTES = 8_388_608
MAX_STREAM_DELTA_BYTES = 16_384
MAX_STREAM_OUTPUT_BYTES = 1_000_000
MAX_STREAM_EVENTS = 10_000


class OpenAICompatibleProvider:
    """Minimal non-streaming `/chat/completions` adapter.

    The API key is intentionally never included in exceptions, object reprs, or logs.
    """

    def __init__(
        self,
        *,
        base_url: str,
        api_key: str,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self._endpoint = f"{base_url.rstrip('/')}/chat/completions"
        self._api_key = api_key
        self._client = client if client is not None else httpx.AsyncClient(trust_env=False)
        self._closed = False

    async def complete(self, request: ProviderCompletionRequest) -> RunExecutionResult:
        payload = {
            "model": request.model,
            "messages": [_message_payload(message) for message in request.messages],
            "max_tokens": request.max_output_tokens,
            "stream": False,
        }
        headers = {
            "Authorization": f"Bearer {self._api_key}",
            "Content-Type": "application/json",
            "X-Request-ID": request.request_id,
            "X-Correlation-ID": request.request_id,
        }
        try:
            response = await self._client.post(
                self._endpoint,
                json=payload,
                headers=headers,
                timeout=httpx.Timeout(request.timeout_ms / 1_000),
            )
        except httpx.TimeoutException:
            raise ProviderTimeoutError() from None
        except httpx.TransportError:
            raise ProviderUnavailableError() from None

        _raise_for_provider_status(response.status_code)
        try:
            body = response.json()
            choice = _first_choice(body)
            message = choice["message"]
            content = _content_text(message.get("content"))
            finish_reason = choice.get("finish_reason") or "unknown"
            usage_body = body.get("usage")
            if usage_body is not None and not isinstance(usage_body, dict):
                raise TypeError("usage must be an object")
            usage_values = usage_body if isinstance(usage_body, dict) else {}
            tokens_reported = all(
                key in usage_values
                for key in ("prompt_tokens", "completion_tokens", "total_tokens")
            )
            input_tokens = (
                _non_negative_int(usage_values["prompt_tokens"]) if tokens_reported else 0
            )
            output_tokens = (
                _non_negative_int(usage_values["completion_tokens"]) if tokens_reported else 0
            )
            total_tokens = _non_negative_int(usage_values["total_tokens"]) if tokens_reported else 0
            if tokens_reported and (
                total_tokens < input_tokens + output_tokens
                or total_tokens == 0
                or input_tokens + output_tokens == 0
            ):
                raise ValueError("reported token usage is inconsistent with a successful response")
            cost_reported = "cost_micros" in usage_values
            cost_micros = _non_negative_int(usage_values["cost_micros"]) if cost_reported else 0
            tool_calls = message.get("tool_calls") or []
            if not isinstance(tool_calls, list):
                raise TypeError("tool_calls must be a list")

            return RunExecutionResult(
                output=RunOutput(
                    content=content,
                    finish_reason=str(finish_reason),
                    model=str(body.get("model") or request.model),
                    provider="openai_compatible",
                    response_id=_optional_string(body.get("id")),
                ),
                usage=RunUsage(
                    input_tokens=input_tokens,
                    output_tokens=output_tokens,
                    total_tokens=total_tokens,
                    tool_calls=len(tool_calls),
                    cost_micros=cost_micros,
                    tokens_reported=tokens_reported,
                    cost_reported=cost_reported,
                ),
            )
        except (KeyError, TypeError, ValueError, ValidationError) as error:
            raise ProviderResponseError() from error

    async def stream(
        self,
        request: ProviderCompletionRequest,
    ) -> AsyncIterator[ProviderStreamEvent]:
        """Execute one bounded OpenAI-compatible SSE completion.

        The decoder accepts only comment and ``data`` fields, validates every
        JSON envelope, requires a finish reason, a final ``[DONE]`` marker, and
        trustworthy token usage. Provider bodies and credentials are never
        copied into an exception.
        """

        payload = {
            "model": request.model,
            "messages": [_message_payload(message) for message in request.messages],
            "max_tokens": request.max_output_tokens,
            "stream": True,
            "stream_options": {"include_usage": True},
        }
        headers = {
            "Authorization": f"Bearer {self._api_key}",
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
            "X-Request-ID": request.request_id,
            "X-Correlation-ID": request.request_id,
        }
        decoder = _StrictSSEDecoder()
        state = _OpenAIStreamState(request=request)
        try:
            async with self._client.stream(
                "POST",
                self._endpoint,
                json=payload,
                headers=headers,
                timeout=httpx.Timeout(request.timeout_ms / 1_000),
            ) as response:
                _raise_for_provider_status(response.status_code)
                content_type = response.headers.get("content-type", "").split(";", 1)[0].strip()
                if content_type.lower() != "text/event-stream":
                    raise ProviderResponseError()

                async for chunk in response.aiter_raw():
                    for data in decoder.feed(chunk):
                        delta = state.accept(data)
                        if delta is not None:
                            yield ProviderStreamDelta(content=delta)
                for data in decoder.finish():
                    delta = state.accept(data)
                    if delta is not None:
                        yield ProviderStreamDelta(content=delta)
                yield ProviderStreamTerminal(result=state.result(), mode="live")
        except (
            ProviderAuthenticationError,
            ProviderRateLimitError,
            ProviderRequestError,
            ProviderResponseError,
            ProviderTimeoutError,
            ProviderUnavailableError,
        ):
            raise
        except httpx.TimeoutException:
            raise ProviderTimeoutError() from None
        except httpx.TransportError:
            raise ProviderUnavailableError() from None
        except (UnicodeDecodeError, json.JSONDecodeError, KeyError, TypeError, ValueError) as error:
            raise ProviderResponseError() from error

    async def is_ready(self) -> bool:
        # Readiness verifies local configuration/lifecycle without a paid network call.
        return not self._closed

    async def cancel(self, run_id: UUID) -> bool:
        # The generic chat-completions protocol has no status/cancel resource.
        # Closing a client request does not prove that upstream generation stopped.
        return False

    async def aclose(self) -> None:
        if not self._closed:
            self._closed = True
            await self._client.aclose()


def _message_payload(message: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {"role": message.role.value, "content": message.content}
    if message.name is not None:
        payload["name"] = message.name
    if message.tool_call_id is not None:
        payload["tool_call_id"] = message.tool_call_id
    return payload


def _raise_for_provider_status(status_code: int) -> None:
    if status_code < 400:
        return
    if status_code in {401, 403}:
        raise ProviderAuthenticationError()
    if status_code == 408:
        raise ProviderTimeoutError()
    if status_code == 429:
        raise ProviderRateLimitError()
    if status_code in {400, 404, 405, 409, 422}:
        raise ProviderRequestError()
    if status_code >= 500:
        raise ProviderUnavailableError()
    raise ProviderRequestError()


def _first_choice(body: Any) -> dict[str, Any]:
    if not isinstance(body, dict):
        raise TypeError("response body must be an object")
    choices = body.get("choices")
    if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
        raise TypeError("response choices are missing")
    message = choices[0].get("message")
    if not isinstance(message, dict):
        raise TypeError("response message is missing")
    return choices[0]


def _content_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for part in content:
            if not isinstance(part, dict) or not isinstance(part.get("text"), str):
                raise TypeError("unsupported structured content")
            parts.append(part["text"])
        return "".join(parts)
    raise TypeError("response content must be text")


def _non_negative_int(value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise TypeError("usage value must be a non-negative integer")
    return value


def _optional_string(value: Any) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or not value:
        raise TypeError("response id must be text")
    return value


@dataclass(slots=True)
class _StrictSSEDecoder:
    buffer: bytearray = field(default_factory=bytearray)
    data_lines: list[bytes] = field(default_factory=list)
    event_bytes: int = 0
    wire_bytes: int = 0

    def feed(self, chunk: bytes) -> list[bytes]:
        if not isinstance(chunk, bytes):
            raise TypeError("SSE chunks must be bytes")
        self.wire_bytes += len(chunk)
        if self.wire_bytes > MAX_SSE_WIRE_BYTES:
            raise ValueError("SSE response exceeds the wire limit")
        self.buffer.extend(chunk)
        events: list[bytes] = []
        while True:
            newline = self.buffer.find(b"\n")
            if newline < 0:
                if len(self.buffer) + self.event_bytes > MAX_SSE_EVENT_BYTES:
                    raise ValueError("SSE event exceeds the event limit")
                break
            line = bytes(self.buffer[:newline])
            del self.buffer[: newline + 1]
            if line.endswith(b"\r"):
                line = line[:-1]
            self.event_bytes += len(line) + 1
            if self.event_bytes > MAX_SSE_EVENT_BYTES:
                raise ValueError("SSE event exceeds the event limit")
            event = self._line(line)
            if event is not None:
                events.append(event)
        return events

    def finish(self) -> list[bytes]:
        if self.buffer:
            line = bytes(self.buffer)
            self.buffer.clear()
            if line.endswith(b"\r"):
                line = line[:-1]
            self.event_bytes += len(line)
            if self.event_bytes > MAX_SSE_EVENT_BYTES:
                raise ValueError("SSE event exceeds the event limit")
            event = self._line(line)
            if event is not None:
                return [event]
        if self.data_lines:
            raise ValueError("SSE response ended before the event delimiter")
        return []

    def _line(self, line: bytes) -> bytes | None:
        if line == b"":
            if not self.data_lines:
                self.event_bytes = 0
                return None
            event = b"\n".join(self.data_lines)
            self.data_lines.clear()
            self.event_bytes = 0
            return event
        if line.startswith(b":"):
            return None
        if not line.startswith(b"data:"):
            raise ValueError("unsupported SSE field")
        value = line[5:]
        if value.startswith(b" "):
            value = value[1:]
        self.data_lines.append(value)
        return None


@dataclass(slots=True)
class _OpenAIStreamState:
    request: ProviderCompletionRequest
    content_parts: list[str] = field(default_factory=list)
    output_bytes: int = 0
    event_count: int = 0
    delta_count: int = 0
    response_id: str | None = None
    model: str | None = None
    finish_reason: str | None = None
    usage: RunUsage | None = None
    done: bool = False

    def accept(self, data: bytes) -> str | None:
        self.event_count += 1
        if self.event_count > MAX_STREAM_EVENTS:
            raise ValueError("stream event limit exceeded")
        if data == b"[DONE]":
            if self.done:
                raise ValueError("duplicate stream terminator")
            self.done = True
            return None
        if self.done:
            raise ValueError("data followed the stream terminator")

        body = json.loads(data.decode("utf-8", errors="strict"))
        if not isinstance(body, dict):
            raise TypeError("stream envelope must be an object")
        self._identity(body)
        if "usage" in body and body["usage"] is not None:
            if self.usage is not None:
                raise ValueError("usage was reported more than once")
            self.usage = _strict_stream_usage(body["usage"])

        choices = body.get("choices")
        if not isinstance(choices, list):
            raise TypeError("stream choices must be a list")
        if not choices:
            if body.get("usage") is None:
                raise ValueError("an empty choices event must carry usage")
            return None
        if len(choices) != 1 or not isinstance(choices[0], dict):
            raise TypeError("stream must contain exactly one choice")
        choice = choices[0]
        if choice.get("index", 0) != 0:
            raise ValueError("stream choice index must be zero")
        delta = choice.get("delta")
        if not isinstance(delta, dict):
            raise TypeError("stream delta must be an object")
        if delta.get("tool_calls") not in (None, []):
            raise TypeError("streamed tool calls are unsupported")
        content = delta.get("content")
        if content is not None and not isinstance(content, str):
            raise TypeError("stream delta content must be text")
        finish_reason = choice.get("finish_reason")
        if finish_reason is not None:
            if (
                not isinstance(finish_reason, str)
                or not 1 <= len(finish_reason) <= 128
                or (self.finish_reason is not None and self.finish_reason != finish_reason)
            ):
                raise ValueError("invalid stream finish reason")
            self.finish_reason = finish_reason
        if not content:
            return None
        encoded = content.encode("utf-8")
        if len(encoded) > MAX_STREAM_DELTA_BYTES:
            raise ValueError("stream delta exceeds the delta limit")
        self.delta_count += 1
        if self.delta_count >= MAX_STREAM_EVENTS:
            raise ValueError("stream delta count leaves no terminal event")
        self.output_bytes += len(encoded)
        if self.output_bytes > MAX_STREAM_OUTPUT_BYTES:
            raise ValueError("stream output exceeds the output limit")
        self.content_parts.append(content)
        return content

    def result(self) -> RunExecutionResult:
        if (
            not self.done
            or self.finish_reason is None
            or self.usage is None
            or self.response_id is None
            or self.model is None
        ):
            raise ValueError("stream ended without terminal metadata and usage")
        return RunExecutionResult(
            output=RunOutput(
                content="".join(self.content_parts),
                finish_reason=self.finish_reason,
                model=self.model,
                provider="openai_compatible",
                response_id=self.response_id,
            ),
            usage=self.usage,
        )

    def _identity(self, body: dict[str, Any]) -> None:
        response_id = body.get("id")
        model = body.get("model")
        if response_id is not None:
            if not isinstance(response_id, str) or not 1 <= len(response_id) <= 256:
                raise TypeError("stream response id is invalid")
            if self.response_id is not None and response_id != self.response_id:
                raise ValueError("stream response id changed")
            self.response_id = response_id
        if model is not None:
            if not isinstance(model, str) or not 1 <= len(model) <= 256:
                raise TypeError("stream model is invalid")
            if self.model is not None and model != self.model:
                raise ValueError("stream model changed")
            self.model = model


def _strict_stream_usage(value: Any) -> RunUsage:
    if not isinstance(value, dict):
        raise TypeError("stream usage must be an object")
    input_tokens = _non_negative_int(value["prompt_tokens"])
    output_tokens = _non_negative_int(value["completion_tokens"])
    total_tokens = _non_negative_int(value["total_tokens"])
    if (
        total_tokens < input_tokens + output_tokens
        or total_tokens == 0
        or input_tokens + output_tokens == 0
    ):
        raise ValueError("stream usage is inconsistent")
    cost_reported = "cost_micros" in value
    cost_micros = _non_negative_int(value["cost_micros"]) if cost_reported else 0
    return RunUsage(
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        total_tokens=total_tokens,
        tool_calls=0,
        cost_micros=cost_micros,
        tokens_reported=True,
        cost_reported=cost_reported,
    )
