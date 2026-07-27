from __future__ import annotations

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Header, HTTPException, Request, status
from fastapi.responses import JSONResponse

from enterprise_ai_runtime.domain.errors import (
    InvalidRunTransitionError,
    RunNotFoundError,
)
from enterprise_ai_runtime.domain.models import (
    HealthResponse,
    RunCreateRequest,
    RunCreateResponse,
    RunRecord,
)
from enterprise_ai_runtime.services.run_service import RunService

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
    components = {
        "run_store": "ready" if store_ready else "not_ready",
        "runtime": "ready" if runtime_ready else "not_ready",
        **{
            name: "ready" if component_ready else "not_ready"
            for name, component_ready in knowledge_components.items()
        },
    }
    knowledge_ready = all(knowledge_components.values())
    response = HealthResponse(
        status="ready" if store_ready and runtime_ready and knowledge_ready else "not_ready",
        components=components,
    )
    if store_ready and runtime_ready and knowledge_ready:
        return response
    return JSONResponse(status_code=503, content=response.model_dump(mode="json"))


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
