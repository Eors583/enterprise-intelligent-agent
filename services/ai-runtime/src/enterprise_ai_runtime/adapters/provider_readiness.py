from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable


class ProviderReadinessEvidence:
    """Caches evidence from a real provider request without treating config as readiness."""

    def __init__(
        self,
        *,
        success_ttl_seconds: float = 300.0,
        failure_ttl_seconds: float = 30.0,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if success_ttl_seconds <= 0 or failure_ttl_seconds <= 0:
            raise ValueError("provider readiness TTLs must be positive")
        self._success_ttl_seconds = success_ttl_seconds
        self._failure_ttl_seconds = failure_ttl_seconds
        self._clock = clock
        self._checked_at: float | None = None
        self._ready = False
        self._lock = asyncio.Lock()

    def record_success(self) -> None:
        self._record(True)

    def record_failure(self) -> None:
        self._record(False)

    async def resolve(self, probe: Callable[[], Awaitable[object]]) -> bool:
        cached = self._cached_value()
        if cached is not None:
            return cached

        async with self._lock:
            cached = self._cached_value()
            if cached is not None:
                return cached
            try:
                await probe()
            except Exception:
                self.record_failure()
                return False
            self.record_success()
            return True

    def _record(self, ready: bool) -> None:
        self._ready = ready
        self._checked_at = self._clock()

    def _cached_value(self) -> bool | None:
        if self._checked_at is None:
            return None
        ttl = self._success_ttl_seconds if self._ready else self._failure_ttl_seconds
        if self._clock() - self._checked_at >= ttl:
            return None
        return self._ready
