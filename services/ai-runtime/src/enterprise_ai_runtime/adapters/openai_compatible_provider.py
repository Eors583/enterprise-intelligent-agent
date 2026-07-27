from __future__ import annotations

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
from enterprise_ai_runtime.ports.provider import ProviderCompletionRequest


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
        self._client = client if client is not None else httpx.AsyncClient()
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
        }
        try:
            response = await self._client.post(
                self._endpoint,
                json=payload,
                headers=headers,
                timeout=httpx.Timeout(request.timeout_ms / 1_000),
            )
        except httpx.TimeoutException as error:
            raise ProviderTimeoutError() from error
        except httpx.TransportError as error:
            raise ProviderUnavailableError() from error

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
                _non_negative_int(usage_values["prompt_tokens"])
                if tokens_reported
                else 0
            )
            output_tokens = (
                _non_negative_int(usage_values["completion_tokens"])
                if tokens_reported
                else 0
            )
            total_tokens = (
                _non_negative_int(usage_values["total_tokens"])
                if tokens_reported
                else 0
            )
            if tokens_reported and (
                total_tokens < input_tokens + output_tokens
                or total_tokens == 0
                or input_tokens + output_tokens == 0
            ):
                raise ValueError("reported token usage is inconsistent with a successful response")
            cost_reported = "cost_micros" in usage_values
            cost_micros = (
                _non_negative_int(usage_values["cost_micros"])
                if cost_reported
                else 0
            )
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
