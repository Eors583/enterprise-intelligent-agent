from __future__ import annotations

import re
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from uuid import uuid4

import uvicorn
from fastapi import FastAPI, Request, Response

from enterprise_ai_runtime.adapters.cohere_rerank_provider import CohereRerankProvider
from enterprise_ai_runtime.adapters.manus_provider import ManusProvider
from enterprise_ai_runtime.adapters.memory_run_store import InMemoryRunStore
from enterprise_ai_runtime.adapters.noop_runtime import NoopRuntime
from enterprise_ai_runtime.adapters.openai_compatible_provider import OpenAICompatibleProvider
from enterprise_ai_runtime.adapters.openai_embedding_provider import OpenAIEmbeddingProvider
from enterprise_ai_runtime.adapters.provider_runtime import ProviderRuntime
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
from enterprise_ai_runtime.ports.run_store import RunStorePort
from enterprise_ai_runtime.ports.runtime import RuntimePort
from enterprise_ai_runtime.services.knowledge_service import KnowledgeService
from enterprise_ai_runtime.services.run_service import RunService

REQUEST_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")


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
                await runtime_adapter.aclose()

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

    @app.middleware("http")
    async def request_id_middleware(
        request: Request,
        call_next: Callable[[Request], Awaitable[Response]],
    ) -> Response:
        request_id = normalized_request_id(request.headers.get("X-Request-ID"))
        request.state.request_id = request_id
        response = await call_next(request)
        response.headers["X-Request-ID"] = request_id
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

    rerank_provider = None
    if settings.rerank_driver == RerankDriver.COHERE_COMPATIBLE:
        rerank_provider = CohereRerankProvider(
            base_url=settings.rerank_base_url or "",
            api_key=settings.rerank_api_key or "",
            model=settings.rerank_model or "",
            timeout_seconds=settings.rerank_timeout_seconds,
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
        provider = OpenAICompatibleProvider(
            base_url=settings.openai_base_url or "",
            api_key=settings.openai_api_key or "",
        )
        return ProviderRuntime(provider, model=settings.openai_model or "")

    provider = ManusProvider(
        base_url=settings.manus_api_base_url,
        api_key=settings.manus_api_key or "",
        project_id=settings.manus_project_id,
        poll_interval_seconds=settings.manus_poll_interval_seconds,
        max_wait_seconds=settings.manus_max_wait_seconds,
        proxy_url=settings.manus_proxy_url,
    )
    return ProviderRuntime(provider, model=settings.manus_agent_profile)


def build_store(settings: RuntimeSettings) -> RunStorePort:
    if settings.store_driver == StoreDriver.MEMORY:
        return InMemoryRunStore()
    raise RuntimeConfigurationError(
        "postgres RunStore is not implemented; inject a durable RunStorePort adapter"
    )


load_runtime_dotenv()
app = create_app()


def run() -> None:
    uvicorn.run(
        "enterprise_ai_runtime.main:app",
        # The internal API has no service authentication in the MVP. Keep the
        # console entry point loopback-only; production must expose it through
        # an authenticated private service boundary explicitly.
        host="127.0.0.1",
        port=8100,
        reload=False,
    )


if __name__ == "__main__":
    run()
