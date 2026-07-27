from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request, status

from enterprise_ai_runtime.api import TenantHeader
from enterprise_ai_runtime.domain.errors import RuntimeExecutionError
from enterprise_ai_runtime.domain.knowledge_models import (
    EmbeddingRequest,
    EmbeddingResponse,
    KnowledgeCapabilitiesResponse,
    RerankRequest,
    RerankResponse,
)
from enterprise_ai_runtime.services.knowledge_service import KnowledgeService

router = APIRouter(prefix="/internal/v1/knowledge", tags=["knowledge"])


def service_from(request: Request) -> KnowledgeService:
    return request.app.state.knowledge_service


def _enforce_tenant(tenant_id: str, body_tenant_id: str) -> None:
    if tenant_id != body_tenant_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "code": "TENANT_CONTEXT_MISMATCH",
                "message": "X-Tenant-ID must match body tenant_id",
                "retryable": False,
            },
        )


def _provider_error(error: RuntimeExecutionError) -> HTTPException:
    status_code = {
        "PROVIDER_TIMEOUT": status.HTTP_504_GATEWAY_TIMEOUT,
        "PROVIDER_RATE_LIMITED": status.HTTP_429_TOO_MANY_REQUESTS,
        "KNOWLEDGE_CAPABILITY_DISABLED": status.HTTP_503_SERVICE_UNAVAILABLE,
    }.get(error.code, status.HTTP_502_BAD_GATEWAY)
    return HTTPException(
        status_code=status_code,
        detail={
            "code": error.code,
            "message": error.public_message,
            "retryable": error.retryable,
        },
    )


@router.get("/capabilities", response_model=KnowledgeCapabilitiesResponse)
async def capabilities(request: Request, tenant_id: TenantHeader) -> KnowledgeCapabilitiesResponse:
    del tenant_id  # Authentication boundary still requires a syntactically valid tenant context.
    return await service_from(request).capabilities()


@router.post("/embeddings", response_model=EmbeddingResponse)
async def embeddings(
    command: EmbeddingRequest,
    request: Request,
    tenant_id: TenantHeader,
) -> EmbeddingResponse:
    _enforce_tenant(tenant_id, command.tenant_id)
    try:
        return await service_from(request).embed(command, request_id=request.state.request_id)
    except RuntimeExecutionError as error:
        raise _provider_error(error) from error


@router.post("/rerank", response_model=RerankResponse)
async def rerank(
    command: RerankRequest,
    request: Request,
    tenant_id: TenantHeader,
) -> RerankResponse:
    _enforce_tenant(tenant_id, command.tenant_id)
    try:
        return await service_from(request).rerank(command, request_id=request.state.request_id)
    except RuntimeExecutionError as error:
        raise _provider_error(error) from error
