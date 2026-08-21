from __future__ import annotations

from uuid import UUID

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from enterprise_ai_runtime.adapters.memory_run_store import InMemoryRunStore
from enterprise_ai_runtime.adapters.noop_runtime import NoopRuntime
from enterprise_ai_runtime.api import _stream_cursor
from enterprise_ai_runtime.config import (
    ModelRouteCatalogEntry,
    RuntimeDriver,
    RuntimeEnvironment,
    RuntimeSettings,
)
from enterprise_ai_runtime.main import create_app


def test_health_checks_and_request_id(client: TestClient) -> None:
    live = client.get(
        "/health/live",
        headers={
            "X-Request-ID": "req-health-1",
            "X-Correlation-ID": "task:42",
            "traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
        },
    )
    assert live.status_code == 200
    assert live.json() == {
        "status": "ok",
        "service": "enterprise-ai-runtime",
        "components": None,
    }
    assert live.headers["X-Request-ID"] == "req-health-1"
    assert live.headers["X-Correlation-ID"] == "task:42"
    assert live.headers["traceparent"] == "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"

    ready = client.get("/health/ready")
    assert ready.status_code == 200
    assert ready.json()["status"] == "ready"
    assert ready.json()["components"] == {
        "run_store": "ready",
        "runtime": "ready",
    }
    assert ready.headers["X-Request-ID"]

    dependencies = client.get("/health/dependencies")
    assert dependencies.status_code == 200
    assert dependencies.json()["status"] == "ready"
    assert dependencies.json()["components"] == {
        "run_store": {
            "status": "ready",
            "configured": True,
            "evidence": "lifecycle_probe",
            "external_connectivity_verified": False,
            "fallback_mode": None,
        },
        "model": {
            "status": "ready",
            "configured": True,
            "evidence": "lifecycle_probe",
            "external_connectivity_verified": False,
            "fallback_mode": None,
        },
        "embedding": {
            "status": "disabled",
            "configured": False,
            "evidence": "lifecycle_probe",
            "external_connectivity_verified": False,
            "fallback_mode": "semantic_retrieval_not_configured",
        },
        "reranker": {
            "status": "disabled",
            "configured": False,
            "evidence": "lifecycle_probe",
            "external_connectivity_verified": False,
            "fallback_mode": "hybrid_retrieval_without_rerank",
        },
        "evaluation_attestation": {
            "status": "disabled",
            "configured": False,
            "evidence": "lifecycle_probe",
            "external_connectivity_verified": False,
            "fallback_mode": "block_evaluation_execution_and_release_publication",
        },
    }


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


def test_create_is_idempotent_for_caller_supplied_run_id(
    client: TestClient,
    run_payload: dict[str, object],
) -> None:
    run_id = "00000000-0000-7000-8000-000000000801"
    payload = {**run_payload, "run_id": run_id}
    headers = {"X-Tenant-ID": "tenant-a", "X-Request-ID": "agent-run-local-801"}

    first = client.post("/internal/v1/runs", headers=headers, json=payload)
    second = client.post("/internal/v1/runs", headers=headers, json=payload)

    assert first.status_code == 202
    assert second.status_code == 202
    assert first.json()["run_id"] == run_id
    assert second.json()["run_id"] == run_id


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

    with TestClient(create_app(store=InMemoryRunStore(), runtime=NotReadyRuntime())) as test_client:
        dependency_response = test_client.get("/health/dependencies")
    assert dependency_response.status_code == 200
    assert dependency_response.json()["status"] == "degraded"
    assert dependency_response.json()["components"]["model"]["status"] == "degraded"
    assert (
        dependency_response.json()["components"]["model"]["fallback_mode"]
        == "knowledge_retrieval_then_human_handoff"
    )


def test_internal_routes_require_configured_service_credentials(
    run_payload: dict[str, object],
) -> None:
    token = "runtime-service-token-at-least-32-characters"
    app = create_app(
        settings=RuntimeSettings(
            environment=RuntimeEnvironment.TEST,
            driver=RuntimeDriver.NOOP,
            service_token=token,
        )
    )
    with TestClient(app) as test_client:
        live = test_client.get("/health/live")
        unauthorized = test_client.post(
            "/internal/v1/runs",
            headers={"X-Tenant-ID": "tenant-a"},
            json=run_payload,
        )
        authorized = test_client.post(
            "/internal/v1/runs",
            headers={
                "X-Tenant-ID": "tenant-a",
                "Authorization": f"Bearer {token}",
            },
            json=run_payload,
        )
        run_id = authorized.json()["run_id"]
        unauthorized_stream = test_client.post(
            f"/internal/v1/runs/{run_id}/execute/stream",
            headers={"X-Tenant-ID": "tenant-a"},
        )
        authorized_stream = test_client.post(
            f"/internal/v1/runs/{run_id}/execute/stream",
            headers={
                "X-Tenant-ID": "tenant-a",
                "Authorization": f"Bearer {token}",
                "Accept": "text/event-stream",
            },
        )

    assert live.status_code == 200
    assert unauthorized.status_code == 401
    assert unauthorized.json()["detail"]["code"] == "SERVICE_AUTHENTICATION_FAILED"
    assert unauthorized.headers["X-Request-ID"]
    assert authorized.status_code == 202
    assert unauthorized_stream.status_code == 401
    assert authorized_stream.status_code == 200
    assert authorized_stream.headers["content-type"].startswith("text/event-stream")
    assert "event: terminal_only" in authorized_stream.text
    assert "RUNTIME_NOT_CONFIGURED" in authorized_stream.text
    assert "input" not in authorized_stream.text


def test_model_routing_readiness_exposes_authenticated_allowlist_evidence() -> None:
    token = "runtime-service-token-at-least-32-characters"
    catalog_version_id = UUID("00000000-0000-7000-8000-000000000991")
    settings = RuntimeSettings(
        environment=RuntimeEnvironment.TEST,
        driver=RuntimeDriver.OPENAI_COMPATIBLE,
        service_token=token,
        openai_base_url="https://model.example.test/v1",
        openai_api_key="test-only-provider-key",
        openai_model="model-a",
        require_trusted_model_route=True,
        model_route_catalog=(
            ModelRouteCatalogEntry(
                route_key="GENERAL.PRIMARY",
                catalog_version_id=catalog_version_id,
                provider="OPENAI_COMPATIBLE",
                model="model-a",
                credential_reference="vault://ai/general-primary",
            ),
        ),
    )
    app = create_app(
        settings=settings,
        store=InMemoryRunStore(),
        runtime=NoopRuntime(),
    )
    with TestClient(app) as test_client:
        unauthorized = test_client.get("/internal/v1/model-routing/readiness")
        response = test_client.get(
            "/internal/v1/model-routing/readiness",
            headers={"Authorization": f"Bearer {token}"},
        )

    assert unauthorized.status_code == 401
    assert response.status_code == 200
    assert response.headers["Cache-Control"] == "no-store"
    body = response.json()
    assert body["status"] == "ready"
    assert body["require_trusted_route"] is True
    assert body["provider_ready"] is True
    assert body["evidence"] == "local_configuration_probe"
    assert body["external_connectivity_verified"] is False
    assert body["routes"] == [
        {
            "route_key": "GENERAL.PRIMARY",
            "catalog_version_id": str(catalog_version_id),
            "provider": "OPENAI_COMPATIBLE",
            "model": "model-a",
            "configuration_sha256": (
                "86317f444e7fad160e3e9026ff7414c4ce54a9f4e4211b0b9b60c2b0dd386af8"
            ),
        }
    ]


@pytest.mark.parametrize(
    "value",
    [
        "00000000-0000-7000-8000-000000000802:",
        "00000000-0000-7000-8000-000000000802:+1",
        "00000000-0000-7000-8000-000000000802:-1",
        "00000000-0000-7000-8000-000000000802:01",
        "00000000-0000-7000-8000-000000000802: 1",
        "00000000-0000-7000-8000-000000000802:1 ",
        "00000000-0000-7000-8000-000000000802:1e2",
        "00000000-0000-7000-8000-000000000802:10001",
        "00000000-0000-7000-8000-000000000999:1",
    ],
)
def test_stream_cursor_rejects_noncanonical_last_event_id(value: str) -> None:
    with pytest.raises(HTTPException) as raised:
        _stream_cursor(
            UUID("00000000-0000-7000-8000-000000000802"),
            0,
            value,
        )
    assert getattr(raised.value, "status_code", None) == 400
