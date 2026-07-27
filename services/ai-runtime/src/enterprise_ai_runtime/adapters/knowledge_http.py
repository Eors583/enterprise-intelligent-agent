from __future__ import annotations

import math
from typing import Any

from enterprise_ai_runtime.domain.errors import (
    ProviderAuthenticationError,
    ProviderRateLimitError,
    ProviderRequestError,
    ProviderTimeoutError,
    ProviderUnavailableError,
)


def raise_for_provider_status(status_code: int) -> None:
    if status_code < 300:
        return
    if status_code in {401, 403}:
        raise ProviderAuthenticationError()
    if status_code == 408:
        raise ProviderTimeoutError()
    if status_code == 429:
        raise ProviderRateLimitError()
    if status_code >= 500:
        raise ProviderUnavailableError()
    raise ProviderRequestError()


def finite_float(value: Any) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise TypeError("value must be numeric")
    parsed = float(value)
    if not math.isfinite(parsed):
        raise ValueError("value must be finite")
    return parsed


def non_negative_int(value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise TypeError("value must be a non-negative integer")
    return value
