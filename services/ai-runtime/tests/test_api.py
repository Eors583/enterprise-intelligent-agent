from __future__ import annotations

from fastapi.testclient import TestClient

from enterprise_ai_runtime.adapters.memory_run_store import InMemoryRunStore
from enterprise_ai_runtime.adapters.noop_runtime import NoopRuntime
from enterprise_ai_runtime.main import create_app


def test_health_checks_and_request_id(client: TestClient) -> None:
    live = client.get("/health/live", headers={"X-Request-ID": "req-health-1"})
    assert live.status_code == 200
    assert live.json() == {
        "status": "ok",
        "service": "enterprise-ai-runtime",
        "components": None,
    }
    assert live.headers["X-Request-ID"] == "req-health-1"

    ready = client.get("/health/ready")
    assert ready.status_code == 200
    assert ready.json()["status"] == "ready"
    assert ready.json()["components"] == {
        "run_store": "ready",
        "runtime": "ready",
    }
    assert ready.headers["X-Request-ID"]


def test_create_get_and_idempotent_cancel(
    client: TestClient,
    run_payload: dict[str, object],
) -> None:
    headers = {"X-Tenant-ID": "tenant-a", "X-Request-ID": "req-create-1"}
    created = client.post("/internal/v1/runs", headers=headers, json=run_payload)

    assert created.status_code == 202
    assert created.json()["status"] == "queued"
    assert created.json()["request_id"] == "req-create-1"
    run_id = created.json()["run_id"]

    fetched = client.get(
        f"/internal/v1/runs/{run_id}",
        headers={"X-Tenant-ID": "tenant-a"},
    )
    assert fetched.status_code == 200
    assert fetched.json()["tenant_id"] == "tenant-a"
    assert fetched.json()["principal"]["principal_id"] == "user-1"
    assert fetched.json()["agent_version"] == "2026-07-14.1"
    assert fetched.json()["budget"]["max_tool_calls"] == 5
    assert fetched.json()["status"] == "queued"
    assert fetched.json()["version"] == 1

    canceled = client.post(
        f"/internal/v1/runs/{run_id}/cancel",
        headers={"X-Tenant-ID": "tenant-a"},
    )
    assert canceled.status_code == 200
    assert canceled.json()["status"] == "cancelled"
    assert canceled.json()["finished_at"] is not None
    assert canceled.json()["version"] == 2

    canceled_again = client.post(
        f"/internal/v1/runs/{run_id}/cancel",
        headers={"X-Tenant-ID": "tenant-a"},
    )
    assert canceled_again.status_code == 200
    assert canceled_again.json()["status"] == "cancelled"
    assert canceled_again.json()["version"] == 2


def test_tenant_context_is_enforced(
    client: TestClient,
    run_payload: dict[str, object],
) -> None:
    mismatch = client.post(
        "/internal/v1/runs",
        headers={"X-Tenant-ID": "tenant-b"},
        json=run_payload,
    )
    assert mismatch.status_code == 400
    assert mismatch.json()["detail"]["code"] == "TENANT_CONTEXT_MISMATCH"

    created = client.post(
        "/internal/v1/runs",
        headers={"X-Tenant-ID": "tenant-a"},
        json=run_payload,
    )
    run_id = created.json()["run_id"]
    hidden = client.get(
        f"/internal/v1/runs/{run_id}",
        headers={"X-Tenant-ID": "tenant-b"},
    )
    assert hidden.status_code == 404
    assert hidden.json()["detail"]["code"] == "RUN_NOT_FOUND"


def test_invalid_payload_and_missing_tenant_header(
    client: TestClient,
    run_payload: dict[str, object],
) -> None:
    missing_header = client.post("/internal/v1/runs", json=run_payload)
    assert missing_header.status_code == 422

    invalid_payload = dict(run_payload)
    invalid_payload.pop("budget")
    rejected = client.post(
        "/internal/v1/runs",
        headers={"X-Tenant-ID": "tenant-a"},
        json=invalid_payload,
    )
    assert rejected.status_code == 422


def test_invalid_request_id_is_replaced(client: TestClient) -> None:
    response = client.get("/health/live", headers={"X-Request-ID": "invalid id with spaces"})
    generated = response.headers["X-Request-ID"]
    assert generated != "invalid id with spaces"
    assert len(generated) == 36


class NotReadyRuntime(NoopRuntime):
    async def is_ready(self) -> bool:
        return False


def test_readiness_returns_503_when_an_adapter_is_not_ready() -> None:
    app = create_app(store=InMemoryRunStore(), runtime=NotReadyRuntime())
    with TestClient(app) as test_client:
        response = test_client.get("/health/ready")

    assert response.status_code == 503
    assert response.json()["status"] == "not_ready"
    assert response.json()["components"]["runtime"] == "not_ready"
