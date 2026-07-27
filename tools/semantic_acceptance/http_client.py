from __future__ import annotations

import json
import ipaddress
import re
import ssl
import urllib.error
import urllib.request
from typing import Any
from urllib.parse import urlsplit

ENV_NAME_PATTERN = re.compile(r"^[A-Z_][A-Z0-9_]*$")
MAX_RESPONSE_BYTES = 10 * 1024 * 1024


class AcceptanceHttpError(RuntimeError):
    def __init__(
        self, message: str, *, status: int | None = None, request_id: str | None = None
    ):
        super().__init__(message)
        self.status = status
        self.request_id = request_id


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[no-untyped-def]
        del req, fp, code, msg, headers, newurl
        return None


class JsonHttpClient:
    def __init__(
        self, base_url: str, *, timeout_seconds: float, bearer_token: str | None
    ):
        self._base_url = validate_base_url(base_url)
        if not 0.1 <= timeout_seconds <= 300:
            raise ValueError("timeout must be between 0.1 and 300 seconds")
        self._timeout_seconds = timeout_seconds
        self._bearer_token = bearer_token
        self._opener = urllib.request.build_opener(
            _NoRedirectHandler(),
            urllib.request.HTTPSHandler(context=ssl.create_default_context()),
        )

    @property
    def safe_base_url(self) -> str:
        return self._base_url

    def get(self, path: str, *, headers: dict[str, str] | None = None) -> Any:
        return self._request("GET", path, body=None, headers=headers)

    def post(
        self,
        path: str,
        body: dict[str, Any],
        *,
        headers: dict[str, str] | None = None,
    ) -> Any:
        return self._request("POST", path, body=body, headers=headers)

    def _request(
        self,
        method: str,
        path: str,
        *,
        body: dict[str, Any] | None,
        headers: dict[str, str] | None,
    ) -> Any:
        if not path.startswith("/") or path.startswith("//"):
            raise ValueError("request path must be an absolute application path")
        url = f"{self._base_url}{path}"
        request_headers = {
            "Accept": "application/json",
            "User-Agent": "enterprise-semantic-acceptance/1.0",
            **(headers or {}),
        }
        payload = None
        if body is not None:
            request_headers["Content-Type"] = "application/json"
            payload = json.dumps(body, ensure_ascii=False, allow_nan=False).encode(
                "utf-8"
            )
        if self._bearer_token:
            request_headers["Authorization"] = f"Bearer {self._bearer_token}"
        request = urllib.request.Request(
            url, data=payload, headers=request_headers, method=method
        )
        try:
            with self._opener.open(request, timeout=self._timeout_seconds) as response:
                raw = response.read(MAX_RESPONSE_BYTES + 1)
                if len(raw) > MAX_RESPONSE_BYTES:
                    raise AcceptanceHttpError(
                        "response exceeded the 10 MiB safety limit"
                    )
                return _parse_json(raw)
        except urllib.error.HTTPError as error:
            request_id = error.headers.get("X-Request-ID") if error.headers else None
            raise AcceptanceHttpError(
                f"{method} {path} returned HTTP {error.code}",
                status=error.code,
                request_id=request_id,
            ) from error
        except urllib.error.URLError as error:
            reason = type(error.reason).__name__
            raise AcceptanceHttpError(
                f"{method} {path} could not connect ({reason})"
            ) from error
        except TimeoutError as error:
            raise AcceptanceHttpError(f"{method} {path} timed out") from error


def validate_base_url(raw_url: str) -> str:
    candidate = raw_url.strip().rstrip("/")
    parsed = urlsplit(candidate)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("base URL must use http or https and include a host")
    if parsed.username or parsed.password:
        raise ValueError("credentials must not be embedded in a base URL")
    if parsed.query or parsed.fragment:
        raise ValueError("base URL must not contain a query or fragment")
    if parsed.scheme == "http" and not _is_loopback(parsed.hostname):
        raise ValueError("non-loopback acceptance targets must use HTTPS")
    return candidate


def validate_secret_env_name(name: str) -> str:
    if not ENV_NAME_PATTERN.fullmatch(name):
        raise ValueError(
            "secret environment variable names must use uppercase letters and digits"
        )
    return name


def _parse_json(raw: bytes) -> Any:
    try:
        return json.loads(
            raw.decode("utf-8"),
            object_pairs_hook=_object_without_duplicate_keys,
            parse_constant=lambda value: (_ for _ in ()).throw(
                ValueError(f"non-finite JSON number {value}")
            ),
        )
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
        raise AcceptanceHttpError("response was not strict UTF-8 JSON") from error


def _is_loopback(hostname: str) -> bool:
    if hostname.lower() == "localhost":
        return True
    try:
        return ipaddress.ip_address(hostname).is_loopback
    except ValueError:
        return False


def _object_without_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate JSON object key {key!r}")
        result[key] = value
    return result
