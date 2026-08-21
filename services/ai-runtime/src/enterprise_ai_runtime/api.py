from __future__ import annotations

import asyncio
import hashlib
import json
from datetime import UTC, datetime
from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Header, HTTPException, Query, Request, Response, status
from fastapi.responses import JSONResponse, StreamingResponse

from enterprise_ai_runtime.domain.errors import (
    InvalidRunTransitionError,
    RunNotFoundError,
    RunStreamReconciliationRequiredError,
)
from enterprise_ai_runtime.domain.models import (
    DependencyHealthComponent,
    DependencyHealthResponse,
    HealthResponse,
    ModelRoutingReadinessResponse,
    ModelRoutingReadinessRoute,
    RunCreateRequest,
    RunCreateResponse,
    RunRecord,
)
from enterprise_ai_runtime.evaluation_models import (
    EvaluationExecutionRequest,
    EvaluationExecutionResponse,
)
from enterprise_ai_runtime.services.evaluation_service import (
    EvaluationRequestIntegrityError,
    EvaluationRunnerNotConfiguredError,
)
from enterprise_ai_runtime.services.run_service import RunService
from enterprise_ai_runtime.telemetry import TelemetryState, TelemetryStatus

router = APIRouter()

TenantHeader = Annotated[
    str,
    Header(
        alias="X-Tenant-ID",
        min_length=1,
        max_length=128,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9._:@/-]*$",
    ),
]


def service_from(request: Request) -> RunService:
    return request.app.state.run_service


def request_id_from(request: Request) -> str:
    return request.state.request_id


def not_found(error: RunNotFoundError) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail={"code": "RUN_NOT_FOUND", "message": str(error)},
    )


def conflict(error: InvalidRunTransitionError) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail={"code": "INVALID_RUN_TRANSITION", "message": str(error)},
    )


@router.get("/health/live", response_model=HealthResponse, tags=["health"])
async def live() -> HealthResponse:
    return HealthResponse(status="ok")


@router.get(
    "/health/ready",
    response_model=HealthResponse,
    responses={503: {"model": HealthResponse}},
    tags=["health"],
)
async def ready(request: Request) -> HealthResponse | JSONResponse:
    store_ready, runtime_ready = await service_from(request).readiness()
    knowledge_components = await request.app.state.knowledge_service.readiness_components()
    telemetry_runtime = getattr(request.app.state, "telemetry_runtime", None)
    if telemetry_runtime is not None:
        await telemetry_runtime.refresh_export_health()
    components: dict[str, Literal["ready", "not_ready"]] = {
        "run_store": "ready" if store_ready else "not_ready",
        "runtime": "ready" if runtime_ready else "not_ready",
        **{
            name: "ready" if component_ready else "not_ready"
            for name, component_ready in knowledge_components.items()
        },
    }
    telemetry_status: TelemetryStatus | None = getattr(request.app.state, "telemetry_status", None)
    telemetry_ready = telemetry_status is None or not telemetry_status.required
    if telemetry_status is not None:
        telemetry_ready = not telemetry_status.required or telemetry_status.ready
        components["telemetry"] = "ready" if telemetry_status.ready else "not_ready"
    knowledge_ready = all(knowledge_components.values())
    response = HealthResponse(
        status=(
            "ready"
            if store_ready and runtime_ready and knowledge_ready and telemetry_ready
            else "not_ready"
        ),
        components=components,
    )
    if store_ready and runtime_ready and knowledge_ready and telemetry_ready:
        return response
    return JSONResponse(status_code=503, content=response.model_dump(mode="json"))


@router.get(
    "/health/dependencies",
    response_model=DependencyHealthResponse,
    tags=["health"],
)
async def dependencies(request: Request) -> DependencyHealthResponse:
    store_ready, runtime_ready = await service_from(request).readiness()
    capabilities = await request.app.state.knowledge_service.capabilities()
    telemetry_runtime = getattr(request.app.state, "telemetry_runtime", None)
    if telemetry_runtime is not None:
        await telemetry_runtime.refresh_export_health()
    embedding_status = capabilities.embeddings.status.value
    rerank_status = capabilities.rerank.status.value

    components = {
        "run_store": DependencyHealthComponent(
            status="ready" if store_ready else "degraded",
            configured=True,
            fallback_mode=None if store_ready else "reject_new_runs_and_preserve_existing_state",
        ),
        "model": DependencyHealthComponent(
            status="ready" if runtime_ready else "degraded",
            configured=True,
            fallback_mode=None if runtime_ready else "knowledge_retrieval_then_human_handoff",
        ),
        "embedding": DependencyHealthComponent(
            status=(
                "disabled"
                if embedding_status == "disabled"
                else "ready"
                if embedding_status == "ready"
                else "degraded"
            ),
            configured=embedding_status != "disabled",
            fallback_mode=(
                "semantic_retrieval_not_configured"
                if embedding_status == "disabled"
                else None
                if embedding_status == "ready"
                else "pause_unsupported_generation_and_use_structured_data"
            ),
        ),
        "reranker": DependencyHealthComponent(
            status=(
                "disabled"
                if rerank_status == "disabled"
                else "ready"
                if rerank_status == "ready"
                else "degraded"
            ),
            configured=rerank_status != "disabled",
            fallback_mode=("hybrid_retrieval_without_rerank" if rerank_status != "ready" else None),
        ),
    }
    telemetry_status: TelemetryStatus | None = getattr(request.app.state, "telemetry_status", None)
    if telemetry_status is not None:
        components["telemetry"] = DependencyHealthComponent(
            status=(
                "ready"
                if telemetry_status.ready
                else "degraded"
                if telemetry_status.required or telemetry_status.state == TelemetryState.FAILED
                else "disabled"
            ),
            configured=telemetry_status.configured,
            evidence="otlp_export_probe",
            external_connectivity_verified=(
                telemetry_status.last_successful_export_at is not None
                and not telemetry_status.stale
            ),
            fallback_mode=(
                None
                if telemetry_status.ready
                else "readiness_blocked_until_telemetry_recovers"
                if telemetry_status.required
                else "local_logs_and_health_only"
            ),
            last_successful_export_at=telemetry_status.last_successful_export_at,
            stale=telemetry_status.stale,
        )
    evaluation_service = request.app.state.evaluation_service
    components["evaluation_attestation"] = DependencyHealthComponent(
        status="ready" if evaluation_service.configured else "disabled",
        configured=evaluation_service.configured,
        fallback_mode=(
            None
            if evaluation_service.configured
            else "block_evaluation_execution_and_release_publication"
        ),
    )
    degraded = any(component.status == "degraded" for component in components.values())
    return DependencyHealthResponse(
        status="degraded" if degraded else "ready",
        components=components,
    )


@router.get(
    "/internal/v1/model-routing/readiness",
    response_model=ModelRoutingReadinessResponse,
    tags=["model-routing"],
)
async def model_routing_readiness(
    request: Request,
    response: Response,
) -> ModelRoutingReadinessResponse:
    response.headers["Cache-Control"] = "no-store"
    settings = request.app.state.runtime_settings
    _store_ready, provider_ready = await service_from(request).readiness()
    routes = [
        ModelRoutingReadinessRoute(
            route_key=entry.route_key,
            catalog_version_id=entry.catalog_version_id,
            provider=entry.provider,
            model=entry.model,
            configuration_sha256=_route_configuration_sha256(
                entry.route_key,
                str(entry.catalog_version_id),
                entry.provider,
                entry.model,
                entry.credential_reference,
            ),
        )
        for entry in settings.model_route_catalog
    ]
    trusted = settings.require_trusted_model_route
    return ModelRoutingReadinessResponse(
        status="ready" if trusted and provider_ready and routes else "not_ready",
        require_trusted_route=trusted,
        provider_ready=provider_ready,
        checked_at=datetime.now(UTC),
        routes=routes,
    )


@router.post(
    "/internal/v1/evaluations/execute",
    response_model=EvaluationExecutionResponse,
    tags=["evaluations"],
)
async def execute_evaluation(
    command: EvaluationExecutionRequest,
    request: Request,
    tenant_id: TenantHeader,
) -> EvaluationExecutionResponse:
    if str(command.tenant_id) != tenant_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "code": "TENANT_CONTEXT_MISMATCH",
                "message": "X-Tenant-ID must match body tenant_id",
            },
        )
    try:
        return await request.app.state.evaluation_service.execute(
            command,
            request_id_from(request),
        )
    except EvaluationRunnerNotConfiguredError as error:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "code": "EVALUATION_RUNNER_NOT_CONFIGURED",
                "message": str(error),
                "retryable": False,
            },
        ) from error
    except EvaluationRequestIntegrityError as error:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "code": "EVALUATION_REQUEST_INTEGRITY_FAILED",
                "message": str(error),
                "retryable": False,
            },
        ) from error


@router.post(
    "/internal/v1/runs",
    response_model=RunCreateResponse,
    status_code=status.HTTP_202_ACCEPTED,
    tags=["runs"],
)
async def create_run(
    command: RunCreateRequest,
    request: Request,
    tenant_id: TenantHeader,
) -> RunCreateResponse:
    if command.tenant_id != tenant_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "code": "TENANT_CONTEXT_MISMATCH",
                "message": "X-Tenant-ID must match body tenant_id",
            },
        )
    run = await service_from(request).create(command, request_id_from(request))
    return RunCreateResponse(run_id=run.run_id, status=run.status, request_id=run.request_id)


def _route_configuration_sha256(
    route_key: str,
    catalog_version_id: str,
    provider: str,
    model: str,
    credential_reference: str,
) -> str:
    canonical = "\0".join((route_key, catalog_version_id, provider, model, credential_reference))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


@router.get(
    "/internal/v1/runs/{run_id}",
    response_model=RunRecord,
    tags=["runs"],
)
async def get_run(run_id: UUID, request: Request, tenant_id: TenantHeader) -> RunRecord:
    try:
        return await service_from(request).get(tenant_id, run_id)
    except RunNotFoundError as error:
        raise not_found(error) from error


@router.post(
    "/internal/v1/runs/{run_id}/execute",
    response_model=RunRecord,
    tags=["runs"],
)
async def execute_run(run_id: UUID, request: Request, tenant_id: TenantHeader) -> RunRecord:
    try:
        return await service_from(request).execute(
            tenant_id,
            run_id,
            request_id_from(request),
        )
    except RunNotFoundError as error:
        raise not_found(error) from error
    except InvalidRunTransitionError as error:
        raise conflict(error) from error


@router.post(
    "/internal/v1/runs/{run_id}/execute/stream",
    response_class=StreamingResponse,
    tags=["runs"],
)
async def stream_run(
    run_id: UUID,
    request: Request,
    tenant_id: TenantHeader,
    cursor: Annotated[int, Query(ge=0, le=10_000)] = 0,
    last_event_id: Annotated[str | None, Header(alias="Last-Event-ID")] = None,
) -> StreamingResponse:
    stream_cursor = _stream_cursor(run_id, cursor, last_event_id)

    async def event_source():
        iterator = (
            service_from(request)
            .stream(
                tenant_id,
                run_id,
                request_id_from(request),
                cursor=stream_cursor,
            )
            .__aiter__()
        )
        pending: asyncio.Task | None = None
        try:
            while True:
                if pending is None:
                    pending = asyncio.create_task(anext(iterator))
                done, _ = await asyncio.wait({pending}, timeout=10)
                if not done:
                    # Subscriber heartbeat only; this is deliberately not a
                    # durable Run event and carries no content.
                    yield ": heartbeat\n\n"
                    continue
                try:
                    event = pending.result()
                except StopAsyncIteration:
                    return
                pending = None
                yield (
                    f"id: {event.event_id}\n"
                    f"event: {event.type}\n"
                    f"data: {event.model_dump_json()}\n\n"
                )
        except RunNotFoundError as error:
            yield _safe_stream_error("RUN_NOT_FOUND", str(error))
        except RunStreamReconciliationRequiredError:
            yield _safe_stream_error(
                "RUN_STREAM_RECONCILIATION_REQUIRED",
                "the durable Run outcome requires reconciliation",
            )
        finally:
            if pending is not None and not pending.done():
                pending.cancel()
                await asyncio.gather(pending, return_exceptions=True)
            await iterator.aclose()

    return StreamingResponse(
        event_source(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-store, no-transform",
            "X-Accel-Buffering": "no",
        },
    )


@router.post(
    "/internal/v1/runs/{run_id}/cancel",
    response_model=RunRecord,
    tags=["runs"],
)
async def cancel_run(run_id: UUID, request: Request, tenant_id: TenantHeader) -> RunRecord:
    try:
        return await service_from(request).cancel(tenant_id, run_id)
    except RunNotFoundError as error:
        raise not_found(error) from error
    except InvalidRunTransitionError as error:
        raise conflict(error) from error


def _stream_cursor(run_id: UUID, query_cursor: int, last_event_id: str | None) -> int:
    if last_event_id is None:
        return query_cursor
    prefix = f"{run_id}:"
    if not last_event_id.startswith(prefix):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "code": "INVALID_STREAM_CURSOR",
                "message": "Last-Event-ID does not belong to this Run",
            },
        )
    suffix = last_event_id[len(prefix) :]
    if (
        not suffix
        or not suffix.isascii()
        or not suffix.isdecimal()
        or (len(suffix) > 1 and suffix.startswith("0"))
        or len(suffix) > 5
    ):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "INVALID_STREAM_CURSOR", "message": "Last-Event-ID is invalid"},
        )
    try:
        parsed = int(suffix)
    except ValueError as error:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "INVALID_STREAM_CURSOR", "message": "Last-Event-ID is invalid"},
        ) from error
    if not 0 <= parsed <= 10_000:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "INVALID_STREAM_CURSOR", "message": "Last-Event-ID is invalid"},
        )
    return max(query_cursor, parsed)


def _safe_stream_error(code: str, message: str) -> str:
    data = json.dumps({"code": code, "message": message}, separators=(",", ":"))
    return f"event: error\ndata: {data}\n\n"
