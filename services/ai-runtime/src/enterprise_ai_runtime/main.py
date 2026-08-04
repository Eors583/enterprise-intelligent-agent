from __future__ import annotations

import logging
import os
import re
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from secrets import compare_digest
from time import perf_counter
from uuid import uuid4

import uvicorn
from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse

from enterprise_ai_runtime.adapters.cohere_rerank_provider import CohereRerankProvider
from enterprise_ai_runtime.adapters.local_fastembed_provider import (
    LocalFastembedEmbeddingProvider,
    LocalFastembedRerankProvider,
)
from enterprise_ai_runtime.adapters.manus_provider import ManusProvider
from enterprise_ai_runtime.adapters.memory_run_store import InMemoryRunStore
from enterprise_ai_runtime.adapters.noop_runtime import NoopRuntime
from enterprise_ai_runtime.adapters.openai_compatible_provider import OpenAICompatibleProvider
from enterprise_ai_runtime.adapters.openai_embedding_provider import OpenAIEmbeddingProvider
from enterprise_ai_runtime.adapters.postgres_run_store import PostgresRunStore
from enterprise_ai_runtime.adapters.provider_runtime import ProviderRuntime
from enterprise_ai_runtime.adapters.routed_provider_runtime import RoutedProviderRuntime
from enterprise_ai_runtime.api import router
from enterprise_ai_runtime.config import (
    EmbeddingDriver,
    RerankDriver,
    RuntimeDriver,
    RuntimeEnvironment,
    RuntimeSettings,
    StoreDriver,
    load_runtime_dotenv,
)
from enterprise_ai_runtime.domain.errors import RuntimeConfigurationError
from enterprise_ai_runtime.knowledge_api import router as knowledge_router
from enterprise_ai_runtime.observability import resolve_trace_context, structured_access_log
from enterprise_ai_runtime.ports.run_store import RunStorePort
from enterprise_ai_runtime.ports.runtime import RuntimePort
from enterprise_ai_runtime.services.evaluation_service import EvaluationService
from enterprise_ai_runtime.services.knowledge_service import KnowledgeService
from enterprise_ai_runtime.services.run_service import RunService
from enterprise_ai_runtime.telemetry import (
    TelemetryRuntime,
    read_telemetry_config,
    start_telemetry,
)

REQUEST_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
access_logger = logging.getLogger("enterprise_ai_runtime.access")


def normalized_request_id(raw_request_id: str | None) -> str:
    if raw_request_id and REQUEST_ID_PATTERN.fullmatch(raw_request_id):
        return raw_request_id
    return str(uuid4())


def create_app(
    *,
    settings: RuntimeSettings | None = None,
    store: RunStorePort | None = None,
    runtime: RuntimePort | None = None,
    knowledge_service: KnowledgeService | None = None,
    telemetry: TelemetryRuntime | None = None,
) -> FastAPI:
    runtime_settings = settings if settings is not None else RuntimeSettings.from_env()
    store_adapter = store if store is not None else build_store(runtime_settings)
    if runtime_settings.environment == RuntimeEnvironment.PRODUCTION and isinstance(
        store_adapter, InMemoryRunStore
    ):
        raise RuntimeConfigurationError("InMemoryRunStore is forbidden in production")
    runtime_adapter = runtime if runtime is not None else build_runtime(runtime_settings)
    knowledge_service_adapter = (
        knowledge_service
        if knowledge_service is not None
        else build_knowledge_service(runtime_settings)
    )
    if runtime_settings.environment == RuntimeEnvironment.PRODUCTION and isinstance(
        runtime_adapter, NoopRuntime
    ):
        raise RuntimeConfigurationError("NoopRuntime is forbidden in production")

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        try:
            yield
        finally:
            try:
                await knowledge_service_adapter.aclose()
            finally:
                try:
                    await runtime_adapter.aclose()
                finally:
                    try:
                        await store_adapter.aclose()
                    finally:
                        if telemetry is not None:
                            await telemetry.aclose()

    app = FastAPI(
        title="Enterprise AI Runtime",
        version="0.2.0",
        docs_url="/internal/docs",
        openapi_url="/internal/openapi.json",
        lifespan=lifespan,
    )
    app.state.runtime_settings = runtime_settings
    app.state.run_service = RunService(
        store=store_adapter,
        runtime=runtime_adapter,
    )
    app.state.knowledge_service = knowledge_service_adapter
    app.state.evaluation_service = EvaluationService(
        runtime=runtime_adapter,
        attestation_secret=runtime_settings.evaluation_attestation_secret,
    )
    if telemetry is not None:
        app.state.telemetry_status = telemetry.status
        app.state.telemetry_runtime = telemetry

    @app.middleware("http")
    async def request_id_middleware(
        request: Request,
        call_next: Callable[[Request], Awaitable[Response]],
    ) -> Response:
        started_at = perf_counter()
        request_id = normalized_request_id(request.headers.get("X-Request-ID"))
        correlation_id, trace_id, traceparent = resolve_trace_context(
            request_id=request_id,
            correlation_id=request.headers.get("X-Correlation-ID"),
            traceparent=request.headers.get("traceparent"),
        )
        request.state.request_id = request_id
        request.state.correlation_id = correlation_id
        request.state.trace_id = trace_id
        request.state.traceparent = traceparent
        response: Response
        if request.url.path.startswith("/internal/") and runtime_settings.service_token is not None:
            authorization = request.headers.get("Authorization")
            expected = f"Bearer {runtime_settings.service_token}"
            if authorization is None or not compare_digest(authorization, expected):
                response = JSONResponse(
                    status_code=401,
                    content={
                        "detail": {
                            "code": "SERVICE_AUTHENTICATION_FAILED",
                            "message": "valid internal service credentials are required",
                        }
                    },
                    headers={"WWW-Authenticate": "Bearer"},
                )
            else:
                response = await call_next(request)
        else:
            response = await call_next(request)
        response.headers["X-Request-ID"] = request_id
        response.headers["X-Correlation-ID"] = correlation_id
        response.headers["traceparent"] = traceparent
        access_logger.info(
            structured_access_log(
                request_id=request_id,
                correlation_id=correlation_id,
                trace_id=trace_id,
                method=request.method,
                path=request.url.path,
                status_code=response.status_code,
                duration_ms=(perf_counter() - started_at) * 1000,
                occurred_at_utc=datetime.now(UTC).isoformat(),
            )
        )
        return response

    app.include_router(router)
    app.include_router(knowledge_router)
    return app


def build_knowledge_service(settings: RuntimeSettings) -> KnowledgeService:
    embedding_provider = None
    if settings.embedding_driver == EmbeddingDriver.OPENAI_COMPATIBLE:
        embedding_provider = OpenAIEmbeddingProvider(
            base_url=settings.embedding_base_url or "",
            api_key=settings.embedding_api_key or "",
            model=settings.embedding_model or "",
            dimensions=settings.embedding_dimensions,
            timeout_seconds=settings.embedding_timeout_seconds,
        )
    elif settings.embedding_driver == EmbeddingDriver.LOCAL_FASTEMBED:
        embedding_provider = LocalFastembedEmbeddingProvider(
            model=settings.embedding_model or "",
            dimensions=settings.embedding_dimensions,
            cache_dir=settings.local_model_cache_dir,
            threads=settings.local_model_threads,
            allow_download=settings.local_model_allow_download,
        )

    rerank_provider = None
    if settings.rerank_driver == RerankDriver.COHERE_COMPATIBLE:
        rerank_provider = CohereRerankProvider(
            base_url=settings.rerank_base_url or "",
            api_key=settings.rerank_api_key or "",
            model=settings.rerank_model or "",
            timeout_seconds=settings.rerank_timeout_seconds,
        )
    elif settings.rerank_driver == RerankDriver.LOCAL_FASTEMBED:
        rerank_provider = LocalFastembedRerankProvider(
            model=settings.rerank_model or "",
            cache_dir=settings.local_model_cache_dir,
            threads=settings.local_model_threads,
            allow_download=settings.local_model_allow_download,
        )

    return KnowledgeService(
        embedding_provider=embedding_provider,
        rerank_provider=rerank_provider,
        embedding_dimensions=settings.embedding_dimensions,
    )


def build_runtime(settings: RuntimeSettings) -> RuntimePort:
    if settings.driver == RuntimeDriver.NOOP:
        return NoopRuntime()

    if settings.driver == RuntimeDriver.OPENAI_COMPATIBLE:
        openai_provider = OpenAICompatibleProvider(
            base_url=settings.openai_base_url or "",
            api_key=settings.openai_api_key or "",
        )
        if settings.model_route_catalog or settings.require_trusted_model_route:
            return RoutedProviderRuntime(
                openai_provider,
                catalog=settings.model_route_catalog,
                require_route=settings.require_trusted_model_route,
            )
        return ProviderRuntime(openai_provider, model=settings.openai_model or "")

    manus_provider = ManusProvider(
        base_url=settings.manus_api_base_url,
        api_key=settings.manus_api_key or "",
        project_id=settings.manus_project_id,
        poll_interval_seconds=settings.manus_poll_interval_seconds,
        max_wait_seconds=settings.manus_max_wait_seconds,
        proxy_url=settings.manus_proxy_url,
    )
    if settings.model_route_catalog or settings.require_trusted_model_route:
        return RoutedProviderRuntime(
            manus_provider,
            catalog=settings.model_route_catalog,
            require_route=settings.require_trusted_model_route,
        )
    return ProviderRuntime(manus_provider, model=settings.manus_agent_profile)


def build_store(settings: RuntimeSettings) -> RunStorePort:
    if settings.store_driver == StoreDriver.MEMORY:
        return InMemoryRunStore()
    return PostgresRunStore(
        dsn=settings.postgres_dsn or "",
        min_size=settings.postgres_pool_min_size,
        max_size=settings.postgres_pool_max_size,
        command_timeout_seconds=settings.postgres_command_timeout_seconds,
    )


load_runtime_dotenv()
_runtime_settings = RuntimeSettings.from_env()
_telemetry = start_telemetry(
    read_telemetry_config(os.environ, _runtime_settings.environment),
    _runtime_settings.environment,
)
app = create_app(settings=_runtime_settings, telemetry=_telemetry)
_telemetry.instrument_app(app)


def run() -> None:
    uvicorn.run(
        "enterprise_ai_runtime.main:app",
        # Loopback remains the safe local default. Production deployments can
        # bind through their private service definition and must configure the
        # service token enforced by the application middleware.
        host="127.0.0.1",
        port=8100,
        reload=False,
    )


if __name__ == "__main__":
    run()
