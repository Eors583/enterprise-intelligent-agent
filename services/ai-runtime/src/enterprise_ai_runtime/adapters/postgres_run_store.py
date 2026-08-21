from __future__ import annotations

import asyncio
import json
from collections.abc import Mapping
from typing import Any
from uuid import UUID

import asyncpg  # type: ignore[import-untyped]

from enterprise_ai_runtime.domain.errors import (
    InvalidRunTransitionError,
    RunAlreadyExistsError,
    RunNotFoundError,
)
from enterprise_ai_runtime.domain.models import (
    RunErrorInfo,
    RunOutput,
    RunRecord,
    RunStatus,
    RunUsage,
    utc_now,
)
from enterprise_ai_runtime.domain.state import ensure_transition_allowed


class PostgresRunStore:
    """Durable, tenant-scoped RunStore backed by PostgreSQL.

    Each data operation sets ``app.tenant_id`` inside the same transaction as
    the query. The database migration FORCE-enables RLS, so a missing or stale
    tenant context cannot expose another tenant's Run.
    """

    def __init__(
        self,
        *,
        dsn: str,
        min_size: int = 1,
        max_size: int = 10,
        command_timeout_seconds: float = 10.0,
    ) -> None:
        self._dsn = dsn
        self._min_size = min_size
        self._max_size = max_size
        self._command_timeout_seconds = command_timeout_seconds
        self._pool: asyncpg.Pool | None = None
        self._pool_lock = asyncio.Lock()

    async def create(self, run: RunRecord) -> RunRecord:
        pool = await self._get_pool()
        tenant_key = _tenant_uuid(run.tenant_id, run.run_id)
        try:
            async with pool.acquire() as connection, connection.transaction():
                await _set_runtime_context(connection, run.tenant_id)
                record = await connection.fetchrow(
                    """
                    INSERT INTO public.ai_runtime_runs (
                      tenant_id,
                      run_id,
                      status,
                      version,
                      record,
                      created_at,
                      updated_at
                    )
                    VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
                    RETURNING record
                    """,
                    tenant_key,
                    run.run_id,
                    run.status.value,
                    run.version,
                    run.model_dump_json(),
                    run.created_at,
                    run.updated_at,
                )
        except asyncpg.UniqueViolationError as error:
            raise RunAlreadyExistsError(str(run.run_id)) from error
        return _run_from_row(record, run.run_id)

    async def get(self, tenant_id: str, run_id: UUID) -> RunRecord:
        pool = await self._get_pool()
        tenant_key = _tenant_uuid(tenant_id, run_id)
        async with pool.acquire() as connection, connection.transaction():
            await _set_runtime_context(connection, tenant_id)
            record = await connection.fetchrow(
                """
                SELECT record
                FROM public.ai_runtime_runs
                WHERE tenant_id = $1 AND run_id = $2
                """,
                tenant_key,
                run_id,
            )
        return _run_from_row(record, run_id)

    async def transition(
        self,
        tenant_id: str,
        run_id: UUID,
        target: RunStatus,
        *,
        error: RunErrorInfo | None = None,
        output: RunOutput | None = None,
        usage: RunUsage | None = None,
        request_id: str | None = None,
    ) -> RunRecord:
        pool = await self._get_pool()
        tenant_key = _tenant_uuid(tenant_id, run_id)
        async with pool.acquire() as connection, connection.transaction():
            await _set_runtime_context(connection, tenant_id)
            stored = await connection.fetchrow(
                """
                SELECT record
                FROM public.ai_runtime_runs
                WHERE tenant_id = $1 AND run_id = $2
                FOR UPDATE
                """,
                tenant_key,
                run_id,
            )
            current = _run_from_row(stored, run_id)
            ensure_transition_allowed(current.status, target)

            now = utc_now()
            changes: dict[str, object] = {
                "status": target,
                "updated_at": now,
                "version": current.version + 1,
                "error": error,
                "output": output,
                "usage": usage,
            }
            if request_id is not None:
                changes["execution_request_id"] = request_id
            if target == RunStatus.RUNNING and current.started_at is None:
                changes["started_at"] = now
            if target.is_terminal:
                changes["finished_at"] = now
            updated = current.model_copy(update=changes, deep=True)

            saved = await connection.fetchrow(
                """
                UPDATE public.ai_runtime_runs
                SET status = $3,
                    version = $4,
                    record = $5::jsonb,
                    updated_at = $6
                WHERE tenant_id = $1
                  AND run_id = $2
                  AND version = $7
                RETURNING record
                """,
                tenant_key,
                run_id,
                target.value,
                updated.version,
                updated.model_dump_json(),
                updated.updated_at,
                current.version,
            )
            if saved is None:
                raise InvalidRunTransitionError(
                    current=current.status.value,
                    target=target.value,
                )
        return _run_from_row(saved, run_id)

    async def is_ready(self) -> bool:
        try:
            pool = await self._get_pool()
            async with pool.acquire() as connection, connection.transaction():
                await connection.execute("SET LOCAL ROLE enterprise_agent_runtime")
                await connection.fetchval("SELECT 1")
                table_exists = await connection.fetchval(
                    "SELECT to_regclass('public.ai_runtime_runs') IS NOT NULL"
                )
            return table_exists is True
        except Exception:
            return False

    async def aclose(self) -> None:
        async with self._pool_lock:
            pool = self._pool
            self._pool = None
        if pool is not None:
            await pool.close()

    async def _get_pool(self) -> asyncpg.Pool:
        pool = self._pool
        if pool is not None:
            return pool
        async with self._pool_lock:
            if self._pool is None:
                self._pool = await asyncpg.create_pool(
                    dsn=self._dsn,
                    min_size=self._min_size,
                    max_size=self._max_size,
                    command_timeout=self._command_timeout_seconds,
                    server_settings={
                        "application_name": "enterprise-ai-runtime",
                        "statement_timeout": str(
                            max(100, int(self._command_timeout_seconds * 1_000))
                        ),
                    },
                )
            return self._pool


async def _set_runtime_context(connection: asyncpg.Connection, tenant_id: str) -> None:
    await connection.execute("SET LOCAL ROLE enterprise_agent_runtime")
    await connection.fetchval(
        "SELECT set_config('app.tenant_id', $1, true)",
        tenant_id,
    )


def _run_from_row(row: Mapping[str, Any] | None, run_id: UUID) -> RunRecord:
    if row is None:
        raise RunNotFoundError(str(run_id))
    raw_record = row["record"]
    if isinstance(raw_record, str):
        value: object = json.loads(raw_record)
    else:
        value = raw_record
    return RunRecord.model_validate(value)


def _tenant_uuid(tenant_id: str, run_id: UUID) -> UUID:
    try:
        return UUID(tenant_id)
    except ValueError as error:
        # The PostgreSQL store is attached to the enterprise database where
        # tenant identities are UUIDs. Do not expose whether another form of
        # tenant identifier exists.
        raise RunNotFoundError(str(run_id)) from error
