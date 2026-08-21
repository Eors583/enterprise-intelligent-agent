from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from typing import Any
from uuid import UUID, uuid4

import pytest

from enterprise_ai_runtime.adapters.postgres_run_store import PostgresRunStore
from enterprise_ai_runtime.domain.errors import RunNotFoundError
from enterprise_ai_runtime.domain.models import (
    MessageRole,
    PrincipalContext,
    PrincipalType,
    RunBudget,
    RunInput,
    RunMessage,
    RunRecord,
    RunStatus,
)

TENANT_A = "00000000-0000-7000-8000-000000000001"
TENANT_B = "00000000-0000-7000-8000-000000000002"


class _AsyncContext:
    def __init__(self, value: Any = None) -> None:
        self._value = value

    async def __aenter__(self) -> Any:
        return self._value

    async def __aexit__(self, *_: object) -> None:
        return None


class _FakeConnection:
    def __init__(self, records: dict[tuple[str, UUID], str]) -> None:
        self.records = records
        self.tenant_id: str | None = None

    def transaction(self) -> _AsyncContext:
        return _AsyncContext()

    async def execute(self, query: str) -> str:
        assert query == "SET LOCAL ROLE enterprise_agent_runtime"
        return "SET"

    async def fetchval(self, query: str, *values: object) -> object:
        if "set_config" in query:
            self.tenant_id = str(values[0])
            return self.tenant_id
        if "to_regclass" in query:
            return True
        return 1

    async def fetchrow(self, query: str, *values: object) -> dict[str, object] | None:
        normalized = " ".join(query.split())
        tenant_id = str(values[0])
        run_id = values[1]
        assert isinstance(run_id, UUID)
        assert self.tenant_id == tenant_id
        key = (tenant_id, run_id)

        if normalized.startswith("INSERT"):
            self.records[key] = str(values[4])
            return {"record": self.records[key]}
        if normalized.startswith("SELECT"):
            value = self.records.get(key)
            return None if value is None else {"record": value}
        if normalized.startswith("UPDATE"):
            current_version = int(values[6])
            current = self.records.get(key)
            if current is None or RunRecord.model_validate_json(current).version != current_version:
                return None
            self.records[key] = str(values[4])
            return {"record": self.records[key]}
        raise AssertionError(f"unexpected query: {normalized}")


class _FakePool:
    def __init__(self) -> None:
        self.records: dict[tuple[str, UUID], str] = {}
        self.connection = _FakeConnection(self.records)
        self.closed = False

    def acquire(self) -> _AsyncContext:
        return _AsyncContext(self.connection)

    async def close(self) -> None:
        self.closed = True


def _run(tenant_id: str) -> RunRecord:
    now = datetime.now(UTC)
    return RunRecord(
        run_id=uuid4(),
        tenant_id=tenant_id,
        principal=PrincipalContext(
            principal_id="user-1",
            principal_type=PrincipalType.USER,
            roles=["member"],
            scopes=["agent:run"],
        ),
        agent_id="agent-1",
        agent_version="1",
        input=RunInput(messages=[RunMessage(role=MessageRole.USER, content="hello")]),
        budget=RunBudget(
            max_input_tokens=1_000,
            max_output_tokens=200,
            max_tool_calls=0,
            timeout_ms=30_000,
            max_cost_micros=10_000,
        ),
        metadata={},
        status=RunStatus.QUEUED,
        request_id="request-1",
        created_at=now,
        updated_at=now,
    )


def test_postgres_store_persists_transitions_and_closes_pool(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pool = _FakePool()

    async def create_pool(**_: object) -> _FakePool:
        return pool

    monkeypatch.setattr(
        "enterprise_ai_runtime.adapters.postgres_run_store.asyncpg.create_pool",
        create_pool,
    )
    store = PostgresRunStore(dsn="postgresql://runtime:secret@db.example/runtime")
    run = _run(TENANT_A)

    async def scenario() -> None:
        created = await store.create(run)
        assert created == run
        running = await store.transition(
            run.tenant_id,
            run.run_id,
            RunStatus.RUNNING,
            request_id="execute-1",
        )
        assert running.status == RunStatus.RUNNING
        assert running.version == 2
        assert running.started_at is not None
        assert running.execution_request_id == "execute-1"
        fetched = await store.get(run.tenant_id, run.run_id)
        assert fetched == running
        assert await store.is_ready() is True
        await store.aclose()

    asyncio.run(scenario())
    assert pool.closed is True


def test_postgres_store_hides_a_run_from_another_tenant(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pool = _FakePool()

    async def create_pool(**_: object) -> _FakePool:
        return pool

    monkeypatch.setattr(
        "enterprise_ai_runtime.adapters.postgres_run_store.asyncpg.create_pool",
        create_pool,
    )
    store = PostgresRunStore(dsn="postgresql://runtime:secret@db.example/runtime")
    run = _run(TENANT_A)

    async def scenario() -> None:
        await store.create(run)
        with pytest.raises(RunNotFoundError):
            await store.get(TENANT_B, run.run_id)
        await store.aclose()

    asyncio.run(scenario())
