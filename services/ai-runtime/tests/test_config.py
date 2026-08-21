from __future__ import annotations

import asyncio
from pathlib import Path
from uuid import UUID

import pytest

from enterprise_ai_runtime.adapters.noop_runtime import NoopRuntime
from enterprise_ai_runtime.adapters.postgres_run_store import PostgresRunStore
from enterprise_ai_runtime.adapters.provider_runtime import ProviderRuntime
from enterprise_ai_runtime.config import (
    EmbeddingDriver,
    ModelRouteCatalogEntry,
    RerankDriver,
    RuntimeDriver,
    RuntimeEnvironment,
    RuntimeSettings,
    StoreDriver,
    load_runtime_dotenv,
)
from enterprise_ai_runtime.domain.errors import RuntimeConfigurationError
from enterprise_ai_runtime.main import build_runtime, build_store, create_app


def test_noop_is_the_safe_development_default() -> None:
    settings = RuntimeSettings.from_env({})
    assert settings.driver == RuntimeDriver.NOOP
    assert settings.store_driver == StoreDriver.MEMORY
    assert settings.embedding_driver == EmbeddingDriver.DISABLED
    assert settings.rerank_driver == RerankDriver.DISABLED
    assert settings.embedding_dimensions == 1536


def test_knowledge_providers_are_configured_independently_from_run_driver() -> None:
    settings = RuntimeSettings.from_env(
        {
            "AI_RUNTIME_DRIVER": "manus",
            "MANUS_API_KEY": "manus-secret",
            "AI_RUNTIME_EMBEDDING_DRIVER": "openai_compatible",
            "AI_RUNTIME_EMBEDDING_BASE_URL": "https://embedding.example/v1",
            "AI_RUNTIME_EMBEDDING_API_KEY": "embedding-secret",
            "AI_RUNTIME_EMBEDDING_MODEL": "embedding-model",
            "AI_RUNTIME_RERANK_DRIVER": "cohere_compatible",
            "AI_RUNTIME_RERANK_BASE_URL": "https://rerank.example/v2",
            "AI_RUNTIME_RERANK_API_KEY": "rerank-secret",
            "AI_RUNTIME_RERANK_MODEL": "rerank-model",
        }
    )
    assert settings.driver == RuntimeDriver.MANUS
    assert settings.embedding_driver == EmbeddingDriver.OPENAI_COMPATIBLE
    assert settings.rerank_driver == RerankDriver.COHERE_COMPATIBLE
    rendered = repr(settings)
    assert "manus-secret" not in rendered
    assert "embedding-secret" not in rendered
    assert "rerank-secret" not in rendered


@pytest.mark.parametrize(
    ("environment", "base_url", "expected"),
    [
        ("development", "not-a-url", "absolute HTTP"),
        ("development", "https://user:password@provider.example/v1", "credentials"),
        ("production", "http://provider.example/v1", "HTTPS"),
        ("production", "https://provider.example/v1?tenant=secret", "query or fragment"),
        ("production", "https://provider.example/v1#metadata", "query or fragment"),
    ],
)
def test_embedding_provider_rejects_unsafe_urls(
    environment: str,
    base_url: str,
    expected: str,
) -> None:
    values = {
        "AI_RUNTIME_ENVIRONMENT": environment,
        "AI_RUNTIME_DRIVER": "openai_compatible" if environment == "production" else "noop",
        "AI_RUNTIME_STORE_DRIVER": "postgres" if environment == "production" else "memory",
        **(
            {
                "AI_RUNTIME_POSTGRES_DSN": (
                    "postgresql://runtime:secret@db.example/runtime?sslmode=require"
                )
            }
            if environment == "production"
            else {}
        ),
        "AI_RUNTIME_OPENAI_BASE_URL": "https://chat.example/v1",
        "AI_RUNTIME_OPENAI_API_KEY": "chat-secret",
        "AI_RUNTIME_OPENAI_MODEL": "chat-model",
        "AI_RUNTIME_EMBEDDING_DRIVER": "openai_compatible",
        "AI_RUNTIME_EMBEDDING_BASE_URL": base_url,
        "AI_RUNTIME_EMBEDDING_API_KEY": "embedding-secret",
        "AI_RUNTIME_EMBEDDING_MODEL": "embedding-model",
    }
    with pytest.raises(RuntimeConfigurationError, match=expected):
        RuntimeSettings.from_env(values)


def test_embedding_dimension_is_configurable_and_provider_configuration_is_complete() -> None:
    assert (
        RuntimeSettings.from_env({"AI_RUNTIME_EMBEDDING_DIMENSIONS": "768"}).embedding_dimensions
        == 768
    )
    with pytest.raises(RuntimeConfigurationError, match="between 1 and 16000"):
        RuntimeSettings.from_env({"AI_RUNTIME_EMBEDDING_DIMENSIONS": "16001"})
    with pytest.raises(RuntimeConfigurationError, match="AI_RUNTIME_EMBEDDING_API_KEY"):
        RuntimeSettings.from_env(
            {
                "AI_RUNTIME_EMBEDDING_DRIVER": "openai_compatible",
                "AI_RUNTIME_EMBEDDING_BASE_URL": "https://embedding.example/v1",
                "AI_RUNTIME_EMBEDDING_MODEL": "embedding-model",
            }
        )


def test_local_knowledge_drivers_use_safe_chinese_defaults_without_secrets() -> None:
    settings = RuntimeSettings.from_env(
        {
            "AI_RUNTIME_EMBEDDING_DRIVER": "local_fastembed",
            "AI_RUNTIME_RERANK_DRIVER": "local_fastembed",
            "AI_RUNTIME_LOCAL_MODEL_CACHE_DIR": ".data/models",
            "AI_RUNTIME_LOCAL_MODEL_THREADS": "3",
        }
    )

    assert settings.embedding_driver == EmbeddingDriver.LOCAL_FASTEMBED
    assert settings.embedding_model == "BAAI/bge-small-zh-v1.5"
    assert settings.rerank_driver == RerankDriver.LOCAL_FASTEMBED
    assert settings.rerank_model == "BAAI/bge-reranker-base"
    assert settings.local_model_cache_dir == ".data/models"
    assert settings.local_model_threads == 3
    assert settings.local_model_allow_download is True


def test_production_local_models_must_be_preprovisioned() -> None:
    values = {
        "AI_RUNTIME_ENVIRONMENT": "production",
        "AI_RUNTIME_DRIVER": "openai_compatible",
        "AI_RUNTIME_STORE_DRIVER": "postgres",
        "AI_RUNTIME_POSTGRES_DSN": "postgresql://runtime:secret@db.example/runtime?sslmode=require",
        "AI_RUNTIME_SERVICE_TOKEN": "runtime-service-token-at-least-32-characters",
        "AI_RUNTIME_OPENAI_BASE_URL": "https://chat.example/v1",
        "AI_RUNTIME_OPENAI_API_KEY": "chat-secret",
        "AI_RUNTIME_OPENAI_MODEL": "chat-model",
        "AI_RUNTIME_EMBEDDING_DRIVER": "local_fastembed",
        "AI_RUNTIME_RERANK_DRIVER": "local_fastembed",
        "AI_RUNTIME_LOCAL_MODEL_ALLOW_DOWNLOAD": "true",
        "AI_RUNTIME_MODEL_ROUTE_CATALOG": (
            '[{"route_key":"GENERAL.PRIMARY",'
            '"catalog_version_id":"00000000-0000-7000-8000-000000000101",'
            '"provider":"OPENAI_COMPATIBLE","model":"chat-model",'
            '"credential_reference":"vault://ai/chat"}]'
        ),
    }
    with pytest.raises(RuntimeConfigurationError, match="ALLOW_DOWNLOAD must be false"):
        RuntimeSettings.from_env(values)
    with pytest.raises(RuntimeConfigurationError, match="AI_RUNTIME_RERANK_API_KEY"):
        RuntimeSettings.from_env(
            {
                "AI_RUNTIME_RERANK_DRIVER": "cohere_compatible",
                "AI_RUNTIME_RERANK_BASE_URL": "https://rerank.example/v2",
                "AI_RUNTIME_RERANK_MODEL": "rerank-model",
            }
        )


@pytest.mark.parametrize(
    ("name", "value"),
    [
        ("AI_RUNTIME_EMBEDDING_TIMEOUT_SECONDS", "0.01"),
        ("AI_RUNTIME_EMBEDDING_TIMEOUT_SECONDS", "301"),
        ("AI_RUNTIME_RERANK_TIMEOUT_SECONDS", "0.01"),
        ("AI_RUNTIME_RERANK_TIMEOUT_SECONDS", "301"),
    ],
)
def test_knowledge_provider_timeouts_are_bounded(name: str, value: str) -> None:
    with pytest.raises(RuntimeConfigurationError, match=name):
        RuntimeSettings.from_env({name: value})


def test_noop_is_forbidden_in_production() -> None:
    with pytest.raises(RuntimeConfigurationError, match="forbidden"):
        RuntimeSettings.from_env(
            {
                "AI_RUNTIME_ENVIRONMENT": "production",
                "AI_RUNTIME_DRIVER": "noop",
            }
        )


def test_openai_driver_requires_complete_configuration() -> None:
    with pytest.raises(RuntimeConfigurationError, match="AI_RUNTIME_OPENAI_API_KEY"):
        RuntimeSettings.from_env(
            {
                "AI_RUNTIME_DRIVER": "openai_compatible",
                "AI_RUNTIME_OPENAI_BASE_URL": "https://provider.example/v1",
                "AI_RUNTIME_OPENAI_MODEL": "model-a",
            }
        )


def test_api_key_is_excluded_from_settings_repr() -> None:
    settings = RuntimeSettings.from_env(
        {
            "AI_RUNTIME_DRIVER": "openai_compatible",
            "AI_RUNTIME_OPENAI_BASE_URL": "https://provider.example/v1",
            "AI_RUNTIME_OPENAI_API_KEY": "top-secret-key",
            "AI_RUNTIME_OPENAI_MODEL": "model-a",
        }
    )
    assert "top-secret-key" not in repr(settings)


def test_model_route_catalog_is_strict_server_side_allowlist() -> None:
    settings = RuntimeSettings.from_env(
        {
            "AI_RUNTIME_DRIVER": "openai_compatible",
            "AI_RUNTIME_OPENAI_BASE_URL": "https://provider.example/v1",
            "AI_RUNTIME_OPENAI_API_KEY": "top-secret-key",
            "AI_RUNTIME_OPENAI_MODEL": "legacy-model",
            "AI_RUNTIME_REQUIRE_TRUSTED_MODEL_ROUTE": "true",
            "AI_RUNTIME_MODEL_ROUTE_CATALOG": (
                '[{"route_key":"GENERAL.PRIMARY",'
                '"catalog_version_id":"00000000-0000-7000-8000-000000000101",'
                '"provider":"OPENAI_COMPATIBLE","model":"model-a",'
                '"credential_reference":"vault://ai/general"}]'
            ),
        }
    )
    assert settings.require_trusted_model_route
    assert settings.model_route_catalog[0].model == "model-a"
    assert "top-secret-key" not in repr(settings)


@pytest.mark.parametrize(
    "catalog",
    [
        (
            '[{"route_key":"GENERAL.PRIMARY",'
            '"catalog_version_id":"00000000-0000-7000-8000-000000000101",'
            '"provider":"OPENAI_COMPATIBLE","model":"model-a",'
            '"credential_reference":"vault://ai/general",'
            '"endpoint":"https://attacker.invalid/v1"}]'
        ),
        (
            '[{"route_key":"GENERAL.PRIMARY",'
            '"catalog_version_id":"00000000-0000-7000-8000-000000000101",'
            '"provider":"OPENAI_COMPATIBLE","model":"model-a",'
            '"credential_reference":"secret=plaintext"}]'
        ),
    ],
)
def test_model_route_catalog_rejects_endpoint_and_plaintext_secret(catalog: str) -> None:
    with pytest.raises(RuntimeConfigurationError, match="MODEL_ROUTE_CATALOG|credential"):
        RuntimeSettings.from_env(
            {
                "AI_RUNTIME_DRIVER": "openai_compatible",
                "AI_RUNTIME_OPENAI_BASE_URL": "https://provider.example/v1",
                "AI_RUNTIME_OPENAI_API_KEY": "top-secret-key",
                "AI_RUNTIME_OPENAI_MODEL": "legacy-model",
                "AI_RUNTIME_REQUIRE_TRUSTED_MODEL_ROUTE": "true",
                "AI_RUNTIME_MODEL_ROUTE_CATALOG": catalog,
            }
        )


def test_manus_driver_requires_key_and_uses_safe_defaults() -> None:
    with pytest.raises(RuntimeConfigurationError, match="MANUS_API_KEY"):
        RuntimeSettings.from_env({"AI_RUNTIME_DRIVER": "manus"})

    settings = RuntimeSettings.from_env(
        {
            "AI_RUNTIME_DRIVER": "manus",
            "MANUS_API_KEY": "dummy-manus-key",
        }
    )
    assert settings.driver == RuntimeDriver.MANUS
    assert settings.manus_api_base_url == "https://api.manus.ai"
    assert settings.manus_agent_profile == "manus-1.6-lite"
    assert settings.manus_poll_interval_seconds == 2
    assert settings.manus_max_wait_seconds == 300
    assert "dummy-manus-key" not in repr(settings)

    runtime = build_runtime(settings)
    assert isinstance(runtime, ProviderRuntime)
    asyncio.run(runtime.aclose())


def test_manus_driver_accepts_an_explicit_http_proxy() -> None:
    settings = RuntimeSettings.from_env(
        {
            "AI_RUNTIME_DRIVER": "manus",
            "MANUS_API_KEY": "dummy-manus-key",
            "MANUS_PROXY_URL": "http://127.0.0.1:10837",
        }
    )
    assert settings.manus_proxy_url == "http://127.0.0.1:10837"
    assert "127.0.0.1:10837" not in repr(settings)

    runtime = build_runtime(settings)
    assert isinstance(runtime, ProviderRuntime)
    asyncio.run(runtime.aclose())


def _production_manus_environment(proxy_url: str) -> dict[str, str]:
    return {
        "AI_RUNTIME_ENVIRONMENT": "production",
        "AI_RUNTIME_DRIVER": "manus",
        "AI_RUNTIME_STORE_DRIVER": "postgres",
        "AI_RUNTIME_POSTGRES_DSN": (
            "postgresql://runtime:secret@db.example/runtime?sslmode=require"
        ),
        "AI_RUNTIME_SERVICE_TOKEN": "runtime-service-token-at-least-32-characters",
        "AI_RUNTIME_MODEL_ROUTE_CATALOG": (
            '[{"route_key":"GENERAL.PRIMARY",'
            '"catalog_version_id":"00000000-0000-7000-8000-000000000101",'
            '"provider":"MANUS","model":"manus-1.6-lite",'
            '"credential_reference":"vault://ai/manus"}]'
        ),
        "MANUS_API_KEY": "dummy-manus-key",
        "MANUS_PROXY_URL": proxy_url,
    }


def test_manus_production_accepts_an_explicit_https_proxy() -> None:
    settings = RuntimeSettings.from_env(_production_manus_environment("https://proxy.example"))
    assert settings.manus_proxy_url == "https://proxy.example"


@pytest.mark.parametrize(
    "proxy_url",
    [
        "http://proxy.example",
        "https://user:password@proxy.example",
        "https://proxy.example?tenant=secret",
        "https://proxy.example#metadata",
        "https://127.0.0.1:8443",
        "https://10.0.0.1:8443",
        "https://169.254.169.254:8443",
        "https://[::1]:8443",
        "https://[::ffff:192.0.2.10]:8443",
    ],
)
def test_manus_production_rejects_unsafe_explicit_proxy(proxy_url: str) -> None:
    with pytest.raises(RuntimeConfigurationError, match="MANUS_PROXY_URL"):
        RuntimeSettings.from_env(_production_manus_environment(proxy_url))


@pytest.mark.parametrize("proxy_url", ["127.0.0.1:10837", "socks5://127.0.0.1:10837"])
def test_manus_driver_rejects_invalid_proxy_urls(proxy_url: str) -> None:
    with pytest.raises(RuntimeConfigurationError, match="MANUS_PROXY_URL"):
        RuntimeSettings.from_env(
            {
                "AI_RUNTIME_DRIVER": "manus",
                "MANUS_API_KEY": "dummy-manus-key",
                "MANUS_PROXY_URL": proxy_url,
            }
        )


@pytest.mark.parametrize(
    "base_url",
    [
        "http://api.manus.ai",
        "https://api.manus.ai.evil.example",
        "https://user:password@api.manus.ai",
        "https://api.manus.ai/v2",
        "https://api.manus.ai?redirect=evil",
    ],
)
def test_manus_driver_only_sends_key_to_official_api_root(base_url: str) -> None:
    with pytest.raises(RuntimeConfigurationError, match="official HTTPS API root"):
        RuntimeSettings.from_env(
            {
                "AI_RUNTIME_DRIVER": "manus",
                "MANUS_API_KEY": "dummy-manus-key",
                "MANUS_API_BASE_URL": base_url,
            }
        )


@pytest.mark.parametrize(
    ("overrides", "expected"),
    [
        ({"MANUS_AGENT_PROFILE": "unknown"}, "MANUS_AGENT_PROFILE"),
        ({"MANUS_POLL_INTERVAL_SECONDS": "0.5"}, "MANUS_POLL_INTERVAL_SECONDS"),
        ({"MANUS_MAX_WAIT_SECONDS": "1"}, "MANUS_MAX_WAIT_SECONDS"),
        ({"MANUS_MAX_WAIT_SECONDS": "not-a-number"}, "MANUS_MAX_WAIT_SECONDS"),
    ],
)
def test_manus_driver_rejects_invalid_bounds(
    overrides: dict[str, str],
    expected: str,
) -> None:
    with pytest.raises(RuntimeConfigurationError, match=expected):
        RuntimeSettings.from_env(
            {
                "AI_RUNTIME_DRIVER": "manus",
                "MANUS_API_KEY": "dummy-manus-key",
                **overrides,
            }
        )


def test_development_dotenv_loads_without_overriding_injected_values(tmp_path: Path) -> None:
    dotenv_path = tmp_path / ".env"
    dotenv_path.write_text(
        "AI_RUNTIME_DRIVER=manus\n"
        "MANUS_API_KEY=dummy-file-key\n"
        "MANUS_AGENT_PROFILE=manus-1.6-max\n"
        "AI_RUNTIME_OTEL_SERVICE_NAME=enterprise-ai-runtime-test\n"
        "DATABASE_URL=must-not-enter-ai-runtime\n",
        encoding="utf-8",
    )
    environ = {"MANUS_API_KEY": "dummy-process-key"}

    assert load_runtime_dotenv(environ=environ, dotenv_path=dotenv_path) is True
    assert environ["AI_RUNTIME_DRIVER"] == "manus"
    assert environ["MANUS_API_KEY"] == "dummy-process-key"
    assert environ["MANUS_AGENT_PROFILE"] == "manus-1.6-max"
    assert environ["AI_RUNTIME_OTEL_SERVICE_NAME"] == "enterprise-ai-runtime-test"
    assert "DATABASE_URL" not in environ
    settings = RuntimeSettings.from_env(environ)
    assert "dummy-file-key" not in repr(settings)
    assert "dummy-process-key" not in repr(settings)


def test_development_postgres_store_reuses_local_database_without_prisma_schema_option(
    tmp_path: Path,
) -> None:
    dotenv_path = tmp_path / ".env"
    dotenv_path.write_text(
        "AI_RUNTIME_STORE_DRIVER=postgres\n"
        "DATABASE_URL=postgresql://local:secret@127.0.0.1:5432/app?schema=public\n",
        encoding="utf-8",
    )
    environ: dict[str, str] = {}

    assert load_runtime_dotenv(environ=environ, dotenv_path=dotenv_path) is True
    assert environ["AI_RUNTIME_POSTGRES_DSN"] == (
        "postgresql://local:secret@127.0.0.1:5432/app"
    )
    assert "DATABASE_URL" not in environ
    settings = RuntimeSettings.from_env(environ)
    assert settings.store_driver == StoreDriver.POSTGRES
    assert "secret" not in repr(settings)


def test_production_never_loads_dotenv(tmp_path: Path) -> None:
    dotenv_path = tmp_path / ".env"
    dotenv_path.write_text("SHOULD_NOT_LOAD=yes\n", encoding="utf-8")
    environ = {"AI_RUNTIME_ENVIRONMENT": "production"}

    assert load_runtime_dotenv(environ=environ, dotenv_path=dotenv_path) is False
    assert "SHOULD_NOT_LOAD" not in environ


def test_dotenv_cannot_turn_a_local_process_into_production(tmp_path: Path) -> None:
    dotenv_path = tmp_path / ".env"
    dotenv_path.write_text("AI_RUNTIME_ENVIRONMENT=production\n", encoding="utf-8")

    with pytest.raises(RuntimeConfigurationError, match="supplied by the process"):
        load_runtime_dotenv(environ={}, dotenv_path=dotenv_path)


def test_production_openai_driver_requires_https_and_no_url_credentials() -> None:
    base = {
        "AI_RUNTIME_ENVIRONMENT": "production",
        "AI_RUNTIME_DRIVER": "openai_compatible",
        "AI_RUNTIME_STORE_DRIVER": "postgres",
        "AI_RUNTIME_POSTGRES_DSN": (
            "postgresql://runtime:secret@db.example/runtime?sslmode=require"
        ),
        "AI_RUNTIME_OPENAI_API_KEY": "secret",
        "AI_RUNTIME_OPENAI_MODEL": "model-a",
    }
    with pytest.raises(RuntimeConfigurationError, match="HTTPS"):
        RuntimeSettings.from_env(
            {**base, "AI_RUNTIME_OPENAI_BASE_URL": "http://provider.example/v1"}
        )
    with pytest.raises(RuntimeConfigurationError, match="credentials"):
        RuntimeSettings.from_env(
            {**base, "AI_RUNTIME_OPENAI_BASE_URL": "https://user:pass@provider.example/v1"}
        )
    for unsafe_url in (
        "https://provider.example/v1?tenant=secret",
        "https://provider.example/v1#metadata",
    ):
        with pytest.raises(RuntimeConfigurationError, match="query or fragment"):
            RuntimeSettings.from_env({**base, "AI_RUNTIME_OPENAI_BASE_URL": unsafe_url})


@pytest.mark.parametrize(
    "unsafe_url",
    [
        "https://127.0.0.1/v1",
        "https://127.1/v1",
        "https://2130706433/v1",
        "https://0x7f000001/v1",
        "https://10.0.0.1/v1",
        "https://169.254.169.254/v1",
        "https://[::1]/v1",
        "https://[::ffff:192.0.2.10]/v1",
    ],
)
@pytest.mark.parametrize(
    ("setting_name", "expected_name"),
    [
        ("AI_RUNTIME_OPENAI_BASE_URL", "AI_RUNTIME_OPENAI_BASE_URL"),
        ("AI_RUNTIME_EMBEDDING_BASE_URL", "AI_RUNTIME_EMBEDDING_BASE_URL"),
        ("AI_RUNTIME_RERANK_BASE_URL", "AI_RUNTIME_RERANK_BASE_URL"),
    ],
)
def test_production_provider_urls_reject_non_public_literal_ips(
    unsafe_url: str,
    setting_name: str,
    expected_name: str,
) -> None:
    values = {
        "AI_RUNTIME_ENVIRONMENT": "production",
        "AI_RUNTIME_DRIVER": "openai_compatible",
        "AI_RUNTIME_STORE_DRIVER": "postgres",
        "AI_RUNTIME_POSTGRES_DSN": (
            "postgresql://runtime:secret@db.example/runtime?sslmode=require"
        ),
        "AI_RUNTIME_SERVICE_TOKEN": "runtime-service-token-at-least-32-characters",
        "AI_RUNTIME_OPENAI_BASE_URL": "https://chat.example/v1",
        "AI_RUNTIME_OPENAI_API_KEY": "chat-secret",
        "AI_RUNTIME_OPENAI_MODEL": "chat-model",
        "AI_RUNTIME_EMBEDDING_DRIVER": "openai_compatible",
        "AI_RUNTIME_EMBEDDING_BASE_URL": "https://embedding.example/v1",
        "AI_RUNTIME_EMBEDDING_API_KEY": "embedding-secret",
        "AI_RUNTIME_EMBEDDING_MODEL": "embedding-model",
        "AI_RUNTIME_RERANK_DRIVER": "cohere_compatible",
        "AI_RUNTIME_RERANK_BASE_URL": "https://rerank.example/v2",
        "AI_RUNTIME_RERANK_API_KEY": "rerank-secret",
        "AI_RUNTIME_RERANK_MODEL": "rerank-model",
        "AI_RUNTIME_MODEL_ROUTE_CATALOG": (
            '[{"route_key":"GENERAL.PRIMARY",'
            '"catalog_version_id":"00000000-0000-7000-8000-000000000101",'
            '"provider":"OPENAI_COMPATIBLE","model":"model-a",'
            '"credential_reference":"vault://ai/general"}]'
        ),
    }
    values[setting_name] = unsafe_url
    with pytest.raises(
        RuntimeConfigurationError,
        match=f"{expected_name}.*literal IP",
    ):
        RuntimeSettings.from_env(values)


def test_memory_store_is_forbidden_in_production() -> None:
    with pytest.raises(RuntimeConfigurationError, match="STORE_DRIVER=memory"):
        RuntimeSettings(
            environment=RuntimeEnvironment.PRODUCTION,
            driver=RuntimeDriver.OPENAI_COMPATIBLE,
            store_driver=StoreDriver.MEMORY,
            openai_base_url="https://provider.example/v1",
            openai_api_key="secret",
            openai_model="model-a",
        )


def test_postgres_store_requires_a_dsn() -> None:
    with pytest.raises(RuntimeConfigurationError, match="AI_RUNTIME_POSTGRES_DSN"):
        RuntimeSettings(
            environment=RuntimeEnvironment.DEVELOPMENT,
            driver=RuntimeDriver.NOOP,
            store_driver=StoreDriver.POSTGRES,
        )


def test_postgres_store_is_constructed_without_leaking_its_dsn() -> None:
    settings = RuntimeSettings(
        environment=RuntimeEnvironment.DEVELOPMENT,
        driver=RuntimeDriver.NOOP,
        store_driver=StoreDriver.POSTGRES,
        postgres_dsn="postgresql://runtime:secret@db.example/runtime",
        postgres_pool_min_size=2,
        postgres_pool_max_size=8,
    )
    assert "secret" not in repr(settings)
    store = build_store(settings)
    assert isinstance(store, PostgresRunStore)


@pytest.mark.parametrize(
    "dsn",
    [
        "postgresql://runtime:secret@db.example/runtime",
        "postgresql://runtime:secret@db.example/runtime?sslmode=prefer",
        "postgresql://runtime:secret@db.example/runtime?sslmode=disable",
        ("postgresql://runtime:secret@db.example/runtime?sslmode=require&sslmode=disable"),
        "postgresql://runtime:secret@db.example/runtime?sslmode=require&ssl=false",
    ],
)
def test_production_postgres_store_requires_tls(dsn: str) -> None:
    with pytest.raises(RuntimeConfigurationError, match="must require TLS"):
        RuntimeSettings(
            environment=RuntimeEnvironment.PRODUCTION,
            driver=RuntimeDriver.OPENAI_COMPATIBLE,
            store_driver=StoreDriver.POSTGRES,
            postgres_dsn=dsn,
            openai_base_url="https://provider.example/v1",
            openai_api_key="secret",
            openai_model="model-a",
        )


def test_production_requires_a_long_service_token() -> None:
    with pytest.raises(RuntimeConfigurationError, match="AI_RUNTIME_SERVICE_TOKEN"):
        RuntimeSettings(
            environment=RuntimeEnvironment.PRODUCTION,
            driver=RuntimeDriver.OPENAI_COMPATIBLE,
            store_driver=StoreDriver.POSTGRES,
            postgres_dsn="postgresql://runtime:secret@db.example/runtime?sslmode=require",
            openai_base_url="https://provider.example/v1",
            openai_api_key="secret",
            openai_model="model-a",
        )


class DurableStoreStub:
    """Only used to reach the independent production runtime-injection guard."""


def test_injected_noop_runtime_is_also_forbidden_in_production() -> None:
    settings = RuntimeSettings(
        environment=RuntimeEnvironment.PRODUCTION,
        driver=RuntimeDriver.OPENAI_COMPATIBLE,
        store_driver=StoreDriver.POSTGRES,
        postgres_dsn="postgresql://runtime:secret@db.example/runtime?sslmode=require",
        service_token="runtime-service-token-at-least-32-characters",
        openai_base_url="https://provider.example/v1",
        openai_api_key="top-secret-key",
        openai_model="model-a",
        require_trusted_model_route=True,
        model_route_catalog=(
            ModelRouteCatalogEntry(
                route_key="GENERAL.PRIMARY",
                catalog_version_id=UUID("00000000-0000-7000-8000-000000000101"),
                provider="OPENAI_COMPATIBLE",
                model="model-a",
                credential_reference="vault://ai/general",
            ),
        ),
    )
    with pytest.raises(RuntimeConfigurationError, match="NoopRuntime"):
        create_app(
            settings=settings,
            store=DurableStoreStub(),  # type: ignore[arg-type]
            runtime=NoopRuntime(),
        )
